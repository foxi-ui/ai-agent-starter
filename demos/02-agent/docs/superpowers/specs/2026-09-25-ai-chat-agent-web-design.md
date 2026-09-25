# ai-chat-agent 前后端分离改造 · 设计文档

- 日期：2026-09-25
- 状态：待 review
- 范围：阶段二「LLM + Tool Calling」——把纯 CLI 的 Agent 项目改造成**前后端分离 + 浏览器聊天对话框**，
  自实现 Agent（Agent Loop + Tool Schema + Tool Registry），工具本地、非流式。
- 前置项目：`demos/01-llm`（阶段一，M1–M3 完成态），本项目的代码底座**复制自它**。
- 被取代的文档：`2026-09-23-ai-chat-agent-design.md`（纯 CLI 版设计，已作废，正文保留作为历史记录）。

---

## 1. 背景与目标

### 1.1 为什么要重新设计

原设计（2026-09-23）把阶段二定义为一个**纯 CLI** 项目，且它「复制底座」时复制的是 **M1 时代的 01-llm** ——
它的「明确推迟」清单里写着「streaming（SSE 解析）」「会话持久化（JSONL 落盘、`--resume`）」
「命令 `/clear` `/history` `/model`」，**这三样 01-llm 现在已经全部做完了**（M3 完成态，167 个用例）。

也就是说，原设计描述的起点已经不存在了。同时用户提出新的产品要求：

> 把项目 2 改成一个有前端聊天对话框的、分前后端的项目。聊天对话框前期只做简单的输入展示，
> 先把 Agent 流程打通。服务端（后端）使用 Node + express。

于是本次重新设计的有两件事，而不是一件：

1. **改造形态**：从纯 CLI 改为「CLI + HTTP 服务 + 浏览器前端」三段
2. **重新划范围**：起点从 M1 底座改为 M3 底座，原设计里三条「推迟」全部需要重新判定

### 1.2 目标

以天气为例，端到端跑通：

```text
浏览器输入：北京今天天气怎么样？
    ↓ POST /api/sessions/:id/messages
Agent：需要天气工具
    ↓ Tool Call: weather({"city":"Beijing"})
Tool Result：25°C, Sunny
    ↓ 回喂模型
Final：北京今天 25°C，晴天。
    ↓ 200 { reply, items }
浏览器：先渲染工具轨迹气泡，再渲染回答气泡
```

成功标准（本次范围）：

- 模型能按 `tools` 声明决定「要不要调工具、调哪个、传什么参」
- Agent 循环有界（`maxSteps`），工具失败/参数非法不崩溃，回喂模型自行纠正
- **CLI 与 HTTP 两个入口共用同一个 Agent 循环**，不是各写一套
- 浏览器对话框能看到**工具调用轨迹**（调了哪个工具、传了什么参、返回什么、成没成功）
- 刷新页面，会话历史仍在
- 全部行为可在无网络下断言（fake client + fake registry + 临时端口）

---

## 2. 范围界定

### 本次范围

- 复制 01-llm **M3 完成态**底座：`cli/config` / `cli/args` / `cli/store` / `core/session` /
  `core/journal` / `core/commands` / `llm/*`，以及全部 11 个测试文件
- 扩展消息结构：`Message` 改为**可辨识联合**，支持 `tool` 角色与 `tool_calls`
- **升级会话日志格式**以承载 tool 消息（见 §6）—— 这是原设计完全没有覆盖、本次必然要付的成本
- 新增 `core/tool-registry.ts`（接口）、`tools/`（三个无状态工具）、`core/agent.ts`（Agent 循环）
- 扩展 `llm/deepseek.ts`：发送 `tools`、解析 `tool_calls` 与 `finish_reason`
- 新增 `server/` 层：express 路由、会话注册表、错误映射
- 新增 `web/`：React + Vite 聊天对话框（独立项目）
- CLI 改造为走同一个 Agent 循环（**退回非流式**，见 D3）
- 非流式（streaming 继续延后）

### 明确推迟（本次不实现、不设计细节）

| 项 | 说明 |
|---|---|
| HTTP 层会话持久化 | HTTP 的 `Session` 不传 `onChange`，重启即丢 |
| SSE 流式 + 工具调用的合并 | `llm/sse.ts` / `chatStream` 复制过来但**无入口**；`createStreamRenderer` 本次**删除**（见 D10） |
| `[思考中…]` | 非流式路径下它只能在等待结束后打印，无意义；本次由工具轨迹取代它作为进度信号 |
| MCP Client / Server | 只预留 `ToolRegistry` 挂载点 |
| token 统计 / 成本账本 | 01-llm 的 M4 欠账，两阶段共用 |
| 错误类型体系（带 `code` 的 `LLMError`）、自动重试、上游取消与首字节超时 | 01-llm 明确推给 M6 的欠账；本次只在 HTTP 边界做 502/504 二分 |
| 上下文预算裁剪 | 同上 |
| HTTP 侧的斜杠命令（`/clear` `/history`） | 前端没有命令输入口 |
| 前端测试框架（vitest / RTL） | 只把 `chatReducer` 拆成纯模块，使将来补测试不需重构（见 D19） |
| `express.static` 托管 `web/dist`（同源部署） | 本次只跑 Vite dev + proxy |
| HTTP 鉴权 / CORS 白名单 | 只监听 `127.0.0.1`，不 `0.0.0.0` |
| 会话淘汰用 LRU | 本次 FIFO，上限 100（见 D18） |
| 浏览器断开后取消服务端在途请求 | 本次不做 |

