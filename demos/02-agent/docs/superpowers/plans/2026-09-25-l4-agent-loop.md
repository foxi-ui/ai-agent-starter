# L4 · Agent 循环与展示投影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**这是渐进步骤的第 4 步（共 6 步）。** 顺序与判据见 [`README.md`](./README.md)。
**前置：L1–L3 已完成**（类型已就位、工具层已跑通、模型能开单）。

**Goal:** 把 L2/L3 手工走的那串动作**包进一个循环** —— 模型开单就执行、把结果回喂、再问模型，
直到模型不再开单或跑满 `maxSteps`；然后把「本轮发生了什么」**投影**成给人看的展示项。

**这一步学到什么：**

1. **Agent Loop 就是一个「调模型 → 看有没有开单 → 有就执行并回喂 → 再调模型」的循环**，它必须**有界**。
   本步对应 ROADMAP 阶段 1 五条验收项里最核心的三条：自己实现 Agent Loop、处理 Tool Result、防止无限循环。
2. **循环的判据是 `tool_calls` 非空，不是 `finish_reason`。** 有些 OpenAI 兼容实现会在
   `finish_reason: 'stop'` 的同时返回 `tool_calls` —— 看 `finish_reason` 就会漏调工具、
   把 `content: null` 当成最终答案回给用户（前端显示一个空气泡），**而且不报任何错**。
3. **工具失败不是崩溃，是一段回喂给模型的错误文本。** 参数非法、工具抛异常、工具名不存在 ——
   三种都变成 `tool` 消息让模型自己纠正。
4. **agent 层只产出事实，展示项一律由外层投影。** `runAgentTurn` 返回的
   `{final, added, stopReason}` 里**没有任何一个字段是为了界面存在的**（spec D4）。
   「调了哪个工具、传了什么、成没成功」全部由 `presentation/transcript.ts` 从 `added` 推导出来。

**Architecture:** `core/agent.ts` 里两个函数、两种粒度：`runAgentTurn` 是**纯函数**（只吃 messages、不改 `Session`，因此能在没有会话、没有网络的前提下被测透）；`runSessionTurn` 是薄薄一层编排，把一轮对话与 `Session` 的读写绑在一起。`presentation/transcript.ts` 是**新增的边界层** —— 它把 `Message[]`（按模型需要组织）折成 `TranscriptItem[]`（按人的阅读顺序组织），`core/` 完全不知道它的存在。

**Tech Stack:** Node 22、`node --test`；两个接缝都用**手写对象字面量**替身（`fakeClient` / `fakeRegistry`）。

