# L3 · 接上模型（LLM 层） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**这是渐进步骤的第 3 步（共 6 步）。** 顺序与判据见 [`README.md`](./README.md)。
**前置：L1、L2 已完成**（类型契约已就位，工具层已跑通）。

**Goal:** 重写 `llm/deepseek.ts` —— 让它**按线上的包装层级**发送 `tools`、并**解析并校验**响应里的 `tool_calls` 与 `finish_reason`；同时删掉全部流式代码。做完这一步，**L2 里你手写的那张调用单，改由模型开出来**。

**这一步学到什么：**

1. **`tools` 发出去的形状，与内部用的形状不是一回事。** 内部是扁平的 `{name, description, parameters}`，线上要再包一层 `{type:'function', function:{…}}`。少包一层上游直接 400，而**报错不会提到「少包了一层」** —— 所以这个层级必须由一条测试钉住。
2. **`tool_calls` 的每一项都得逐字段校验。** `id` 缺失会变成 `tool_call_id: undefined`，`JSON.stringify` 时键被丢掉，下一轮请求 400，而报错完全不指向真正的原因。策略是「丢弃非法项、保留合法项」。
3. **`content` 为 `null` 是正常的。** 工具调用轮次里模型可能一个字都不说。兜底成 `''` 会让「模型说了空话」与「模型没说话」无法区分。

**Architecture:** `llm/` 是最底层，只依赖 `core/` 的类型，**不打印任何东西**（保持安静才能在测试里被反复调用）。`chat()` 每次都重新构造请求体：`tools` 非空才带该字段 —— 部分 OpenAI 兼容实现会对 `tools: []` 直接 400，而「传了一个空列表」与「这次不传工具」语义上本来就是一回事。

**Tech Stack:** Node 22 的全局 `fetch`，无第三方 HTTP 库。