---

## 3. 架构

```text
web/     React 前端（独立项目、独立构建）—— 只通过 HTTP 说话
  ↑
server/  express 路由、请求校验、错误映射、会话注册表      ← 全新
cli/     readline 主循环、打印、配置与参数解析、会话文件读写  ← 复制自 01-llm，本次改造
  ↓ 两者都只依赖 core / llm 的公开接口，彼此互不导入
core/    会话状态、消息组装、Agent 循环、展示投影、ToolRegistry 接口
  ↓ 只依赖 core 自身类型
llm/     DeepSeek adapter：请求构造、工具声明序列化、tool_calls 解析
tools/   具体工具实现（weather / get_time / calculator）—— 实现 core 声明的接口，core 不 import 它
```

**分层硬约束**（相对 01-llm 新增的边界）：

- `core` / `llm` / `tools` **不 import express**、不碰 `req` / `res`
- `llm` / `core` 不 import `node:readline` / `node:fs` / `express`，
  不写 `process.stdout` / `process.stderr`（01-llm 只约束了 `stdout`，本次补上 `stderr`）
- `core` 不 import `tools`（依赖方向是 `tools → core`）
- `server` 与 `cli` **互不导入**；两者只在 `core/prompt.ts` 一类无 IO 模块上汇合
- `web/` 不 import 服务端任何文件，只认 HTTP 契约

**三个测试接缝**（全部通过依赖注入，测试用替身替换）：

1. `LLMClient`（已有）
2. `SessionStore`（已有）
3. `ToolRegistry`（新增，接口在 core，实现在 tools）

---

## 4. 目录结构

```text
demos/02-agent/
  package.json          # type: module；dependencies: express；scripts: start / start:server / test / typecheck
  tsconfig.json         # strict；noEmit；module: nodenext；allowImportingTsExtensions
  loader.mjs            # @/ 别名钩子（复制自 01-llm）
  loader-hooks.mjs
  .env                  # 模板（占位符，入库）
  .env.local            # 真实密钥（gitignore）
  .gitignore            # .sessions/、web/node_modules/、web/dist/
  src/
    index.ts            # CLI 入口：解析配置 → 组装 client + registry → runRepl
    core/
      types.ts          # 改造：Role/Message 联合/ToolCall/Tool/ToolResult/ChatResult/ChatOptions
      session.ts        # 改造：append 收窄 / appendMessage / appendAll / history 深拷贝
      journal.ts        # 改造：MessageRecord + parseRecord 白名单 + replay
      commands.ts       # 复制（原样）
      prompt.ts         # 新增：SYSTEM_PROMPT（从 cli/repl.ts 搬出，见 R8）
      transcript.ts     # 新增：foldTranscript: Message[] → TranscriptItem[]
      tool-registry.ts  # 新增：ToolRegistry 接口
      agent.ts          # 新增：runAgentTurn + runSessionTurn
    tools/
      registry.ts       # 新增：createToolRegistry() 注册 weather/get_time/calculator
      weather.ts        # 新增：确定性 mock
      time.ts           # 新增：get_time
      calculator.ts     # 新增：四则运算（白名单正则 + 受限算术求值器，非 eval）
    llm/
      client.ts         # 复制（原样）
      deepseek.ts       # 改造：发送 tools、解析 tool_calls / finish_reason
      sse.ts            # 复制（本次无入口，为后续流式保留）
    cli/
      config.ts         # 复制（原样）
      args.ts           # 复制（原样）
      store.ts          # 复制（原样）
      render.ts         # 改造：删 createStreamRenderer，加 renderAnswer / renderToolStep / describeMessage
      repl.ts           # 改造：非流式 + runSessionTurn + 注入 registry
    server/
      main.ts           # 新增：HTTP 入口（读 env → 组装 → listen → 端口公告 → 优雅退出）
      app.ts            # 新增：createApp(deps) → express.Application（不 listen）
      errors.ts         # 新增：mapErrorToStatus
      session-registry.ts  # 新增：Map + FIFO 上限 + 每会话串行锁
      ids.ts            # 新增：newSessionId()
  test/                 # 与被测模块一一对应；不放非 *.test.ts 文件
  web/                  # 独立项目：自己的 package.json / pnpm-lock.yaml / tsconfig / vite.config
    index.html
    src/
      main.tsx  App.tsx  api.ts  types.ts  chatReducer.ts  useChat.ts  styles.css
      components/ MessageList.tsx  MessageBubble.tsx  ToolTrace.tsx  Composer.tsx
  docs/  troubleshooting.md  how-agent-works.html
  README.md  ARCHITECTURE.md  DECISIONS.md  EVALUATION.md
```

---

## 5. 类型改动（`core/types.ts`）