**Spec:** `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 §8（Agent 循环）、§9（展示投影）；
D4、D7、D8、D9、D18

## Global Constraints

以下约束对**每一个** Task 都生效，六份计划里都完整重复一遍。

- **Node ≥ 22**（本项目在 v22.23.2 验证），依赖原生类型擦除直接运行 `.ts`，服务端**不引入构建步骤**
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。
  判断标准：删掉所有类型标注后仍是合法 JS 的，才能用
- **只当类型用的导入必须写 `import type`**，否则擦除阶段无法识别，运行时抛
  「does not provide an export named …」而 `tsc --noEmit` 放行
- **`core/` / `llm/` / `tools/` / `presentation/` 零第三方依赖**，只用 `node:` 内置模块与全局 `fetch`
- **`http/` 层允许运行时依赖且必须登记**：当前唯一一条是 `express`（配套 `@types/express`）
- **依赖方向单向**：`http → presentation → core`、`http → core`、`http → llm`、`http → tools`、
  `core → llm`（仅 `import type`）、`tools → core`。
  **`core` 不 import `tools`**；**`presentation` 不 import `http`**
- `core/` / `llm/` / `tools/` / `presentation/` **不 import express**、不碰 `req` / `res`、
  **不写** `process.stdout` / `process.stderr`；**只有 `src/main.ts` 碰 `process`**
- **`core/types.ts` 里不许出现为了界面存在的字段**（判断标准：删掉它，浏览器上的东西会少一块吗？）
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**；`start` / `dev` / `test` 三个脚本都要带
- ESM（`"type": "module"`）；包管理器 pnpm
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（裸 `node --test` 会匹配到它，静默撑大用例数）
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。
**本步相关的两条：**

1. **`finish_reason: 'stop'` 但响应里带 `tool_calls`** —— 期望行为：**仍然执行工具**。
   若循环条件看 `finish_reason`，就会漏调工具、把 `content: null` 当答案回给用户（空气泡），且不报错。
   测试落点：Task 6 Step 2 的 `finish_reason 是 stop 但带 tool_calls` 用例。
2. **一个只有 `tool_calls`、没有正文的 assistant 消息** —— 它不该在对话框里产生一个空气泡；
   而它后面的 `tool` 结果必须靠 `tool_call_id` 正确填回对应那一项。
   测试落点：Task 7 Step 1 的 `只有 tool_calls 没有正文的 assistant 不产出 assistant 项`。

---

### Task 6: Agent 循环

本项目的技术核心（spec §8，对应 ROADMAP 阶段 1 的五条验收项）。
注意 `AgentTurn` **没有 `steps`** —— 本轮调了哪些工具属于「怎么给人看」，
由 Task 7 的投影层从 `added` 推导（spec D4）。

**Files:**
- Create: `demos/02-agent/apps/server/src/core/prompt.ts`
- Create: `demos/02-agent/apps/server/src/core/agent.ts`
- Test: `demos/02-agent/apps/server/test/agent.test.ts`

**Interfaces:**
- Consumes: L1 的 `ChatResult` / `Message` / `ToolResult`；L2 的 `ToolRegistry`；L3 的 `LLMClient` 实现
- Produces: `SYSTEM_PROMPT`；`AgentTurn`（`final` / `added` / `stopReason`）；`AgentOptions`；
  `runAgentTurn(client, registry, messages, options?)`；
  `runSessionTurn(session, client, registry, question, options)`

- [ ] **Step 1: 写 `src/core/prompt.ts`**

```ts
// 系统提示。
//
// 单独一个文件而不是塞进 agent.ts：它是我们唯一会反复微调的东西，
// 也是读代码的人最想第一眼看到的东西。

/**
 * 系统提示词。
 *
 * 每次请求都作为第一条消息重新带上，不存在 Session 里（见 core/session.ts）。
 * 末句「需要时可调用工具」是本阶段相对阶段一唯一的改动 ——
 * 模型需要有这句话才会认真考虑工具。
 */
export const SYSTEM_PROMPT = '你是 AI 助手，简洁直接地回答问题。需要时可调用工具。';
```

- [ ] **Step 2: 写失败测试**

`test/agent.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn, runSessionTurn } from '@/core/agent.ts';
import { Session } from '@/core/session.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import type { ChatOptions, ChatResult, Message, ToolResult } from '@/core/types.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';

/** 按顺序吐出预设响应，并记录每次收到的 messages 与 options */
function fakeClient(results: ChatResult[]): {
  client: LLMClient;
  seen: Message[][];
  seenOptions: Array<ChatOptions | undefined>;
} {
  const seen: Message[][] = [];
  const seenOptions: Array<ChatOptions | undefined> = [];
  let index = 0;
  return {
    seen,
    seenOptions,
    client: {
      async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
        seen.push(messages.map((message) => ({ ...message })));
        seenOptions.push(options);
        const result = results[index];
        index += 1;
        if (!result) throw new Error('fakeClient 的预设响应用完了');
        return result;
      },
    },
  };
}

/** 一张工具声明（内容不重要，只为占位） */
const anyTool = {
  name: 'weather',
  description: 'x',
  parameters: { type: 'object' as const, properties: {} },
};

function fakeRegistry(handlers: Record<string, () => ToolResult | Promise<ToolResult>>): ToolRegistry {
  return {
    list: () => [anyTool],
    async execute(name: string): Promise<ToolResult> {
      const handler = handlers[name];
      if (!handler) return { ok: false, error: `未知工具：${name}` };
      return await handler();
    },
  };
}

function toolCallResult(id: string, name: string, args: string): ChatResult {
  return {
    content: null,
    finish_reason: 'tool_calls',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  };
}

const answer = (text: string): ChatResult => ({ content: text, finish_reason: 'stop' });

test('没有 tool_calls 时直接返回答案', async () => {
  const { client, seen } = fakeClient([answer('你好')]);
  const turn = await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(turn.final.content, '你好');
  assert.strictEqual(turn.stopReason, 'answered');
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(turn.added, [{ role: 'assistant', content: '你好' }]);
});

