# ai-chat M2 · 设计文档（streaming + 命令）

- 日期：2026-09-24
- 状态：待 review
- 范围：M2 —— **streaming（SSE 流式输出）** + **`/clear` `/model` `/history` 三个命令**
- 前置：M1（非流式多轮对话 + 最小错误处理）已完成，见 `docs/superpowers/specs/2026-09-23-ai-chat-design.md`
- 约束来源：`ARCHITECTURE.md`，以及本文 §7（SSE 契约）/ §8（流式请求契约）

本 spec 拆成两个实施计划，因为两半互不依赖、各自可独立验收：

```text
M2a  streaming：sse.ts → chatStream → render.ts → repl 接入
M2b  命令层：commands.ts → Session 扩展 → repl 接入
```

---

## 1. 背景与目标

M1 走通了「LLM API → 消息结构 → 上下文管理」。M2 补两件事：

1. **streaming**：把「一次 fetch 等完整回答」变成「逐字到达」。这是阶段 0 验收的六条之一（见 `docs/ROADMAP.md` 的「阶段验收标准」），也是 M1 明确推迟的部分。
2. **三个命令**：`/clear` `/model` `/history`，让会话在进程内可控。

成功标准（本次范围）：

- 回答逐字出现，而不是等完整响应后一次性打印
- 思考过程不淹没答案，但等待期间有反馈
- 卡住的流不会永久挂死
- 三个命令可用，且**命令本身不进入对话上下文**
- `/model` 能在会话中途切换模型并生效

---

## 2. 范围界定

### 本次范围

- `src/llm/sse.ts`：SSE 分帧（纯函数）
- `src/llm/deepseek.ts`：`chatStream()` 实现 + 空闲超时
- `src/llm/client.ts`：`LLMClient` 增加 `chatStream`
- `src/cli/render.ts`：`StreamEvent` → stdout/stderr 的呈现
- `src/core/commands.ts`：命令解析与执行（纯逻辑）
- `src/core/session.ts`：当前模型、`clear()`、`history()`
- `src/cli/repl.ts`：改走 `chatStream`，接入命令
- 相关测试与文档同步

### 明确推迟（本次不实现、不设计细节）

- `usage` 事件与 Token 账本 → M4
- `--timeout` 开关、错误分类（`LLMError.code`）、自动重试 → M6
- Ctrl+C 中断与「会话回滚到本轮之前」 → M6
- `--show-reasoning`（展开思考全文）、`--no-thinking` → M4
- structured output → M5

---

## 3. 设计决策汇总

本次拍板的决策。**每条都记了被放弃的选项**，因为决策过程不在代码里。

### D-M2-1. `chatStream()` 新增，`chat()` 保留为独立实现

两者共享请求体构造（`buildBody()`），但各走各的 wire 路径：`chat()` 收 JSON，`chatStream()` 收 SSE。

**放弃**：把 `chat()` 改成在 `chatStream()` 之上收集事件。那个方案 wire 路径只有一条、更"干净"，但会把 `deepseek.test.ts` 现有 **6 个**用例作废（它们喂的是 JSON 响应，不是 SSE），且非流式路径作为「简单参照实现」的对照价值会消失——而"非流式 vs 流式"的对照正是阶段 0 要学的东西。

两个方法都接受可选的 `options?: ChatOptions`（`chat()` 加上它不影响现有调用）。

### D-M2-2. `options` 携带 per-call 参数；「当前模型」存在 `Session`

```ts
chat(messages, options?: ChatOptions): Promise<ChatResult>
chatStream(messages, options?: ChatOptions): AsyncIterable<StreamEvent>
interface ChatOptions { model?: string }
```

**背景问题**：`deepseek.ts` 在 `createDeepSeekClient(config)` 时就把 `config.model` 闭包捕获了，`/model <name>` 按原接口根本换不了模型。

