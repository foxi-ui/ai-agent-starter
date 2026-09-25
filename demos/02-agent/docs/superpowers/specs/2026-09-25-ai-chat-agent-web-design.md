# ai-chat-agent · 前后端分离改造（monorepo）· 设计文档

- 日期：2026-09-25
- 状态：待 review
- 范围：阶段二「LLM + Tool Calling」——一个 pnpm monorepo 里的两个应用：
  **Express 服务端**（内含自实现的 Agent）与 **React 聊天前端**。工具本地、非流式。
- 前置项目：`demos/01-llm`（阶段一，M1–M3 完成态）。本项目**复制它的 4 个文件**作为起点，其余全部新写。
- 被取代的文档：`2026-09-23-ai-chat-agent-design.md`（纯 CLI 版，已作废，正文保留作为历史记录）。

---

## 1. 背景与目标

### 1.1 为什么要重新设计

原设计（2026-09-23）把阶段二定义为一个**纯 CLI** 项目，且它「复制底座」时复制的是 **M1 时代的 01-llm** ——
它的「明确推迟」清单里写着「streaming」「会话持久化」「命令」，**这三样 01-llm 现在已经全部做完了**。
也就是说，原设计描述的起点已经不存在了。

用户随后提出三条改造要求，逐条改变了这份设计的形状：

1. **要有前端聊天对话框、分前后端**，服务端用 express；对话框前期只做简单输入展示，先把 Agent 流程打通
2. **别留 CLI** —— 它拖进来的 readline、stdout/stderr 分流、JSONL 落盘与格式升级全是**阶段一已经学过的题目**，
   与本阶段的 Tool Calling / Agent Loop 无关，却让最精细、最容易写错的一整块（会话日志格式升级）重新出现
3. **别让展示层与 agent 层交汇太多** —— 原设计里 `core/agent.ts` 返回的 `ToolStep` 带着 `index` 与 `ms`
   两个纯为界面服务的字段（`ms` 甚至是「唯一非确定字段，测试不得断言」），`core/transcript.ts` 的
   `TranscriptItem` 是个视图模型却住在 core。**agent 层的输出形状被 UI 需求塑形了。**

第 3 条催生了本次最重要的结构决定：**agent 层只产出事实，展示项一律由外层投影**（见 D4 与 §8）。

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
    ↓ 200 { items: [ {kind:'tool',…}, {kind:'assistant',…} ] }
浏览器：先渲染工具轨迹气泡，再渲染回答气泡
```

成功标准（本次范围）：

- 模型能按 `tools` 声明决定「要不要调工具、调哪个、传什么参」
- Agent 循环有界（`maxSteps`），工具失败 / 参数非法不崩溃，回喂模型自行纠正
- 浏览器对话框能看到**工具调用轨迹**（调了哪个工具、传了什么参、返回什么、成没成功）
- 刷新页面，会话历史仍在
- **`core/` 里没有任何一个字段是为了界面存在的**
- 全部行为可在无网络下断言（fake client + fake registry + 临时端口）

---

## 2. 范围界定

### 本次范围

- 建 pnpm monorepo：`apps/server`（服务端，含 Agent）+ `apps/web`（前端）
- 复制 01-llm 的 4 个文件作为起点并改造：`core/types.ts`、`core/session.ts`、`llm/client.ts`、`llm/deepseek.ts`
- `Message` 改为**可辨识联合**，支持 `tool` 角色与 `tool_calls`
- 新增 `core/tool-registry.ts`（接口）、`tools/`（三个无状态工具）、`core/agent.ts`（Agent 循环）
- 新增 `presentation/transcript.ts`：把 `Message[]` 投影成展示项
- 新增 `http/`：express 路由、会话注册表、错误映射
- 新增 `apps/web`：React + Vite 聊天对话框
- 非流式

### 明确推迟（本次不实现、不设计细节）

| 项 | 说明 |
|---|---|
| CLI 入口与 readline 交互 | 见 D2。**整个不做**，不是「以后补」 |
| 会话持久化（JSONL / 落盘 / 恢复） | 见 D3。服务端只用内存 Map，重启即丢 |
| SSE 流式（含 `chatStream` / `sse.ts`） | 见 D5。`LLMClient` 本次只有一个方法 |
| MCP Client / Server | 只预留 `ToolRegistry` 的挂载点 |
| token 统计 / 成本账本 | 01-llm 的 M4 欠账 |
| 错误类型体系（带 `code` 的 `LLMError`）、自动重试、上游取消与首字节超时 | 01-llm 明确推给 M6 的欠账；本次只在 HTTP 边界做 502/504 二分 |
| 上下文预算裁剪 | 同上 |
| HTTP 侧的斜杠命令（`/clear` `/history`） | 前端没有命令输入口 |
| 前端测试框架（vitest / RTL） | 见 D14，一笔明确的欠账 |
| `express.static` 托管 `web/dist`（同源部署） | 本次只跑 Vite dev + proxy |
| HTTP 鉴权 / CORS 白名单 | 见 D17，只监听 `127.0.0.1` |
| 会话淘汰用 LRU | 本次 FIFO，上限 100（见 D16） |
| 浏览器断开后取消服务端在途请求 | 本次不做 |
| 多会话（前端同时开多个对话） | 前端一次只跟一个会话说话 |

---

## 3. 架构

```text
apps/web/      React 前端（独立 package.json 与工具链）—— 只通过 HTTP 说话
  ↑