test('一轮工具后收敛：added 里是 assistant{tool_calls} + tool + 最终 assistant', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'weather', '{"city":"Beijing"}'),
    answer('北京今天 25°C，晴天。'),
  ]);
  const registry = fakeRegistry({
    weather: () => ({ ok: true, value: { temperature: '25°C', condition: 'Sunny' } }),
  });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '北京天气' }]);

  assert.strictEqual(turn.stopReason, 'answered');
  assert.strictEqual(turn.final.content, '北京今天 25°C，晴天。');
  assert.deepStrictEqual(turn.added, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"temperature":"25°C","condition":"Sunny"}',
    },
    { role: 'assistant', content: '北京今天 25°C，晴天。' },
  ]);
});

test('多步循环：连续两次工具调用后才收敛', async () => {
  const { client, seen } = fakeClient([
    toolCallResult('c1', 'weather', '{"city":"Beijing"}'),
    toolCallResult('c2', 'weather', '{"city":"Shanghai"}'),
    answer('两地都晴。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '两地天气' }]);

  assert.strictEqual(seen.length, 3);
  assert.strictEqual(turn.added.length, 5);
  assert.strictEqual(turn.final.content, '两地都晴。');
});

test('同一轮里多个 tool_calls：每个各回一条 tool 消息', async () => {
  const { client } = fakeClient([
    {
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
        { id: 'c2', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } },
      ],
    },
    answer('都晴。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  const toolMessages = turn.added.filter((message) => message.role === 'tool');
  assert.deepStrictEqual(
    toolMessages.map((message) => (message.role === 'tool' ? message.tool_call_id : '')),
    ['c1', 'c2'],
  );
});

test('arguments 不是合法 JSON：错误文本回喂，且不执行工具', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'weather', '{city: Beijing'),
    answer('我换个写法。'),
  ]);
  let called = false;
  const registry = fakeRegistry({
    weather: () => {
      called = true;
      return { ok: true, value: '不应被执行' };
    },
  });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(called, false, '参数解析失败时不该执行工具');
  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('JSON'));
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('{city: Beijing'));
  assert.strictEqual(turn.final.content, '我换个写法。');
});

test('工具抛异常：兜底成 {ok:false} 回喂，不崩', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'weather', '{"city":"Beijing"}'),
    answer('工具挂了，我直接答。'),
  ]);
  const registry = fakeRegistry({
    weather: () => {
      throw new Error('上游超时');
    },
  });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  assert.strictEqual(toolMessage.content, '上游超时');
  assert.strictEqual(turn.final.content, '工具挂了，我直接答。');
});

test('未知名工具：错误文本回喂', async () => {
  const { client } = fakeClient([toolCallResult('c1', 'nope', '{}'), answer('好，我不用工具了。')]);

  const turn = await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }]);

  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('nope'));
});

test('finish_reason 是 stop 但带 tool_calls：仍要执行工具', async () => {
  // 有些 OpenAI 兼容实现会这样返回。若循环条件看 finish_reason，
  // 就会漏调工具、把 content: null 当成最终答案回给用户（前端显示一个空气泡）。
  const { client } = fakeClient([
    {
      content: null,
      finish_reason: 'stop',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    answer('北京今天 25°C，晴天。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '25°C, Sunny' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '北京天气' }]);

  const toolMessages = turn.added.filter((message) => message.role === 'tool');
  assert.strictEqual(toolMessages.length, 1, '必须执行了工具');
  assert.strictEqual(turn.final.content, '北京今天 25°C，晴天。');
});

test('工具返回 undefined 时回喂 "null"（tool 消息的 content 必须是非空字符串）', async () => {
  const { client } = fakeClient([toolCallResult('c1', 'weather', '{}'), answer('好')]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: undefined }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  assert.strictEqual(toolMessage.content, 'null');
});

test('跑满 maxSteps：调用次数恰好等于 maxSteps，且最后一条是带 content 的 assistant', async () => {
  // 每次都给 tool_calls，永远不收敛
  const results = Array.from({ length: 3 }, (_, index) =>
    toolCallResult(`c${index}`, 'weather', '{}'),
  );
  const { client, seen } = fakeClient(results);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }], { maxSteps: 3 });

  assert.strictEqual(seen.length, 3, 'maxSteps 是「最多调几次模型」，off-by-one 会在这里露出来');
  assert.strictEqual(turn.stopReason, 'max-steps');

  const last = turn.added[turn.added.length - 1]!;
  assert.strictEqual(last.role, 'assistant');
  assert.ok(
    last.role === 'assistant' && typeof last.content === 'string' && last.content !== '',
    '最后一条必须是带正文的 assistant，否则历史对 API 非法',
  );
  assert.strictEqual(last.role === 'assistant' ? last.tool_calls : undefined, undefined);
});

test('maxSteps 默认为 6', async () => {
  const results = Array.from({ length: 6 }, (_, index) =>
    toolCallResult(`c${index}`, 'weather', '{}'),
  );
  const { client, seen } = fakeClient(results);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(seen.length, 6);
  assert.strictEqual(turn.stopReason, 'max-steps');
});

test('输入 messages 不被修改', async () => {
  const { client } = fakeClient([answer('好')]);
  const input: Message[] = [{ role: 'user', content: 'hi' }];
  const snapshot = JSON.stringify(input);

  await runAgentTurn(client, fakeRegistry({}), input);

  assert.strictEqual(JSON.stringify(input), snapshot);
});

test('每次请求都带上 registry.list() 与 model', async () => {
  const { client, seenOptions } = fakeClient([answer('好')]);
  await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }], {
    model: 'deepseek-v4-pro',
  });

  assert.deepStrictEqual(seenOptions[0]?.tools, [anyTool]);
  assert.strictEqual(seenOptions[0]?.model, 'deepseek-v4-pro');
});