**放弃**：
- *repl 持 factory，切换时重建 client* —— `LLMClient` 接口不用动，但 `runRepl` 的签名要从「注入 client」改成「注入 factory」，4 个 repl 测试和 `config` 传递都要改。
- *client 加可变 `setModel()`* —— 接口变成有状态，一个 client 被多个会话共享时会互相污染，测试更难写。

**选它的决定性理由**：M4 的 `--no-thinking` 同样需要 per-call 参数（thinking 开关不是 client 的身份，是这一轮的参数）。这个参数位迟早要加。且蓝图 §3 对 `core/session.ts` 职责的描述本来就是「会话状态：消息数组、**当前模型**、会话 id」。

### D-M2-3. `StreamEvent` 本次只吐三种，`usage` 推迟到 M4

```ts
type StreamEvent =
  | { type: 'text-delta';      text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'done';            reason: FinishReason }
```

`done` 必须现在就有：`finish_reason === 'length'` 表示回答被截断，要告诉用户。

**放弃**：现在就把 `usage` 也解析出来。没有消费者，还要连带定义 `TokenUsage` 及其测试——YAGNI。

### D-M2-4. SSE 解析器是纯函数 + 显式残余缓冲

```ts
function parseSse(chunk: string, buffer?: string): { events: SseEvent[]; rest: string }
```

调用方把上一次的 `rest` 传回来，解析器自身完全无状态。

**放弃**：
- *有状态类 `SseDecoder`* —— 调用方更简单，但"事件跨 read 分片"的测试要构造实例并连续 `push`，且引入可变状态。
- *async generator 直接吃字节流* —— 最贴近真实用法，但把**分帧**与**读流**揉在一起，而分帧恰恰是 M2 最容易错、最需要测透的地方（蓝图 §6 第 3 条）。纯函数可以用「喂字符串、断言字符串」把它测穿。

**解码位置**：`TextDecoder` 的 `{ stream: true }` 在**调用方**（`deepseek.ts`）逐块解码，**分帧在字符串层**。理由：SSE 按字节到达，一个中文 3 字节，很可能被 TCP 切在字符中间；交给 `TextDecoder` 处理跨块多字节序列，分帧逻辑才不必关心字节。

### D-M2-5. 一个硬编码的流空闲超时（30s），不加开关

`deepseek.ts` 内部维护一个计时器，**每收到一个 chunk 就重置**；超时只 reject 并抛普通 `Error`，连接由流收尾的 `reader.cancel()` 收掉（**没有** `AbortController`）。

**为什么流式必须有**：非流式时卡住是「整个请求没响应」，用户明确知道在等；流式时已经打印了半句话然后停住，**用户无法区分「模型在想」和「连接死了」**。

**实现观察**：流式下「首字节超时」就是「第一个 chunk 之前的空闲超时」——同一个计时器覆盖两种情形。蓝图 §6 把它们写成两条，是因为非流式下这两者确实不同。**限定（2026-09-24 补）**：计时器建立在拿到 `response.body` **之后**，`await fetch(...)` 之上没有本项目的时限，因此它覆盖的是「**响应头之后的**首字节」；真正的首字节超时归 M6，详见 §9 与 `DECISIONS.md` D21。

**放弃**：把 `--timeout` 开关一起做（那是 M6），或不做超时（卡住的流永久挂死）。

### D-M2-6. 思考过程：stderr 一行活动指示

首个 `reasoning-delta` 到达时往 **stderr** 写一行 `[思考中…]`，此后不再输出。事件层照常吐 `reasoning-delta`，M4 的 `--show-reasoning` 只改渲染策略，不动 `llm/` 层。

**为什么不能完全忽略**：流式的首要价值是「等待期间有反馈」。thinking 默认开启且可能持续十几秒——若这段什么都不显示，最长的等待仍是一片死寂，流式只解决了一半问题。

**为什么走 stderr**：stdout 只承载模型回答（D13），因此 `pnpm start > answers.txt` 依然只有纯净回答。

