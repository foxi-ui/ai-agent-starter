# ai-chat-agent 工具调用（Tool Calling）· 设计文档

> **后续进展（2026-09-25 补记）：本文档已被取代，正文保留作为历史记录。**
>
> 取代它的是 [`2026-09-25-ai-chat-agent-web-design.md`](2026-09-25-ai-chat-agent-web-design.md)。
> 作废的三个原因：
>
> 1. **本文档描述的起点不存在了。** 它的 §2「本次范围」写着「复制 `ai-chat` 阶段一底座：
>    `config` / `session` / `deepseek` / `repl` 骨架」—— 那是 **M1 时代的 01-llm**；
>    而它的「明确推迟」清单同时列着「streaming（SSE 解析）」「会话持久化（JSONL 落盘、`--resume`）」
>    「命令 `/clear` `/history` `/model` `/usage`」—— **这三样 01-llm 已经全部做完了**（M3 完成态）。
> 2. **形态改变，且范围收窄。** 原设计是纯 CLI 项目；新设计改成 pnpm monorepo 里的
>    **Express 服务端 + React 前端**两个应用。CLI 与它拖进来的 readline / 落盘 / 日志格式升级
>    被整体砍掉 —— 那些都是阶段一已经学过的题目，与 Tool Calling 无关。
> 3. **展示层与 agent 层的边界重划。** 本文档 §8 让 `runAgentTurn` 返回 `steps`（`ToolStep` 数组），
>    而那个结构里带着 `index` 与 `ms` 两个纯为界面存在的字段。新设计里 agent 层只产出事实
>    （`added: Message[]`），展示项一律由 `presentation/` 投影。
>
> 本文档里**仍然有效**的部分（新设计已继承）：§5 的消息联合类型设计、§6 的 `ToolRegistry` 接口、
> §7 的三个工具、§8 的 Agent 循环四个兜底、§11 的错误处理表，
> 以及 §16 的决策 D2/D4/D5/D6/D7/D8/D9/D10（编号在新文档里已重排）。
> 新设计对它们的改动逐条记在新文档的 §1.1 与 §17。

- 日期：2026-09-23
- 状态：**已被取代**（2026-09-25），正文不再更新
- 范围：阶段二「LLM + Tool Calling」——自实现一个最简单的 Agent（Agent Loop + Tool Schema + Tool Registry），本地工具，非流式。
- 前置项目：`demos/01-llm`（阶段一，非流式多轮对话），本项目的代码底座复制自它。

---

## 1. 背景与目标

`ai-chat` 走通了「LLM API → 消息结构 → 上下文管理」这条链路的起点（非流式多轮对话）。
本阶段（`ai-chat-agent`）在其之上叠加**工具调用**，亲手实现一个最简单的 Agent。

对应 `docs/ROADMAP.md` 的阶段 1「第一个 Agent」（学习内容：Tool Calling / Agent Loop / State）。以天气为例：

```text
用户：北京今天天气怎么样？
Agent：需要天气工具
Tool Call：weather("Beijing")
Tool Result：25°C, Sunny
Final：北京今天 25°C，晴天。
```

成功标准（本次范围）：

- 模型能按 `tools` 声明决定「要不要调工具、调哪个、传什么参」
- Agent 循环：调 LLM → 有 `tool_calls` 就执行工具、把结果回喂 → 再调，直到出最终答案
- 循环有界（`maxSteps`），工具失败/参数非法不崩溃，回喂模型自行纠正
- Tool Schema / Tool Registry 结构清晰，Registry 预留 MCP 挂载点（本次不实现 MCP）
- 全部行为可在无网络下断言（fake client + fake registry）

---

## 2. 范围界定

### 本次范围

- 复制 `ai-chat` 阶段一底座：`config` / `session` / `deepseek` / `repl` 骨架，作为起点
- 扩展消息结构：`Message` 支持 `tool` 角色与 `tool_calls`（可辨识联合）
- 新增 `tools/` 层：`Tool` 声明 + `ToolRegistry` + 三个无状态工具（weather / get_time / calculator）
- 新增 `core/agent.ts`：Agent 循环 `runAgentTurn`
- 扩展 `llm/deepseek.ts`：发送 `tools`、解析 `tool_calls` 与 `finish_reason`
- 非流式（与 ai-chat 一致，streaming 继续延后）

### 明确推迟（本次不实现、不设计细节）

