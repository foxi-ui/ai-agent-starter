# 架构

> 回答：这个系统由什么组成，一轮请求实际跑过了哪些步骤？
> 事实来源：`src/` 实际源码目录。

## 总览

三层内核，依赖方向**严格单向**：

```text
cli/      readline 主循环、打印、配置解析
  ↓  只依赖 core 与 llm 的公开接口
core/     会话状态、消息组装
  ↓  只依赖 core 自身类型
llm/      DeepSeek adapter：请求构造、响应解析、SSE 分帧与事件归一化
```

关键约束（由 spec 规定，代码需遵守）：

- `llm/` 与 `core/` **不 import `node:readline`**，**不写 `process.stdout` / `process.stderr`**。
  副作用只允许出现在 `cli/` 与 `src/index.ts`。
- 边界接口是 `LLMClient`。测试用替身替换它，使 CLI 行为能在**无网络**下断言。

这套骨架为后续增量（命令 / 落盘 / token 统计）预留了挂载点：新增能力主要落在
`llm/`（如何调用）与 `cli/`（如何交互），`core/` 保持稳定。
**streaming（M2a）已经按这个方式落过一遍** —— 新增 `llm/sse.ts` 与 `cli/render.ts`
两个文件，`core/types.ts` 只多了几个类型，`core/session.ts` 只多了一个 `model` 存取器。
**commands（M2b）** 是这条法则的一个例外：命令逻辑落在**新增的 `core/commands.ts`** 里，
因为 `core` 不许写 stdout，所以「改 Session」留在 core、「打印」放进 `cli/render.ts` —— 分层反而更严了。

## 模块职责

| 文件 | 层 | 职责 | 不负责 |
| --- | --- | --- | --- |
| `src/index.ts` | 入口 | 解析配置、组装依赖、启动 REPL；配置缺失时退出码 1 | 任何对话逻辑 |
| `src/cli/config.ts` | cli | 环境变量 → `Config`，集中默认值 | 读取 `process.env` 之外的事 |
| `src/cli/repl.ts` | cli | readline 主循环、解析并执行斜杠命令（经 `core/commands.ts`）、调用 `LLMClient`、经渲染器呈现流式结果（错误直写 stderr） | HTTP、消息组装细节 |
| `src/core/types.ts` | core | `Role` / `Message` / `ChatResult` / `StreamEvent` / `FinishReason` / `ChatOptions` 类型定义 | 行为 |
| `src/core/session.ts` | core | 消息数组累积；`toMessages(systemPrompt)` 组装请求消息 | 网络、打印 |
| `src/core/commands.ts` | core | 命令解析（`parseCommand`）与执行（`executeCommand` → `CommandResult`）；只改 `Session`、不打印 | 打印、网络 |
| `src/llm/client.ts` | llm | `LLMClient` 接口 + `LLMClientConfig`（测试接缝） | 具体实现 |
| `src/llm/deepseek.ts` | llm | `fetch` 调用 `/chat/completions`（非流式 + 流式）、解析 `content`、把 SSE chunk 归一化成 `StreamEvent`、非 2xx 抛错 | 打印、重试 |
| `src/llm/sse.ts` | llm | SSE 分帧（纯函数，只懂协议不懂 DeepSeek） | 网络、解码、事件语义 |
| `src/cli/render.ts` | cli | `StreamEvent` 与 `CommandResult` → stdout/stderr 的呈现：`createStreamRenderer` / `renderCommandResult` / `renderUnknownCommand` | 累积正文、解析命令、网络 |
| `loader.mjs` | 构建 | 向 Node 注册 `@/` 别名钩子 | 业务逻辑 |
| `loader-hooks.mjs` | 构建 | 把 `@/x` 解析为 `src/x` 的真实文件 URL | 业务逻辑 |

## 接口边界

`src/llm/client.ts` 是整个架构的接缝：

```ts
export interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamEvent>;
}

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type LLMClientFactory = (config: LLMClientConfig) => LLMClient;
```

`ChatOptions` 是**每次请求**的参数（目前只有 `model`，将来还会加 thinking 开关），
定义在 `core/types.ts`。它随请求传，而不是塞进 `LLMClientConfig` —— 否则 client
会变成有状态的，多会话共享时互相污染（见 D17）。