**副作用（好的）**：**不需要 TTY 检测**。指示天然与答案分流，管道场景下不会污染文件，也不需要 `\r` 动画。

### D-M2-7. 渲染器只呈现，不累积；用 `finish()` 保证收尾

`createStreamRenderer()` 每轮新建一个实例（所以「指示只出现一次」是天然的）。它只负责把事件变成输出，**不攒正文**——正文由 `repl` 自己 `text += ev.text` 累积。

`finish()` 保证一轮正文后**有且只有一个换行**，无论正常结束还是异常结束（异常时若不补，下一次 `You: ` 提示符会接在半句话后面）。

### D-M2-8. 命令逻辑归 `core/commands.ts`，打印归 `cli/`

蓝图 §3 把命令放在 `core/commands.ts`，但命令要打印结果，而 `core` 不许写 stdout。因此拆成两半：

- `core/commands.ts`：**解析 + 改 Session + 返回结构化结果**（纯逻辑，全部可离线测）
- `cli/render.ts`：**把结果打印出来**

### D-M2-9. 命令永不进入对话上下文

命令在 `session.append('user', …)` **之前**处理。

理由：否则 `/clear` 会作为一条 user 消息留在刚被它清空的历史里；`/history` 会让模型看到「用户查了历史」，污染后续推理。这是必然选择，不是偏好。

### D-M2-10. 输出分流的边界细化

D13 定的规则是「stdout 只承载模型回答」。本次细化为：

| 流 | 内容 |
| --- | --- |
| **stdout** | 用户主动要看的：模型回答 + **命令结果**（`/history` 列表、`/model` 当前模型、`/clear` 反馈） |
| **stderr** | 用户没主动要的：错误、`[思考中…]` 指示、截断警告、未知命令提示 |

理由：`/history` 是用户显式索要的输出，`> answers.txt` 里看不到它反而反直觉。未知命令是错误，仍走 stderr。

---

## 4. 架构与数据流

### 流式一轮的路径

```text
user 输入（非命令）
  │
  ├─ session.append('user', question)
  │
  ├─ client.chatStream(session.toMessages(SYSTEM_PROMPT), { model: session.model })
  │     │
  │     ├─ POST /chat/completions  body: { model, messages, stream: true }
  │     ├─ response.ok? 否 → 抛错（沿用 M1 的防御式错误体解析）
  │     ├─ for await (chunk of response.body)
  │     │     ├─ TextDecoder({stream:true}).decode(chunk, {stream:true})
  │     │     ├─ parseSse(decoded, rest) → { events, rest }
  │     │     └─ 每个 event: data JSON 解析 → 归一化成 StreamEvent
  │     │         · choices[0].delta.content          → text-delta
  │     │         · choices[0].delta.reasoning_content → reasoning-delta
  │     │         · choices[0].finish_reason 非 null   → done
  │     │         · data === '[DONE]'                  → done（兜底，见 §7）
  │     └─ 空闲计时器每收到 chunk 重置；超时 → abort + 抛错
  │
  ├─ renderer.onEvent(ev)   → stdout（正文逐字）/ stderr（[思考中…]）
  ├─ text += ev.text        → repl 自己攒正文
  │
  ├─ 成功：session.append('assistant', text)
  └─ 失败：写 stderr，**不 append**（D7 保持）
  │
  └─ renderer.finish()  → finally 里调用，保证收尾换行
```

### 一条命令的路径

```text
user 输入以 / 开头
  │
  ├─ parseCommand(trimmed) → none | known | unknown
  │     · unknown → renderUnknownCommand → stderr，continue（不 append，不请求）
  │     · known   → executeCommand(name, argument, session) → CommandResult
  │                  → renderCommandResult → stdout
  │                  → continue（不 append，不请求）
  │
  └─ （none 才走普通提问路径）
```

---

## 5. 目录结构