apps/server/
  http/          路由、请求校验、错误映射、会话注册表、进程入口
  presentation/  展示投影：Message[] → TranscriptItem[]      ← 本次新增的边界
  ↓
  core/          Agent 循环、会话状态、消息组装、ToolRegistry 接口、系统提示
  ↓
  llm/           DeepSeek adapter：请求构造、工具声明序列化、tool_calls 解析
  tools/         具体工具实现（weather / get_time / calculator）
```

**依赖方向**（单向，无环）：

```text
http → presentation → core
http → core
http → llm
http → tools
core → llm          （仅 import type）
tools → core        （实现 core 声明的 ToolRegistry 接口）
```

### 硬约束

- `core/` / `llm/` / `tools/` / `presentation/` **不 import express**，不碰 `req` / `res`
- `core/` / `llm/` / `tools/` / `presentation/` **不写** `process.stdout` / `process.stderr`
- `core/` **不 import `tools`**（方向是 `tools → core`）
- `presentation/` **不 import `http/`** —— 它不知道 HTTP 存在，只认 `Message`
- 只有 `src/main.ts` 碰 `process`；只有 `http/` 碰 express
- `apps/web/` 不 import 服务端任何文件，只认 HTTP 契约

### 三个测试接缝

| 接缝 | 接口位置 | 替身 |
|---|---|---|
| `LLMClient` | `llm/client.ts` | 手写对象字面量 |
| `ToolRegistry` | `core/tool-registry.ts` | 手写对象字面量 |
| 端口 | `http/app.ts` 的 `createApp(deps)` | `app.listen(0)` + 原生 `fetch` |

（01-llm 的第四个接缝 `SessionStore` 随持久化一起消失。）

---

## 4. 目录结构

```text
demos/02-agent/
  pnpm-workspace.yaml          # packages: ['apps/*']
  package.json                 # 只放编排脚本，无源码
  README.md  ARCHITECTURE.md  DECISIONS.md  EVALUATION.md
  docs/
    troubleshooting.md
    how-agent-works.html       # 已有（Agent 循环讲解页）
    superpowers/specs/  plans/

  apps/server/
    package.json               # name: server；dependencies: express
    tsconfig.json              # strict / noEmit / nodenext / allowImportingTsExtensions
    loader.mjs                 # @/ 别名钩子（复制自 01-llm）
    loader-hooks.mjs
    .env                       # 模板（占位符，入库）
    .env.local                 # 真实密钥（gitignore）
    src/
      main.ts                  # 进程入口：装配 client + registry + 会话表 → listen
      core/
        types.ts               # [改造] Role/Message 联合/ToolCall/Tool/ToolResult/ChatResult
        session.ts             # [改造] 只留 append/appendMessage/appendAll/toMessages/history
        prompt.ts              # [新] SYSTEM_PROMPT
        tool-registry.ts       # [新] ToolRegistry 接口 + ToolDefinition
        agent.ts               # [新] runAgentTurn + runSessionTurn
      llm/
        client.ts              # [改造] 只留 chat()
        config.ts              # [新] resolveConfig(env) → LLMClientConfig（纯函数）
        deepseek.ts            # [改造] 去流式；发 tools、解析 tool_calls
      tools/
        weather.ts  time.ts  calculator.ts   # [新]
        registry.ts                          # [新] createToolRegistry()
      presentation/
        transcript.ts          # [新] foldTranscript: Message[] → TranscriptItem[]
      http/
        app.ts                 # [新] createApp(deps) → express.Application（不 listen）
        errors.ts              # [新] mapErrorToStatus
        session-registry.ts    # [新] Map + FIFO 上限 + 每会话串行锁
        ids.ts                 # [新] newSessionId()
    test/                      # 与被测模块一一对应；不放非 *.test.ts 文件

  apps/web/
    package.json  tsconfig.json  vite.config.ts  index.html
    src/
      main.tsx  App.tsx  api.ts  types.ts  chatReducer.ts  useChat.ts  styles.css
      components/
        MessageList.tsx  MessageBubble.tsx  ToolTrace.tsx  Composer.tsx