- `cli/repl.ts` 只依赖 `LLMClient`，不知道 DeepSeek 的存在。
- `llm/deepseek.ts` 是它的一个实现。
- 测试直接传入手写替身（见 `test/repl.test.ts` 的 `fakeClient`），因此
  **REPL 的全部行为都能在没有网络、没有 API key 的情况下断言**。

这是「可测试性」在这里的具体含义：把网络调用收敛到一个接口后面。

## 依赖规则

| 允许 | 禁止 |
| --- | --- |
| `cli → core`、`cli → llm` | `core → cli`、`llm → cli` |
| `llm → core`（只取类型）；`llm/sse.ts` 是纯函数，不碰 IO | `core → llm` |
| 任意层 → `node:` 内置模块 | `llm` / `core` → `node:readline` |
| `core` / `llm` 导出纯函数与类型 | `core` / `llm` 写 `process.stdout` |

`core` 与 `llm` 之间只有类型依赖（`import type`），运行时不存在 `core → llm` 的边。

## `@/` 路径别名

源码统一用 `@/` 指向 `src/`：

```ts
import { Session } from '@/core/session.ts';
```

**这件事需要特别说明**，因为 Node 的原生类型擦除**不读取 `tsconfig.json` 的
`paths`**：

- `tsc` 依据 `tsconfig.json` 的 `paths` 做类型检查 → 别名对类型检查有效。
- Node 运行时完全不看 `paths` → 别名对运行时**无效**。

结果是：`@/` 出现在 `import type` 中能侥幸工作（该语句在运行前被整体擦除），
但一旦出现在**值导入**中，就会在运行时抛 `ERR_MODULE_NOT_FOUND`。

因此项目注册了一个 `resolve` 钩子把别名补上：

```text
loader.mjs         通过 node --import 加载，调用 module.register()
      ↓ 注册
loader-hooks.mjs   在钩子线程中把 @/x 解析为 src/x 的文件 URL
```

`package.json` 的 `start` 与 `test` 脚本都带上 `--import ./loader.mjs`
（`node --test` 会把 `--import` 传递给派生的测试子进程）。

> **注意**：`--import` 只是「导入」模块，并不会自动把其中的 `resolve` 导出当作钩子，
> 必须显式调用 `module.register()`。这是两个文件而非一个文件的原因。

`tsconfig.json` 同时开启了 `allowImportingTsExtensions`：本项目在值导入中写
`'./x.ts'` 显式扩展名（配合原生类型擦除），不开这个选项会报 `TS5097`。

## 重要约束

- **零运行时依赖**：`dependencies` 为空。`loader-hooks.mjs` 只用 `node:` 内置模块。
- **密钥不落代码**：`apiKey` 只从环境变量读入，经 `Config` 传给 adapter。
- **上下文只在内存**：进程退出即清空。持久化属于后续增量。

## 运行时数据流

> 一轮请求实际发生了什么。静态结构见上文「模块职责」，决策理由见 `DECISIONS.md`。
> 事实来源：`src/cli/repl.ts`、`src/cli/render.ts`、`src/core/session.ts`、`src/llm/deepseek.ts`、`src/llm/sse.ts`。

### 数据流全貌