```text
demos/01-llm/src/
  cli/
    config.ts       （不变）
    render.ts       【新】StreamEvent → stdout/stderr；命令结果与未知命令的打印
    repl.ts         改：走 chatStream、接入命令
  core/
    commands.ts     【新】命令解析与执行（返回结构化结果）
    session.ts      改：当前模型、clear()、history()
    types.ts        改：StreamEvent / FinishReason / ChatOptions
  llm/
    client.ts       改：+ chatStream，chat/chatStream 都接受 options?
    deepseek.ts     改：+ chatStream 实现 + 空闲超时；抽出 buildBody()
    sse.ts          【新】SSE 分帧（纯函数）
  index.ts          改：把初始模型传给 runRepl
test/
  sse.test.ts       【新】
  commands.test.ts  【新】
  render.test.ts    【新】
  deepseek.test.ts  改
  session.test.ts   改
  repl.test.ts      改
  config.test.ts    （不变）
  index.test.ts     （不变）
```

---

## 6. 类型定义

### `core/types.ts` 新增

```ts
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'aborted';

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'done'; reason: FinishReason };

export interface ChatOptions {
  /** 本次请求使用的模型；不传则由 client 用构造时的默认值 */
  model?: string;
}
```

### `llm/client.ts` 改动

```ts
export interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamEvent>;
}
```

> **注意**：`StreamEvent` / `ChatOptions` / `FinishReason` 定义在 `core/types.ts`（与 `Message` 同处），`llm/` 从这里 `import type`。依赖方向不变。

### `llm/sse.ts`

```ts
export interface SseEvent {
  /** SSE 的 event: 字段；缺省为 'message' */
  event: string;
  /** 该事件的 data: 内容（多行 data 已按规范用 \n 拼接） */
  data: string;
}

/**
 * 把一段**已解码的字符串**切成 SSE 事件。
 * @param chunk 本次新到的文本
 * @param buffer 上一次返回的 rest；首次调用可省略
 * @returns events 本次能完整解析出的事件；rest 尚未成形的残余
 */
export function parseSse(
  chunk: string,
  buffer?: string,
): { events: SseEvent[]; rest: string };
```

**职责边界**：`parseSse` 只懂 SSE 协议，**不懂 OpenAI/DeepSeek**。`data === '[DONE]'` 对它就是一条普通事件，含义由 `deepseek.ts` 解释。

### `core/commands.ts`

```ts
export type CommandName = 'clear' | 'history' | 'model';

export const COMMAND_NAMES: readonly CommandName[] = ['clear', 'history', 'model'];

export type ParsedCommand =
  | { kind: 'none' }
  | { kind: 'known'; name: CommandName; argument: string }
  | { kind: 'unknown'; input: string };

export type CommandResult =
  | { kind: 'cleared'; removed: number }
  | { kind: 'history'; messages: Message[] }
  | { kind: 'model-current'; model: string }
  | { kind: 'model-changed'; model: string };

export function parseCommand(line: string): ParsedCommand;
export function executeCommand(
  name: CommandName,
  argument: string,
  session: Session,
): CommandResult;
```

### `core/session.ts` 改动

```ts
export class Session {
  private messages: Message[] = [];

  constructor(private currentModel: string) {}

  get model(): string;
  set model(name: string);

  append(role: Role, content: string): void;
  toMessages(systemPrompt: string): Message[];

  /** 清空消息，返回清掉的条数（供反馈）；不影响当前模型 */
  clear(): number;

  /** 返回消息列表的**副本**，外部改不动内部状态 */
  history(): Message[];
}
```

> `constructor(model)` 是必填参数——会话总得知道自己在用哪个模型。这会连带修改 M1 的 2 个 `session.test.ts` 用例。

### `cli/repl.ts` 改动

```ts
export interface ReplOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  prompt: string;
  /** 会话的初始模型，通常来自 resolveConfig 的 config.model */
  model: string;
}

export async function runRepl(client: LLMClient, options: ReplOptions): Promise<void>;
```

### `cli/render.ts`