```

**为什么 monorepo 而不是「阶段根 = 服务端」**：那样 `demos/02-agent/package.json` 会既当阶段根、
又当服务端，`src/` 与 `web/` 的地位看不出区别。`apps/` 下两个平级应用把「两个可运行的东西」写在名字里，
同时阶段根仍能一条命令跑全部（`pnpm -r`），也留给以后抽 `packages/` 的位置。

---

## 5. 类型契约（`core/types.ts`）

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
  content: string | null;      // 工具调用轮次中为 null
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
}

/** 工具的**声明** —— 发给模型看的那份说明，不是实现。**扁平形状**，见 §9 */
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
  model?: string;
  tools?: Tool[];
}
```

相对 01-llm 的改动：

- `Role` 加 `'tool'`
- `Message` 从扁平 `interface` 改为**可辨识联合** —— 三种角色的字段本来就不同，
  写成扁平结构用可选字段糊过去，会让「assistant 忘了带 `tool_calls`」这类 bug 溜到运行时才发现
- `ChatResult` 加 `tool_calls` / `finish_reason`，`content` 放宽为 `string | null`
- **`StreamEvent` 删除**（见 D5）

`llm/client.ts` 同步收窄：

```ts
interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
}
```

`LLMClientFactory` 一并删除 —— 01-llm 里它从未被使用过，是纯文档型导出。

### `core/types.ts` 不该出现的东西

**任何为了界面存在的字段。** 判断标准：删掉这个字段，浏览器上的东西会不会少一块？
会，就说明它属于 `presentation/` 而不是这里。

---

## 6. 会话状态（`core/session.ts`）

```ts
class Session {
  readonly model: string;
  constructor(model: string);

  append(role: 'system' | 'user', content: string): void;
  appendMessage(message: Message): void;
  appendAll(messages: Message[]): void;

  toMessages(systemPrompt: string): Message[];   // [system, ...历史]
  history(): Message[];                          // 深拷贝
}
```

相对 01-llm **删掉**了三样（见 D6）：

| 删掉的 | 为什么 |
|---|---|
| `onChange` 变更广播 + `SessionOptions` | 它的唯一用途是落盘，而本次不做持久化 |
| `clear()` | 唯一调用方是 `/clear` 命令，CLI 已砍 |
| `set model` / 构造时的 `history` 参数 | 没有 `/model` 命令，也没有恢复会话的入口 |

`append` 的 `role` **收窄成 `'system' \| 'user'`**，这是刻意的类型级防线：
assistant 消息可能带 `tool_calls`、tool 消息必须带 `tool_call_id`，都不是 `(role, content)`
这种签名写得出来的。收窄之后，「assistant 消息丢掉 `tool_calls`」**无法通过类型检查**。

`history()` 必须是**深拷贝**：`tool_calls` 是数组、数组里还有 `function` 对象，
`{...m}` 不再完备 —— 调用方一句 `h[0].tool_calls[0].function.name = 'x'` 就穿透改了会话状态。
（01-llm 的源码注释已经预言了这一刻：「将来若给 Message 加了嵌套字段，这一行必须同步升级」。）

---

## 7. Agent 循环（`core/agent.ts`）

```ts
interface AgentTurn {
  final: ChatResult;                 // 最终回答
  added: Message[];                  // 本轮新追加的消息
  stopReason: 'answered' | 'max-steps';
}

async function runAgentTurn(
  client: LLMClient,
  registry: ToolRegistry,
  messages: Message[],               // 输入上下文 [system, ...history, user]，函数内部不修改它
  options?: { maxSteps?: number; model?: string },   // maxSteps 默认 6
): Promise<AgentTurn>;

async function runSessionTurn(
  session: Session,
  client: LLMClient,
  registry: ToolRegistry,
  question: string,
  options: { systemPrompt: string; maxSteps?: number },
): Promise<AgentTurn>;
```

**注意这里没有 `steps`。** 本轮调了哪些工具、传了什么参、成没成功 —— 全部可以从 `added` 推导，
而推导逻辑只有一份，在 `presentation/` 里（§8）。agent 层只负责「发生了什么」，
不负责「怎么给人看」。这是本次相对原设计最重要的一处收窄。

### 循环体

内部维护 `working = [...messages]` 与 `added = []`：

