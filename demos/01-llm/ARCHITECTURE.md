# 架构

> 回答：这个系统由什么组成，一轮请求实际跑过了哪些步骤？
> 事实来源：`src/` 实际源码目录。

## 总览

三层内核，依赖方向**严格单向**：

```text
cli/      readline 主循环、打印、配置解析、参数解析、会话文件的读写
  ↓  只依赖 core 与 llm 的公开接口
core/     会话状态、消息组装、会话日志的纯逻辑（格式 / 解析 / 回放）
  ↓  只依赖 core 自身类型
llm/      DeepSeek adapter：请求构造、响应解析、SSE 分帧与事件归一化
```

关键约束（由 spec 规定，代码需遵守）：

- `llm/` 与 `core/` **不 import `node:readline`**，**不写 `process.stdout` / `process.stderr`**。
  副作用只允许出现在 `cli/` 与 `src/index.ts`。
- `core/` **不 import `node:fs`**（M3 起延伸出的同一条规则）：会话日志的格式与回放
  在 `core/journal.ts` 里是纯逻辑，真正读写文件的 `cli/store.ts` 是它唯一的实现。
- 边界接口是 `LLMClient`（网络）与 `SessionStore`（磁盘）。测试用替身替换它们，
  使 CLI 行为能在**无网络、无文件系统**下断言。

这套骨架为后续增量（命令 / 落盘 / token 统计）预留了挂载点：新增能力主要落在
`llm/`（如何调用）与 `cli/`（如何交互），`core/` 保持稳定。
**streaming（M2a）已经按这个方式落过一遍** —— 新增 `llm/sse.ts` 与 `cli/render.ts`
两个文件，`core/types.ts` 只多了几个类型，`core/session.ts` 只多了一个 `model` 存取器。
**commands（M2b）** 是这条法则的一个例外：命令逻辑落在**新增的 `core/commands.ts`** 里，
因为 `core` 不许写 stdout，所以「改 Session」留在 core、「打印」放进 `cli/render.ts` —— 分层反而更严了。
**persistence（M3）** 沿用同一条思路再切一刀：会话日志的**格式与回放**（`core/journal.ts`）
是纯逻辑，**文件读写**（`cli/store.ts`）留在 cli，于是 core 至今不 import `node:fs`。
**context（M4a）** 是同一法则的又一次应用：上下文预算的裁剪策略是**新增的
`core/context.ts`** 里的纯函数，由 `cli/repl.ts` 在组装之后调一次 ——
它**不进 `Session`**，因为预算是策略而不是状态。
**usage（M4b）** 沿同一条思路：时段判断与计价是**新增的 `core/usage.ts`** 里的
纯函数 + 一个只碰内存的 `UsageLedger`，落盘由 `cli/repl.ts` 直接调 `store.append` ——
账本**不进 `Session`**，也就**不走 `onChange` 广播**（见下文的落盘路径）。

## 模块职责

| 文件 | 层 | 职责 | 不负责 |
| --- | --- | --- | --- |
| `src/index.ts` | 入口 | 解析配置与命令行参数、新建或恢复会话、组装依赖、启动 REPL；任一前置步骤失败退出码 1 | 任何对话逻辑 |
| `src/cli/config.ts` | cli | 环境变量 → `Config`，集中默认值 | 读取 `process.env` 之外的事 |
| `src/cli/args.ts` | cli | 命令行参数 → `Args`（`fresh` / `resume`）；纯函数，非法输入抛错（消息带用法） | 打印、退出码、文件系统 |
| `src/cli/store.ts` | cli | `SessionStore` 的文件实现：建文件（独占创建）、追加、读取、列出；两道路径校验 | 记录格式与回放语义 |
| `src/cli/repl.ts` | cli | readline 主循环、解析并执行斜杠命令（经 `core/commands.ts`）、调用 `LLMClient`、经渲染器呈现流式结果（错误直写 stderr）、把会话变更落盘（`onChange`） | HTTP、消息组装细节、记录格式 |
| `src/core/types.ts` | core | `Role` / `Message` / `ChatResult` / `StreamEvent` / `FinishReason` / `ChatOptions` 类型定义 | 行为 |
| `src/core/journal.ts` | core | 会话日志的**纯逻辑**：记录类型、序列化/解析、`replay` 回放、会话 id 生成与校验、`SessionStore` 接口 | 文件 IO、打印 |
| `src/core/session.ts` | core | 消息数组累积；`toMessages(systemPrompt)` 组装请求消息；变更广播（`onChange`） | 网络、打印、落盘、**预算** |
| `src/core/context.ts` | core | 上下文预算：`estimateTokens` 保守估算、`fitToBudget` 按轮裁剪（纯函数）；结果**只用于本次请求** | 会话状态、IO、打印 |
| `src/core/commands.ts` | core | 命令解析（`parseCommand`）与执行（`executeCommand` → `CommandResult`）；只改 `Session`、不打印；外部数据经 `CommandDeps` 注入 | 打印、网络、文件系统 |
| `src/core/usage.ts` | core | 用量与成本：`periodAt` 时段判断（北京时间 + 2026 法定节假日表）、`costOf` 峰谷分档计价、`UsageLedger`（纯逻辑，不落盘、不打印） | IO、打印、真实账单核对 |
| `src/llm/client.ts` | llm | `LLMClient` 接口 + `LLMClientConfig`（测试接缝） | 具体实现 |
| `src/llm/deepseek.ts` | llm | `fetch` 调用 `/chat/completions`（非流式 + 流式）、解析 `content` 与 `usage`、把 SSE chunk 归一化成 `StreamEvent`、非 2xx 抛错 | 打印、重试 |
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