test('runSessionTurn：先把 user 写进会话，再组装 messages 发出去', async () => {
  const { client, seen } = fakeClient([answer('好')]);
  const session = new Session('deepseek-flash');
  session.append('user', '上一轮的话');

  await runSessionTurn(session, client, fakeRegistry({}), '本轮的话', { systemPrompt: SYSTEM_PROMPT });

  assert.deepStrictEqual(seen[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '上一轮的话' },
    { role: 'user', content: '本轮的话' },
  ]);
  assert.deepStrictEqual(session.history(), [
    { role: 'user', content: '上一轮的话' },
    { role: 'user', content: '本轮的话' },
    { role: 'assistant', content: '好' },
  ]);
});

test('runSessionTurn：本轮失败时只留下 user 那一条', async () => {
  const client: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 500: boom');
    },
  };
  const session = new Session('deepseek-flash');

  await assert.rejects(
    () => runSessionTurn(session, client, fakeRegistry({}), 'hi', { systemPrompt: SYSTEM_PROMPT }),
    /boom/,
  );

  assert.deepStrictEqual(session.history(), [{ role: 'user', content: 'hi' }]);
});

test('runSessionTurn：把 session.model 作为 per-call 参数传下去', async () => {
  const { client, seenOptions } = fakeClient([answer('好')]);
  const session = new Session('deepseek-v4-pro');

  await runSessionTurn(session, client, fakeRegistry({}), 'hi', { systemPrompt: SYSTEM_PROMPT });

  assert.strictEqual(seenOptions[0]?.model, 'deepseek-v4-pro');
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/agent.test.ts`
Expected: FAIL —— `Cannot find module '@/core/agent.ts'`

- [ ] **Step 4: 写 `src/core/agent.ts`**

```ts
// Agent 循环：把「调模型 → 执行工具 → 回喂 → 再调模型」这件事写成有界的循环。
//
// 两个函数，两种粒度：
//   runAgentTurn   —— 纯函数，只吃 messages、不改 Session，便于离线断言
//   runSessionTurn —— 薄薄一层编排，把一轮对话与 Session 的读写绑在一起
//
// **它只产出事实，不产出展示。** 本轮调了哪些工具、传了什么参、成没成功，
// 全都可以从 `added` 推导（见 presentation/transcript.ts）——
// 在这里额外返回一份「给人看的 steps」会让 agent 层的输出形状被界面需求塑形，
// 也会引入 `ms` 这类无法断言的字段。见 spec D4。

import type { ChatResult, Message, ToolResult } from '@/core/types.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { Session } from '@/core/session.ts';

/** 默认的最大步数。对应 guides「Agent 为什么会无限循环」—— 循环必须有界（spec D9） */
const DEFAULT_MAX_STEPS = 6;

/** 跑满步数时追加的提示语 */
const MAX_STEPS_NOTICE = '（已达最大步数，停止）';

/** 一轮对话的产出 —— 只有事实 */
export interface AgentTurn {
  /** 最终回答 */
  final: ChatResult;
  /** 本轮新追加的消息（assistant{tool_calls} + tool 结果 + 最终 assistant） */
  added: Message[];
  /** 循环是怎么结束的：拿到答案，还是跑满了步数 */
  stopReason: 'answered' | 'max-steps';
}

export interface AgentOptions {
  maxSteps?: number;
  /** 本次请求使用的模型；不传则由 client 用它构造时的默认值 */
  model?: string;
}

/** 解析模型给的参数串 */
function parseArguments(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // 把原文带回错误里 —— 模型据此才知道自己写歪在哪
    return { ok: false, error: `参数不是合法 JSON：${text}` };
  }
}

/** 工具结果 → 回喂给模型的那条 tool 消息的 content */
function toToolContent(result: ToolResult): string {
  if (!result.ok) return result.error;
  const json = JSON.stringify(result.value);
  // JSON.stringify(undefined) 返回 undefined 而不是字符串，
  // 而 tool 消息的 content 必须是非空字符串，否则下一轮请求 400
  return json === undefined ? 'null' : json;
}

/**
 * 跑一轮带工具的对话。
 *
 * **纯函数**：不修改传入的 `messages`，也不碰 `Session` ——
 * 要不要把 `added` 写进会话由调用方决定（见 runSessionTurn）。
 * 这样这个循环能在没有会话、没有网络的前提下被测透。
 */
export async function runAgentTurn(
  client: LLMClient,
  registry: ToolRegistry,
  messages: Message[],
  options: AgentOptions = {},
): Promise<AgentTurn> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  // 复制外层数组再往里面推，调用方的数组不受影响
  const working: Message[] = [...messages];
  const added: Message[] = [];
  const tools = registry.list();

  for (let step = 1; step <= maxSteps; step += 1) {
    const result = await client.chat(working, {
      tools,
      ...(options.model === undefined ? {} : { model: options.model }),
    });

    // 判据是 **tool_calls 是否非空**，不是 finish_reason（spec D7）。
    // 有些 OpenAI 兼容实现会在 finish_reason: 'stop' 的同时返回 tool_calls ——
    // 若看 finish_reason，就会漏调工具、把 content: null 当成最终答案
    // 回给用户（前端会显示一个空气泡），而且不报任何错。
    const toolCalls = result.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const message: Message = { role: 'assistant', content: result.content };
      working.push(message);
      added.push(message);
      return { final: result, added, stopReason: 'answered' };
    }

    // 先把「模型要调工具」这件事记进数组：下一步请求必须带上它，
    // 否则后面那条 tool 消息没有任何东西可以挂在上面，API 会直接 400
    const assistantMessage: Message = {
      role: 'assistant',
      content: result.content,
      tool_calls: toolCalls,
    };
    working.push(assistantMessage);
    added.push(assistantMessage);

    // 一轮里可能有多个调用，按序逐个执行、每个各回一条 tool 消息
    for (const call of toolCalls) {
      const parsed = parseArguments(call.function.arguments);

      let outcome: ToolResult;
      if (!parsed.ok) {
        // 参数非法**不执行工具**，直接把解析错误当成工具结果回喂 ——
        // 让模型看到自己写歪的 JSON，自行改一版
        outcome = { ok: false, error: parsed.error };
      } else {
        try {
          outcome = await registry.execute(call.function.name, parsed.value);
        } catch (error) {
          // 工具抛异常也**不崩**：兜底成错误文本（spec D8）。
          // 这是「兜底」发生的唯一一处。
          outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      const toolMessage: Message = {
        role: 'tool',
        tool_call_id: call.id,
        content: toToolContent(outcome),
      };
      working.push(toolMessage);
      added.push(toolMessage);
    }
  }

  // 跑满步数仍未收敛。追加一条**带正文的** assistant 再返回 ——
  // 不能留一条只有 tool_calls 的消息在末尾，那样的历史对 API 是非法的（spec D9）。
  const notice: Message = { role: 'assistant', content: MAX_STEPS_NOTICE };
  working.push(notice);
  added.push(notice);

  return {
    final: { content: MAX_STEPS_NOTICE, finish_reason: 'length' },
    added,
    stopReason: 'max-steps',
  };
}

/**
 * 在某个会话上跑一轮：写 user、跑循环、成功后再把结果写回会话。
 *
 * **这三行的顺序是语义，不是风格**（spec §8）：
 *
 * 1. `append('user', …)` 必须在 `toMessages()` **之前** —— 反过来的话，
 *    用户这句话根本没被发出去，而循环照样跑、照样有回答，只是答的是上一轮的问题。
 * 2. `appendAll(added)` 必须在**成功之后** —— 否则失败轮次会留下一条
 *    **伪造的 assistant 回答**（对齐 01-llm 的 D7，也是 spec §13 的「提交原子性」）。
 *
 * 为什么单独一层而不是让 HTTP 路由写这三行：路由的职责是状态码与 JSON 形状，
 * 不是对话时序。把顺序敏感的语句内联进 async handler，是把 agent 语义
 * 与 HTTP 语义搅在一起 —— 写反了不会报错，只会静默丢消息或留下伪造的回答。
 */
export async function runSessionTurn(
  session: Session,
  client: LLMClient,
  registry: ToolRegistry,
  question: string,
  options: { systemPrompt: string; maxSteps?: number },
): Promise<AgentTurn> {
  session.append('user', question);

  const turn = await runAgentTurn(client, registry, session.toMessages(options.systemPrompt), {
    model: session.model,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });

  session.appendAll(turn.added);
  return turn;
}
```

- [ ] **Step 5: 跑单文件测试**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/agent.test.ts`
Expected: 全绿（16 条）

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/core/prompt.ts demos/02-agent/apps/server/src/core/agent.ts \
        demos/02-agent/apps/server/test/agent.test.ts
git commit -m "feat(server): 新增 Agent 循环，只产出事实（final/added/stopReason）"
```

---

### Task 7: 展示投影（`presentation/transcript.ts`）

**这一层是本项目「展示层与 agent 层不交汇」这条约束的落点**（spec §1.2 第 3 条 / D4 / D18）：
它把 `Message[]` 变成给界面看的东西，而 `core/` 完全不知道它的存在。

**Files:**
- Create: `demos/02-agent/apps/server/src/presentation/transcript.ts`
- Test: `demos/02-agent/apps/server/test/transcript.test.ts`

**Interfaces:**
- Consumes: L1 的 `Message`
- Produces: `TranscriptItem`（三种 `kind`）；`foldTranscript(messages: Message[]): TranscriptItem[]`

- [ ] **Step 1: 写失败测试**

`test/transcript.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { foldTranscript } from '@/presentation/transcript.ts';

test('user 与有正文的 assistant 各自成项', () => {
  const items = foldTranscript([
    { role: 'system', content: '被跳过' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ]);

  assert.deepStrictEqual(items, [
    { kind: 'user', text: '你好' },
    { kind: 'assistant', text: '你好呀' },
  ]);
});

test('只有 tool_calls 没有正文的 assistant 不产出 assistant 项', () => {
  // 否则对话框里会多出一个空气泡（本文件 Review Focus 第 2 条）
  const items = foldTranscript([
    { role: 'user', content: '北京天气' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"temperature":"25°C"}' },
  ]);

  assert.deepStrictEqual(items, [
    { kind: 'user', text: '北京天气' },
    {
      kind: 'tool',
      name: 'weather',
      argumentsText: '{"city":"Beijing"}',
      ok: true,
      result: '{"temperature":"25°C"}',
    },
  ]);
});

test('失败的工具结果（不是合法 JSON）标记为 ok: false', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '无法计算「1/0」：除数不能为 0' },
  ]);

  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.strictEqual(tool.ok, false);
  assert.strictEqual(tool.result, '无法计算「1/0」：除数不能为 0');
});