```ts
export interface StreamRenderer {
  onEvent(event: StreamEvent): void;
  /** 保证本轮正文后有且只有一个换行；正常与异常结束都要调用 */
  finish(): void;
}

export function createStreamRenderer(options: {
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
}): StreamRenderer;

export function renderCommandResult(
  result: CommandResult,
  options: { output: NodeJS.WritableStream },
): void;

export function renderUnknownCommand(
  input: string,
  options: { errorOutput: NodeJS.WritableStream },
): void;
```

---

## 7. SSE 分帧契约

`parseSse` 必须正确处理以下情形（全部是 `sse.test.ts` 的用例）：

| # | 情形 | 期望 |
| --- | --- | --- |
| 1 | 一次 chunk 含**多个**完整事件 | 全部解析出来，`rest` 为空串 |
| 2 | 一条事件被切成**两次** chunk | 第一次 `rest` 是半条，第二次补全后解析出来 |
| 3 | 事件之间以**空行**分隔 | 空行是 dispatch 边界 |
| 4 | 换行是 `\r\n`（SSE 规范允许） | 与 `\n` 等价处理 |
| 5 | `:` 开头的**注释行**（keep-alive） | 忽略，不影响 `rest` 归属 |
| 6 | 同一事件**多行 `data:`** | 按规范用 `\n` 拼接成一条 `data` |
| 7 | `data:` 后有一个**可选空格** | 剥掉该空格 |
| 8 | `event:` 字段 | 作为事件的 `event`；缺省 `'message'` |
| 9 | `id:` / `retry:` 等其他字段 | 忽略 |
| 10 | 尾部有**半条** `data:`（无空行收尾） | 进 `rest`，不产出事件 |

---

## 8. 流式请求契约

### 请求体

```json
{
  "model": "<本次模型>",
  "messages": [ ... ],
  "stream": true
}
```

**只传这三个字段，不传 `stream_options`。**

- 依赖方向：**`stream_options` 依赖 `stream: true`**（单独传它才 400），不是反过来。官方文档没有任何地方要求流式必须带 `stream_options`。
- 不加 `include_usage` 时，`usage` **仍然只在最后一个 chunk** 出现，供 M4 消费——所以 M2 现在加它没有任何收益。
- 这与项目既有约定一致：`deepseek.ts` 的注释写明「请求体只传本次用到的字段，`stream` / `temperature` 等都跟随服务端默认值，不额外发送」。

> 蓝图 §6 第 1 条原文写反了（写成「流式必须带 `stream_options`」），已于 2026-09-24 对照官方文档更正。

### 响应归一化（`deepseek.ts` 负责，`sse.ts` 不管）

| 上游 | 归一化 |
| --- | --- |
| `choices[0].delta.content` 非空串 | `{ type: 'text-delta', text }` |
| `choices[0].delta.reasoning_content` 非空串 | `{ type: 'reasoning-delta', text }` |
| `choices[0].finish_reason` 非 null | `{ type: 'done', reason }`，并标记本轮已 done |
| `data === '[DONE]'` 且本轮未 done | `{ type: 'done', reason: 'stop' }`（兜底） |
| `data === '[DONE]'` 且本轮已 done | 忽略 |
| 其他 chunk（如只有 role、usage） | 忽略 |

> **同一 chunk 可命中多行规则，必须都处理。** 最常见的是**最后一个 chunk 同时带 `delta.content` 和 `finish_reason`**——此时要**先吐 `text-delta` 再吐 `done`**，顺序不能反。漏掉这条会丢掉回答的最后一段文字。
>
> 判定按 `delta` 的字段逐个进行，不是 `switch` 整个 chunk。

**`finish_reason` 取值**：未知字符串不崩，原样作为 `reason` 传出（`FinishReason` 是宽松联合，解析时不做白名单校验——服务端新增取值不该让客户端崩）。

---

## 9. 空闲超时