`ChatOptions` 是**每次请求**的参数（`model` 与 `thinking` 开关），定义在 `core/types.ts`。
它随请求传，而不是塞进 `LLMClientConfig` —— 否则 client 会变成有状态的，
多会话共享时互相污染（见 D17）。

`thinking` 是 `boolean` 而不是照抄 API 的 `{ type: 'enabled' | 'disabled' }`：
`core/types.ts` 是**项目自己的**类型，把它拼成请求体的形状是 `llm/` 层的职责。
`thinking: false` → 请求体带 `{ thinking: { type: 'disabled' } }`；为 `true` 或
**不传** → 请求体里连这个键都没有（服务端默认为开启，见 D-M4a-10）。

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
| `cli` → `node:fs`（只有 `cli/store.ts` 一处） | `core` → `node:fs` |
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
- **会话落盘是事件流**：`.sessions/<id>.jsonl` 一行一条记录，回放即重建
  （见 `runtime` 一节与 D28）。它**不是**「一份消息快照」，`/clear` 与 `/model`
  这类没有对应消息的状态变更同样会被记下来。
- **磁盘只落后、不阻断**：写盘失败不打断对话，只是磁盘落后于内存并给一行警告（D34）。
- **会话 id 是路径的一部分**，因此受白名单校验 + 路径包含检查两道路径防线约束（D32）。
- **裁剪不回写会话**：`fitToBudget` 的结果只用于本次请求，`Session` 与 JSONL 始终是
  完整历史（D-M4a-5）。
- **金额不是账单**：`/usage` 的数字是**估算** —— 价目表是代码里的常量（与事实文档的
  一致性由 `test/pricing.test.ts` 钉住），时段按**每条记录自己的 `at`** 判断，
  节假日表只覆盖 2026 年，且**中断的轮次不计入**。所以输出里那两行
  「口径」「范围」是硬要求，不是客套话（D57）。
- **开关不落盘**：`--show-reasoning` / `--no-thinking` / `--max-context` 是「本次启动的
  偏好」而不是会话状态，因此不进 `Session`、不动 JSONL 格式契约（D-M4a-7）。

## 运行时数据流

> 一轮请求实际发生了什么。静态结构见上文「模块职责」，决策理由见 `DECISIONS.md`。
> 事实来源：`src/index.ts`、`src/cli/repl.ts`、`src/cli/render.ts`、`src/core/session.ts`、`src/core/journal.ts`、`src/llm/deepseek.ts`、`src/llm/sse.ts`。

### 启动：从进程启动到 REPL 就绪

```text
resolveConfig(process.env)          # 缺 DEEPSEEK_API_KEY → stderr + 退出码 1
      ↓                             #   （排在参数解析之前，保持 M1 的既有行为）
parseArgs(process.argv.slice(2))    # 非法参数 → stderr + 退出码 1
      ↓                             #   --resume / --show-reasoning / --no-thinking /
      ↓                             #   --max-context；前两者互斥。以上两步都在建文件之前
createFileStore(AI_CHAT_HOME ?? '.sessions')
      ↓
  ┌─ fresh ──────────────────────────────────────────────┐
  │ makeSessionId(now, randomBytes(2))   # 本地时间 + 随机后缀 │
  │ store.create(id, model)              # 独占创建 + 写 meta 行 │
  │ stderr: [session] <id>               │
  └──────────────────────────────────────────────────────┘
  ┌─ resume <id> ────────────────────────────────────────┐
  │ store.load(id)  → null ? stderr「会话不存在」+ 退出码 1   │
  │ replay(records) → { messages, model }                │
  │ model 缺失时回落到 config.model                        │
  │ stderr: [resumed] <id>（N 条消息）                     │
  └──────────────────────────────────────────────────────┘
      ↓
runRepl(client, { sessionId, history, store, showReasoning, noThinking, maxContext, … })
```

三条诊断信息（`[session]` / `[resumed]` / `[警告]`）都走 **stderr**：它们是诊断，
不是用户要的输出，stdout 仍然只承载模型回答与命令结果。