test('配不上对的 tool_calls 产出 ok: null（半截历史）', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    },
  ]);

  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.strictEqual(tool.ok, null);
  assert.strictEqual(tool.result, '');
});

test('同一轮多个工具调用按顺序各成一项', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
        { id: 'c2', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '"25°C, Sunny"' },
    { role: 'tool', tool_call_id: 'c2', content: '"28°C, Cloudy"' },
  ]);

  const tools = items.filter((item) => item.kind === 'tool');
  assert.strictEqual(tools.length, 2);
  assert.ok(tools[0]!.kind === 'tool' && tools[0]!.argumentsText.includes('Beijing'));
  assert.ok(tools[1]!.kind === 'tool' && tools[1]!.argumentsText.includes('Shanghai'));
  assert.ok(tools[0]!.kind === 'tool' && tools[0]!.ok === true);
  assert.ok(tools[1]!.kind === 'tool' && tools[1]!.ok === true);
});

test('assistant 既有正文又有 tool_calls 时两者都不丢', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: '我查一下',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '"晴"' },
  ]);

  assert.deepStrictEqual(
    items.map((item) => item.kind),
    ['assistant', 'tool'],
  );
});

test('找不到调用单的孤儿 tool 消息被忽略', () => {
  const items = foldTranscript([{ role: 'tool', tool_call_id: 'ghost', content: '"x"' }]);
  assert.deepStrictEqual(items, []);
});