- 常量：`STREAM_IDLE_TIMEOUT_MS = 30_000`，定义在 `deepseek.ts`（本次不做成配置项）
- 时机：每收到一个 chunk 重置计时器；**包括第一个 chunk 之前**（覆盖「首字节超时」）
  - **限定（2026-09-24 补）**：计时器在拿到 `response.body` **之后**才建立，
    `await fetch(...)` 之上没有本项目的时限 —— 服务端接受连接但不回响应头时会等到
    undici 默认的 `headersTimeout`（约 300s）才失败，不是 30s。它覆盖的是
    「**响应头之后的**首字节」；真正的首字节超时归 M6。见 `DECISIONS.md` D21
- 超时动作：只 reject 并抛 `new Error('流空闲超时（30s 无数据），已中断')`；连接由流收尾的 `reader.cancel()` 收掉（**没有** `AbortController`）
- 错误去向：`repl` 的 `catch` → stderr；**不追加 assistant 消息**

**测试方式**：常量以参数形式可注入（默认 30s），测试传一个极短值；或用假计时器。具体手法由实施计划决定。

---

## 10. 命令契约

**识别规则**：`line.trim()` 以 `/` 开头即视为命令尝试。

| 输入 | 行为 |
| --- | --- |
| `/clear` | `session.clear()` → `已清空 N 条消息。`（N=0 时同样输出） |
| `/history` | 列出 `session.history()`；每条截断到 **200 字符**并加 `…` |
| `/history`（空会话） | `(当前会话没有消息)` |
| `/model` | `当前模型：<name>` |
| `/model <name>` | `session.model = name` → `已切换模型：<name>` |
| `/model `（只有空格） | 等同无参数，显示当前模型 |
| 未知如 `/foo`、空 `/` | stderr：`未知命令：/foo。可用：/clear /history /model` |

> 提示里的可用命令列表**必须由 `COMMAND_NAMES` 拼接生成**，不要硬编码字符串——否则以后新增命令时提示不会跟着更新。空 `/` 时 `input` 原样展示为 `/`。

**`/history` 输出格式**：

```text
1. [user] 什么是 React Server Components？
2. [assistant] 它是只在服务器上渲染、其代码不会打进客户端 bundle 的组件…
```

**`/model` 不校验模型名**。理由：避免维护一份会过期的模型清单；`AI_CHAT_MODEL` 也没有校验。写错的模型名会在下一次请求时由 API 报错，走现有错误路径（stderr）。这是**有意选择**，不是遗漏。

---

## 11. 错误与边界

| 场景 | 行为 |
| --- | --- |
| 非 2xx | 沿用 M1：**开始读流之前**检查 `response.ok`，防御式解析错误体（`error.message` → 原始 body），抛 `DeepSeek API error {status}: {detail}` |
| 空闲超时 | 抛错 → stderr；本轮不 append |
| 流中途网络断开 | 同上。**已打印的半截答案留在屏幕上，但不进入上下文** |
| 单条事件 JSON 解析失败 | 跳过该事件，累计计数；流结束时 stderr 警告一次。**不因一条坏 chunk 丢掉整个回答**<br>**注（2026-09-24 补）**：M2a 仅实现「跳过」；「累计计数 + 流结束时 stderr 警告一次」**未落地** —— 原因（D-M2-3 的事件联合已冻结为 3 成员、`llm/` 不许写 stderr）与落点（M6）见 `DECISIONS.md` D23。本表此行与 §12 的测试清单本来也互相矛盾 |
| `finish_reason === 'length'` | 正常收尾，stderr 警告：`[警告] 回答被截断（finish_reason=length）` |
| 流正常结束但未收到 `done` | 不报错；`finish()` 照常收尾换行 |
| 未知的 `finish_reason` 取值 | 原样传出，不崩 |

**「屏幕 ≠ 上下文」**：中断后屏幕上能看到半截回答，但下一轮模型看不到它（因为没 append）。这条写在 `ARCHITECTURE.md` 的「运行时数据流」，否则会被误认为「模型忘了我刚才说过的话」。

---

## 12. 测试策略（全部离线）