- MCP Client / MCP Server（只预留 Registry 挂载点）
- streaming（SSE 解析）
- 会话持久化（JSONL 落盘、`--resume`）
- 命令 `/clear` `/history` `/model` `/usage`
- token 统计 / 成本账本
- 自动重试 / 熔断
- 一次性模式 `-p`

---

## 3. 架构

在 ai-chat 的三层内核之上，新增一个独立 `tools/` 层：

```text
cli/     readline 主循环、打印、配置解析
  ↓ 只依赖 core 与 llm 的公开接口
core/    会话状态、消息组装、Agent 循环、ToolRegistry 接口
  ↓ 只依赖 llm 的公开接口
llm/     DeepSeek adapter：请求构造、工具声明序列化、tool_calls 解析
tools/   具体工具实现（weather / get_time / calculator）—— 被 index.ts 注入，非 core 直接 import
```

- `core` / `llm` / `tools` 都不 import `node:readline`、不写 `process.stdout`。
- 两个测试接缝（均通过依赖注入，测试用替身替换）：
  1. `LLMClient`（已有）
  2. `ToolRegistry`（新增，接口在 core，实现在 tools）
- `ToolRegistry` 的**接口**声明在 `core/tool-registry.ts`（与 `LLMClient` 接口同级、作为稳定契约），
  **实现**在 `tools/registry.ts`。将来 MCP 接入时给实现类加 `mount()` 挂载点，接口不变、core/llm 不动。

---

## 4. 目录结构

```text
demos/02-agent/
  package.json          # type: module；scripts: start / test / typecheck
  tsconfig.json         # strict；noEmit；module: nodenext；allowImportingTsExtensions
  loader.mjs            # 注册 @/ 别名钩子（复制自 ai-chat）
  loader-hooks.mjs
  .env                  # 模板（占位符，入库）
  .env.local            # 真实密钥（gitignore）
  .gitignore
  src/
    index.ts            # 入口：解析配置 → 组装 client + registry → runRepl
    cli/
      config.ts         # 复制自 ai-chat（env → Config）
      repl.ts           # 改造：注入 registry，每轮调 runAgentTurn 而非 client.chat
    core/
      types.ts          # 扩展：Role/Message/ToolCall/Tool/ToolResult/FinishReason/ChatResult
      tool-registry.ts  # 新增：ToolRegistry 接口（list / execute）
      session.ts        # 扩展：appendMessage / appendAll 支持 tool 消息
      agent.ts          # 新增：Agent 循环 runAgentTurn
    tools/
      registry.ts       # 新增：createToolRegistry() 注册 weather/get_time/calculator
      weather.ts        # 新增：确定性 mock
      time.ts           # 新增：get_time
      calculator.ts     # 新增：四则运算（白名单 + 非 eval）
    llm/
      client.ts         # 扩展：chat(messages, options?) → ChatResult
      deepseek.ts       # 扩展：发送 tools、解析 tool_calls / finish_reason
  test/                 # 与被测模块一一对应
  docs/  troubleshooting.md
  README.md  ARCHITECTURE.md  DECISIONS.md  EVALUATION.md
```

---

## 5. 类型改动（core/types.ts）

`Message` 从单一结构改为**可辨识联合**（本次对既有契约的唯一硬改动）：

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool';