test('空历史折叠成空数组', () => {
  assert.deepStrictEqual(foldTranscript([]), []);
});

test('成功路径的字符串结果也能被认出来（JSON.stringify 出来的都是合法 JSON）', () => {
  // 工具返回一个纯字符串时，成功路径写的是 `"晴"`（带引号），仍是合法 JSON
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '"晴"' },
  ]);

  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.strictEqual(tool.ok, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/transcript.test.ts`
Expected: FAIL —— `Cannot find module '@/presentation/transcript.ts'`

- [ ] **Step 3: 写 `src/presentation/transcript.ts`**

```ts
// 把消息数组折叠成**给界面看的展示项**。
//
// 为什么要有这一层，而不是让 core 直接产出展示项：
// `Message` 是发给 API 的线格式，它按「模型需要什么」组织
// （assistant{tool_calls} 与 tool 是两条独立消息）；而界面要的是
// 「一次工具调用连它的结果」这样的一整块。两者的形状天然不同。
// 把投影放在 core 之外，agent 层就不必为了界面多返回任何字段（spec D4）。
//
// 实时路径（本轮新增）与历史路径（读回整段会话）共用这一个函数（spec D18）——
// 前端因此只需要一套渲染逻辑。
//
// 它**不 import http/**：这一层不知道 HTTP 存在，只认 Message。

import type { Message } from '@/core/types.ts';

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** 模型给的原始 JSON 字符串 */
      argumentsText: string;
      /** true=成功，false=失败，**null=没等到结果**（半截历史） */
      ok: boolean | null;
      result: string;
    };