**Spec:** `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 §10（LLM 层）、§16（需在实施时核实的一点）；D5（不做流式）、D20（不自动重试）

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
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿。

  **✅ 本步起这条约束不再有例外。** L1 与 L2 期间那条一直红着的
  `src/llm/deepseek.ts`（它 `import { parseSse } from '@/llm/sse.ts'`，而 `sse.ts` 按设计没复制过来）
  **就是本步要重写的文件**。做完 Task 5，`pnpm test` 与 `pnpm run typecheck` 都应当第一次全绿。
  **如果那时还红，说明本步没做完。**

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。
**本步相关的一条：**

1. **`tools` 数组元素的包装层级** —— 内部扁平、线上要包一层。少包一层上游 400，
   而报错不指向原因。期望行为：`{type:'function', function:{name, description, parameters}}`。
   测试落点：Task 5 Step 4 的 `带 tools 时请求体按线上的包装层级发送`。
   **这条测试钉住的是一个假设** —— 所以 Step 1 必须先向官方文档核实（spec §16）。

---

### Task 5: LLM 层——去流式、发 tools、解析 tool_calls

只动 `llm/deepseek.ts` 与它的测试。**这一步同时清掉 L1 / L2 一直挂着的那条红。**

**Files:**
- Modify: `demos/02-agent/apps/server/src/llm/deepseek.ts`
- Test: `demos/02-agent/apps/server/test/deepseek.test.ts`

**Interfaces:**
- Consumes: L1 的 `ToolCall` / `Tool` / `ChatOptions.tools` / `ChatResult`
- Produces: `createDeepSeekClient(config): LLMClient` —— 只实现 `chat()`、按**线上包装层级**发送 `tools`、
  正确解析并校验 `tool_calls`；私有函数 `toWireTools(tools)` / `normalizeToolCalls(value)`

- [ ] **Step 1: 核实 DeepSeek 工具调用的确切线上格式**

**这一步不能跳。** spec §16 明确要求「实施时对照 DeepSeek 官方文档再核一遍确切字段名」——
因为下面 Step 4 会写一个**逐字断言包装层级**的测试，一旦层级搞错，那个测试会把错误假设固化下来，
而**上游 400 的报错不会提到「少包了一层」**。

按顺序做三件事，把结论写进 Step 2 代码块的对应注释里：

1. 读本仓库已确认的事实：`demos/01-llm/docs/deepseek-api-facts.md`
   （已确认 `tool` 角色与 `tool_calls` finish_reason 存在）
2. 对照 DeepSeek 官方文档的 Function Calling 一节，确认这四点：
   - 请求体 `tools` 数组元素是不是 `{ type: 'function', function: { name, description, parameters } }`
   - 响应里是 `message.tool_calls`，元素含 `id` / `type` / `function.name` / `function.arguments`
   - `arguments` 是 **JSON 字符串**（不是对象）
   - 回喂时用 `role: 'tool'` + `tool_call_id`
3. 若官方文档与本计划的形状**不一致**，**停下来告诉人**，不要擅自改代码去迁就文档 ——
   spec §5 与 §10 的类型契约要同步改，那是设计层面的决定，不是实施细节。

Run（官方文档）：
```bash
open https://api-docs.deepseek.com/api/create-chat-completion
```

**注意用哪个页面**：`guides/function_calling` 那个快速开始页**没有**这些内容
（2026-09-26 实测：它只有非流式对话示例，请求体字段只列了 `model` / `messages` / `thinking` /
`reasoning_effort` / `stream`，通篇没有 `tools`）。四点全在 **API Reference 的
Create Chat Completion** 页上。

Expected: 四点全部确认。**在 Step 2 的 `toWireTools` 注释里写一行「已核实（日期）：……」，**
留下核实的痕迹。

- [ ] **Step 2: 重写 `src/llm/deepseek.ts`**

整个文件替换为：

```ts
// DeepSeek 的具体实现：把「消息数组」变成一次 HTTP 请求。
//
// 属于 llm 层（最底层），只依赖 core 的类型。
// 这一层**不打印任何东西**——打印不属于它，它保持安静才能在测试里被反复调用。
//
// 本文件是从 01-llm 复制过来的那个版本**重写**的结果：
// 复制版 import 了没被复制过来的 `@/llm/sse.ts`，在本步之前一直是红的。
// 这次改动删掉了全部流式代码（chatStream / 空闲超时 / SSE 解析，见 spec D5）：
// 本项目不做流式，而下个里程碑做「流式 + 工具」时，分片 tool_calls 的拼接
// 本来就要另写一套，留着只是重写前的负担。
//
// 仍然成立的取舍：**不读** `reasoning_content`（见下方 chat() 内的注释）。

import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type { ChatOptions, Message, ChatResult, FinishReason, Tool, ToolCall } from '@/core/types.ts';

/**
 * 内部扁平的工具声明 → 线上的包装层级。
 *
 * 这两层形状是**故意不一样**的：
 *   - 线上的 `tools` 数组元素是 `{ type: 'function', function: { … } }`（OpenAI 约定）
 *   - 而 `core/types.ts` 里的 `Tool` 是扁平的 `{ name, description, parameters }`
 *
 * 内部保持扁平，是因为调用方（tools/registry.ts）只关心「这个工具叫什么、要什么参数」，
 * 外面那层 `type: 'function'` 目前只有一种取值、纯粹是协议规定的封装。
 * 把包装收敛在这一个函数里，将来协议变了只改这里。
 *
 * **已核实（2026-09-26，对照 DeepSeek API Reference 的 Create Chat Completion 页）**：
 * 线上层级确为 `{ type: 'function', function: { name, description, parameters } }`。
 * （另有 beta 的 `strict` 字段，我们不发。）响应侧是 `message.tool_calls`，元素含
 * `id` / `type` / `function.name` / `function.arguments`，且 `arguments` 是 JSON **字符串**；
 * 回喂用 `role: 'tool'` + `tool_call_id`。
 *
 * **不要图省事直接把 options.tools 发出去** —— 上游会 400 说结构不对，
 * 而报错信息里不会提到「少包了一层」。
 */
function toWireTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * 把响应里的 `tool_calls` 归一化成 `ToolCall[]`。
 *
 * 策略是**丢弃非法项、保留合法项**：模型给出的东西尽量用上，
 * 丢一条总比整轮不调工具强。
 *
 * 为什么必须校验：`id` 缺失会变成 `tool_call_id: undefined`，
 * `JSON.stringify` 时键被丢掉，下一轮请求直接 400，
 * 而那个报错信息完全不指向真正的原因。
 */
function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];

  const calls: ToolCall[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const call = item as Record<string, unknown>;
    const fn = call.function;
    if (typeof call.id !== 'string') continue;
    if (typeof fn !== 'object' || fn === null) continue;
    const fnRecord = fn as Record<string, unknown>;
    if (typeof fnRecord.name !== 'string' || typeof fnRecord.arguments !== 'string') continue;

    calls.push({
      id: call.id,
      // type 归一化为 'function'：官方目前只有这一种，
      // 原样透出未知取值只会让下游多一层无意义的判断
      type: 'function',
      function: { name: fnRecord.name, arguments: fnRecord.arguments },
    });
  }
  return calls;
}

/**
 * 造一个调用 DeepSeek 接口的客户端。
 *
 * 它**无状态**（只持有 url 与 headers 两个闭包常量），所以一个实例
 * 可以被多个会话共享；「当前模型」随请求传（见 core/types.ts 的 ChatOptions）。
 */