分两步落地：**先做纯加法**（加类型、加可选字段），再改 `Message` 为联合。分两步是为了让
「加字段是否破坏了既有消费方」在测试里暴露出来，而不是被联合类型的连锁改动淹没。

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };   // arguments 是 JSON 字符串
}

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResult {
  content: string | null;      // 工具轮次中为 null
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
}

// Tool 声明（JSON Schema 的最小子集，后续可扩）
interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'integer'; description?: string }>;
    required?: string[];
  };
}

type ToolResult =
  | { ok: true; value: unknown }     // 会被 JSON.stringify 后回给模型
  | { ok: false; error: string };    // 错误文本回给模型

interface ChatOptions {
  model?: string;                    // 已有
  tools?: Tool[];                    // 新增
}
```

**两处连带改动，都是编译期防线：**

1. **`Session.append` 的 `role` 参数收窄成 `'system' | 'user'`**
   这是一个刻意的类型级保护：assistant 消息现在可能带 `tool_calls`、tool 消息必须带 `tool_call_id`，
   用 `append(role, content)` 这种扁平签名写不出来。收窄之后，「assistant 消息丢掉 `tool_calls`」
   这类 bug **无法通过类型检查** —— 要写 assistant 消息只能走 `appendMessage(message)`。

2. **`Session.history()` 必须升级成深拷贝**
   01-llm 的源码注释原文已经预言了这一刻：

   > `{ ...message }` 在这里是**完备**的深拷贝、不是半吊子加固：`Message` 是扁平结构……
   > 将来若给 Message 加了嵌套字段，这一行必须同步升级成真正的深拷贝。

   `tool_calls` 是数组、数组里还有 `function` 对象，`{...m}` 不再完备 ——
   调用方一句 `h[0].tool_calls[0].function.name = 'x'` 就穿透改了会话状态。

---

## 6. 会话日志格式升级（`core/journal.ts`）—— 原设计未覆盖

### 为什么必须做

CLI 侧仍然落盘（01-llm M3 的能力被复制过来），而 CLI 现在也走 Agent Loop、会产生 tool 消息。
当前的 `SessionChange` 是 `{type:'message'; role: Role; content: string}`，**装不下**
`tool_calls` 与 `tool_call_id`。

**不走「tool 消息不进磁盘」的捷径。** 那条捷径的代码量更大且更难审计：

- 内存里的 `Session` **必须**持有 tool 消息 —— 否则下一轮 `toMessages()` 发出的
  `assistant{tool_calls}` 后面没有 `tool` 回应，DeepSeek 直接 400。
  所以「不进磁盘」只能实现成「进内存但不广播」，即加一条**过滤规则**。
- 这条过滤规则要判断「哪些 `added` 该广播」，而 `added` 里 assistant-with-tool_calls
  与 assistant-final 长得像、tool 与普通消息都是 `{role, content}`。过滤写错的表现是
  **日志里留下孤儿 `assistant{tool_calls}`**，`--resume` 后第一次请求 400 —— 不致命但难查。
- 而扩展格式是**纯加字段**：老行原样解析、原样序列化，字节级往返一致。开销约 30 行 + 几个测试。

若真走捷径，代价是：`--resume` 恢复出的历史缺**整段工具轨迹**，只留下 `user` + 最终 `assistant`。
对模型而言那仍是一段合法且自洽的对话（等于它直接答了），不会崩 —— 但 `/history` 里看不到
「它调过天气工具」，而这个阶段的学习目标恰恰是工具调用。**后果是教学价值归零，不是正确性问题。**

### 格式

按 `role` 分三种记录形状：

```ts
type MessageRecord =
  | { type: 'message'; role: 'system' | 'user'; content: string }
  | { type: 'message'; role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { type: 'message'; role: 'tool'; content: string; tool_call_id: string };

type SessionChange = MessageRecord | { type: 'clear' } | { type: 'model'; model: string };
type SessionRecord =
  | { type: 'meta'; id: string; createdAt: string; model: string }
  | SessionChange;
```

老文件里的 `{"type":"message","role":"user","content":"…"}` 在新格式下**完全合法**，
所以不需要版本号，也不需要考虑迁移。`parseRecord` 里本来就有的那句注释
（「未知 `type` 当坏行跳过 —— 这条路径顺便充当了格式兼容位」）说的就是这个位置。

### `parseRecord` 的白名单要补的两条

- `role === 'assistant'`：`content` 允许 `string | null`；`tool_calls` **存在时**必须是合法数组，
  逐项校验 `id` / `type` / `function.name` / `function.arguments` 都是 string
- `role === 'tool'`：`tool_call_id` 与 `content` 都必须是 string

**校验不通过时不得把键设成 `undefined`**（见 §16 R3）。

### `replay` 的改动

用显式的 `toMessage(record)` 重建 `Message`，**不要 spread** ——
record 上带着 `type: 'message'` 这个键，spread 进 `Message` 会多一个不属于它的字段。

`clear` 的语义不变：只清 messages、不清 model（与 `Session.clear()` 严格对齐）。

---

## 7. ToolRegistry 接口（`core/tool-registry.ts`）

```ts
interface ToolRegistry {
  list(): Tool[];                                              // 序列化成请求里的 tools
  execute(name: string, args: unknown): Promise<ToolResult>;   // 按名派发
}
```

- 这是第三个测试接缝。
- MCP-ready：将来接入 MCP 时给 `tools/registry.ts` 的实现加 `mount()`，接口不变、core/llm 不动。

---

## 8. tools 层（三个无状态工具）

| 文件 | 工具 | 参数 | 行为 |
|---|---|---|---|
| `weather.ts` | `weather` | `{ city: string }` | 确定性 mock：内置小表（Beijing → `25°C, Sunny`，Shanghai、Shenzhen 等），命中返回对应值，未命中返回固定兜底并注明「模拟数据」。无网络、无 key |
| `time.ts` | `get_time` | 无 | 返回 `{ now: <ISO 字符串> }` |
| `calculator.ts` | `calculator` | `{ expression: string }` | 只支持 `+ - * / ( )` 与数字；先正则白名单校验，再用受限算术求值器求值（**不用 `eval` / `new Function`**）；非法表达式返回 `{ok:false}` |

- 每个工具自带 `Tool` 声明 + `run(args)` 实现。
- `tools/registry.ts` 的 `createToolRegistry()` 把三者注册进 `Map`，`execute` 按名派发；
  工具自身负责参数校验，抛出的异常由 agent 兜底成 `{ok:false, error}`。
- **`calculator` 的 `{ok:false}` 错误文本必须包含表达式原文** ——
  那是模型唯一的纠错线索（见 §16 R18）。
- 全部纯逻辑、无 I/O，可离线单测。

---

## 9. Agent 循环（`core/agent.ts`）

```ts
interface ToolStep {
  index: number;                    // 第几步（1 起）
  callId: string;
  name: string;
  argumentsText: string;            // 模型给的原始 JSON 字符串，原样透出
  args?: Record<string, unknown>;   // 解析成功时才有
  parseError?: string;              // JSON.parse 失败的原因
  ok: boolean;
  result: string;                   // 回喂模型的那份文本（成功=JSON、失败=错误文本）
  ms: number;                       // 唯一非确定字段，测试不得断言其值
}

interface AgentTurn {
  final: ChatResult;
  added: Message[];                 // 本轮新追加的消息
  steps: ToolStep[];
  stopReason: 'answered' | 'max-steps';
}

interface AgentOptions { maxSteps?: number }   // 默认 6

async function runAgentTurn(
  client: LLMClient,
  registry: ToolRegistry,
  messages: Message[],       // 输入上下文 [system, ...history, user]，函数内部不修改它
  options?: AgentOptions,
): Promise<AgentTurn>;

async function runSessionTurn(
  session: Session,
  client: LLMClient,
  registry: ToolRegistry,
  question: string,
  options: { systemPrompt: string; maxSteps?: number },
): Promise<AgentTurn>;
```

### `runAgentTurn` 循环

内部维护 `working = [...messages]` 与 `added = []`：

```text
for step in 1..maxSteps:
  result = client.chat(working, { tools: registry.list(), model })
  if result.tool_calls?.length > 0:
    working.push(assistant{ content: result.content, tool_calls })     # 记录「模型要调工具」
    for tc in result.tool_calls:
      args = 尝试 JSON.parse(tc.function.arguments)   # 失败 → {ok:false, error:"参数 JSON 非法"}
      tr   = await registry.execute(tc.function.name, args)   # 抛异常兜底成 {ok:false}
      content = tr.ok ? JSON.stringify(tr.value) : tr.error   # 成功回值、失败回错误文本
      working.push(tool{ tool_call_id: tc.id, content })
      added.push(上面两条)  与 steps.push(...)
    continue
  else:
    working.push(assistant{ content: result.content })
    return { final: result, added, steps, stopReason: 'answered' }
# 跑满 maxSteps 仍未收敛 → 追加一条 assistant「（已达最大步数，停止）」并返回 stopReason: 'max-steps'
```

**循环条件恒为 `result.tool_calls?.length > 0`，不看 `finish_reason`** ——
有些服务端会在 `finish_reason: 'stop'` 的同时返回 `tool_calls`。若写成看 `finish_reason`，
就会漏调工具、把 `content: null` 当成最终答案回给用户（前端显示一个空气泡）。见 §16 R5。

三个刻意的学习点（继承自原设计）：

- **工具失败 / 参数非法不崩**：作为 `tool` 结果的错误文本回给模型，让它自己纠正
- **`maxSteps` 上限**（默认 6）防死循环，对应 guides「Agent 为什么会无限循环」，必须有界
- `tool_calls` 里可能多个工具调用，按序逐个执行、每个各回一条 `tool` 消息

### `runSessionTurn` —— 抽这一层的理由

它做三件事，顺序是**语义**、不是风格：

```text
session.append('user', question)                                  # 必须在 toMessages() 之前
runAgentTurn(client, registry, session.toMessages(prompt), ...)   # 内部用 session.model
session.appendAll(added)                                          # 必须在「成功之后」
```

- `append('user')` 若放在 `toMessages()` 之后，用户这句话根本没发出去
- `appendAll(added)` 若放在 `try` 之外或之前，失败轮次会留下**伪造的 assistant 回答**（01-llm D7）

两处各写一遍 = 两处都可能写反，而写反了都只是「行为微妙不对」，不崩、不报错。
这与仓库既有的 `onChange` 广播（01-llm D29）是同一个理由：**结构上不可能漏，优于记得写**。

`runSessionTurn` 内部自己读 `session.model` 传给 client，这样 CLI 的 `/model`
与将来 HTTP 的模型切换走同一条路，不需要额外的 `options.model`。

---

## 10. 展示投影（`core/transcript.ts`）

实时路径（本轮 `steps`）与历史路径（`GET` 取回整段会话）需要的是**同一种东西**：
给前端渲染的展示项。定义一次，两处复用：

```ts
type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; argumentsText: string; ok: boolean | null; result: string };