```text
for step in 1..maxSteps:
  result = client.chat(working, { tools: registry.list(), model })
  if result.tool_calls?.length > 0:
    working.push(assistant{ content: result.content, tool_calls })    # 记录「模型要调工具」
    for tc in result.tool_calls:
      args = 尝试 JSON.parse(tc.function.arguments)   # 失败 → {ok:false, error:"参数不是合法 JSON：…"}
      tr   = await registry.execute(tc.function.name, args)   # 抛异常兜底成 {ok:false}
      content = tr.ok ? JSON.stringify(tr.value) : tr.error
      working.push(tool{ tool_call_id: tc.id, content })
    continue
  else:
    working.push(assistant{ content: result.content })
    return { final: result, added, stopReason: 'answered' }
# 跑满 maxSteps → 追加一条 assistant「（已达最大步数，停止）」并返回 stopReason: 'max-steps'
```

四个刻意的学习点：

- **循环条件恒为 `result.tool_calls?.length > 0`，不看 `finish_reason`** ——
  有些服务端会在 `finish_reason: 'stop'` 的同时返回 `tool_calls`。若看 `finish_reason`，
  就会漏调工具、把 `content: null` 当成最终答案回给用户（前端显示一个空气泡），而且不报任何错。
- **工具失败 / 参数非法不崩**：作为 `tool` 结果的错误文本回给模型，让它自己纠正
- **`maxSteps` 上限**（默认 6）防死循环，对应 guides「Agent 为什么会无限循环」
- 跑满时追加的最后一条必须是**带 `content` 的 assistant**，不能是只有 `tool_calls` 的消息 ——
  那样的历史对 API 是非法的

### `runSessionTurn` 为什么还要单独一层

它做三件事，**顺序是语义、不是风格**：

```text
session.append('user', question)                                  # 必须在 toMessages() 之前
runAgentTurn(client, registry, session.toMessages(prompt), …)     # 内部用 session.model
session.appendAll(added)                                          # 必须在「成功之后」
```

- `append('user')` 若放在 `toMessages()` 之后，用户这句话根本没发出去
- `appendAll(added)` 若不放在成功之后，失败轮次会留下**伪造的 assistant 回答**（01-llm 的 D7）

原设计抽这一层的理由是「两个入口各写一遍就是两次写反的机会」。**现在只有一个入口了，
理由换了一层**：HTTP 路由的职责是状态码与 JSON 形状，不是对话时序。
把三行顺序敏感的语句内联进 async handler，是把 agent 语义和 HTTP 语义搅在一起 ——
这恰恰是本次要修的那类问题。

`runSessionTurn` 内部自己读 `session.model` 传给 client，路由不需要知道模型这回事。

---

## 8. 展示投影（`presentation/transcript.ts`）

```ts
type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      argumentsText: string;      // 模型给的原始 JSON 字符串
      ok: boolean | null;         // true=成功，false=失败，null=没等到结果
      result: string;
    };

function foldTranscript(messages: Message[]): TranscriptItem[];
```

折叠规则：

- `system` → 跳过（它不在 `Session` 里，每次请求现加）
- `user` → `{kind:'user', text}`
- `assistant`：`content` 非空则产出一项；`tool_calls` 的每一项先占位成 `ok: null` 的 tool 项
- `tool` 消息按 `tool_call_id` 把结果填回对应的那一项，`ok` 由**结果是不是合法 JSON** 判定

**「结果是不是合法 JSON」这个判据的依据是一个不变量**：成功路径的结果一定经过
`JSON.stringify`（见 §7 的 `toToolContent`），所以一定是合法 JSON；失败路径回的是人写的错误文本，
解析必然失败。之所以要这样反推而不是在消息里存一个标记位 —— `Message` 是发给 API 的线格式，
多一个字段就是给上游发未知字段。

**代价说清**：界面因此分不出「参数 JSON 非法」与「工具执行失败」。这是**有意接受**的 ——
两者的错误文本本身就写着原因（`参数不是合法 JSON：{city: Beijing` vs `无法计算「1/0」：除数不能为 0`），
用户看到的信息没有损失，而换来的是 `Message` 保持纯净、实时与历史两条路径共用同一个函数。

### 两条路径的对称性

| 接口 | `items` 是什么 | 怎么来的 |
|---|---|---|
| `POST /api/sessions/:id/messages` | **本轮**新增的展示项（工具轨迹 + 最终回答，不含用户那条） | `foldTranscript(turn.added)` |
| `GET /api/sessions/:id/messages` | **整段**会话的展示项（user + tool + assistant） | `foldTranscript(session.history())` |

同一个函数、同一种类型，只差范围。这就是把展示投影收进一层的直接收益 ——
原设计里 POST 返回 `steps`（一个 `ToolStep` 数组）、GET 返回 `messages`（`Message` 数组），
前端要写两套渲染逻辑。