export function createDeepSeekClient(config: LLMClientConfig): LLMClient {
  const url = `${config.baseUrl}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    // 鉴权：Bearer + API key。key 只来自环境变量，不落代码
    authorization: `Bearer ${config.apiKey}`,
  };

  return {
    async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
      // 用 Node 内置的 fetch，无需任何第三方 HTTP 库
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // 有工具才带 tools 字段。**空数组按「不带」处理** ——
        // 部分 OpenAI 兼容实现会对 `tools: []` 直接 400，
        // 而「传了一个空列表」与「这次不传工具」在语义上本来就是一回事。
        //
        // 其余字段（temperature / thinking 等）跟随服务端默认值，不额外发送。
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          ...(options?.tools && options.tools.length > 0
            ? { tools: toWireTools(options.tools) }
            : {}),
        }),
      });

      // 非 2xx（如 401 密钥错误、429 限流）统一当作失败抛出，
      // 交给调用方决定怎么显示。这一层不做自动重试（见 spec D20）。
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          // DeepSeek 的错误体是 JSON（形如 { error: { message } }），
          // 优先取出里面给人看的那句话；取不到就退回原始文本。
          // 官方未给出错误响应体的字段名，所以必须防御式处理。
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        // 抛裸 Error，消息里带状态码 —— HTTP 层靠这个前缀区分「上游返回了错误」
        // 与「连不上上游」（见 L5 的 http/errors.ts）
        throw new Error(`DeepSeek API error ${response.status}: ${detail}`);
      }

      // 响应形状大致是：
      // { choices: [ { message: { content, reasoning_content, tool_calls }, finish_reason } ] }
      const data = (await response.json()) as {
        choices: Array<{
          message?: { content?: string | null; tool_calls?: unknown };
          finish_reason?: string | null;
        }>;
      };
      const choice = data.choices[0];

      // 工具调用轮次里模型可能一个字都不说，content 缺省或为 null 都是正常的。
      // 这里把「没有正文」如实表示成 null，而不是兜底成 '' ——
      // 空串会让调用方分不清「模型说了空话」和「模型没说话只开了调用单」。
      //
      // 另外：刻意**不读** reasoning_content（模型的思考过程）。它通常比答案长得多，
      // 带进后续上下文既浪费 token 又可能干扰推理（对齐 01-llm 的 D6 / D22）。
      const content = choice?.message?.content ?? null;
      const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);

      // finish_reason 缺失时按 stop；宽松处理，服务端新增取值时原样传出，不做白名单校验
      const finish_reason = (choice?.finish_reason ?? 'stop') as FinishReason;

      return {
        content,
        finish_reason,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    },
  };
}
```

- [ ] **Step 3: 瘦身 `test/deepseek.test.ts`**

先跑一遍看现状：

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: 失败 —— 主要是 `chatStream` 不再存在（23 条用例里有 19 行碰它）。
另有个别用例传了第二个参数（`idleTimeoutMs`），而新的 `createDeepSeekClient` 只接受一个。

**删除所有 `chatStream` 相关的用例**（用 `grep -n "chatStream\|空闲超时\|SSE\|delta\|DONE" test/deepseek.test.ts` 找齐）。
它们测的能力本项目整体砍掉了，留着只能是死代码。

**删除 `mockFetch` 的流式分支与 `ReadableStream` 相关的辅助函数**（若它们只被上面的用例用到）。

**同时删掉文件顶部的 `import type { StreamEvent } from '@/core/types.ts'`** ——
它只被流式用例用到，而 `StreamEvent` 在 L1 已被删除，留着必然 TS2307。

**改这一条**：`content 缺失时返回空串不崩溃` → 语义变了，改名并改断言：

```ts
test('content 缺失或为 null 时返回 null，而不是空串', async () => {
  mockFetch(async () => jsonResponse({ choices: [{ message: {}, finish_reason: 'stop' }] }));
  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(result.content, null, '兜底成空串会让「说了空话」与「没说话」无法区分');
});
```

**保留**这 7 条：`请求体包含 model 和 messages`、`成功时返回 content，抑制 reasoning_content`、
`非 2xx 抛出错误`、`fetch 抛错时向上冒泡，不被吞掉`、`错误体不是 JSON 时回落为原始文本`、
`options.model 覆盖构造时的默认模型`、`不传 options.model 时回落构造时的默认模型`。

⚠️ **其中 `成功时返回 content，抑制 reasoning_content` 有一条断言必须改**（本计划原先写的是
「保留不动」，那是错的）：它断言的是 `assert.deepEqual(result, { content: '最终回答' })`，
而新的 `ChatResult` 多了 `finish_reason` 字段（这条用例的响应没给 `finish_reason`，
所以实际返回值是 `{ content: '最终回答', finish_reason: 'stop' }`）——
整对象 `deepEqual` 会因为多出的键而失败。改成
`assert.deepEqual(result, { content: '最终回答', finish_reason: 'stop' })` 即可，
整对象断言反而更好：它同时证明了 `reasoning_content` 没被带出来。其余 6 条确实一字未动。

- [ ] **Step 4: 追加新用例**

在 `test/deepseek.test.ts` 末尾追加：

```ts
test('带 tools 时请求体按线上的包装层级发送（type/function 两层）', async () => {
  let body: Record<string, unknown> = {};
  mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], {
    tools: [
      {
        name: 'weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
  });

  // 少包一层上游会 400 说 tools 结构不对，而报错不会提到「少包了一层」。
  // 这条断言依赖 Step 1 的核实结论 —— 它是**假设的固化**，不是独立验证。
  assert.deepStrictEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ]);
});

test('tools 为空数组时不发送该字段', async () => {
  let body: Record<string, unknown> = {};
  mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], { tools: [] });

  assert.ok(!('tools' in body), '空数组在部分 OpenAI 兼容实现上会 400，必须不发');
});

test('解析 tool_calls 与 finish_reason', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Beijing"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: '北京天气' }]);

  assert.strictEqual(result.content, null);
  assert.strictEqual(result.finish_reason, 'tool_calls');
  assert.deepStrictEqual(result.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
  ]);
});

test('finish_reason 缺失时回落 stop', async () => {
  mockFetch(async () => jsonResponse({ choices: [{ message: { content: '好' } }] }));

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.finish_reason, 'stop');
});

test('tool_calls 里混入一条坏的：丢掉坏的、保留好的', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'broken' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.tool_calls?.length, 1);
  assert.strictEqual(result.tool_calls?.[0]?.id, 'c1');
});

test('tool_calls 全是坏的：当作没有 tool_calls', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [{ message: { content: '好', tool_calls: [{ id: 1 }] }, finish_reason: 'stop' }],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.tool_calls, undefined);
});

test('没有 tool_calls 时不带该字段', async () => {
  mockFetch(async () =>
    jsonResponse({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.ok(!('tool_calls' in result));
});
```

**`mockFetch` 不要改签名。** 复制过来的 `test/deepseek.test.ts` 顶部已经有这两个辅助函数，
它们就是上面用到的样子（实测确认）：

```ts
function mockFetch(
  handler: (url: string, init: Parameters<typeof fetch>[1]) => Promise<Response>,
) {
  globalThis.fetch = handler as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

**handler 形状**意味着「怎么响应」由每个用例自己决定 ——
要断言请求体的用例在 handler 里先捕获 `init` 再返回响应，
不需要请求体的用例直接 `async () => jsonResponse(...)`。
**保留的那 7 条用例也是这个用法**，所以加新用例不需要动它们一行。

- [ ] **Step 5: 跑单文件测试**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: 全绿（7 保留 + 1 改名 + 7 新增 = 15 条）

- [ ] **Step 6: 全量验证 —— L1 起一直挂着的那条红应当在这里消失**

Run:
```bash
cd demos/02-agent
pnpm run typecheck
pnpm test
```
Expected: **两条都第一次全绿**。typecheck 退出码 0，测试全绿。

**若 typecheck 还报 TS2307 指向 `@/llm/sse.ts`**：说明 `deepseek.ts` 没被真正替换掉
（旧版还在 import 它）。回去看 Step 2 是不是整个文件替换的。

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/llm/deepseek.ts demos/02-agent/apps/server/test/deepseek.test.ts
git commit -m "feat(server): llm 层去流式、按线上层级发送 tools、解析并校验 tool_calls"
```

---

## L3 的验证：你这一步看见了什么

1. **全量门第一次全绿**：

   ```bash
   cd demos/02-agent
   pnpm run typecheck && pnpm test
   ```
   Expected: typecheck 退出码 0；`# fail 0`。
   **这是 L1 以来第一次** —— 从这一刻起 Global Constraints 那条约束不再有例外。

2. **让模型真开一张单** —— 用 `.env.local` 里的真 key 发一次真实请求。
   **这一步单独跑，不进 `pnpm test`**（Global Constraints 的规矩）。

   先写一个**临时**脚本 `apps/server/scratch.ts`：

   ```ts
   // 临时脚本：验证「模型真能开出一张调用单」。看完就删，不要提交。
   import { resolveConfig } from '@/llm/config.ts';
   import { createDeepSeekClient } from '@/llm/deepseek.ts';
   import { createToolRegistry } from '@/tools/registry.ts';

   const client = createDeepSeekClient(resolveConfig(process.env));
   const registry = createToolRegistry();

   const result = await client.chat(
     [{ role: 'user', content: '北京今天天气怎么样？' }],
     { tools: registry.list() },
   );

   process.stdout.write(JSON.stringify(result, null, 2) + '\n');
   ```

   Run:
   ```bash
   cd demos/02-agent/apps/server
   node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs scratch.ts
   ```
   Expected: 打印出 `tool_calls`，且 `arguments` 形如 `{"city":"Beijing"}`。
   **这就是 L2 里你手写的那张单子 —— 现在它是模型开的。**

   注意 `content` 很可能是 `null`：模型这一轮没说话，只开了调用单。这是正常的。

   看完**删掉它**：`rm scratch.ts`。

4. **对照 L2 的切片**：L2 的 ② 里你手写了 `arguments: '{"city":"Beijing"}'`；
   现在同一个字段由模型生成。两者形状完全一致 —— 说明 L2 那条链路的设计是对的。

**下一步** → [`l4-agent-loop.md`](./2026-09-25-l4-agent-loop.md)：把「开单 → 执行 → 回喂」
包进一个**有界的循环**，让模型自己决定要不要接着调、什么时候停。