function foldTranscript(messages: Message[]): TranscriptItem[];
```

折叠规则：

- `user` / `system` → `{kind:'user'}`（system 不进投影，它不在 `Session` 里）
- `assistant` 有 `content` → `{kind:'assistant', text}`；只有 `tool_calls` 没有 content → 不产出 item
- `tool_calls` 的每一项与随后的 `tool` 消息按 `tool_call_id` 配对 → `{kind:'tool'}`；
  **配不上对的 `tool_calls` 产出 `ok: null`**（表示「调了但没有结果」，比如 `--resume` 读到半截日志）

这样 HTTP 契约里只有一个项目类型，前端也只需要一套渲染逻辑。

---

## 11. LLM 扩展（`llm/deepseek.ts`）

- 请求体：有工具时多传 `tools`；**`tools` 为空数组时不传**（部分 OpenAI 兼容实现会对 `tools: []` 报 400）
- **内部声明与线上格式差一层包装。** `core/types.ts` 的 `Tool` 是扁平的
  `{name, description, parameters}`，而线上 `tools` 数组的元素是
  `{type:'function', function:{name, description, parameters}}`。包装收敛在 `deepseek.ts` 的
  一个私有函数 `toWireTools()` 里 —— 内部保持扁平是因为调用方只关心「叫什么、要什么参数」，
  外面那层 `type` 目前只有一种取值、纯粹是协议封装。少包一层上游会直接 400，
  而报错不会提到「少包了一层」，所以有专门的测试钉住这个层级
- 响应解析：从只取 `content` 扩展为同时取 `message.tool_calls` 与 `finish_reason`（缺省按 `stop`）
- **`tool_calls` 必须逐字段校验后归一化**：`id` / `type` / `function.name` / `function.arguments`
  都是 string，`type` 归一化为 `'function'`；非法项丢弃，丢完为空就当作没有 `tool_calls`。
  不校验的后果：`tool_call_id: undefined` → `JSON.stringify` 丢键 → 下一轮 API 400，
  而报错信息完全不指向真正的原因（见 §16 R15）
- 仍非流式，`reasoning_content` 仍抑制，非 2xx 仍抛裸 `Error`（消息含 status，供 HTTP 层识别）

`chatStream` 与 `llm/sse.ts` **保留但不改造**，本次无调用方。

---

## 12. CLI 接入（`cli/repl.ts` + `cli/render.ts`）

`runRepl(client, registry, options)` 注入两个接缝，每轮：

```text
session.append('user', question)          ← 由 runSessionTurn 内部做
{ final, added, steps } = runSessionTurn(...)
打印工具轨迹（每步一行）→ 打印最终答案
```

- **`SYSTEM_PROMPT` 搬到 `core/prompt.ts`** —— 必须搬。否则 `server/app.ts` 导入它会连带把
  `node:readline` 拖进服务端进程：能跑，但架构被悄悄破坏（见 §16 R8）
- `cli/render.ts` **删除 `createStreamRenderer`**（见 D10），新增：
  - `renderToolStep(step, {output})` —— 打印一行工具轨迹
  - `renderAnswer(result, {output, errorOutput})` —— 打印 `AI: ` 前缀 + 正文，
    `finish_reason === 'length'` 时仍往 stderr 写截断警告（保留 01-llm 的既有约定）
  - `describeMessage(message)` —— `/history` 用，必须处理 assistant 的 `content: null`（见 §16 R14）
- 输出流归属沿用 01-llm 的 D13/D26：**模型回答与命令结果走 stdout，诊断与错误走 stderr**。
  工具轨迹是「用户主动要看的」，走 **stdout**

---

## 13. HTTP 层（`server/`）

### 接口

```text
POST /api/sessions
  → 201 { sessionId, model }