---

## 9. LLM 层（`llm/deepseek.ts`）

`chat()` 的三处改动：

1. **发送 `tools`**：`options.tools` 非空时才带该字段 —— 部分 OpenAI 兼容实现会对 `tools: []` 直接 400，
   而「传了一个空列表」与「这次不传工具」在语义上本来就是一回事
2. **内部声明与线上格式差一层包装**：`core/types.ts` 的 `Tool` 是扁平的
   `{name, description, parameters}`，线上 `tools` 数组的元素是
   `{type:'function', function:{name, description, parameters}}`。
   包装收敛在一个私有函数 `toWireTools()` 里 —— 内部保持扁平是因为调用方只关心「叫什么、要什么参数」，
   外面那层 `type` 目前只有一种取值、纯粹是协议封装。
   **少包一层上游会直接 400，而报错不会提到「少包了一层」**，所以有专门的测试钉住这个层级
3. **解析 `tool_calls` 与 `finish_reason`**：`content` 缺省或为 `null` 都如实表示为 `null`，
   不兜底成 `''`（空串会让调用方分不清「模型说了空话」与「模型没说话只开了调用单」）；
   `finish_reason` 缺省按 `stop`

`tool_calls` 必须逐字段校验后归一化（`normalizeToolCalls`）：`id` / `function.name` / `function.arguments`
都必须是 string，`type` 归一化为 `'function'`。**策略是「丢弃非法项、保留合法项」** ——
不校验的后果是 `tool_call_id: undefined`，`JSON.stringify` 时键被丢掉，下一轮请求 400，
而报错信息完全不指向真正的原因。

### 删掉的东西

`chatStream`、`readWithIdleTimeout`、`STREAM_IDLE_TIMEOUT_MS`、`llm/sse.ts` 全部删除（见 D5）。
`ReasoningContent` 的抑制逻辑（不读 `reasoning_content`）保留在注释里 —— 它是一条仍然成立的取舍。

---

## 10. HTTP 层（`http/`）

### 接口

```text
POST /api/sessions
  → 201 { sessionId, model }

POST /api/sessions/:id/messages      body: { message: string }
  → 200 { items: TranscriptItem[], stopReason: 'answered' | 'max-steps' }

GET  /api/sessions/:id/messages
  → 200 { items: TranscriptItem[] }
```

错误统一 `{ error: { code: string, message: string } }`。

| 状态 | 触发 |
|---|---|
| 400 | 参数非法（含 `req.body` 为 `undefined` 的情况） |
| 404 | 会话不存在 |
| 502 | 上游返回了错误响应 |
| 504 | 上游连不上 / 超时 |
| 500 | 其余 |

**上游 status 绝不原样透出。** `res.status(401)` 会把「我们的 DeepSeek key 无效」
变成「你这个浏览器用户没登录」，前端拿到 401 会去查一个不存在的登录态。
上游状态码只允许出现在 message 文本里。

**不引入错误类型体系**：`deepseek.ts` 只抛裸 `Error`，`http/errors.ts` 靠消息前缀识别。
按状态码细分属于 01-llm 明确推给 M6 的欠账。

### 五个实现要点

1. **`createApp(deps)` 返回 `express.Application`，不 listen。**
   测试用 `app.listen(0, '127.0.0.1')` + Node 原生 `fetch` 打临时端口，**不引 `supertest`**
   （它的核心价值是「不监听端口就能打请求」，而 `listen(0)` 是 5 行代码，且 `127.0.0.1`
   上的临时端口不出网，不违反「测试不依赖真实网络」）。
   注意 `server.close()` 会被 undici 的 keep-alive 连接挂住，必须先 `closeAllConnections()`。

2. **选 express 5 而非 4。** 决定性理由：**5 会把 async handler 的 rejected promise
   自动转给错误中间件**，4 需要 `asyncHandler` 包装或每个 handler 手写 try/catch，
   而本项目所有 handler 都是 async（要 `await runSessionTurn`）。
   代价是两处 4→5 陷阱：`app.get('*')` 会抛错、`req.body` 可能是 `undefined`。

3. **同一会话串行化。** `SessionRegistry.run(id, fn)` 用 promise chain 把同一 id 上的调用串起来。
   `Session.append` 是同步无锁的，而 `runSessionTurn` 中间有 await ——
   两个请求同时在途时，两条 `user` 消息会都先落地，第二条的 `toMessages()` 里就出现
   「`assistant{tool_calls}` 没有对应的 `tool` 回应」，上游直接 400，而那个报错完全不指向并发。
   锁必须在 registry 内部（与 Map 同一个持有者）。