**恢复出来的历史只在构造时铺进 `Session`，不走 `append`** —— 否则每恢复一条历史
就会多写一行日志，打开一次会话文件就翻一倍（见 D29）。

### 数据流全貌

```text
readline 读到一行
  │
  ├─ line.trim() === '' ? 跳过（空行不进入上下文）
  │
  ├─ session.append('user', question)
  │       └─ onChange 广播 → store.append(id, change) → 追加一行 JSON
  │
  ├─ messages = session.toMessages(SYSTEM_PROMPT)     # [system, ...完整历史]
  │
  ├─ fitToBudget(messages, maxContext)                # 只影响这一次请求（M4a）
  │       └─ 裁掉了东西 → stderr 一行 [上下文] 警告
  │
  ├─ client.chatStream(fitted.messages, { model: session.model, thinking? })
  │       → POST {baseUrl}/chat/completions
  │         body: { model, messages, stream: true }   # thinking 只在关闭时多一个键
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

### 步骤 4：裁剪到预算之内（M4a）

```ts
const fitted = fitToBudget(session.toMessages(SYSTEM_PROMPT), options.maxContext);
if (fitted.dropped > 0) {
  writeError(`[上下文] 已裁剪 ${fitted.dropped} 条最早的消息（约 ${fitted.droppedTokens} token）`);
}
```

`fitToBudget`（`src/core/context.ts`）是**纯函数**，只做三件事：估算、按轮分组、
从最老的组开始丢。两条规则不可违反：**`system` 永不裁**、**最后一组（当前问题）永不裁**。

三个设计点：

1. **裁剪结果只用于本次请求，不回写 `Session`、不影响落盘。** `Session` 与 JSONL 始终
   是完整历史，所以每一轮都会拿完整历史重新裁一遍。这是「发给模型的内容」与
   「会话记得的内容」的区别 —— 与 D7 的「屏幕上看到的 ≠ 模型记得的」是同一类边界（D-M4a-5）。
2. **按 `user` 消息切轮，不按 role 交替推。** 失败的轮次只留 `user` 不留 `assistant`（D7），
   历史里会出现两个相邻的 `user`；按交替推会在那里切错（D-M4a-3）。
3. **裁掉了才警告，且只一行。** 静默的话用户只会觉得「模型怎么把前面忘了」（D-M4a-4）。

估算用 `chars / 1.5` 上取整，**不是**蓝图写的 `chars / 4` —— 后者对中文是低估，
方向恰好不保守（D-M4a-1）。`--max-context` 可以把预算调到几百 token，
让这条路径在真实使用中能被观察到。

### 步骤 5：发起请求

`createDeepSeekClient`（`src/llm/deepseek.ts`）用原生 `fetch` 发一次 POST：

```ts
POST {baseUrl}/chat/completions
headers: { 'content-type': 'application/json',
           authorization: `Bearer ${apiKey}` }
body:    { model, messages, stream: true }
```

**流式**：body 只发这三个字段，**不发 `stream_options`** —— 官方文档没有要求流式
必须带它（依赖方向是反的：单独传 `stream_options` 才返回 400），且官方口径是不传它时
`usage` 也出现在最后一个 chunk 上。M4b 起确实消费 `usage` 了，但前提未变，
所以请求体仍然不变（2026-09-28 实测确认：不传它也能拿到非零 usage，
见 `docs/deepseek-api-facts.md` 的「接口」）。

响应是一个 SSE **字节流**，要经过三步才变成 `StreamEvent`：

```text
response.body.getReader()  逐块 read 出 Uint8Array
      ↓  TextDecoder({ stream: true }).decode(chunk)   跨块的多字节字符在这里补齐
      ↓  parseSse(chunk, buffer) → { events, rest }    纯函数分帧，残缺的尾巴进 rest
      ↓  归一化                                          data 里的 JSON → StreamEvent
