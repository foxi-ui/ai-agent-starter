# 一轮对话发生了什么

> 回答：从敲下回车到看见回答，代码里实际执行了哪些步骤？
> 事实来源：`src/cli/repl.ts`、`src/core/session.ts`、`src/llm/deepseek.ts`。

## 数据流全貌

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

## 逐步说明

### 1. 读取一行

`src/cli/repl.ts` 用 `readline` 的**异步迭代器**逐行消费输入：

```ts
for await (const line of rl) { ... }
```

选择 `for await` 而不是 `rl.on('line', ...)` 的原因：每行的处理包含
`await client.chat(...)`。事件回调无法自然地串行化异步工作，快速连续输入时
会并发发起请求，导致上下文顺序错乱。异步迭代器保证**上一轮完全结束后**
才处理下一行。

循环在输入流关闭（EOF / Ctrl-D）时自然退出。

空行被 `continue` 跳过，因此不会污染上下文。

### 2. 累积用户消息

```ts
session.append('user', question);
```

`Session`（`src/core/session.ts`）内部只是一个 `Message[]`。它不关心网络，
只负责按顺序保存。

### 3. 组装请求消息

```ts
session.toMessages(SYSTEM_PROMPT)
```

返回 `[{ role: 'system', content: SYSTEM_PROMPT }, ...历史]`。
`system` 永远在最前，作为稳定前缀；其后是历次 `user` / `assistant` 交替。

`systemPrompt` 为空串时不插入 `system` 消息（便于测试与后续自定义）。

### 4. 发起请求

`createDeepSeekClient`（`src/llm/deepseek.ts`）用原生 `fetch` 发一次 POST：

```ts
POST {baseUrl}/chat/completions
headers: { 'content-type': 'application/json',
           authorization: `Bearer ${apiKey}` }
body:    { model, messages }
```

**非流式**：一次请求拿完整响应，不做 SSE 解析。

### 5. 解析响应

```ts
const content = data.choices[0]?.message?.content ?? '';
```

逐层可选链，缺字段时回落为空串——**任何一层缺失都不会抛错**。

### 6. 追加 assistant 并打印

```ts
session.append('assistant', result.content);
write(result.content);
```

这一步让下一轮能「记得」刚才的回答，从而支持「总结刚才内容」。

## 消息结构

直接对接 OpenAI-compatible 的消息数组：

```ts
type Role = 'system' | 'user' | 'assistant';
interface Message { role: Role; content: string; }
```

一次两轮对话后，实际发给 API 的 `messages`：

```text
第 1 轮： [ system, user ]
第 2 轮： [ system, user, assistant, user ]
```

这就是「多轮上下文」的全部机制——没有隐式状态，就是数组在累积。
上下文只在进程内存中，进程退出即清空。

## `content` 与 `reasoning_content`

DeepSeek 的响应中，`message` 可能同时包含两个字段：

| 字段 | 含义 |
| --- | --- |
| `message.content` | 最终回答（要打印的内容） |
| `message.reasoning_content` | 模型的思考过程（thinking 默认开启时会返回） |

本项目**只读取并打印 `content`**，`reasoning_content` 存在但被忽略。
adapter 显式只解构 `content` 字段，因此思考过程不会进入 `Session`，
也不会占用后续请求的上下文。

## 一轮对话在终端上的形状

需求（`docs/00-index.md`、spec §2、`README.md` 三处画的是同一份）：

```text
You: 什么是 React Server Components？
AI: ...
You: 总结刚才内容
AI: ...
```

三条规则，缺一条形状就不对：

1. **`You: ` 在每次读取之前写**，不是只在循环开始前写一次 —— 否则第二轮起用户是"盲打"
2. **提示符不补换行** —— 它要和用户输入同行（终端负责回显输入）
3. **`AI: ` 与正文一起写，且只在成功路径上写** —— 失败时 stdout 不会留下一个空的 `AI: `

**已知边界**：提示符写在读取之前，而 EOF 只有在读的时候才知道，所以**最后一次提示符
必然已经写出去**。文档没有规定退出时的行为，这里选择接受它（`pnpm start < q.txt` 的
输出会以 `You: ` 结尾）。见 `DECISIONS.md` D15。

## 错误处理策略

最小策略：**只保证不崩溃、不污染上下文**。正式的错误分类与重试属于后续增量。

| 场景 | 行为 |
| --- | --- |
| 启动时缺 `DEEPSEEK_API_KEY` | 打印提示，**退出码 1**（此时尚未进入 REPL） |
| 非 2xx（如 401） | 抛出 `DeepSeek API error {status}: {detail}`，由 REPL 捕获后打印 `[error] ...`，**继续循环** |
| `fetch` 抛错（DNS / 连接拒绝） | 同上，异常向上冒泡到 REPL 的 `try/catch` |
| 响应缺 `choices[0].message.content` | 不抛错，返回 `content: ''` |

**输出去向**：模型回答走 **stdout**，错误与诊断走 **stderr**。
因此 `pnpm start > answers.txt` 得到的文件里只有回答；
`pnpm start 2>/dev/null` 也能单独屏蔽报错。

`ReplOptions` 因此有两个输出通道（`output` / `errorOutput`），
且都是必填字段——忘记分流会在类型检查阶段被拦下。

两个细节：

1. **失败的轮次不追加 assistant 消息。** `session.append('assistant', ...)` 只在
   `chat()` 成功返回后执行，因此报错不会在历史中留下空洞。
2. **错误信息优先取 API 返回的 `error.message`。** 非 2xx 时先尝试把 body 解析成
   JSON 并取 `error.message`（例如 `Invalid API key`）；解析失败则回落到原始 body 文本。

### 错误后的上下文形状

输入 `第一问` → `fail` → `第三问`，实际发给 API 的消息：

```text
第 1 轮： [ system, user(第一问) ]                              → 成功，追加 assistant
第 2 轮： [ system, user, assistant, user(fail) ]               → 401，不追加
第 3 轮： [ system, user, assistant, user(fail), user(第三问) ]  → 成功
```

可以看到失败的 `user(fail)` 保留在历史中（用户确实说过），但对应的
`assistant` 缺失——**不会伪造一条空回答**。

## 流式：屏幕上看到的 ≠ 模型记得的

流式输出会**边收边打印**，所以中途失败时屏幕上会留下半截回答。但那半截
**不会**进入 `Session` —— `session.append('assistant', …)` 只在流正常结束后执行。

后果：下一轮模型看不到那半截内容。你看到的和它记得的是两回事，
这不是 bug，是「失败轮次不写上下文」这条规则的必然结果（见 D7）。

## 验证方式

上述行为都有对应测试，且全部不需要网络：

| 行为 | 测试 |
| --- | --- |
| 消息按序累积、`system` 在最前 | `test/session.test.ts` |
| 请求体 / 响应解析 / 401 抛错 / 空 content / fetch 抛错 / 非 JSON 错误体 | `test/deepseek.test.ts`（mock `globalThis.fetch`） |
| 一问一答、错误写 stderr 不污染 stdout、报错后继续、多轮上下文形状 | `test/repl.test.ts`（fake `LLMClient`） |
| 缺 key 抛错、默认值、环境变量覆盖 | `test/config.test.ts` |
| 缺 key 时 stderr 提示 + 退出码 1 | `test/index.test.ts`（子进程集成测试） |

```bash
pnpm test
```