4. **会话 id**：`YYYYMMDD-HHMMSS-xxxx`（本地时间 + 4 位随机十六进制），可读、可按字典序当时间序。
   因为本次没有文件系统，**不需要路径穿越校验** —— id 只用来查 Map，查不到就是 404。

5. **Map 加 FIFO 上限 100。** 淘汰的代价是零：浏览器 `localStorage` 里的 id 失效后本来就要处理 404
   （服务端重启也会 404），降级分支是已有需求。

### 依赖

`express@5.2.1`（运行时）+ `@types/express@5.0.6`（dev）。
这是本仓库**第一个运行时依赖**，理由与代价记在 D12。

---

## 11. 前端（`apps/web`）

### 项目形态

`apps/web` 是 monorepo 里的一个 workspace 包，有自己的 `package.json`、`tsconfig.json` 与 Vite 配置。
依赖在**阶段根**一次 `pnpm install` 装完。

### 联调

`vite.config.ts` 配 `server.proxy: { '/api': 'http://127.0.0.1:3000' }`，**不装 `cors`**。
前端代码里一律用**相对路径** `/api/...` —— 将来同源部署时不用改任何代码。
（本次不做同源部署。）

### 组件与状态

- 组件：`App` / `MessageList` / `MessageBubble`（三种样式）/ `ToolTrace` / `Composer`
- 状态：`useReducer` + 独立的纯函数 `chatReducer.ts`。
  理由**不是「状态多」**，而是 `items / status / notice` 三者若各用一个 `useState`，
  很容易渲染出「错误已设置但 status 还是 sending」的中间态。
- 不需要 `tempId`：`status === 'sending'` 时 Composer 禁用，同一时刻只有一个在途请求，
  回包一定属于最后一条 user 消息。

### 会话恢复

- `sessionId` 存 `localStorage`，**首次发送时才建会话**，不是 mount 就 `POST /api/sessions`
  —— 否则每刷新一次页面，服务端就多一个没人用的会话
- mount 时若本地有 id，`GET` 历史；**404（服务端重启 / 会话被淘汰）静默清掉 id 并给一条可关闭的提示**，
  不能白屏。下一次发送会自动新建

### 类型

前端 TypeScript 类型**手写一份 `apps/web/src/types.ts`**，不跨包 import 服务端的类型。
理由：那要把服务端的 `@types/node` 拖进前端 tsconfig、`@/` 别名要在两边各配一次，
而 `apps/web` 的 `tsconfig` 刻意设了 `"types": []` —— 前端**不应该**依赖 Node 的类型。
真正的守卫是 `test/http-app.test.ts` 里对响应 JSON 键与形状的断言，
`apps/web/src/types.ts` 是它的抄写（记为已知重复，见 D15）。

---

## 12. 错误处理

| 场景 | 行为 |
|---|---|
| API 非 2xx / 网络抛错 | HTTP 层映射成 502 / 504；前端显示一条可关闭的错误气泡 |
| 工具执行抛异常 | 兜底成 `{ok:false, error}` 回喂模型 |
| `arguments` JSON 解析失败 | 同上，错误文本含原文 |
| 跑满 `maxSteps` | 追加「已达最大步数，停止」后返回，`stopReason: 'max-steps'` |
| calculator 非法表达式 | 白名单正则 + 受限算术求值器，返回 `{ok:false}`，错误文本含表达式原文 |
| 上游返回 401/429 | HTTP 层一律 502，**上游 status 不透出** |
| 请求体不是合法 JSON | `400 invalid_body`（body-parser 的 `SyntaxError` 自带 `status: 400`） |

**提交原子性**：`added` 只在 `runAgentTurn` 成功返回后才 `appendAll` 进 `Session`（由 `runSessionTurn` 保证）——
上游中途失败则本轮只留下 user 消息、不残留半截工具痕迹（对齐 01-llm 的 D7）。

---

## 13. 测试策略（全部离线）