```text
readline 读到一行
  │
  ├─ line.trim() === '' ? 跳过（空行不进入上下文）
  │
  ├─ session.append('user', question)
  │
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

### 步骤 1：读取一行

`src/cli/repl.ts` 用 `readline` 的**异步迭代器**逐行消费输入，但**手写迭代**而不是
`for await`：

```ts
const lines = rl[Symbol.asyncIterator]();
// ...
writePrompt();                      // 提示符必须写在「读取」之前
const { value: line, done } = await lines.next();
```

不用 `rl.on('line', ...)` 的原因：每行的处理包含 `await`（消费
`client.chatStream(...)` 返回的整个事件流）。事件回调无法自然地串行化异步工作，
快速连续输入时会并发发起请求，导致上下文顺序错乱。异步迭代器保证
**上一轮完全结束（流读到底）后**才处理下一行。

之所以不写成 `for await (const line of rl)`：提示符必须在**读取下一行之前**写出，
而 `for await` 把「读取」藏在语法里，拿不到这个时机（见 D15）。串行语义不变。

循环在输入流关闭（EOF / Ctrl-D）时自然退出。

空行被 `continue` 跳过，因此不会污染上下文。

### 步骤 2：累积用户消息

```ts
session.append('user', question);
```

`Session`（`src/core/session.ts`）内部只是一个 `Message[]`。它不关心网络，
只负责按顺序保存。

### 步骤 3：组装请求消息

```ts
session.toMessages(SYSTEM_PROMPT)
```

返回 `[{ role: 'system', content: SYSTEM_PROMPT }, ...历史]`。
`system` 永远在最前，作为稳定前缀；其后是历次 `user` / `assistant` 交替。

`systemPrompt` 为空串时不插入 `system` 消息（便于测试与后续自定义）。

### 步骤 4：发起请求

`createDeepSeekClient`（`src/llm/deepseek.ts`）用原生 `fetch` 发一次 POST：

```ts
POST {baseUrl}/chat/completions
headers: { 'content-type': 'application/json',
           authorization: `Bearer ${apiKey}` }
body:    { model, messages, stream: true }
```

**流式**：body 只发这三个字段，**不发 `stream_options`** —— 官方文档没有要求流式
必须带它（依赖方向是反的：单独传 `stream_options` 才返回 400），而 M2 也不消费
`usage`，发了没有收益（见 `docs/deepseek-api-facts.md` 的「接口」）。

响应是一个 SSE **字节流**，要经过三步才变成 `StreamEvent`：

```text
response.body.getReader()  逐块 read 出 Uint8Array
      ↓  TextDecoder({ stream: true }).decode(chunk)   跨块的多字节字符在这里补齐
      ↓  parseSse(chunk, buffer) → { events, rest }    纯函数分帧，残缺的尾巴进 rest
      ↓  归一化                                          data 里的 JSON → StreamEvent
```

### 步骤 5：解析响应（`chat()` 的非流式路径）

流式路径的正文来自下面步骤 6 的 `text-delta` 累积。而 `chat()` 这条**非流式**路径
仍然保留着（见 D16），它一次拿到完整 JSON，解析方式没变：

```ts
const content = data.choices[0]?.message?.content ?? '';
```

逐层可选链，缺字段时回落为空串——**任何一层缺失都不会抛错**。

### 步骤 6：渲染事件并追加 assistant

正文由**渲染器**（`src/cli/render.ts`）逐块写到 stdout：第一个 `text-delta` 到达时
先写 `AI: ` 前缀，之后每来一块正文就接着写，**不补换行**（换行统一由收尾负责）。
另外 `done` 分支有个**兜底**：整轮一个字都没产出（比如空回答）时也补上前缀 ——
空回答在流式与非流式两条路径下的形状必须一致（见 `test/render.test.ts`）。

```ts
for await (const event of stream) {
  renderer.onEvent(event);                                // 呈现：stdout 出正文、stderr 出指示
  if (event.type === 'text-delta') text += event.text;    // 累积：由 repl 自己攒
}
session.append('assistant', text);
```

累积**不在渲染器里做**：只有攒出完整正文才能写进 `Session` 当上下文，那是 repl 的
职责；渲染器只管「这一轮在终端上长什么样」。

`renderer.finish()` 在 `finally` 里调用，保证正文后有**且只有一个**换行 —— 否则下一次
`You: ` 提示符会接在半句话后面。正常与异常路径都走它。

这一步让下一轮能「记得」刚才的回答，从而支持「总结刚才内容」。

### 流式：屏幕上看到的 ≠ 模型记得的

流式输出会**边收边打印**，所以中途失败时屏幕上会留下半截回答。但那半截
**不会**进入 `Session` —— `session.append('assistant', …)` 只在流正常结束后执行。

后果：下一轮模型看不到那半截内容。你看到的和它记得的是两回事，
这不是 bug，是「失败轮次不写上下文」这条规则的必然结果（见 D7）。
