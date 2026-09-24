# ai-chat M2a（streaming）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让回答逐字到达终端，而不是等完整响应后一次性打印；并让「本次用哪个模型」成为每次请求的参数，为 M2b 的 `/model` 铺路。

**Architecture:** 新增 `llm/sse.ts`（纯函数的 SSE 分帧）与 `cli/render.ts`（`StreamEvent` → stdout/stderr 的呈现）。`LLMClient` 增加 `chatStream()`，与既有 `chat()` 并存、各自独立实现。`TextDecoder({stream:true})` 在 `deepseek.ts` 逐块解码，**分帧在字符串层**做。分层与依赖方向（`cli → core → llm`）不变。

**Tech Stack:** Node 22（原生 TS 类型擦除）、pnpm、`node --test`、原生 `fetch` + `ReadableStream`、`AbortController`。零运行时依赖。

**Spec:** `demos/01-llm/docs/superpowers/specs/2026-09-24-ai-chat-m2-design.md`（本计划实现其 §3 D-M2-1 ~ D-M2-7、§7、§8、§9、§11）

**配套计划:** `2026-09-24-ai-chat-m2b-commands.md`（命令层）。**本次先做 M2a** —— 它落地两个计划共用的接口改动（`ChatOptions` + `Session` 的模型字段），M2b 直接复用。

## Global Constraints

- Node ≥ 22（本项目在 **v22.23.2** 验证）；**不引入构建步骤**
- ESM（`"type": "module"`）；包管理器 pnpm
- **零运行时依赖**；devDependency 仅 `typescript` + `@types/node`
- 分层单向：`cli → core → llm`；`llm` / `core` **不 import `node:readline`、不写 `process.stdout` / `process.stderr`**
- 源码用 `@/` 指向 `src/`；`start` / `test` 脚本**都**必须带 `--import ./loader.mjs`
- 单文件跑测试也必须带 loader：`node --import ./loader.mjs --test test/<name>.test.ts`
- **不在 `test/` 下放非 `*.test.ts` 的文件** —— 实测 `node --test` 会把 `test/` 下任何 `.ts` 当测试跑并计入用例数
- 密钥只经环境变量；所有验证命令在 `demos/01-llm/` 下执行
- 测试**不依赖真实网络**

## 起点状态（执行前请自行确认）

```text
TypeCheck: 退出码 0
Test:      16/16 通过
            config 3 / deepseek 6 / index 1 / repl 4 / session 2
```

## Review Focus

1. **`pnpm --silent start > answers.txt`** → 文件里只有回答，**无** `[思考中…]`、无 `[error]`
2. **一轮对话的终端形状不能被这次改动破坏**：仍是 `You: 问` / `AI: 答` 交替 ——
   `AI: ` 前缀由渲染器在**第一段正文之前**写出（见 Task 5），`You: ` 提示符仍在每次读取之前写。
   **这是 M1 刚修好的东西（`DECISIONS.md` D15），流式实现极易把它丢掉**：
   直接 `output.write(event.text)` 就会让前缀再次消失，且 M1 的三个逐字节断言会立刻变红。
3. **多字节字符不被切断**：长中文回答逐字出现时无乱码（`TextDecoder({stream:true})` 生效）
4. **`chat()` 与 `chatStream()` 的请求体差异**：`chat()` 不含 `stream`，`chatStream()` 含 `stream: true`，**两者都不含 `stream_options`**
5. **末 chunk 的 `finish_reason` 触发 `done`**，且该 chunk 携带的 `usage` 被忽略而不报错
6. **半截答案不进上下文**：流中途失败后，下一轮 `messages` 里没有那条失败的回答
7. **回归**：`config` 与 `index` 两个测试文件完全不用改；
   **`repl.test.ts` 里三个逐字节断言（`'You: AI: …'`）必须继续通过** —— 它们是这次改动是否退化的探针

---

### Task 1: 新增流式相关类型

**Files:**
- Modify: `demos/01-llm/src/core/types.ts`（在文件末尾追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'insufficient_system_resource' | 'aborted'`
  - `type StreamEvent = { type: 'text-delta'; text: string } | { type: 'reasoning-delta'; text: string } | { type: 'done'; reason: FinishReason }`
  - `interface ChatOptions { model?: string }`

> 纯类型新增，**不破坏任何现有代码**，因此本任务没有测试，只做类型检查。这与 M1 计划 Task 1/2 对纯类型文件的处理一致。

- [ ] **Step 1: 在 `src/core/types.ts` 末尾追加**

```ts
/**
 * 模型停止生成的原因，取自服务端的 `finish_reason`。
 *
 * 联合类型是**宽松**的：服务端新增取值时，解析侧不做白名单校验，
 * 原样传出即可——未知取值不该让客户端崩掉。
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'aborted';

/**
 * 流式响应归一化后的事件。
 *
 * llm 层把「DeepSeek/OpenAI 的 SSE chunk」翻译成这三种事件，
 * cli 层只认这三种，不知道 SSE 的存在。
 *
 * 注意：**没有 `usage` 事件**。Token 统计属于 M4，现在解析了也没有消费者，
 * 与其定义一个没人用的 `TokenUsage` 并连带写测试，不如等 M4 一起做。
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'done'; reason: FinishReason };

/**
 * 一次请求的可选参数。
 *
 * 这些是「这一轮请求」的属性，不是 client 的身份——所以随请求传，
 * 而不是塞进 `LLMClientConfig` 让 client 变成有状态的。
 * 「当前模型」存在 `Session` 里（见 `core/session.ts`）。
 */
export interface ChatOptions {
  /** 本次请求使用的模型；不传则由 client 用它构造时的默认值 */
  model?: string;
}
```

- [ ] **Step 2: 跑类型检查**

Run: `pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 3: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（16/16，数量不变）

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add streaming types (StreamEvent, ChatOptions)"
```

---

### Task 2: SSE 分帧（纯函数）

**Files:**
- Create: `demos/01-llm/src/llm/sse.ts`
- Test: `demos/01-llm/test/sse.test.ts`

**Interfaces:**
- Consumes: 无（不依赖任何项目内模块）
- Produces:
  - `interface SseEvent { event: string; data: string }`
  - `function parseSse(chunk: string, buffer?: string): { events: SseEvent[]; rest: string }`

> **为什么这一段单独成任务**：分帧是 M2 最容易错、最需要测透的地方（一条事件可能被 TCP 切成两次 `read()`，一次 `read()` 可能含多条事件）。做成纯函数才能用「喂字符串、断言字符串」把它测穿。
>
> **`parseSse` 只懂 SSE 协议，不懂 DeepSeek**。`data === '[DONE]'` 对它就是一条普通事件，含义由 `deepseek.ts` 解释（Task 4）。`event: message` 是缺省值。
>
> **换行规范化的顺序很关键**：必须先 `buffer + chunk` 拼接**再**把 `\r\n` 规范化成 `\n`。若先规范化 `buffer`，尾部一个落单的 `\r` 无法判断它是否与下一块的 `\n` 成对。

- [ ] **Step 1: 写失败测试 `test/sse.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from '@/llm/sse.ts';

test('一次 chunk 含多个完整事件', () => {
  const { events, rest } = parseSse('data: a\n\ndata: b\n\n');
  assert.deepEqual(events, [
    { event: 'message', data: 'a' },
    { event: 'message', data: 'b' },
  ]);
  assert.equal(rest, '');
});

test('一条事件被切成两次 chunk', () => {
  const first = parseSse('data: he');
  assert.deepEqual(first.events, []);
  assert.equal(first.rest, 'data: he');

  const second = parseSse('llo\n\n', first.rest);
  assert.deepEqual(second.events, [{ event: 'message', data: 'hello' }]);
  assert.equal(second.rest, '');
});