| 文件 | 关键用例 |
|---|---|
| `test/session.test.ts` | `append` 只接受 user/system；`appendMessage` 记录 tool 角色；`toMessages` 拼 `[system, ...]`；**改 `history()` 返回值的 `tool_calls` 不影响会话状态** |
| `test/deepseek.test.ts` | 请求体按线上的包装层级发 `tools`；**`tools` 为空数组时不带该字段**；解析 `tool_calls` 与 `finish_reason`；`content` 为 null；`finish_reason` 缺省 `stop`；**`tool_calls` 里混一条坏的 → 丢弃**；全是坏的 → 当作没有 |
| `test/tools-weather.test.ts` | Beijing 命中 `25°C, Sunny`；大小写与空白不敏感；未知城市兜底且注明「模拟数据」；缺 `city` → `{ok:false}` |
| `test/tools-time.test.ts` | 返回可解析 ISO 字符串；忽略多余参数 |
| `test/tools-calculator.test.ts` | 四则 / 括号 / 一元负号；除零；字母与非法字符 → `{ok:false}`；语法错误；**错误文本含表达式原文** |
| `test/tools-registry.test.ts` | 注册三个；`list()` 返回三份 schema；按名派发；未知名 → `{ok:false}`；`list()` 返回新数组 |
| `test/agent.test.ts` | 无工具直答；一轮工具后收敛；多步循环；一轮多个调用；参数非法回喂；工具抛错回喂；未知名工具回喂；**`finish_reason:'stop'` + 有 `tool_calls` 仍要执行工具**；**`client.chat` 调用次数恰好等于 maxSteps**；跑满时最后一条是带 content 的 assistant；输入 messages 不被修改；`runSessionTurn` 的 user 先于 toMessages；失败时不追加；`session.model` 作为 per-call 参数传下去 |
| `test/transcript.test.ts` | 三类折叠；只有 tool_calls 无正文的 assistant 不产出 assistant 项；失败结果（非 JSON）→ `ok:false`；配不上对的 tool_calls → `ok:null`；既有正文又有 tool_calls 时两者都不丢 |
| `test/http-session-registry.test.ts` | 同 id 串行（`A…A…B…B`）；不同 id 不阻塞；前一次失败不毒化这条链；FIFO 淘汰；未知 id 抛 `SessionNotFoundError` |
| `test/http-errors.test.ts` | 上游 401 → 502；`fetch failed` → 504；未知 → 500；返回值只可能是 500/502/504 |
| `test/http-app.test.ts` | `app.listen(0)` + fetch：建会话 / 发消息 / 取历史 / 未知会话 404 / **不带 Content-Type → 400** / 非法 JSON → 400 / 上游 401 → 502 / 失败轮不写进会话 / 未知路径 → **JSON** 404；**逐字断言响应 JSON 的键与形状**（这是前端类型的真正守卫） |
| `test/main.test.ts` | 子进程 + `AI_AGENT_PORT=0`：缺 key → 退出码 1 + stderr；起来后 stdout 打印真实端口；`SIGTERM` 能干净退出 |

集成（离线）：fake client 先返回一次 `tool_calls` 再返回最终答案，跑通整个 HTTP 天气流程。

---

## 14. 工具链

- Node ≥ 22 原生类型擦除直接运行：`node --import ./loader.mjs src/main.ts`
- TypeCheck：`tsc --noEmit`
- 测试：`node --test`
- 服务端：`dependencies` 只有 `express`；devDependency 为 `typescript` + `@types/node` + `@types/express`
- 前端：React 19 + Vite 8，独立工具链，与上面前三条无关

阶段根的命令（一条命令跑全部）：

```bash
pnpm install          # 一次装完两个 app
pnpm start            # 起服务端
pnpm dev              # 并行起服务端 + 前端 dev server
pnpm test             # 服务端的 node --test
pnpm run typecheck    # 两个 app 都跑 tsc --noEmit
```

---

## 15. 需在实施时核实的一点

DeepSeek 工具调用遵循 OpenAI 兼容格式（`tools` 数组 + `message.tool_calls` + `finish_reason:"tool_calls"`，
`arguments` 为 JSON 字符串）。`demos/01-llm/docs/deepseek-api-facts.md` 已确认 `tool` 角色与
`tool_calls` finish_reason 存在；实施时**对照 DeepSeek 官方文档再核一遍确切字段名**，
尤其确认 `tools` 数组元素的包装层级是不是 `{type:'function', function:{…}}`（§9 的 `toWireTools`）。

---

## 16. 验收

- TypeCheck：`pnpm run typecheck` 通过（两个 app）
- Test：`pnpm test` 全绿
- Build：服务端无构建产物（noEmit）；`apps/web` 的 `pnpm -F web build` 通过
- 手动冒烟：真实 `DEEPSEEK_API_KEY` 下端到端跑通天气例子 ——
  浏览器先出现 `weather` 轨迹，再出现「北京今天 25°C，晴天。」
- 冒烟附带验证：刷新页面历史仍在；杀掉服务端再刷新 → 出现可关闭的提示而非白屏；
  连刷三次页面服务端会话数不增长

---

## 17. 设计决策（待写入 DECISIONS.md，独立编号）