POST /api/sessions/:id/messages      body: { message: string }
  → 200 { reply: string, items: TranscriptItem[], stopReason: 'answered'|'max-steps', model }

GET  /api/sessions/:id/messages
  → 200 { sessionId, model, items: TranscriptItem[] }
```

错误统一 `{ error: { code: string, message: string } }`。

### 状态码

只可能是 `400 / 404 / 500 / 502 / 504`：

| 状态 | 触发 |
|---|---|
| 400 | 参数非法（含 `req.body` 为 `undefined` 的情况） |
| 404 | 会话不存在 |
| 502 | 上游返回了错误响应 |
| 504 | 上游连不上 / 超时 |
| 500 | 其余 |

**上游 status 绝不原样透出。** `res.status(401)` 会把「我们的 DeepSeek key 无效」
变成「你这个浏览器用户没登录」，前端拿到 401 会去查一个不存在的登录态。
上游 status 只出现在 message 文本里。见 §16 R11。

**不引入错误类型体系。** `deepseek.ts` 只抛裸 `Error`，`server/errors.ts` 靠消息前缀识别
（`/^DeepSeek API error \d{3}:/` → 502；`fetch failed` / 超时 → 504）。
按状态码细分属于 01-llm 明确推给 M6 的欠账。

### 四个实现要点

1. **`createApp(deps)` 返回 `express.Application`，不 listen。**
   测试用 `app.listen(0, '127.0.0.1')` + Node 原生 `fetch` 打临时端口。
   **不引 `supertest`** —— 它的核心价值是「不监听端口就能打请求」，而 `listen(0)` 拿临时端口是 5 行代码，
   `127.0.0.1` 上的临时端口不出网，不违反「测试不依赖真实网络」。
   注意 `server.close()` 会被 undici 的 keep-alive 连接挂住，必须先 `closeAllConnections()`（见 §16 R9）。

2. **选 express 5 而非 4。** 决定性理由：**express 5 会把 async handler 的 rejected promise
   自动转给错误中间件**，express 4 需要 `asyncHandler` 包装或每个 handler 手写 try/catch，
   而本项目所有 handler 都是 async（要 `await runSessionTurn`）。选 4 就要么加依赖，要么写 5 遍 try/catch。
   代价是两处 4→5 陷阱：`app.get('*')` 会抛错、`req.body` 可能是 `undefined`（见 §16 R6/R7）。

3. **同一会话串行化。** `SessionRegistry.run(id, fn)` 用 promise chain 把同一 id 上的
   `fn` 串起来执行，不同 id 互不影响。`Session.append` 是同步无锁的，HTTP 下并发请求会乱序 ——
   01-llm 靠 REPL 的串行 `await` 天然规避，服务端没有这个保护（见 §16 R17）。
   **锁必须在 registry 内部**（与 Map 同一个持有者）。

4. **会话 id 复用 `makeSessionId(new Date(), randomBytes(2).toString('hex'))`**，
   两个入口共用同一种 id 形状，将来 Web 建的会话能被 CLI 的 `--resume` 认识。
   Map 加 FIFO 上限 100 —— 淘汰的代价是零：浏览器 localStorage 里的 id 失效后本来就要处理 404
   （服务端重启也会 404），降级分支是已有需求。

### 依赖

`express@5.2.1`（运行时）；`@types/express@5.0.6`（devDependency）。
这是本仓库**第一个运行时依赖**，理由与代价记在 D15。

---

## 14. 前端（`web/`）

### 项目形态

`web/` 是**完全独立的 pnpm 项目**（自己的 `package.json` + `pnpm-lock.yaml`），
**不做 workspace** —— 根 `AGENTS.md` 明文「各阶段是独立项目，根目录没有 `package.json`」，
而两边工具链完全不相交（服务端零依赖 + `node --test`，前端 vite + react），
没有可提升的公共依赖。代价是两次 `pnpm install`。

### 开发与联调

`vite.config.ts` 配 `server.proxy: { '/api': 'http://localhost:3000' }`，**不装 `cors`**。
前端代码里一律用**相对路径** `/api/...` —— 将来用 `express.static` 同源部署时不用改任何代码。
（本次不做同源部署。）

### 组件与状态

- 组件：`App` / `MessageList` / `MessageBubble`（三种样式）/ `ToolTrace` / `Composer`
- 状态：`useReducer` + 独立的纯函数 `chatReducer.ts`。
  理由**不是「状态多」**，而是 `items / status / notice` 三者若各用一个 `useState`，
  很容易渲染出「错误已设置但 status 还是 sending」的中间态。
  前端本次**没有测试框架**（不引 vitest），把 reducer 拆成纯模块是为了将来能补测试而**不必重构** —— 明确记下的债。
- 不需要 `tempId`：`status === 'sending'` 时 Composer 禁用，同一时刻只有一个在途请求，
  回包一定属于最后一条 user 消息。

### 会话恢复

- `sessionId` 存 `localStorage`，**首次发送时才建会话**，不是 mount 就 `POST /api/sessions`
  （否则每次刷新泄漏一个会话，见 §16 R13）
- `404`（服务端重启 / 会话被淘汰）→ 静默新建 + 一条可关闭的提示，不能白屏

### 类型

前端 TypeScript 类型**手写一份 `web/src/types.ts`**，不跨项目 import 服务端类型。
理由：共享要把服务端的 `@types/node` 拖进前端 tsconfig、`@/` 别名要配两处 paths，
而且**线上契约本来就不是服务端的内部 `Message` 联合** —— 它是 `TranscriptItem`，是另一个东西。
共享是假共享。真正的守卫是 `test/server.test.ts` 里对 JSON 键的断言，
`web/src/types.ts` 是它的抄写（记为已知重复，见 D17）。

---

## 15. 错误处理

| 场景 | 行为 |
|---|---|
| API 非 2xx / 网络抛错 | 沿用 ai-chat：CLI 打印 `[error]` 不崩；HTTP 层映射成 502/504 |
| 工具执行抛异常 | 兜底成 `{ok:false, error}` 回喂模型 |
| `arguments` JSON 解析失败 | 同上，并记进 `ToolStep.parseError`（与工具自身失败区分） |
| 跑满 `maxSteps` | 追加「已达最大步数」提示后停止，`stopReason: 'max-steps'` |
| calculator 非法表达式 | 白名单正则 + 受限算术求值器，返回 `{ok:false}`，错误文本含表达式原文 |
| 上游返回 401/429 | HTTP 层一律 502，**上游 status 不透出** |
| 请求体不是合法 JSON | `400 invalid_body`（body-parser 的 `SyntaxError` 自带 `status: 400`） |

**提交原子性**：`added` 只在 `runAgentTurn` 成功返回后才 `appendAll` 进 Session（`runSessionTurn` 内部保证）——
API 中途失败则本轮只留下 user 消息、不残留半截工具痕迹（对齐 ai-chat 的 D7）。

---

## 16. 测试策略（全部离线）

| 文件 | 关键用例 |
|---|---|
| `test/types.test.ts` | 类型联合的构造与窄化 |
| `test/session.test.ts` | `appendMessage` 记录 tool 角色；`append` 只接受 user/system；**改 `history()` 返回值的 `tool_calls` 不影响会话状态** |
| `test/journal.test.ts` | **老格式行解析为普通 assistant**、字节级往返一致；tool 行缺 `tool_call_id` → null；`tool_calls` 非法 → null；`replay` 重建工具轨迹；`clear` 只清消息不清模型 |
| `test/deepseek.test.ts` | 请求体带 `tools`；**`tools` 为空数组时不带该字段**；解析 `tool_calls`；`finish_reason` 缺省 `stop`；`content` 为 null；**`tool_calls` 里混一条坏的 → 丢弃** |
| `test/tools-weather.test.ts` | Beijing 命中 `25°C, Sunny`；未知城市兜底；缺 `city` → `{ok:false}` |
| `test/tools-time.test.ts` | 返回可解析 ISO 字符串 |
| `test/tools-calculator.test.ts` | 四则/括号；除零；字母与非法字符 → `{ok:false}`；错误文本含表达式原文 |
| `test/tools-registry.test.ts` | 注册三个；`list()` 返回三份 schema；按名派发；未知名 → `{ok:false}` |
| `test/agent.test.ts` | 一轮工具后收敛；多步循环；**`client.chat` 调用次数恰好等于 maxSteps**；参数非法回喂；工具抛错回喂；无工具直答；**`finish_reason:'stop'` + 有 `tool_calls` 仍要执行工具**；`stopReason` |
| `test/transcript.test.ts` | 三类折叠；配不上对的 `tool_calls` → `ok: null`；assistant 无 content 不产出 item |
| `test/render.test.ts` | 工具轨迹/答案/截断警告的分流；`describeMessage` 处理 `content: null` |
| `test/repl.test.ts` | fake client+registry：问天气 → 打印工具轨迹与最终答案；失败轮不残留 assistant |
| `test/server-session-registry.test.ts` | 并发串行（同 id 的调用序列是 `A…A…B…B`）；FIFO 淘汰；`get` 未知 id → null |
| `test/server-errors.test.ts` | 上游 401 → 502；`fetch failed` → 504；未知错误 → 500 |
| `test/server.test.ts` | `app.listen(0)` + fetch：建会话 / 发消息 / 取历史 / 404 / **不带 Content-Type 发请求 → 400** / 未知路径 → JSON 404；**断言响应 JSON 的键形状**（这是前端类型的真正守卫） |
| `test/server-main.test.ts` | 子进程 + `AI_AGENT_PORT=0`，从 stdout 读端口；`SIGTERM` 优雅退出 |

集成（离线）：fake client 先返回一次 `tool_calls` 再返回最终答案，跑通整个 HTTP 天气流程。

---

## 17. 工具链

- Node ≥ 22 原生类型擦除直接运行：`node --import ./loader.mjs src/index.ts`
- TypeCheck：`tsc --noEmit`
- 测试：`node --test`
- 服务端：`dependencies` 只有 `express`；devDependency 为 `typescript` + `@types/node` + `@types/express`
- 前端：独立 `package.json`，独立 `pnpm install`，独立 `pnpm run build`

---

## 18. 需在实施时核实的一点

DeepSeek 工具调用遵循 OpenAI 兼容格式（`tools` 数组 + `message.tool_calls` + `finish_reason:"tool_calls"`，
`arguments` 为 JSON 字符串）。`demos/01-llm/docs/deepseek-api-facts.md` 已确认 `tool` 角色与
`tool_calls` finish_reason 存在；实施时**对照 DeepSeek 官方文档再核一遍确切字段名**，
并确认 `tools` 数组元素的 schema 包装层级（OpenAI 是 `{type:'function', function:{...}}`）。

---

## 19. 验收

- TypeCheck：`tsc --noEmit` 通过（服务端）
- Test：`node --test` 全绿
- Build：服务端无构建产物（noEmit）；`web/` 的 `pnpm run build` 通过
- 手动冒烟：真实 `DEEPSEEK_API_KEY` 下端到端跑通天气例子 ——
  浏览器先出现 `weather(city=Beijing)` 轨迹，再出现「北京今天 25°C，晴天。」
- 冒烟附带验证：刷新页面历史仍在；杀掉服务端再刷新 → 静默新建而非白屏；CLI 双入口仍可用

---

## 20. 设计决策（待写入 DECISIONS.md，独立编号）

- **D1 复制 M3 完成态底座，而非 M1 底座** —— 原设计（2026-09-23）假定起点是 M1，
  其三条「推迟」（streaming / 持久化 / 命令）在 01-llm 已完成。放弃沿用原设计的范围划定。
- **D2 保留双入口，两入口共用同一个 Agent 循环** —— 放弃「CLI 保持流式、HTTP 另写一套」：
  那会让两个入口行为不一致、CLI 调试不到工具调用，且「一轮对话」的语义被写两份必然漂移。
- **D3 CLI 退回非流式** —— 流式下 `tool_calls` 是分片 delta，要边收边拼 JSON 参数并处理拼一半断开，
  复杂度高一个量级。本次学习焦点是 Agent Loop，不是 SSE 分片拼接。
  代价：CLI 暂时失去逐字输出；`chatStream`/`sse.ts` 保留但无入口。放弃「本次就做流式 + 工具」。
- **D4 抽 `runSessionTurn`** —— 两行编排的顺序本身是有静默失败模式的语义规则（D7 原子性）。
  放弃「两个入口各写 3 行」。
- **D5 会话日志格式按 role 分三种记录形状** —— 老行字节级往返一致，不需要版本号。
  放弃「tool 消息不进磁盘」（教学价值归零）与「嵌套 `{type:'message', message}`」（老行不兼容）。
- **D6 循环条件看 `tool_calls`、不看 `finish_reason`** —— 部分服务端会在 `stop` 的同时返回 `tool_calls`。
- **D7 工具失败回喂模型而非崩溃**（继承原设计 D4）。
- **D8 `maxSteps` 防死循环**（继承原设计 D5，默认 6）。
- **D9 weather 用确定性 mock**（继承原设计 D6）：无网络/无 key，聚焦 tool calling 本身。
- **D10 `createStreamRenderer` 不复制、直接删** —— 它的契约（前缀恰好写一次 / `finish()` 幂等）
  是为流式设计的，非流式下无法履行。留一份「无入口但有测试锁着形状」的实现，
  会在下个里程碑合并「流式 + 工具」时变成必须推翻的既成事实。
  与「`sse.ts` 保留」不矛盾：后者是协议层能力，与调用方无关。
- **D11 calculator 白名单 + 受限算术求值器**（继承原设计 D8，非 `eval` / `new Function`）。
- **D12 前端显示工具轨迹** —— 接口返回 `TranscriptItem[]`。这是「先把 Agent 流程打通」的可见性前提：
  流程通没通，只能靠看。
- **D13 展示投影只定义一次（`core/transcript.ts`）** —— 实时路径与历史路径用同一种 item，
  前端只需要一套渲染逻辑。放弃「实时返回 `steps`、历史返回 `Message[]`」的两套形状。
- **D14 REST 资源式接口 + 服务端内存会话** —— `GET` 历史让「刷新不丢」成立。
  放弃单端点 `/api/chat`（刷新白屏）与无状态（前端自管历史）。
- **D15 服务端引入 `express`** —— 本仓库第一个运行时依赖，同时破掉「零运行时依赖」。
  选 express 5 的决定性理由是 async handler 的 rejected promise 自动转错误中间件。
  代价：约束必须改写成带范围的版本（核心层零依赖、`server/` 允许依赖且必须登记）。
- **D16 前端 React + Vite，`web/` 独立项目** —— 本仓库第一个前端构建步骤，破掉「不引入构建步骤」。
  放弃原生 HTML/JS（守住零构建）与 Vue CDN（引入外部 CDN 依赖）。不做 workspace。
- **D17 前端类型手写一份，不跨项目共享** —— 线上契约是 `TranscriptItem`，不是服务端的 `Message` 联合，
  共享是假共享。守卫落在 `test/server.test.ts` 的键断言上。
- **D18 会话 Map 用 FIFO 上限 100** —— 淘汰代价为零（404 降级是已有需求）。放弃 LRU 与「不淘汰」。
- **D19 前端不引测试框架，但 reducer 拆成纯模块** —— 这是一笔已知欠账，
  目的是使将来补测试不需要重构。半年后不能误以为前端有测试覆盖。
- **D20 仍非流式**（继承原设计 D9）。
- **D21 不自动重试**（继承原设计 D10，对齐 ai-chat D5）。
- **D22 只监听 `127.0.0.1`，不做鉴权与 CORS 白名单** —— 本机开发工具，不是可暴露的服务。
  代价：不能从别的机器/容器访问。