type FinishReason =
  | 'stop' | 'length' | 'content_filter' | 'tool_calls'
  | 'insufficient_system_resource' | 'aborted';

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
  content: string | null;      // 工具轮次中可为 null
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
```

注意：`assistant.content` 变为 `string | null`——工具调用轮次里模型可能只给 `tool_calls`、`content` 为 `null`。
`Session.append` 与 `repl.ts` 对 `content` 的打印/拼接都要适配。

---

## 6. ToolRegistry 接口（core/tool-registry.ts）

```ts
interface ToolRegistry {
  list(): Tool[];                                   // 序列化成请求里的 tools
  execute(name: string, args: unknown): Promise<ToolResult>;  // 按名派发
}
```

- 这是第二个测试接缝。
- MCP-ready：将来接入 MCP 时给 `tools/registry.ts` 的实现加 `mount()`，接口不变。

---

## 7. tools 层（三个无状态工具）

| 文件 | 工具 | 参数 | 行为 |
|---|---|---|---|
| `weather.ts` | `weather` | `{ city: string }` | 确定性 mock：内置小表（Beijing → `25°C, Sunny`，Shanghai、Shenzhen 等），命中返回对应值，未命中返回固定兜底并注明「模拟数据」。无网络、无 key |
| `time.ts` | `get_time` | 无 | 返回 `{ now: <ISO 字符串> }`（当前时间） |
| `calculator.ts` | `calculator` | `{ expression: string }` | 只支持 `+ - * / ( )` 与数字；先正则白名单校验，再用受限算术求值器求值（**不用 `eval` / `new Function`**）；非法表达式返回 `{ ok:false }` |

- 每个工具自带 `Tool` 声明（name/description/parameters schema）+ `run(args)` 实现。
- `tools/registry.ts` 的 `createToolRegistry()` 把三者注册进 `Map`，`execute` 按名派发；
  工具自身负责参数校验，抛出的异常由 agent 兜底成 `{ ok:false, error }`。
- 全部纯逻辑、无 I/O，可离线单测。

---

## 8. Agent 循环（core/agent.ts）

```ts
interface AgentOptions { maxSteps?: number }   // 默认 6

interface AgentTurn {
  final: ChatResult;       // 最终回答
  added: Message[];        // 本轮新追加的消息（assistant{tool_calls} + tool 结果 + 最终 assistant）
}

async function runAgentTurn(
  client: LLMClient,
  registry: ToolRegistry,
  messages: Message[],       // 输入上下文 [system, ...history, user]，函数内部不修改它
  options?: AgentOptions,
): Promise<AgentTurn>
```

循环（内部维护 `working = [...messages]` 与 `added = []`）：

```text
for step in 1..maxSteps:
  result = client.chat(working, { tools: registry.list() })
  if result.tool_calls 非空:
    working.push(assistant{ tool_calls })             # 记录「模型要调工具」
    for tc in result.tool_calls:
      args = 尝试 JSON.parse(tc.function.arguments)   # 解析失败 → {ok:false, error:"参数 JSON 非法"}
      tr   = await registry.execute(tc.function.name, args)   # 抛异常兜底成 {ok:false}
      content = tr.ok ? JSON.stringify(tr.value) : tr.error   # 成功回值、失败回错误文本
      working.push(tool{ tool_call_id: tc.id, content })
    continue
  else:
    working.push(assistant{ content: result.content })
    return { final: result, added }
# 跑满 maxSteps 仍未收敛 → 追加一条 assistant「（已达最大步数，停止）」并返回
```

三个刻意的学习点：

- **工具失败 / 参数非法不崩**：作为 `tool` 结果的错误文本回给模型，让它自己纠正。
- **`maxSteps` 上限**（默认 6）防死循环，对应 guides「Agent 为什么会无限循环」，必须有界。
- `tool_calls` 里可能多个工具调用，按序逐个执行、每个各回一条 `tool` 消息。

---

## 9. LLM 扩展（llm/client.ts + llm/deepseek.ts）

- 接口：`chat(messages, options?: { tools?: Tool[] }): Promise<ChatResult>`。
- `deepseek.ts`：请求体在有工具时多传 `tools`；响应解析从只取 `content` 扩展为同时取
  `message.tool_calls` 与 `finish_reason`（缺省按 `stop`）。仍非流式，`reasoning_content` 仍抑制，非 2xx 仍抛错。

---

## 10. REPL 接入（cli/repl.ts）

`runRepl(client, registry, options)` 注入两个接缝，每轮：

```text
session.append('user', question)
{ final, added } = runAgentTurn(client, registry, session.toMessages(SYSTEM_PROMPT))
session.appendAll(added)      # 把 tool 消息 + 最终 assistant 一并落进历史
write(final.content)
```

- `Session` 新增 `appendMessage(message: Message)` / `appendAll(messages: Message[])`。
- `SYSTEM_PROMPT` 补一句「需要时可调用工具」。

### 数据流（天气例子端到端）

```text
用户: "北京今天天气怎么样？"
messages = [system, user:"北京今天天气怎么样？"]

step1: chat(messages, {tools}) → finish_reason="tool_calls",
       tool_calls=[{id:"call_1", function:{name:"weather", arguments:'{"city":"Beijing"}'}}]
       → execute("weather",{city:"Beijing"}) → {ok:true, value:{temperature:"25°C", condition:"Sunny"}}
       → messages 追加 assistant{tool_calls} + tool{"25°C, Sunny"}