- **D1 复制范围收窄到 4 个文件** —— 只复制 `core/types.ts`、`core/session.ts`、`llm/client.ts`、
  `llm/deepseek.ts` 作为起点，其余全部新写。放弃「复制整个 M3 底座」：那会把阶段一已学过的
  readline、stdout/stderr 分流、JSONL 落盘一并拖进来。
- **D2 砍掉 CLI 入口** —— CLI 买不到任何与 Tool Calling / Agent Loop 相关的东西，
  它买的是阶段一已经买过的经验。代价：失去终端调试器（`curl` 可替代）与「一套 core 换两种前端」
  的演示（`test/agent.test.ts` 已离线证明 core 不依赖任何入口）。
- **D3 砍掉会话持久化** —— 随 CLI 一起消失。直接收益：会话日志格式升级（`SessionChange` 承载
  tool 消息、`parseRecord` 白名单、老 `.jsonl` 字节级兼容）**根本不需要做**，
  连带四条风险（`parseRecord` 写 `undefined` 键、`/history` 遇到 `content: null` 崩溃、
  `SYSTEM_PROMPT` 把 `node:readline` 拖进服务端、老文件兼容）一起消失。
  代价：刷新页面靠服务端内存，重启即丢。
- **D4 agent 层只产出事实，展示投影全在外层** —— `runAgentTurn` 只返回 `{final, added, stopReason}`，
  不再返回 `ToolStep`；`TranscriptItem` 从 core 移到 `presentation/`。
  放弃原设计的 `steps`（它带着 `index` 与 `ms` 两个纯为界面存在的字段，
  `ms` 甚至是「唯一非确定字段，测试不得断言」）。代价：界面分不出「参数非法」与「工具失败」——
  两者的错误文本本身就写着原因，用户信息没有损失。
- **D5 砍掉 SSE / `chatStream` / `sse.ts` / `StreamEvent`** —— 与 D8 是同一条理由：
  无入口的代码会变成下个里程碑的既成事实。下个里程碑做「流式 + 工具」时，
  分片 `tool_calls` 拼接本来就要另写一套，留着只是重写前的负担。
- **D6 `Session` 退回纯类** —— 删掉 `onChange` / `clear()` / `set model` / 构造时的 `history` 参数。
  它们各自的唯一消费者（落盘、`/clear`、`/model`、`--resume`）随 CLI 与持久化一起消失。
- **D7 循环条件看 `tool_calls`、不看 `finish_reason`** —— 部分服务端会在 `stop` 的同时返回 `tool_calls`。
- **D8 工具失败回喂模型而非崩溃**。
- **D9 `maxSteps` 防死循环**（默认 6）；跑满时追加的最后一条必须是带 `content` 的 assistant。
- **D10 weather 用确定性 mock**：无网络 / 无 key，聚焦 tool calling 本身。
- **D11 calculator 白名单正则 + 受限算术求值器**（非 `eval` / `new Function`）。
- **D12 服务端引入 `express`** —— 本仓库第一个运行时依赖，破掉「零运行时依赖」。
  选 express 5 的决定性理由是 async handler 的 rejected promise 自动转错误中间件。
- **D13 前端 React + Vite，放在 monorepo 的 `apps/web`** —— 本仓库第一个前端构建步骤，
  破掉「不引入构建步骤」。放弃原生 HTML/JS（守住零构建）与 Vue CDN（引入外部 CDN 依赖）。
- **D14 前端不引测试框架，但 reducer 拆成纯模块** —— 一笔**已知欠账**，
  目的是使将来补测试不需要重构。半年后不能误以为前端有测试覆盖。
- **D15 前端类型手写一份，不跨包共享** —— 本次只做「两个 app」，
  还没有值得抽 `packages/` 的第三份共享代码；真正的守卫是服务端测试里的键断言。
- **D16 会话 Map 用 FIFO 上限 100** —— 淘汰代价为零。
- **D17 只监听 `127.0.0.1`，不做鉴权与 CORS 白名单** —— 本机开发工具，不是可暴露的服务。
- **D18 展示投影只定义一次** —— 实时与历史两条路径共用 `foldTranscript`，
  前端只需要一套渲染逻辑。放弃「POST 返回 steps、GET 返回 messages」的两套形状。
- **D19 仍非流式**；**D20 不自动重试**（对齐 01-llm 的 D5）。
- **D21 阶段目录用 pnpm workspace（monorepo）而不是「根即服务端」** ——
  后者会让 `demos/02-agent/package.json` 既当阶段根又当服务端，`src/` 与 `web/` 的地位看不出区别。
  `apps/` 下两个平级应用把边界写在名字里，且阶段根仍能一条命令跑全部。
  这在仓库里是第一次：跨阶段约束「各阶段是独立项目」指的是**阶段之间**，阶段内部的组织形式不在此列。