```

### 步骤 6：解析响应（`chat()` 的非流式路径）

流式路径的正文来自下面步骤 7 的 `text-delta` 累积。而 `chat()` 这条**非流式**路径
仍然保留着（见 D16），它一次拿到完整 JSON，解析方式没变：

```ts
const content = data.choices[0]?.message?.content ?? '';
const usage = data.usage === undefined ? undefined : toTokenUsage(data.usage);
```

`usage` 的归一化（`toTokenUsage`）是**防御式**的：任何字段缺失、类型不对、
整个对象不存在，都退回 0，**永不抛错** —— 统计拿不到不该毁掉一轮对话。
「API 没给 usage」用 `undefined` 表达，而不是全 0：「没拿到」与「真的是 0」是两回事。

逐层可选链，缺字段时回落为空串——**任何一层缺失都不会抛错**。

### 步骤 5b：usage 事件（M4b）

`StreamEvent` 有四种变体，`usage` 是第四个。**顺序契约：`usage` 永远先于 `done`**
（D-M4b-2）—— `done` 是终止信号，消费者见到它可能 break 出循环，之后 yield 的
就永远拿不到了。真实响应里两者常常在**同一个**末 chunk 上，所以这不是理论问题。

渲染器对它是**显式忽略**（`cli/render.ts` 里那个独立的 `if`）：那条 `if` 链的最后
一个分支原本是隐式的 `done`，加了第四个变体之后「走到这里的一定是 done」不再成立，
不拦它就会每轮多写一个 `AI: ` 前缀（D-M4b-11）。用量由 `/usage` 按需展示。

### 步骤 7：渲染事件并追加 assistant

正文由**渲染器**（`src/cli/render.ts`）逐块写到 stdout：第一个 `text-delta` 到达时
先写 `AI: ` 前缀，之后每来一块正文就接着写，**不补换行**（换行统一由收尾负责）。
另外 `done` 分支有个**兜底**：整轮一个字都没产出（比如空回答）时也补上前缀 ——
空回答在流式与非流式两条路径下的形状必须一致（见 `test/render.test.ts`）。

**思考过程**（`reasoning-delta`）按 `--show-reasoning` 分两种呈现，**都走 stderr**：

| 模式 | stderr 上的形状 |
| --- | --- |
| 默认 | 首个 delta 时一行 `[思考中…]`，正文不打印 |
| `--show-reasoning` | `[思考] ` 前缀 + 思考全文（前缀只在真有内容时写） |

两条流都不把思考放进 stdout：那样 `pnpm start > answers.txt` 拿到的就不只是回答了（D-M4a-6）。

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

### 落盘路径：一次变更怎么变成一行日志

```text
session.append(role, content) / session.clear() / session.model = name
      ↓  先改内存状态
      ↓  再广播：this.onChange?.({ type: 'message' | 'clear' | 'model', … })
cli/repl.ts 的 onChange 实现：store.append(options.sessionId, change)
      ↓
cli/store.ts：serializeRecord(change) + '\n' → appendFileSync(<id>.jsonl)
```

**`usage` 记录是这条路唯一的例外**（M4b）：它由 `cli/repl.ts` 在成功轮次
**直接**调 `store.append(id, { type: 'usage', entry })`，不经过 `Session`、
也不走 `onChange`。之所以破例：`onChange` 解决的是「**看不见的写入点**」——
`/clear` 与 `/model` 是 `executeCommand` 内部改的状态，repl 看不见；而
`ledger.record()` 只有一个调用点，就在 repl 的循环里、紧挨着落盘那几行。
给一个看得见的写入点加一套广播，是给不存在的问题上保险（D65）。
它仍然并入 `SessionChange` 联合，只是为了不让 `store.append` 的签名放宽。

由此推出一条常被写错的规则：**`/clear` 不清账本**。账本记的是「这个会话文件
累计花了多少」，钱已经花掉了，与消息内容无关（D64）。回放时 `clear` 同样
只清 `messages`，不动 `usageEntries`。

四个设计点：

1. **广播，而不是让 repl 在每个变更点手动写。** `/clear` 与 `/model <name>` 是
   `executeCommand` **内部**改的状态，repl 的循环里看不见它们 —— 「记得每处补写」
   的写法迟早会漏（见 D29）。
2. **先改内存、再广播。** 写盘抛错时内存状态已经改好，不会留下「推了一半」的中间态；
   降级方向是「磁盘落后于内存 + 一行警告」，而不是丢弃这次对话（见 D34，实现在
   `cli/repl.ts` 的 `reportWriteFailure`，**只警告一次**）。
3. **只读操作永不广播。** `toMessages()` / `history()` / `get model`（即 `/model`
   无参数的查询分支）都不写状态，也就不写日志。`/usage` 同理 —— 它是纯查询，
   `test/commands.test.ts` 专门用写入探针钉住了「零广播」。
4. **写盘失败共用同一条降级路径。** usage 记录的 `append` 也包在 `reportWriteFailure`
   里，所以「只警告一次」这条降级自动覆盖它，不需要第二套闩（`test/repl.test.ts`）。

> 回放的 `clear` **只清消息、不清模型**，与 `Session.clear()` 的语义严格对齐 ——
> 否则 resume 出来的模型会和清空前不一致（见 `core/journal.ts` 的 `replay`）。

### 流式：屏幕上看到的 ≠ 模型记得的

流式输出会**边收边打印**，所以中途失败时屏幕上会留下半截回答。但那半截
**不会**进入 `Session` —— `session.append('assistant', …)` 只在流正常结束后执行。

后果：下一轮模型看不到那半截内容。你看到的和它记得的是两回事，
这不是 bug，是「失败轮次不写上下文」这条规则的必然结果（见 D7）。