| 文件 | 关键用例 |
| --- | --- |
| `sse.test.ts`【新】 | §7 表格的 10 种情形；多字节字符跨块（在 `TextDecoder` 层验证） |
| `commands.test.ts`【新】 | `parseCommand` 三态（none/known/unknown）；`/model` 有无参数；`/clear` 返回条数；`/history` 空会话 |
| `render.test.ts`【新】 | 事件序列 → stdout/stderr 各自内容；`[思考中…]` 只出现一次；`finish()` 保证单个换行；异常路径也补换行；`length` 警告 |
| `deepseek.test.ts`【改】 | `chatStream` 请求体含 `model` + `messages` + `stream: true`，且**不含** `stream_options`；假 SSE 响应体 → 断言事件序列；`finish_reason` → `done`；`[DONE]` 兜底；非 2xx；空闲超时；坏 JSON 事件被跳过 |
| `session.test.ts`【改】 | `new Session('m')`；`clear()` 返回条数且不影响 model；`history()` 返回副本（改返回值不影响内部） |
| `repl.test.ts`【改】 | fake client 换成带 `chatStream` 的；正文逐字写 stdout、`[思考中…]` 只写 stderr；命令不进上下文（`/clear` 后下一轮 messages 只剩 system）；`/history` 走 stdout |
| `config.test.ts`、`index.test.ts` | 不变 |

**约束：不在 `test/` 下放非 `*.test.ts` 的文件。** 已实测：`node --test` 会把 `test/` 下任何 `.ts` 当测试跑并计入用例数（`test/support/helper.ts` 会让用例数从 16 变 18）。因此**不引入共享 helper**——盘下来只有 `repl.test.ts` 需要 fake client，其余测的都是纯函数，各文件自带局部辅助即可。

---

## 13. 验收

```text
TypeCheck: pnpm run typecheck → 退出码 0
Test:      pnpm test          → 全绿（M1 的 16 个用例中改动过的仍通过，总数增加）
Build:     N/A（noEmit）
冒烟:      真实 key 下观察逐字输出；`/history` 有内容；`/clear` 后 messages 只剩 system；
           `/model deepseek-v4-pro` 后下一轮生效
分流:      pnpm --silent start > answers.txt 里只有回答与命令结果，无 [思考中…]、无 [error]
```

---

## 14. 官方文档核实结果（2026-09-24 已核）

原计划「实施时再核一遍」，实际在写计划前就核完了。结论如下，其中第 1 条**推翻了蓝图的一条记载**：

| # | 核实项 | 结论 |
| --- | --- | --- |
| 1 | `stream: true` 是否必须带 `stream_options` | **不需要。** 蓝图 §6 第 1 条写反了——依赖方向是 `stream_options` 依赖 `stream: true`，单独传 `stream_options` 才 400。已更正该条与 §12 的价格表旁注。 |
| 2 | `stream_options.include_usage` 的效果 | `true` 时每个 chunk 都带 `usage`（除末个外均为 `null`）；不传时 `usage` 只在末 chunk 出现。两种情况都不产生单独的 usage-only chunk。 |
| 3 | 末 chunk 的形状 | `choices` **只有一个元素、不带新内容、带非 null 的 `finish_reason`**，`usage` 与它同 chunk，紧接其后是 `data: [DONE]`。 |
| 4 | `finish_reason` 的位置 | 在 **choice 对象上**（与 `delta` 平级），不在 `delta` 里面。 |
| 5 | `delta` 的字段 | `content`、`reasoning_content`（thinking 模式专有）、`role`（只在首个 chunk）、`tool_calls`。**没有 `finish_reason`**。 |
| 6 | 流终止符 | `data: [DONE]`。每个 chunk 的 `id` 与时间戳相同，`object` 恒为 `chat.completion.chunk`。 |

由此确定：M2 的请求体**只传 `{ model, messages, stream: true }`**，不发 `stream_options`（M2 不消费 usage，发了没有收益）。