/**
 * 判断一条 tool 消息是成功还是失败。
 *
 * 依据是一个**不变量**：成功路径的结果一定经过 `JSON.stringify`
 * （见 core/agent.ts 的 toToolContent），所以一定是合法 JSON；
 * 失败路径回的是人写的错误文本，解析必然失败。
 *
 * 之所以要这样反推而不是在消息里存一个标记位 —— `Message` 是发给 API 的
 * 线格式，多一个字段就是给上游发未知字段。宁可在这里多一层判断。
 *
 * **代价**：界面因此分不出「参数 JSON 非法」与「工具执行失败」。
 * 这是有意接受的 —— 两者的错误文本本身就写着原因
 * （`参数不是合法 JSON：{city: Beijing` vs `无法计算「1/0」：除数不能为 0`）。
 */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function foldTranscript(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  /** 已产出但还没等到结果的工具项，按 tool_call_id 索引到 items 里的下标 */
  const pending = new Map<string, number>();

  for (const message of messages) {
    // system 不在 Session 里（每次请求现加），这里只是防御性地跳过
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      items.push({ kind: 'user', text: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content !== null && message.content !== '') {
        items.push({ kind: 'assistant', text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        items.push({
          kind: 'tool',
          name: call.function.name,
          argumentsText: call.function.arguments,
          // 先占位成「没等到结果」，等后面的 tool 消息来把它改掉
          ok: null,
          result: '',
        });
        pending.set(call.id, items.length - 1);
      }
      continue;
    }

    // tool 消息：把结果填回它对应的那一项
    const index = pending.get(message.tool_call_id);
    if (index === undefined) continue; // 找不到调用单的孤儿 tool 消息，忽略
    const existing = items[index];
    if (!existing || existing.kind !== 'tool') continue;
    items[index] = { ...existing, ok: isJson(message.content), result: message.content };
    pending.delete(message.tool_call_id);
  }

  return items;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/transcript.test.ts`
Expected: 全绿（9 条）

- [ ] **Step 5: 确认这一层没有向上依赖**

Run:
```bash
cd demos/02-agent/apps/server
grep -rn "express\|req\.\|res\." src/presentation/ src/core/ src/llm/ src/tools/ || echo "干净：没有任何一层碰到 express / req / res"
grep -rn "process\.stdout\|process\.stderr" src/presentation/ src/core/ src/llm/ src/tools/ || echo "干净：没有任何一层写 stdout/stderr"
grep -rn "@/http/" src/presentation/ src/core/ src/llm/ src/tools/ || echo "干净：没有向上依赖 http/ 的导入"
grep -rn "from '@/tools/" src/core/ || echo "干净：core 不 import tools"
```
Expected: 四条都输出「干净」

再**人工看一眼** `core/types.ts` 与 `core/agent.ts` 导出的全部类型与字段：
有没有 `index` / `ms` / `ok` / `text` / `bubble` 这类只有界面才用得上的东西？
判据就是 spec §1.2 第 3 条那句：**删掉这个字段，浏览器上的东西会不会少一块？会，它就该在
`presentation/` 里**。这一条没法用 grep 自动查，但它是本项目最重要的结构决定，
所以必须有人真的看一遍并在提交信息或 PR 描述里写下结论。

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/presentation demos/02-agent/apps/server/test/transcript.test.ts
git commit -m "feat(server): 新增展示投影层，实时与历史路径共用 foldTranscript"
```

---

## L4 的验证：你这一步看见了什么

1. **跑全量门**：

   ```bash
   cd demos/02-agent
   pnpm run typecheck && pnpm test
   ```
   Expected: 全绿（TypeCheck 0；Test `# fail 0`）。

2. **让真模型跑一次多步循环** —— 临时脚本 `apps/server/scratch.ts`：

   ```ts
   // 临时脚本：看 agent 循环跑起来，以及它产出的展示项。看完就删。
   import { resolveConfig } from '@/llm/config.ts';
   import { createDeepSeekClient } from '@/llm/deepseek.ts';
   import { createToolRegistry } from '@/tools/registry.ts';
   import { runAgentTurn } from '@/core/agent.ts';
   import { foldTranscript } from '@/presentation/transcript.ts';
   import { SYSTEM_PROMPT } from '@/core/prompt.ts';

   const turn = await runAgentTurn(
     createDeepSeekClient(resolveConfig(process.env)),
     createToolRegistry(),
     [
       { role: 'system', content: SYSTEM_PROMPT },
       { role: 'user', content: '北京今天天气怎么样？' },
     ],
   );

   process.stdout.write(`停止原因：${turn.stopReason}\n`);
   process.stdout.write(`本轮新增 ${turn.added.length} 条消息：\n`);
   for (const message of turn.added) {
     process.stdout.write(`  ${message.role}\n`);
   }
   process.stdout.write('折叠成展示项：\n');
   process.stdout.write(JSON.stringify(foldTranscript(turn.added), null, 2) + '\n');
   ```

   Run:
   ```bash
   cd demos/02-agent/apps/server
   node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs scratch.ts
   ```
   Expected: 看到类似

   ```text
   停止原因：answered
   本轮新增 3 条消息：
     assistant      ← 只有 tool_calls，没有正文
     tool
     assistant      ← 最终回答
   折叠成展示项：
   [ { "kind": "tool", "name": "weather", "argumentsText": "{\"city\":\"Beijing\"}",
       "ok": true, "result": "..." },
     { "kind": "assistant", "text": "北京今天 25°C，晴天。" } ]
   ```

   **注意展示项里只有 2 项，而 `added` 有 3 条消息** —— 那条「只有 tool_calls 的 assistant」
   没有变成空气泡，它的信息变成了前面那个 `tool` 项。这就是 Task 7 存在的意义。

   看完**删掉它**：`rm scratch.ts`。

3. **亲手验证「循环必须有界」**：把 `runAgentTurn` 的 `DEFAULT_MAX_STEPS` 改成 `1`，
   再跑上面的脚本，问一个需要两步的问题（例如「北京和上海哪个热？」）。
   Expected: `停止原因：max-steps`，最后一条是「（已达最大步数，停止）」。
   看完改回 `6`。

**下一步** → [`l5-http-server.md`](./2026-09-25-l5-http-server.md)：给这套核心套上 HTTP 边界 ——
会话状态、串行锁、错误映射，让它变成一个能 `curl` 的服务。