step2: chat([system, user, assistant{tool_calls}, tool{...}], {tools})
       → finish_reason="stop", content="北京今天 25°C，晴天。"
       → 追加 assistant{content}

REPL 打印: "北京今天 25°C，晴天。"
```

---

## 11. 错误处理

| 场景 | 行为 |
|---|---|
| API 非 2xx / 网络抛错 | 沿用 ai-chat：打印 `[error]`，不崩、不自动重试 |
| 工具执行抛异常 | 兜底成 `{ok:false, error}` 回喂模型 |
| `arguments` JSON 解析失败 | 同上，作为错误文本回喂 |
| 跑满 `maxSteps` | 追加「已达最大步数」提示后停止 |
| calculator 非法表达式 | 白名单正则拦截 + 受限算术求值器（非 `eval` / `new Function`），返回 `{ok:false}` |

**提交原子性**：`added` 只在 `runAgentTurn` 成功返回后才 `appendAll` 进 Session——
API 中途失败则本轮只留下 user 消息、不残留半截工具痕迹（对齐 ai-chat 的 D7）。

---

## 12. 测试策略（全部离线）

| 文件 | 关键用例 |
|---|---|
| `tools/weather.test.ts` | Beijing 命中 `25°C, Sunny`；未知城市兜底；缺 `city` → `{ok:false}` |
| `tools/time.test.ts` | 返回可解析 ISO 字符串 |
| `tools/calculator.test.ts` | 四则/括号；除零；字母与非法字符 → `{ok:false}` |
| `tools/registry.test.ts` | 注册三个；`list()` 返回三份 schema；按名派发；未知名 → `{ok:false}` |
| `core/agent.test.ts` | 一轮工具后收敛；多步循环；maxSteps 上限；参数非法回喂；工具抛错回喂；无工具直答 |
| `core/session.test.ts` | `appendMessage` 记录 tool 角色；`toMessages` 仍拼 `[system,...]` |
| `llm/deepseek.test.ts` | 请求体带 `tools`；解析 `tool_calls`；`finish_reason` 缺省 `stop`；`content` 为 null |
| `cli/repl.test.ts` | fake client+registry：问天气 → 打印最终答案；失败轮不残留 assistant |

集成（离线）：fake client 先返回一次 `tool_calls` 再返回最终答案，跑通整个 REPL 天气流程、断言 stdout。

---

## 13. 工具链

- Node 22 原生类型擦除直接运行：`node --import ./loader.mjs src/index.ts`（脚本同 ai-chat）。
- TypeCheck：`tsc --noEmit`。
- 测试：`node --test`。
- 零运行时依赖；devDependency 仅 `typescript` + `@types/node`。

---

## 14. 需在实施时核实的一点

DeepSeek 工具调用遵循 OpenAI 兼容格式（`tools` 数组 + `message.tool_calls` + `finish_reason:"tool_calls"`，
`arguments` 为 JSON 字符串）。`demos/01-llm/docs/deepseek-api-facts.md` 已确认 `tool` 角色与 `tool_calls`
finish_reason 存在；实施时对照 DeepSeek 官方文档再核一遍确切字段名。

---

## 15. 验收

- TypeCheck：`tsc --noEmit` 通过
- Test：`node --test` 全绿
- 手动冒烟：真实 `DEEPSEEK_API_KEY` 下端到端跑通天气例子（输出「北京今天 25°C，晴天。」）

---

## 16. 设计决策（待写入 DECISIONS.md，独立编号）

- D1 复制底座而非修改 ai-chat：两个课程模块各自独立，互不污染。
- D2 方案 A：Agent 循环独立成 `core/agent.ts` + `tools/` 独立层，守住既有分层与接缝。
- D3 `ToolRegistry` 接口在 core、实现在 tools：MCP-ready，接口稳定。
- D4 工具失败回喂模型而非崩溃。
- D5 `maxSteps` 防死循环。
- D6 weather 用确定性 mock：无网络/无 key，聚焦 tool calling 本身。
- D7 提交原子性：`added` 仅在 `runAgentTurn` 成功后 `appendAll`。
- D8 calculator 白名单 + 受限算术求值器（非 `eval` / `new Function`）。
- D9 仍非流式（streaming 继续延后）。
- D10 不自动重试（对齐 ai-chat D5）。