test('尾部半条事件进 rest，不产出事件', () => {
  const { events, rest } = parseSse('data: 完整\n\ndata: 未完');
  assert.deepEqual(events, [{ event: 'message', data: '完整' }]);
  assert.equal(rest, 'data: 未完');
});

test('\\r\\n 换行等价处理，且 \\r\\n 被切在两次 chunk 之间也能拼回', () => {
  assert.deepEqual(parseSse('data: a\r\n\r\n').events, [{ event: 'message', data: 'a' }]);

  // \r 与 \n 分属两个 chunk —— 这是最容易写错的边界
  const first = parseSse('data: a\r');
  const second = parseSse('\n\r\n', first.rest);
  assert.deepEqual(second.events, [{ event: 'message', data: 'a' }]);
});

test('注释行（keep-alive）被忽略', () => {
  const { events, rest } = parseSse(': keep-alive\n\ndata: a\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'a' }]);
  assert.equal(rest, '');
});

test('同一事件的多行 data 用 \\n 拼接', () => {
  const { events } = parseSse('data: 第一行\ndata: 第二行\n\n');
  assert.deepEqual(events, [{ event: 'message', data: '第一行\n第二行' }]);
});

test('data: 后的一个可选空格被剥掉，多余空格保留', () => {
  assert.deepEqual(parseSse('data: a\n\n').events, [{ event: 'message', data: 'a' }]);
  assert.deepEqual(parseSse('data:a\n\n').events, [{ event: 'message', data: 'a' }]);
  assert.deepEqual(parseSse('data:  a\n\n').events, [{ event: 'message', data: ' a' }]);
});

test('event: 字段作为事件名，缺省 message', () => {
  const { events } = parseSse('event: ping\ndata: x\n\n');
  assert.deepEqual(events, [{ event: 'ping', data: 'x' }]);
});

test('id: / retry: 等其他字段被忽略', () => {
  const { events } = parseSse('id: 42\nretry: 100\ndata: x\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'x' }]);
});

test('没有 data 的块不产出事件（只有注释、只有 event:）', () => {
  assert.deepEqual(parseSse(': 只有注释\n\n').events, []);
  assert.deepEqual(parseSse('event: ping\n\n').events, []);
});

test('[DONE] 只是一条普通事件，含义由调用方解释', () => {
  const { events } = parseSse('data: [DONE]\n\n');
  assert.deepEqual(events, [{ event: 'message', data: '[DONE]' }]);
});

test('空输入与连续空行不崩', () => {
  assert.deepEqual(parseSse(''), { events: [], rest: '' });
  assert.deepEqual(parseSse('\n\n\n\n').events, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/sse.test.ts`
Expected: FAIL —— `Cannot find package '@/llm'`（模块还不存在）

- [ ] **Step 3: 实现 `src/llm/sse.ts`**

```ts
// SSE（Server-Sent Events）分帧：把字节流切下来的**字符串块**切成一条条事件。
//
// 这一层只懂 SSE 协议本身，**不懂 DeepSeek / OpenAI**：
// `data: [DONE]` 对它就是一条 `data` 为 "[DONE]" 的普通事件，含义由调用方解释。
//
// 为什么是纯函数：SSE 按字节到达，一条事件可能被 TCP 切成两次 read()，
// 一次 read() 也可能含多条事件。用「传入残余缓冲、返回新残余」的纯函数形态，
// 这套最容易出错的逻辑就能用「喂字符串、断言字符串」测透，
// 而不必去构造假的可读流。

/** 一条 SSE 事件 */
export interface SseEvent {
  /** `event:` 字段的值；缺省为 'message' */
  event: string;
  /** 该事件的 `data:` 内容（多行 data 已按规范用 \n 拼接） */
  data: string;
}

/** SSE 规范里没有 `event:` 字段时的事件名 */
const DEFAULT_EVENT = 'message';

/**
 * 解析一个事件块（已被空行分隔出来的那一段）。
 *
 * @returns 有 data 才返回事件；只有注释或其他字段的块返回 null
 */
function parseBlock(block: string): SseEvent | null {
  let event = DEFAULT_EVENT;
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    // 空行不该出现在块内；':' 开头是注释（服务端用它做 keep-alive）
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    // 没有冒号的行按规范是「字段名 + 空值」。本项目用不到这种形态，直接忽略。
    // 注意：`data`（无冒号）真实含义是「data 为空串」，这里不实现该分支。
    if (colon === -1) continue;

    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    // 规范：冒号后若紧跟一个空格，该空格是分隔符，要剥掉；多余空格属于数据
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id / retry 等其他字段本项目用不到，忽略
  }

  // 规范：data 缓冲为空的块不 dispatch
  if (dataLines.length === 0) return null;

  return { event, data: dataLines.join('\n') };
}

/**
 * 把新到的文本与上一次的残余拼起来，切出能完整解析的事件。
 *
 * @param chunk 本次新到的文本（调用方已用 TextDecoder 解好码）
 * @param buffer 上一次返回的 `rest`；首次调用可省略
 */
export function parseSse(
  chunk: string,
  buffer?: string,
): { events: SseEvent[]; rest: string } {
  // 先拼接、后规范化换行。顺序不能反：
  // buffer 尾部可能是一个落单的 '\r'，单独看它无法判断是否与下一块的 '\n' 成对。
  const text = (buffer ?? '') + chunk;
  const normalized = text.replace(/\r\n/g, '\n');

  const parts = normalized.split('\n\n');
  // 最后一段可能是不完整的，留到下次；文本以空行结尾时它是空串
  const rest = parts.pop() ?? '';

  const events: SseEvent[] = [];
  for (const part of parts) {
    const parsed = parseBlock(part);
    if (parsed) events.push(parsed);
  }

  return { events, rest };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/sse.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: Commit**

```bash
git add src/llm/sse.ts test/sse.test.ts
git commit -m "feat: add SSE frame parser"
```

---

### Task 3: per-call 模型打通（M2b 也依赖这一步）

**Files:**
- Modify: `demos/01-llm/src/llm/client.ts`
- Modify: `demos/01-llm/src/llm/deepseek.ts:23-34`
- Modify: `demos/01-llm/src/core/session.ts`
- Modify: `demos/01-llm/src/cli/repl.ts`（`ReplOptions` 加 `model`、`new Session(options.model)`、`chat()` 调用处传 `options`）
- Modify: `demos/01-llm/src/index.ts:24-30`
- Test: `demos/01-llm/test/deepseek.test.ts`（追加 1 例）
- Test: `demos/01-llm/test/session.test.ts`（改 + 追加）
- Test: `demos/01-llm/test/repl.test.ts`（4 处 options 补 `model`）

**Interfaces:**
- Consumes: `ChatOptions`（Task 1）
- Produces:
  - `LLMClient.chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>`
  - `Session` 构造函数改为 `constructor(model: string)`；新增 `get model(): string` / `set model(name: string)`
  - `ReplOptions` 增加必填 `model: string`

> **为什么这三件事合成一个任务**：它们是同一个原子变更。只改 `Session` 不改调用点、或只改 `chat()` 的签名不改 `deepseek.ts`，中间态都编译不过。拆开会产生「提交时仓库是红的」的步骤。
>
> **解决的问题**：`createDeepSeekClient(config)` 原本把 `config.model` 闭包捕获了，模型在构造时就烧死，`/model` 换不了。现在改成「每次请求带模型」，client 保持无状态纯函数式。
>
> **为什么这个参数位迟早要有**：M4 的 `--no-thinking` 也是 per-call 参数（thinking 开关不是 client 的身份，是这一轮的属性）。

- [ ] **Step 1: 写失败测试**

在 `test/deepseek.test.ts` 末尾追加：

```ts
test('options.model 覆盖构造时的默认模型', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4-pro' });

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.model, 'deepseek-v4-pro');
});

test('不传 options.model 时回落构造时的默认模型', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }]);

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.model, 'deepseek-flash');
});
```

把 `test/session.test.ts` 整体替换为：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@/core/session.ts';

test('append 按序保存消息', () => {
  const s = new Session('deepseek-flash');
  s.append('user', '什么是 React Server Components？');
  s.append('assistant', '它是……');
  assert.deepEqual(s.toMessages(''), [
    { role: 'user', content: '什么是 React Server Components？' },
    { role: 'assistant', content: '它是……' },
  ]);
});

test('toMessages 把 system 放在最前', () => {
  const s = new Session('deepseek-flash');
  s.append('user', '总结刚才内容');
  assert.deepEqual(s.toMessages('你是 CLI AI 助手'), [
    { role: 'system', content: '你是 CLI AI 助手' },
    { role: 'user', content: '总结刚才内容' },
  ]);
});

test('构造时带上当前模型，可读可改', () => {
  const s = new Session('deepseek-flash');
  assert.equal(s.model, 'deepseek-flash');
  s.model = 'deepseek-v4-pro';
  assert.equal(s.model, 'deepseek-v4-pro');
});
```

在 `test/repl.test.ts` 里，给 4 个 `runRepl(...)` 的 options 对象各补一行 `model: 'deepseek-flash',`（放在 `prompt` 之前）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/session.test.ts`
Expected: FAIL —— `Session` 构造函数收到多余的参数（Node 只擦类型不检查，因此实际表现为 `s.model` 为 `undefined`，第 3 个用例失败在 `assert.equal(s.model, 'deepseek-flash')`）

Run: `pnpm run typecheck`
Expected: FAIL —— `Session` 不接受构造参数、`ReplOptions` 没有 `model`、`chat()` 不接受第二个参数

- [ ] **Step 3: 改 `src/core/session.ts`**

把：

```ts
export class Session {
  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[] = [];
```

替换为：

```ts
export class Session {
  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[] = [];

  /**
   * 本会话当前使用的模型。
   *
   * 它属于「会话状态」而不是「client 配置」——`/model` 能中途切换它，
   * 每次请求再把它作为 per-call 参数传给 client。
   *
   * @param model 初始模型，通常来自 `resolveConfig` 的 `config.model`
   */
  constructor(private currentModel: string) {}
```

在 `toMessages` 方法之后、类结束之前插入：

```ts
  /** 当前模型 */
  get model(): string {
    return this.currentModel;
  }

  /** 切换当前模型；只影响后续请求，不改动已有消息 */
  set model(name: string) {
    this.currentModel = name;
  }
```

- [ ] **Step 4: 改 `src/llm/client.ts`**

把 `import type { ChatResult, Message } from "@/core/types.ts";` 改为：

```ts
import type { ChatOptions, ChatResult, Message } from "@/core/types.ts";
```

把 `chat` 的声明改为：

```ts
export interface LLMClient {
  /**
   * 发送一次请求，拿到模型的回答。
   *
   * @param messages 完整对话历史（含 system），按时间顺序排列
   * @param options 本次请求的可选参数（如指定模型）
   * @returns 模型回答；失败时应当抛出 Error，而不是返回空值
   */
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
}
```

- [ ] **Step 5: 改 `src/llm/deepseek.ts`**

把导入行改为：

```ts
import type { ChatOptions, Message, ChatResult } from '@/core/types.ts';
```

把 `async chat(messages: Message[]): Promise<ChatResult> {` 与请求体那两处改为：

```ts
    async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
```

```ts
        // 本次请求的模型优先；没传才回落到构造时的默认值。
        // 这样「当前模型」可以随会话切换，而 client 本身保持无状态。
        body: JSON.stringify({ model: options?.model ?? config.model, messages }),
```

- [ ] **Step 6: 改 `src/cli/repl.ts`**

`ReplOptions` 增加字段（放在 `prompt` 之后）：

```ts
  /** 提示符，例如 'You: ' */
  prompt: string;
  /** 会话的初始模型，通常来自 resolveConfig 的 config.model */
  model: string;
```

把 `const session = new Session();` 改为：

```ts
  const session = new Session(options.model);
```

把调用处改为：

```ts
      // 每轮都把「当前模型」作为请求参数传下去
      const result = await client.chat(session.toMessages(SYSTEM_PROMPT), {
        model: session.model,
      });
```

- [ ] **Step 7: 改 `src/index.ts`**

```ts
runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  // 模型回答 → stdout
  output: process.stdout,
  // 错误与诊断 → stderr，两条流互不污染
  errorOutput: process.stderr,
  prompt: 'You: ',
  model: config.model,
});
```

- [ ] **Step 8: 跑测试与类型检查确认通过**

Run: `pnpm run typecheck`
Expected: 退出码 0

Run: `pnpm test`
Expected: PASS（全绿：deepseek 6→8、session 2→3、其余不变）

- [ ] **Step 9: 手动确认缺 key 路径未被破坏**

Run: `env -u DEEPSEEK_API_KEY node --import ./loader.mjs src/index.ts < /dev/null; echo "exit=$?"`
Expected: stderr 出现 `缺少 DEEPSEEK_API_KEY…`，`exit=1`

- [ ] **Step 10: Commit**

```bash
git add src/llm/client.ts src/llm/deepseek.ts src/core/session.ts src/cli/repl.ts src/index.ts test/deepseek.test.ts test/session.test.ts test/repl.test.ts
git commit -m "feat: pass model per request and track it in Session"
```

---

### Task 4: `chatStream()` 接口、实现与空闲超时

**Files:**
- Modify: `demos/01-llm/src/llm/client.ts`
- Modify: `demos/01-llm/src/llm/deepseek.ts`
- Test: `demos/01-llm/test/deepseek.test.ts`（追加 9 例）
- Test: `demos/01-llm/test/repl.test.ts`（fake client 补 `chatStream` 桩，仅为了让类型过关）

**Interfaces:**
- Consumes: `parseSse` / `SseEvent`（Task 2）、`StreamEvent` / `FinishReason` / `ChatOptions`（Task 1）
- Produces:
  - `LLMClient.chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamEvent>`
  - `createDeepSeekClient(config: LLMClientConfig, idleTimeoutMs?: number): LLMClient`（第二参数默认 `30_000`）

> **相对 spec 的一处简化**：spec §3 D-M2-1 提到两个方法「共享请求体构造（`buildBody()`）」。实际写下来，两个请求体各自只有 2–3 个键、差异就一个 `stream: true`，为它抽一个 helper 会让「这次到底发了什么」变得不直观。**不抽 `buildBody()`**，各自内联。
>
> **超时为什么必须有**：非流式卡住是「整个请求没响应」，用户明确知道在等；流式已经打印了半句话然后停住，**用户无法区分「模型在想」和「连接死了」**。
>
> **流式下「首字节超时」就是「第一个 chunk 之前的空闲超时」**，同一个计时器覆盖两种情形（spec §9）。

- [ ] **Step 1: 写失败测试**

在 `test/deepseek.test.ts` 末尾追加：

```ts
// 造一个 SSE 响应：把若干**原始字节**依次推入流。
// 用字节而不是字符串，是为了能精确构造「多字节字符/一条事件被切成两次 read」的场景。
function sseResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const enc = new TextEncoder();

/** 把一个上游 chunk 的 JSON 包成一条 SSE 事件 */
function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ delta, finish_reason: finishReason }] };
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

test('chatStream 请求体含 model/messages/stream，且不含 stream_options', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return sseResponse([enc.encode('data: [DONE]\n\n')]);
  });

  const client = createDeepSeekClient(config);
  await collect(client.chatStream([{ role: 'user', content: 'hi' }]));

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.stream, true);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  // 官方文档没有要求流式必须带 stream_options；M2 也不消费 usage，所以不发
  assert.equal('stream_options' in body, false);
});

test('chatStream 的 options.model 覆盖默认模型', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return sseResponse([enc.encode('data: [DONE]\n\n')]);
  });

  const client = createDeepSeekClient(config);
  await collect(
    client.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4-pro' }),
  );

  assert.equal(JSON.parse(String(capturedInit!.body)).model, 'deepseek-v4-pro');
});

test('chatStream 把 delta 归一化成事件序列', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(deltaChunk({ role: 'assistant', content: '' })) +
          sseChunk(deltaChunk({ reasoning_content: '想一下' })) +
          sseChunk(deltaChunk({ content: '你好' })) +
          sseChunk(deltaChunk({ content: '，世界' })) +
          sseChunk(deltaChunk({}, 'stop')) +
          'data: [DONE]\n\n',
      ),
    ]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'reasoning-delta', text: '想一下' },
    { type: 'text-delta', text: '你好' },
    { type: 'text-delta', text: '，世界' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('末 chunk 的 usage 被忽略，不产生事件也不报错', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(deltaChunk({ content: '答' })) +
          sseChunk({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }) +
          'data: [DONE]\n\n',
      ),
    ]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '答' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('finish_reason 为 length 时 done 带上 length', async () => {
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(deltaChunk({}, 'length')) + 'data: [DONE]\n\n')]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'done', reason: 'length' },
  ]);
});

test('未见过 finish_reason 时 [DONE] 兜底成 stop', async () => {
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(deltaChunk({ content: '答' })) + 'data: [DONE]\n\n')]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '答' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('一条事件被切成两次 read 也能拼回', async () => {
  const whole = sseChunk(deltaChunk({ content: '完整' })) + 'data: [DONE]\n\n';
  const bytes = enc.encode(whole);
  const cut = Math.floor(bytes.length / 2);

  mockFetch(async () => sseResponse([bytes.slice(0, cut), bytes.slice(cut)]));

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '完整' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('多字节字符被切在两次 read 之间也不乱码', async () => {
  const bytes = enc.encode(sseChunk(deltaChunk({ content: '你好' })) + 'data: [DONE]\n\n');

  // 从「你」的 UTF-8 首字节之后一个字节处切开 —— 正好切在多字节字符内部。
  // 用 indexOf 定位而不是写死偏移量：写死的数字会随 JSON 形状变化而失效，
  // 而且很容易不小心落在纯 ASCII 前缀里，那样这个用例就白测了。
  const cut = bytes.indexOf(enc.encode('你')[0]);

  mockFetch(async () => sseResponse([bytes.slice(0, cut + 1), bytes.slice(cut + 1)]));

  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  assert.deepEqual(events[0], { type: 'text-delta', text: '你好' });
});

test('坏 JSON 的事件被跳过，其余照常', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        'data: {这不是 JSON\n\n' +
          sseChunk(deltaChunk({ content: '好的' })) +
          'data: [DONE]\n\n',
      ),
    ]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '好的' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('chatStream 非 2xx 抛错', async () => {
  mockFetch(async () => jsonResponse({ error: { message: 'Invalid API key' } }, 401));

  const client = createDeepSeekClient(config);
  await assert.rejects(
    () => collect(client.chatStream([{ role: 'user', content: 'hi' }])),
    /Invalid API key/,
  );
});

test('空闲超时抛错', async () => {
  // 一个永远不推数据、也不关闭的流
  mockFetch(async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  // 注入极短超时，避免测试真的等 30 秒
  const client = createDeepSeekClient(config, 20);
  await assert.rejects(
    () => collect(client.chatStream([{ role: 'user', content: 'hi' }])),
    /空闲超时/,
  );
});
```

同时给 `test/deepseek.test.ts` 顶部的 import 补上类型：

```ts
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import type { StreamEvent } from '@/core/types.ts';
```

在 `test/repl.test.ts` 的 `fakeClient` 里补一个桩方法（**仅为了让类型过关**，Task 6 才让它真正工作）：

```ts
  return {
    async chat() {
      const a = answers[i++];
      if (a instanceof Error) throw a;
      return { content: a ?? '' };
    },
    // Task 6 会把 repl 切到 chatStream；此处先补桩让类型成立
    async *chatStream() {
      throw new Error('not implemented yet');
    },
  };
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: FAIL —— `client.chatStream is not a function`

- [ ] **Step 3: 在 `src/llm/client.ts` 增加 `chatStream`**

```ts
import type { ChatOptions, ChatResult, Message, StreamEvent } from "@/core/types.ts";
```

```ts
export interface LLMClient {
  /**
   * 发送一次请求，拿到模型的回答。
   *
   * @param messages 完整对话历史（含 system），按时间顺序排列
   * @param options 本次请求的可选参数（如指定模型）
   * @returns 模型回答；失败时应当抛出 Error，而不是返回空值
   */
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;

  /**
   * 发送一次**流式**请求，逐个事件吐出。
   *
   * 与 `chat()` 并存而不是取而代之：`chat()` 是「一次拿完整结果」的简单参照实现，
   * 两者对照着看正是本阶段要学的东西；且保留它不作废既有的非流式测试。
   *
   * 实现约定：
   * - 非 2xx 必须在**开始产出事件之前**抛出
   * - 抛错时已产出的事件保留（调用方自己决定怎么处理半截内容）
   *
   * @param messages 完整对话历史（含 system），按时间顺序排列
   * @param options 本次请求的可选参数（如指定模型）
   */
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamEvent>;
}
```

- [ ] **Step 4: 在 `src/llm/deepseek.ts` 实现**

把导入行改为：

```ts
import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type { ChatOptions, Message, ChatResult, FinishReason, StreamEvent } from '@/core/types.ts';
import { parseSse } from '@/llm/sse.ts';
```

在文件顶部（`createDeepSeekClient` 之前）加常量：

```ts
/**
 * 流式空闲超时：两个 chunk 之间的最大间隔。
 *
 * 为什么流式必须有它：非流式卡住是「整个请求没响应」，用户明确知道在等；
 * 流式已经打印了半句话然后停住，用户无法区分「模型在想」和「连接死了」。
 *
 * 它同时覆盖「首字节超时」——第一个 chunk 之前的等待就是第一次空闲。
 *
 * 为什么不用单一总时长包住整个流：长回答会被误杀（见 docs/01-full-design.md §6）。
 */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * 等下一个 chunk，超过 `timeoutMs` 没有数据就抛错。
 *
 * 单独抽出来是因为「超时」必须作用在**每一次读取**上，
 * 而不是整个流的总时长。
 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`流空闲超时（${timeoutMs / 1000}s 无数据），已中断`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
```

把 `createDeepSeekClient` 的签名与返回对象改为（`chat` 方法体保持不变，只加 `chatStream`）：

```ts
export function createDeepSeekClient(
  config: LLMClientConfig,
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): LLMClient {
  const url = `${config.baseUrl}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  };

  return {
    async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // 本次请求的模型优先；没传才回落到构造时的默认值。
        // 这样「当前模型」可以随会话切换，而 client 本身保持无状态。
        body: JSON.stringify({ model: options?.model ?? config.model, messages }),
      });
      // …（以下与原来完全一致，不改）
```

在 `chat` 方法之后、返回对象结束之前加 `chatStream`：

```ts
    async *chatStream(
      messages: Message[],
      options?: ChatOptions,
    ): AsyncIterable<StreamEvent> {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // 只发三个字段。不发 stream_options —— 官方文档没有要求流式必须带它
        // （依赖方向相反：单独传 stream_options 才 400），
        // 而 M2 也不消费 usage，发了没有收益。
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          stream: true,
        }),
      });

      // 非 2xx 必须在产出任何事件**之前**抛出，处理方式与 chat() 一致
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        throw new Error(`DeepSeek API error ${response.status}: ${detail}`);
      }

      if (!response.body) {
        throw new Error('响应没有 body，无法流式读取');
      }

      const reader = response.body.getReader();
      // stream: true 让 TextDecoder 把跨块的多字节序列暂存在内部。
      // 不这么做的话，一个中文被 TCP 切在字符中间就会解出乱码。
      const decoder = new TextDecoder();
      let buffer = '';
      let doneEmitted = false;

      try {
        while (true) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await readWithIdleTimeout(reader, idleTimeoutMs);
          } catch (error) {
            // 超时/读失败时主动断开连接，否则底层请求会一直挂着
            await reader.cancel().catch(() => undefined);
            throw error;
          }

          if (result.done) break;

          const text = decoder.decode(result.value, { stream: true });
          const { events, rest } = parseSse(text, buffer);
          buffer = rest;

          for (const event of events) {
            // [DONE] 是 OpenAI 的约定，不是 SSE 协议的一部分，
            // 所以由这一层（而不是 sse.ts）来解释它
            if (event.data === '[DONE]') {
              if (!doneEmitted) {
                doneEmitted = true;
                yield { type: 'done', reason: 'stop' };
              }
              continue;
            }

            let payload: {
              choices?: Array<{
                delta?: { content?: string | null; reasoning_content?: string | null };
                finish_reason?: string | null;
              }>;
            };
            try {
              payload = JSON.parse(event.data);
            } catch {
              // 单条坏 chunk 不该让整个回答作废：跳过，继续读后面的
              continue;
            }

            const choice = payload.choices?.[0];
            const delta = choice?.delta;

            // 同一个 chunk 可能同时带内容和 finish_reason，所以逐个字段判定，
            // 不是 switch 整个 chunk。顺序也要紧：先正文后 done。
            if (delta?.reasoning_content) {
              yield { type: 'reasoning-delta', text: delta.reasoning_content };
            }
            if (delta?.content) {
              yield { type: 'text-delta', text: delta.content };
            }
            if (choice?.finish_reason && !doneEmitted) {
              doneEmitted = true;
              // 宽松处理：服务端新增取值时原样传出，不做白名单校验
              yield { type: 'done', reason: choice.finish_reason as FinishReason };
            }
          }
        }

        // 冲掉 decoder 内部可能残留的字节（正常不会剩）
        const tail = decoder.decode();
        if (tail !== '') {
          const { events } = parseSse(tail, buffer);
          for (const event of events) {
            // 收尾阶段只剩极少数情况会有事件，且都不带正文；
            // 这里只处理 done，避免重复实现上面的归一化逻辑
            if (event.data === '[DONE]' && !doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', reason: 'stop' };
            }
          }
        }

        // 服务端没给 finish_reason 也没给 [DONE] 就关流了：
        // 不报错，补一个 stop，让调用方总能收到 done
        if (!doneEmitted) {
          yield { type: 'done', reason: 'stop' };
        }
      } finally {
        // 超时路径下 reader 已经被 cancel，这里只是归还锁。
        try {
          reader.releaseLock();
        } catch {
          // 故意吞掉：清理动作失败不能盖住真正要抛出的那个错误
        }
      }
    },
```

- [ ] **Step 5: 跑测试与类型检查确认通过**

Run: `node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: PASS（20 个用例）

Run: `pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 6: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 7: Commit**

```bash
git add src/llm/client.ts src/llm/deepseek.ts test/deepseek.test.ts test/repl.test.ts
git commit -m "feat: add chatStream with SSE parsing and idle timeout"
```

---

### Task 5: `StreamEvent` 渲染

**Files:**
- Create: `demos/01-llm/src/cli/render.ts`
- Test: `demos/01-llm/test/render.test.ts`

**Interfaces:**
- Consumes: `StreamEvent`（Task 1）
- Produces:
  - `interface StreamRenderer { onEvent(event: StreamEvent): void; finish(): void }`
  - `function createStreamRenderer(options: { output: NodeJS.WritableStream; errorOutput: NodeJS.WritableStream }): StreamRenderer`
  - **渲染器负责写 `AI: ` 前缀**（模块内常量 `ANSWER_PREFIX`），且在**第一段正文之前**写、整轮只写一次

> **渲染器只呈现、不累积**。正文由 `repl` 自己 `text += ev.text` 攒——各管一件事。
>
> **`AI: ` 前缀归渲染器，不归 `repl`**：需求形状是 `You: 问` / `AI: 答` 交替（`docs/00-index.md`、
> spec §2、README 三处都画了）。非流式路径（M1）用 `write(\`AI: ${content}\`)` 一次写完；
> 流式下正文是逐段到的，所以必须由「知道第一段正文何时到达」的渲染器来写前缀。
> **M1 刚修好的东西（`DECISIONS.md` D15），这里漏了就会退化。**
>
> **每轮新建一个渲染器**，所以「`[思考中…]` 只出现一次」是天然的，不需要跨轮的标志位。
>
> **`finish()` 必须在 `finally` 里调用**：流中途报错时若不补换行，下一次 `You: ` 提示符会接在半句话后面。
>
> **不需要 TTY 检测**：思考指示走 stderr、正文走 stdout，天然分流，管道与重定向都不会被污染。

- [ ] **Step 1: 写失败测试 `test/render.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createStreamRenderer } from '@/cli/render.ts';

function collector(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { chunks, stream };
}

function setup() {
  const out = collector();
  const err = collector();
  const renderer = createStreamRenderer({
    output: out.stream,
    errorOutput: err.stream,
  });
  return { out, err, renderer };
}

test('text-delta 逐字写 stdout，不加换行', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '你好' });
  renderer.onEvent({ type: 'text-delta', text: '，世界' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 你好，世界\n');
  assert.deepEqual(err.chunks, []);
});

test('首个 reasoning-delta 在 stderr 写一行指示，且只写一次', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'reasoning-delta', text: '想' });
  renderer.onEvent({ type: 'reasoning-delta', text: '继续想' });
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.finish();

  assert.equal(err.chunks.join(''), '[思考中…]\n');
  // 思考内容本身不出现
  assert.ok(!err.chunks.join('').includes('想'));
  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('没有 reasoning 时 stderr 完全安静', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.deepEqual(err.chunks, []);
  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('finish 调两次只补一个换行', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.finish();
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('整轮没有任何事件时，finish 不写任何东西（一上来就抛错的情形）', () => {
  const { out, renderer } = setup();
  renderer.finish();

  assert.deepEqual(out.chunks, []);
});

test('done 但整轮没有正文时，仍然写出 AI: 前缀', () => {
  // 与 M1 的非流式路径保持一致：那边对空回答写的是 `write(\`AI: ${content}\`)`，
  // content 为空串时同样会输出 `AI: `。两条路径的形状不能不一样。
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: \n');
});

test('前缀只写一次（多个 text-delta 不会重复前缀）', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '一' });
  renderer.onEvent({ type: 'text-delta', text: '二' });
  renderer.onEvent({ type: 'text-delta', text: '三' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 一二三\n');
});

test('finish_reason 为 length 时 stderr 警告截断', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '半句' });
  renderer.onEvent({ type: 'done', reason: 'length' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 半句\n');
  assert.equal(err.chunks.join(''), '[警告] 回答被截断（finish_reason=length）\n');
});

test('finish_reason 为 stop 时不警告', () => {
  const { err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.deepEqual(err.chunks, []);
});

test('已输出正文但流中途失败：finish 仍补换行', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '半截' });
  // 模拟 repl 的 catch 分支之后调用 finish
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 半截\n');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/render.test.ts`
Expected: FAIL —— `Cannot find package '@/cli'` 指向的 `render.ts` 不存在

- [ ] **Step 3: 实现 `src/cli/render.ts`**

```ts
// 把 llm 层吐出的 StreamEvent 变成终端上的输出。
//
// 这是 cli 层：只有这里才允许写 stdout / stderr。
// 渲染器**只呈现、不累积正文** —— 正文由 repl 自己攒（它需要那份完整文本
// 才能写进 Session）。各管一件事。
//
// 输出分流（见 DECISIONS D13 / D-M2-10）：
//   stdout —— 用户主动要看的：模型回答
//   stderr —— 用户没主动要的：思考指示、截断警告、错误

import type { StreamEvent } from '@/core/types.ts';

/** 一轮回答的渲染器；每轮新建一个，用完即弃 */
export interface StreamRenderer {
  /** 处理一个流式事件 */
  onEvent(event: StreamEvent): void;
  /**
   * 收尾：保证本轮正文后有**且只有一个**换行。
   *
   * 必须在 `finally` 里调用 —— 流中途报错时若不补，
   * 下一次 `You: ` 提示符会接在半句话后面。
   */
  finish(): void;
}

/**
 * 一轮回答在 stdout 上的前缀。
 *
 * 需求形状是 `You: 问` / `AI: 答` 交替（见 `docs/00-index.md`、spec §2、README）。
 * 流式下它必须在**第一段正文之前**写出，所以由渲染器持有 ——
 * 这正是「渲染器负责一轮长什么样」的职责。
 */
const ANSWER_PREFIX = 'AI: ';

export function createStreamRenderer(options: {
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
}): StreamRenderer {
  // 每轮一个新的渲染器，所以这些标志天然是「本轮」的，不需要跨轮重置
  let thinkingNotified = false;
  let wrotePrefix = false;
  let finished = false;

  // 前缀必须恰好写出一次，且在正文之前
  const writePrefixOnce = (): void => {
    if (wrotePrefix) return;
    wrotePrefix = true;
    options.output.write(ANSWER_PREFIX);
  };

  return {
    onEvent(event: StreamEvent): void {
      if (event.type === 'reasoning-delta') {
        // 思考可能持续十几秒。这期间若一片死寂，流式解决的「等待没反馈」
        // 就只解决了一半 —— 所以给一行指示，但**不打印思考内容本身**
        // （它通常比答案长得多，会淹没答案；展开全文是 M4 的 --show-reasoning）。
        if (!thinkingNotified) {
          thinkingNotified = true;
          options.errorOutput.write('[思考中…]\n');
        }
        return;
      }

      if (event.type === 'text-delta') {
        writePrefixOnce();
        // 不补换行：正文是连续流动的，换行只由 finish() 统一负责
        options.output.write(event.text);
        return;
      }

      // done
      // 整轮一个字都没来时也要补上前缀 —— 非流式路径对空回答同样会写出
      // `AI: `（`write(\`AI: ${content}\`)` 里 content 是空串），
      // 两条路径的形状必须一致，否则同一件事在流式/非流式下长得不一样。
      writePrefixOnce();
      if (event.reason === 'length') {
        options.errorOutput.write('[警告] 回答被截断（finish_reason=length）\n');
      }
    },

    finish(): void {
      // 幂等：无论调用几次，只补一个换行
      if (finished) return;
      finished = true;
      // 前缀都没写过说明本轮完全没产出（比如一上来就抛错），
      // 此时当前行是空的，补换行只会多一个空行
      if (wrotePrefix) options.output.write('\n');
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/render.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: Commit**

```bash
git add src/cli/render.ts test/render.test.ts
git commit -m "feat: render StreamEvent to stdout/stderr"
```

---

### Task 6: repl 接入流式

**Files:**
- Modify: `demos/01-llm/src/cli/repl.ts`（提问处理段；**提示符那段逻辑不要动**）
- Test: `demos/01-llm/test/repl.test.ts`

**Interfaces:**
- Consumes: `createStreamRenderer`（Task 5）、`LLMClient.chatStream`（Task 4）
- Produces: 无新增导出（`runRepl` 签名不变）

> **只改「提问处理」那一段，不要碰循环结构。** M1 刚把循环从 `for await` 改成手写异步迭代器，
> 为的是在**读取之前**写 `You: ` 提示符（`DECISIONS.md` D15）。本任务只把
> `client.chat(...)` 换成 `client.chatStream(...)` + 渲染器，**提示符的写法和位置保持原样**。
>
> **`AI: ` 前缀不由这里写** —— 它是渲染器（Task 5）的职责。`repl` 只负责攒正文
> （`text += ev.text`）和往 `Session` 里追加。
>
> **一个必须通过的验收信号**：`test/repl.test.ts` 里现有的三个逐字节断言
> （`'You: AI: 你好\nYou: '` 等）在本任务改动后**必须继续通过**。它们是这次改动是否
> 把 M1 修复退化的探针 —— 如果它们变红，说明前缀或提示符被弄丢了。

- [ ] **Step 1: 改测试**

把 `test/repl.test.ts` 的 `fakeClient` 换成能产出事件的版本：

```ts
function fakeClient(answers: Array<string | Error>): LLMClient {
  let i = 0;
  const next = (): string => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return a ?? '';
  };

  return {
    async chat() {
      return { content: next() };
    },
    async *chatStream() {
      // 抛错要发生在 yield 之前，才能模拟「一开始就失败」
      const content = next();
      yield { type: 'text-delta', text: content };
      yield { type: 'done', reason: 'stop' };
    },
  };
}
```

把「多轮对话上下文按序累积」这个用例里手写的 client 换成：

```ts
  const client: LLMClient = {
    async chat() {
      return { content: 'ok' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };
```

追加三个用例：

```ts
test('正文逐字写 stdout，思考指示只写 stderr', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream() {
      yield { type: 'reasoning-delta', text: '想一下' };
      yield { type: 'text-delta', text: '你' };
      yield { type: 'text-delta', text: '好' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  const out = chunks.join('');
  assert.ok(out.includes('你好'));
  assert.ok(!out.includes('想一下'));
  assert.equal(errChunks.join(''), '[思考中…]\n');
});

test('流中途失败：不追加 assistant，且补上收尾换行', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: '半截' };
      throw new Error('流空闲超时（30s 无数据），已中断');
    },
  };

  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  const out = chunks.join('');
  // 半截答案留在了屏幕上，但补了换行（否则第二个提示符会接在后面）
  assert.ok(out.includes('半截\n'));
  assert.ok(errChunks.join('').includes('空闲超时'));

  // 关键：第二轮的 messages 里没有那条失败的回答
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '第一问' },
    { role: 'user', content: '第二问' },
  ]);
});

test('每轮都把当前模型作为请求参数传下去', async () => {
  const models: Array<string | undefined> = [];
  const { stream, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(_messages, options) {
      models.push(options?.model);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  assert.deepEqual(models, ['deepseek-flash']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/repl.test.ts`
Expected: FAIL —— `不实现` 桩抛错导致多数用例失败；「正文逐字写 stdout」等新用例断言不成立

- [ ] **Step 3: 改 `src/cli/repl.ts`**

把导入改为：

```ts
import { createInterface } from 'node:readline';
import { Session } from '@/core/session.ts';
import { createStreamRenderer } from '@/cli/render.ts';
import type { LLMClient } from '@/llm/client.ts';
```

把 `while (true)` 循环体内**从 `session.append('user', question);` 到该轮 `catch` 结束**的那一段
（即「提问处理」部分，**不含** `writePrompt()` 与 `lines.next()`）替换为：

```ts
    session.append('user', question);

    // 每轮新建渲染器：「[思考中…] 只出现一次」因此是天然的
    const renderer = createStreamRenderer({
      output: options.output,
      errorOutput: options.errorOutput,
    });

    // 本轮正文。渲染器只呈现，累积是这里的职责 ——
    // 因为只有攒出完整文本才能写进 Session 当上下文。
    let text = '';

    try {
      // 把「system + 目前为止的全部历史」发过去，模型据此理解上下文；
      // 当前模型随请求走，所以中途切换模型能立即生效
      const stream = client.chatStream(session.toMessages(SYSTEM_PROMPT), {
        model: session.model,
      });

      for await (const event of stream) {
        renderer.onEvent(event);
        if (event.type === 'text-delta') text += event.text;
      }

      // 只在成功之后才记录 AI 的回答。
      // 失败时若也追加，历史里就会出现一条「伪造的回答」，
      // 下一轮模型会把它当成自己说过的话，产生自我矛盾。
      //
      // 注意：流中途失败时屏幕上会留下半截回答，但它**不会**进入上下文。
      // 「屏幕上看到的」与「模型记得的」是两回事。
      session.append('assistant', text);
    } catch (error) {
      // 最小错误处理：打印错误后继续循环。
      // 不崩溃，也不污染上下文——失败的轮次不留 assistant 消息。
      // 走 stderr：stdout 只留给模型回答，重定向时不被诊断信息污染。
      writeError(`[error] ${(error as Error).message}`);
    } finally {
      // 无论正常还是异常结束都收尾：保证正文后有且只有一个换行，
      // 否则下一次提示符会接在半句话后面
      renderer.finish();
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/repl.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 跑类型检查与全量测试**

Run: `pnpm run typecheck`
Expected: 退出码 0

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: 手动验证分流（真实网络，需 key）**

Run:

```bash
printf '用一句话说明什么是闭包\n' | pnpm --silent start 1>"$CLAUDE_JOB_DIR/tmp/out.txt" 2>"$CLAUDE_JOB_DIR/tmp/err.txt"; echo "exit=$?"
echo "--- stdout ---"; cat "$CLAUDE_JOB_DIR/tmp/out.txt"
echo "--- stderr ---"; cat "$CLAUDE_JOB_DIR/tmp/err.txt"
```

Expected:
- stdout 只有 `You: ` + 一段连续回答 + 一个结尾换行
- stderr 只有一行 `[思考中…]`（或为空，若该轮没有思考）
- **stdout 里没有 `[思考中…]`**

> ⚠️ 这一步会发**真实请求**（消耗账号余额、内容出境）。未获用户确认不要执行。
> 跳过时请在最终报告里如实标注「未验证」，不要写成通过。

- [ ] **Step 7: Commit**

```bash
git add src/cli/repl.ts test/repl.test.ts
git commit -m "feat: stream responses in the REPL"
```

---

### Task 7: 文档同步

**Files:**
- Modify: `demos/01-llm/HOW-IT-WORKS.md`
- Modify: `demos/01-llm/ARCHITECTURE.md`
- Modify: `demos/01-llm/DECISIONS.md`
- Modify: `demos/01-llm/README.md`
- Modify: `demos/01-llm/EVALUATION.md`
- Modify: `demos/01-llm/docs/troubleshooting.md`
- Modify: `README.md`（仓库根，阶段目录表的状态列）

**Interfaces:**
- Consumes: 无（纯文档）
- Produces: 与代码一致的文档

- [ ] **Step 1: 改 `HOW-IT-WORKS.md` 的数据流图与逐步说明**

把「数据流全貌」里的调用链改成流式：

```text
  ├─ messages = session.toMessages(SYSTEM_PROMPT)
  │
  ├─ client.chatStream(messages, { model: session.model })
  │       → POST {baseUrl}/chat/completions
  │         body: { model, messages, stream: true }
  │       → 逐块 read → TextDecoder(stream) → parseSse 分帧 → 归一化成 StreamEvent
  │
  ├─ 成功：text 累积 → session.append('assistant', text)
  └─ 失败：打印 [error] ... 到 stderr → 不 append（上下文保持干净）
  │
  └─ renderer.finish() 保证收尾换行（正常与异常都调用）
```

在「错误处理策略」之后插入一节：

```markdown
## 流式：屏幕上看到的 ≠ 模型记得的

流式输出会**边收边打印**，所以中途失败时屏幕上会留下半截回答。但那半截
**不会**进入 `Session` —— `session.append('assistant', …)` 只在流正常结束后执行。

后果：下一轮模型看不到那半截内容。你看到的和它记得的是两回事，
这不是 bug，是「失败轮次不写上下文」这条规则的必然结果（见 D7）。
```

- [ ] **Step 2: 改 `ARCHITECTURE.md` 的模块职责表**

在表格中 `src/llm/deepseek.ts` 一行之后插入：

```markdown
| `src/llm/sse.ts` | llm | SSE 分帧（纯函数，只懂协议不懂 DeepSeek） | 网络、解码、事件语义 |
| `src/cli/render.ts` | cli | `StreamEvent` → stdout/stderr 的呈现 | 累积正文、网络 |
```

并把依赖规则表里 `llm` 一行补上「`llm/sse.ts` 是纯函数，不碰 IO」。

- [ ] **Step 3: 在 `DECISIONS.md` 末尾追加 D16–D22**

```markdown
---

## D16. `chatStream()` 与 `chat()` 并存，各自独立实现

**决策**：`LLMClient` 增加 `chatStream()`，`chat()` 保留为独立的非流式实现。

**理由**

- 这是学习项目。「非流式」与「流式」两条 wire 路径对照着看，正是阶段 0 要学的东西。
- 把 `chat()` 改成在 `chatStream()` 之上收集事件虽然只有一条路径，但会作废
  `deepseek.test.ts` 现有 6 个用例（它们喂的是 JSON 响应，不是 SSE）。

**代价**：`deepseek.ts` 里有两个请求构造点（各 2–3 个键，差异只有一个 `stream: true`）。
**特意不抽 `buildBody()`** —— 为这点差异抽 helper 会让「这次到底发了什么」变得不直观。

---

## D17. per-call `options` 携带模型，「当前模型」存在 `Session`

**决策**：`chat(messages, options?)` / `chatStream(messages, options?)`，
`options.model`；`Session` 增加 `model` getter/setter。

**理由**：`/model` 需要在会话中途切换模型，而原实现把 `config.model` 闭包捕获在
`createDeepSeekClient()` 里，模型在构造时就烧死了。

**为什么参数位迟早要有**：M4 的 `--no-thinking` 同样是 per-call 参数 ——
thinking 开关不是 client 的身份，是这一轮的属性。

**放弃**：repl 持 factory 切换时重建 client（要改 `runRepl` 签名与 4 个测试）；
client 加可变 `setModel()`（接口有状态，多会话共享会互相污染）。

---

## D18. `StreamEvent` 只吐三种，`usage` 推迟到 M4

**决策**：M2 只产出 `text-delta` / `reasoning-delta` / `done`。

**理由**：`done` 必须现在有 —— `finish_reason === 'length'` 表示回答被截断，要告诉用户。
`usage` 现在解析了没有消费者，还要连带定义 `TokenUsage` 及其测试。

**代价**：M4 要在 `StreamEvent` 联合里加第 4 个成员。可接受。

---

## D19. SSE 解析是纯函数 + 显式残余缓冲

**决策**：`parseSse(chunk, buffer?) → { events, rest }`，无状态。

**理由**：分帧是 M2 最容易错的地方（一条事件可能被 TCP 切成两次 `read()`，
一次 `read()` 可能含多条事件）。纯函数才能用「喂字符串、断言字符串」测透，
而不必构造假的可读流。

**放弃**：有状态类（跨分片测试更绕，且引入可变状态）；
async generator 直接吃字节流（把分帧与读流揉在一起，正好把最难测的部分藏进 IO）。

**关键实现细节**：必须**先 `buffer + chunk` 拼接、后**把 `\r\n` 规范化成 `\n`。
反过来做的话，`buffer` 尾部一个落单的 `\r` 无法判断是否与下一块的 `\n` 成对。

---

## D20. `TextDecoder({ stream: true })` 在调用方解码，分帧在字符串层

**决策**：`deepseek.ts` 用 `new TextDecoder()` 配合 `decode(chunk, { stream: true })`
逐块解码，`sse.ts` 只处理字符串。

**理由**：SSE 按字节到达，一个中文 3 字节，很可能被 TCP 切在字符中间。
把跨块多字节序列的处理交给 `TextDecoder`，分帧逻辑就不必关心字节。

---

## D21. 一个 30s 的流空闲超时，不加开关

**决策**：`deepseek.ts` 内部一个每收到 chunk 就重置的计时器，常量 30s，
超时主动断开连接并抛普通 `Error`。

**理由**：非流式卡住是「整个请求没响应」，用户明确知道在等；流式已经打印了
半句话然后停住，**用户无法区分「模型在想」和「连接死了」**。

**实现观察**：流式下「首字节超时」就是「第一个 chunk 之前的空闲超时」——
同一个计时器覆盖两种情形。

**为什么不用单一总时长**：长回答会被误杀（`01-full-design.md` §6）。
`--timeout` 开关属于 M6。

---

## D22. 思考过程走 stderr 一行指示

**决策**：首个 `reasoning-delta` 到达时往 stderr 写一行 `[思考中…]`，此后不再输出；
思考内容本身不打印。

**理由**

- 思考可能持续十几秒。这期间若一片死寂，流式解决的「等待没反馈」只解决了一半。
- 思考通常比答案长得多，打印出来会淹没答案（展开全文是 M4 的 `--show-reasoning`）。
- 走 stderr 而不是 stdout：stdout 只承载模型回答（D13）。

**副产品（好的）**：**不需要 TTY 检测**。两条流天然分流，管道与重定向都不会被污染。
```

- [ ] **Step 4: 改 `README.md` 的「当前能力边界」**

把「已实现」列表里的第一条替换为：

```markdown
- 非流式多轮对话 + **流式（SSE）逐字输出**，上下文在进程内存中累积
- 思考过程默认不展开，仅在 stderr 给一行 `[思考中…]` 指示
```

把「尚未实现」列表里的 `streaming（SSE 解析）` 一行删掉。

把「常用命令」表的测试数量更新为实际值（执行后以 `pnpm test` 输出为准，Task 6 结束时是 **54**）。

并在「项目结构」的 `src/` 清单里插入：

```text
    cli/render.ts       # StreamEvent → stdout/stderr
    llm/sse.ts          # SSE 分帧（纯函数）
```

- [ ] **Step 5: 改 `EVALUATION.md` 第 4 项**

把第 4 项从「❌ 未做」改为「✅ 达标」，并补证据：

```markdown
## 4. 实现 Streaming — ✅ 达标（M2a，2026-09-24）

**证据**

- `src/llm/sse.ts` 手写 SSE 分帧（纯函数），覆盖一次多事件、事件跨两次 read、
  注释行、多行 data、`\r\n` 跨块、`[DONE]`、半条事件残留 —— 见 `test/sse.test.ts`
- `src/llm/deepseek.ts` 的 `chatStream()` 把 chunk 归一化成 `StreamEvent`；
  `test/deepseek.test.ts` 覆盖事件序列、末 chunk 的 `finish_reason`、`[DONE]` 兜底、
  非 2xx、空闲超时、坏 JSON 跳过、**多字节字符被切在两次 read 之间不乱码**
- `src/cli/render.ts` 把事件渲染到 stdout/stderr；`test/render.test.ts` 覆盖分流规则

**五条硬约束的落实**（`01-full-design.md` §6）

| 约束 | 落实 |
| --- | --- |
| ~~`stream: true` 必须带 `stream_options`~~ | **该约束不成立**，官方文档写反了，已于 2026-09-24 更正 |
| `usage` 只在末 chunk、无 usage-only chunk | 已核实；M2 不消费，末 chunk 的 `usage` 被忽略 |
| SSE 必须按字节流缓冲解析 | `TextDecoder({stream:true})` + 纯函数分帧；分片与多字节切分都有测试 |
| thinking 是两条独立通道 | `reasoning-delta` 与 `text-delta` 分别归一化，渲染器只显示指示 |
| thinking 下 `temperature` 无效 | 不传 `temperature`，天然满足 |

**未做（属 M4）**：`--show-reasoning` 展开思考全文、`--no-thinking`
```

把总表第 4 行同步改为 `| 4 | 实现 Streaming | ✅ 达标 | M2 |`，
并把「整体：2 项达标 / 1 项部分 / 3 项未做」改为「**3 项达标 / 1 项部分 / 2 项未做**」。

- [ ] **Step 6: 在 `docs/troubleshooting.md` 追加 T9**

```markdown
## T9（附）往 `test/` 下放辅助文件，用例数被静默撑大

**症状**

放一个 `test/helpers.ts`（或 `test/support/xxx.ts`）进去，跑 `pnpm test` 发现用例数
凭空多了几个，且多出来的"用例"名字就是文件名：

```console
ok 3 - test/helper-probe.ts
ok 7 - test/support/helper.ts
# tests 18
```

**原因**

`pnpm test` 用的是裸 `node --test`（不带路径参数），它的默认发现规则会匹配
**`test/` 目录下的任何文件**，不只是 `*.test.ts`。一个只有导出的辅助文件照样被
当成一个"测试文件"载入，载入成功就算通过。

**解决**

不要在 `test/` 下放非 `*.test.ts` 的文件。各测试文件自带局部辅助即可。

**验证**

`pnpm test` 的 `# tests` 数量应等于各 `*.test.ts` 里 `test(` 的数量之和。

**避免**

如果确实需要共享的测试辅助，把 `test` 脚本改成显式 glob
（`node --test 'test/**/*.test.ts'`）再说 —— 但本项目的测试大多是纯函数测试，
只有 `repl.test.ts` 需要 fake client，没必要为此引入共享文件。

来源：实测（2026-09-24 写 M2 计划时探测到）。
```

- [ ] **Step 7: 改仓库根 `README.md` 的阶段目录表**

把 `demos/01-llm/` 一行的状态列改为：

```markdown
| `demos/01-llm/` | ai-chat | 阶段 0 · 实践项目 1（AI Chat） | 进行中：M1、M2a 完成，M2b–M7 待做 |
```

- [ ] **Step 8: 最终验证**

Run: `pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

Run: `grep -c '^```' HOW-IT-WORKS.md ARCHITECTURE.md DECISIONS.md README.md EVALUATION.md docs/troubleshooting.md`
Expected: 每个文件的 ``` 数量都是偶数（围栏配平）

- [ ] **Step 9: Commit**

```bash
git add HOW-IT-WORKS.md ARCHITECTURE.md DECISIONS.md README.md EVALUATION.md docs/troubleshooting.md
git commit -m "docs: record streaming design and mark acceptance item 4 done"
git add ../../README.md
git commit -m "docs: update stage status for M2a"
```

---

## 完成标准

```text
TypeCheck: pnpm run typecheck  → 退出码 0
Lint:      N/A（本仓库未配置 linter）
Test:      pnpm test           → 全绿
Build:     N/A（noEmit，无构建产物）
冒烟:      Task 6 Step 6 —— 需用户确认后才执行；跳过则如实标注「未验证」
```
