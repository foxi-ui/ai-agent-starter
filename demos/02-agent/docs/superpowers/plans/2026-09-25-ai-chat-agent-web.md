# ai-chat-agent 前后端分离改造（monorepo）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `demos/02-agent/` 建一个 pnpm monorepo，`apps/server` 是内含自实现 Agent 的 Express 服务端，`apps/web` 是能看到工具调用轨迹的 React 聊天前端。

**Architecture:** 服务端内部分 `http → presentation → core → llm` 四层单向依赖，`tools → core`。`core/agent.ts` 的 `runAgentTurn` 只产出**事实**（`final` / `added` / `stopReason`），展示项一律由 `presentation/transcript.ts` 从 `added` 或 `history()` 投影 —— 这是本次相对上一版设计最重要的一处收窄。前端只认 HTTP 契约，`vite.config.ts` 的 proxy 把 `/api` 反代到服务端，因此不需要 CORS。

**Tech Stack:** Node 22（原生 TS 类型擦除，服务端无构建步骤）、pnpm workspace、`node --test`、express 5；`apps/web` 是 React 19 + Vite 8 的独立工具链。

**Spec:** `demos/02-agent/docs/superpowers/specs/2026-09-25-ai-chat-agent-web-design.md`（本计划实现其全部内容）

## Global Constraints

以下约束对**每一个** Task 都生效。数值与措辞抄自 spec 与根 `AGENTS.md`。

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
  **不写** `process.stdout` / `process.stderr`；只有 `src/main.ts` 碰 `process`
- **`core/types.ts` 里不许出现为了界面存在的字段**（判断标准：删掉它，浏览器上的东西会少一块吗？）
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**；`start` / `dev` / `test` 三个脚本都要带
- ESM（`"type": "module"`）；包管理器 pnpm
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（裸 `node --test` 会匹配到它，静默撑大用例数）
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿

## 起点状态（已实测）

```text
工作目录       demos/02-agent/（当前只有 docs/，无 package.json、无源码）→ 本计划 T1 建 monorepo
基线仓库       demos/01-llm/    M1–M3 完成态，11 个测试文件 167 个用例全绿
Node           v22.23.2
pnpm           10.34.5
express        5.2.1（要装的运行时依赖）
@types/express 5.0.6
react          19.3.0 / vite 8.3.1
git 分支       main（无 remote，直接在 main 上提交）
工作区         干净（spec 与 AGENTS.md 的改动已提交）
```

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。**每一条都在下面指名的 Task 里有对应测试** —— 写测试时不要漏。

1. **`finish_reason: 'stop'` 但响应里带 `tool_calls`** —— 部分 OpenAI 兼容实现会这样返回；
   若循环条件看 `finish_reason` 就会漏调工具、把 `content: null` 当答案回给用户（前端显示空气泡）。
   测试落点：Task 5 Step 2 的 `stop` + `tool_calls` 用例。
2. **请求体不带 `Content-Type: application/json`** —— express 5 下 `req.body` 是 `undefined`，
   直接取 `.message` 会抛 `TypeError` 变成 500。期望行为是 400。测试落点：Task 9 Step 3。
3. **上游返回 401** —— 那是「我们的 key 配错了」，不是「浏览器用户没登录」。
   期望行为是响应 502，上游状态码不透出。测试落点：Task 8 Step 1。
4. **同一会话并发两个请求** —— 期望串行（`A…A…B…B`）而不是交错（`A B A B`）；
   交错会让 `toMessages()` 里出现没有 `tool` 回应的 `assistant{tool_calls}`，上游报 400 且错因完全不指向并发。
   测试落点：Task 7 Step 2。
5. **一个只有 `tool_calls`、没有正文的 assistant 消息** —— 它不该在对话框里产生一个空气泡；
   而它后面的 `tool` 结果必须正确填回对应那一项（靠 `tool_call_id` 配对）。
   测试落点：Task 6 Step 1。

---

### Task 1: monorepo 骨架 + 复制起点

建 pnpm workspace，复制 01-llm 的**两个测试文件**作为起点。
这一 Task 结束时 `pnpm -F server test` 应该给出**一大批失败** —— 那是预期的，
失败清单正好枚举了后续 T2/T3 要改的东西。

**Files:**
- Create: `demos/02-agent/pnpm-workspace.yaml`、`package.json`
- Create: `demos/02-agent/apps/server/{package.json,tsconfig.json,loader.mjs,loader-hooks.mjs,.env,.env.local,.gitignore}`
- Create: `demos/02-agent/apps/server/src/{core,llm}/**`（复制 4 个文件）
- Create: `demos/02-agent/apps/server/test/{session,deepseek}.test.ts`（复制）

**Interfaces:**
- Consumes: 无（这是起点）
- Produces: 一个能 `pnpm install`、能跑测试（有失败）的 monorepo

- [ ] **Step 1: 建 workspace 根**

`demos/02-agent/pnpm-workspace.yaml`：

```yaml
packages:
  - 'apps/*'
```

`demos/02-agent/package.json`（**只有编排脚本，没有源码、没有依赖**）：

```json
{
  "name": "ai-chat-agent",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@10.34.5",
  "scripts": {
    "start": "pnpm --filter server start",
    "dev": "pnpm --parallel --filter \"./*\" dev",
    "test": "pnpm --filter server test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

- [ ] **Step 2: 复制起点文件**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
SRC=demos/01-llm
DST=demos/02-agent/apps/server
mkdir -p "$DST/src/core" "$DST/src/llm" "$DST/test"

cp "$SRC/tsconfig.json" "$SRC/loader.mjs" "$SRC/loader-hooks.mjs" "$DST/"
cp "$SRC/.env" "$SRC/.env.local" "$DST/"

cp "$SRC/src/core/types.ts" "$SRC/src/core/session.ts" "$DST/src/core/"
cp "$SRC/src/llm/client.ts" "$SRC/src/llm/deepseek.ts" "$DST/src/llm/"

cp "$SRC/test/session.test.ts" "$SRC/test/deepseek.test.ts" "$DST/test/"
```

**不要复制** `cli/`、`core/journal.ts`、`core/commands.ts`、`llm/sse.ts`、`src/index.ts`、
`examples/`、`.sessions/`，也不要复制其余 9 个测试文件 —— 它们测的都是本次已砍掉的东西（见 spec D2/D3/D5）。

- [ ] **Step 3: 写 `apps/server/package.json`**

```json
{
  "name": "server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/main.ts",
    "dev": "node --watch --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/main.ts",
    "test": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs --test",
    "typecheck": "tsc --noEmit"
  }
}
```

**三个脚本都必须带 `--import ./loader.mjs`**（`src/main.ts` 这一步还不存在，先放着）。

- [ ] **Step 4: 写 `apps/server/.gitignore`**

```gitignore
.env.local
```

（`.env.local` 已被仓库根的 `.gitignore` 覆盖，这里只是让子项目单独取出时也自包含；
`.sessions/` 本次不存在，不需要。）

- [ ] **Step 5: 安装**

Run: `cd demos/02-agent && pnpm install`
Expected: 成功，`node_modules/` 出现（workspace 根一份 + `apps/server` 的软链），`pnpm-lock.yaml` 生成

- [ ] **Step 6: 跑测试，确认失败清单**

Run: `cd demos/02-agent && pnpm test`
Expected: **大量失败**。`Cannot find module '@/core/journal.ts'`（`session.ts` 还在 import 它）
以及 `session.ts` 缺 `TYPE` 之类的连锁错误。这是预期起点。

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent
git commit -m "chore: 建 02-agent 的 pnpm workspace 骨架，复制 01-llm 的 4 个源文件作起点"
```

---

### Task 2: 类型契约与 `Session` 改造

`Message` 改成可辨识联合，`Session` 退回纯类，`LLMClient` 收窄成单方法。
`src/` 与 `test/` 同属一个 tsconfig，所以必须在同一个 Task 里改完。

**Files:**
- Modify: `demos/02-agent/apps/server/src/core/types.ts`
- Modify: `demos/02-agent/apps/server/src/core/session.ts`
- Modify: `demos/02-agent/apps/server/src/llm/client.ts`
- Test: `demos/02-agent/apps/server/test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 的骨架
- Produces: `Role`（4 值）；`ToolCall`；`Tool`；`ToolResult`；`Message`（联合）；
  `ChatResult`（含 `tool_calls` / `finish_reason`）；`ChatOptions.tools`；
  `LLMClient.chat()`；`Session`（`model` / `append` / `appendMessage` / `appendAll` / `toMessages` / `history`）

- [ ] **Step 1: 改 `src/core/types.ts`**

`Role` 替换为：

```ts
/**
 * 消息的四种角色。这是 OpenAI-compatible 接口的通用约定：
 *
 * - `system`    —— 给模型的固定指令（「你是谁、该怎么回答」）
 * - `user`      —— 用户说的话
 * - `assistant` —— 模型的回答（可能不含正文、只开一张工具调用单）
 * - `tool`      —— **程序**执行工具后填回的结果，不是模型说的
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';
```

`Message` 替换为：

```ts
/**
 * 一条对话消息，也是发给 API 的最小单位。
 *
 * 它是**可辨识联合**而不是扁平结构：三种角色的字段并不相同 ——
 * assistant 可能只开调用单没有说话（`content` 为 `null`），
 * tool 必须说明自己在回应哪一张调用单（`tool_call_id`）。
 * 写成扁平 interface 用可选字段糊过去，会让「assistant 忘了带 tool_calls」
 * 这类 bug 一路溜到运行时才发现。
 *
 * 关键理解：模型本身不「记得」任何东西。所谓多轮对话，
 * 靠的是每次把完整的消息数组重新发过去。
 */
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
```

`ChatResult` 替换为：

```ts
/**
 * `LLMClient.chat()` 的返回值。
 *
 * `content` 在工具调用轮次里可以是 `null` —— 模型那一轮没说话，只开了调用单。
 * 所以调用方**不能**假设它一定有正文；兜底成 `''` 会让「模型说了空话」
 * 与「模型没说话」变得无法区分。
 */
export interface ChatResult {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
}
```

`ChatOptions` 替换为：

```ts
export interface ChatOptions {
  /** 本次请求使用的模型；不传则由 client 用它构造时的默认值 */
  model?: string;
  /**
   * 本次请求携带的工具声明。
   *
   * 空数组与不传**语义不同**：不传 = 这次不带工具；空数组在部分
   * OpenAI 兼容实现上会 400，所以 llm 层对空数组按「不带」处理。
   */
  tools?: Tool[];
}
```

在 `FinishReason` 之后新增：

```ts
/**
 * 模型开出的一张「调用单」。
 *
 * 关键理解：模型**从不执行**任何函数。它只是输出了这个结构 ——
 * 函数名与参数都是文字，真正去执行的是我们的程序（见 tools/ 与 core/agent.ts）。
 *
 * `arguments` 是 **JSON 字符串**而不是对象：模型逐字生成文本，中途可能截断，
 * 所以它天然可能是非法 JSON，解析必须容错（见 core/agent.ts）。
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 工具的**声明** —— 发给模型看的那份说明，不是实现。
 *
 * 这里是**扁平形状**（name/description/parameters 平铺）。
 * 线上的 `tools` 数组元素要再包一层 `{type:'function', function:{…}}`，
 * 那层包装收敛在 llm/deepseek.ts 的 toWireTools() 里 ——
 * 内部的调用方只关心「叫什么、要什么参数」。
 */
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<
      string,
      { type: 'string' | 'number' | 'boolean' | 'integer'; description?: string }
    >;
    required?: string[];
  };
}

/**
 * 工具执行的结果。
 *
 * 失败**不是异常**，是一种正常结果：错误文本会被当作 `tool` 消息的 content
 * 回喂给模型，让它看到「工具报错了」后自行纠正（见 core/agent.ts）。
 */
export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
```

**删除 `StreamEvent`** 及其上方的注释块（整块删）。

- [ ] **Step 2: 改 `src/llm/client.ts`**

```ts
// LLM 客户端的接口。core 层只认它，不知道背后是 DeepSeek。
//
// 它是本项目最重要的一个测试接缝：测试塞一个手写的对象字面量进来，
// 整个 Agent 循环就能在没有网络、没有 API key 的情况下被断言。

import type { ChatOptions, ChatResult, Message } from '@/core/types.ts';

export interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
}

export interface LLMClientConfig {
  /** API key，只从环境变量读，禁止写死 */
  apiKey: string;
  /** 例如 https://api.deepseek.com */
  baseUrl: string;
  model: string;
}
```

**删除 `LLMClientFactory`** —— 01-llm 里它从未被使用过，是纯文档型导出。
**删除所有与 `chatStream` / `StreamEvent` 有关的注释与签名。**

- [ ] **Step 3: 改 `src/core/session.ts`**

整个文件替换为：

```ts
// 会话状态：按顺序累积对话消息。
//
// 只负责「记住说过什么」，不碰网络、不负责打印、也不落盘。
//
// 相对 01-llm 的版本，这里**删掉了三样**（见 spec D6）：
//   - `onChange` 变更广播：它的唯一用途是落盘，而本项目不做持久化
//   - `clear()`：唯一调用方是 `/clear` 命令，CLI 已砍
//   - `set model` / 构造时的 history 参数：没有 `/model` 命令，也没有恢复会话的入口
//
// 于是它退回成一个**无副作用的纯类** —— 这正是它最好测试的形态。

import type { Message } from '@/core/types.ts';

export class Session {
  /**
   * 本会话使用的模型。
   *
   * 它是**会话的属性**而不是 client 的身份：client 保持无状态，
   * 每次请求把它作为 per-call 参数带下去（见 core/agent.ts）。
   */
  readonly model: string;

  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[];

  constructor(model: string) {
    // 刻意不用 `constructor(readonly model: string)` 这种参数属性写法：
    // 本项目靠 Node 的原生类型擦除直接跑 .ts，而擦除模式（strip-only）
    // 不支持 TS 独有的参数属性语法，会在运行时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    // 注意 tsc --noEmit 不会拦下它 —— 类型检查能过、运行才炸，所以只能靠这条注释守着。
    this.model = model;
    this.messages = [];
  }

  /**
   * 追加一条**用户或系统**消息。
   *
   * 参数只接受这两个角色是刻意的：assistant 消息可能带 `tool_calls`、
   * tool 消息必须带 `tool_call_id`，都不是 `(role, content)` 这种扁平签名
   * 写得出来的。收窄之后，「assistant 消息丢掉 tool_calls」这类 bug
   * **无法通过类型检查** —— 要写 assistant 只能走 appendMessage。
   */
  append(role: 'system' | 'user', content: string): void {
    this.messages.push({ role, content });
  }

  /** 追加一条任意形状的消息（含 assistant{tool_calls} 与 tool） */
  appendMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * 批量追加。**只在整轮成功后调用一次**（见 core/agent.ts 的 runSessionTurn）——
   * 中途失败时一条都不该落进上下文，否则历史里会出现伪造的回答。
   */
  appendAll(messages: Message[]): void {
    for (const message of messages) this.messages.push(message);
  }

  /**
   * 组装出「这一次要发给 API 的完整消息数组」。
   *
   * 返回 `[system, ...历史消息]`：system 提示永远排在最前。
   * 因为它是每次请求都要重新带上、且位置固定的稳定前缀，
   * 它不属于对话历史，所以不存在 `messages` 里，而是每次现加。
   *
   * @param systemPrompt 系统提示；传空串则不插入 system 消息
   */
  toMessages(systemPrompt: string): Message[] {
    const messages: Message[] = [];
    if (systemPrompt !== '') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    // 用 concat 生成新数组返回，保证「返回的不是内部那个数组」，
    // 免得调用方 push/splice 改到会话状态。
    //
    // 注意它**不保证元素隔离** —— concat 与 slice 一样只复制外层数组。
    // 这是刻意的：这个方法每轮请求都跑，结果直送 JSON.stringify，
    // 全链路上没有任何改动方，深拷贝只会为每轮多分配 N 个小对象。
    // 与 history() 的处置不同是**刻意分开**的，不是漏改 ——
    // 那边对外承诺「外部改不动内部状态」，且在冷路径上。
    return messages.concat(this.messages);
  }

  /**
   * 返回消息列表的**副本**，外部改不动内部状态。
   *
   * 必须是**深**拷贝：`tool_calls` 是数组、数组里还有 `function` 对象，
   * 只做 `{...m}` 的话，调用方一句
   * `h[0].tool_calls[0].function.name = 'x'` 就穿透改了会话状态。
   * （01-llm 的源码注释已经预言了这一刻：「将来若给 Message 加了嵌套字段，
   * 这一行必须同步升级」。）
   */
  history(): Message[] {
    return this.messages.map(cloneMessage);
  }
}

/**
 * 复制一条消息，含嵌套的 `tool_calls`。
 *
 * 单独抽出来而不是内联在 history() 里，是让「Message 有嵌套字段」这件事
 * 在类型层面看得见：将来再加嵌套字段，改这一处。
 */
function cloneMessage(message: Message): Message {
  if (message.role === 'assistant') {
    const copy: Message = { role: 'assistant', content: message.content };
    if (message.tool_calls) {
      copy.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: call.type,
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    }
    return copy;
  }
  return { ...message };
}
```

- [ ] **Step 4: 修 `test/session.test.ts`**

复制过来的文件有 12 个用例。**逐条删除下列 8 条**（它们测的都是本次删掉的能力）：

```
构造时带上当前模型，可读可改
clear 清空消息并返回条数，不影响当前模型
三个变更点各广播一次，载荷就是日志里那一行
只读操作一次都不广播
构造时铺入的 history 不广播（打开一次会话，日志不该变长）
构造时复制 history 数组，外部 push 碰不到会话内部
【已知边界】构造时传入的 history，其**元素对象是共享的**（只做了浅拷贝）
onChange 抛错时，内存状态**已经**更新了（先改内存、再广播）
```

**保留并可能需要微调**这 4 条：`append 按序保存消息`、`toMessages 把 system 放在最前`、
`history 返回副本，改它不影响会话内部`、`history 的元素也是新的，改元素碰不到会话内部`。
它们现在的写法是 `new Session('m')` —— 构造函数签名没变（仍是一个 model 参数），所以应当直接通过。

然后追加这几条：

```ts
test('append 只接受 user 与 system，assistant 必须走 appendMessage', () => {
  // 这条不是运行时断言，而是**类型检查**的守卫：
  // 下一行若写成 session.append('assistant', 'x')，tsc 会报错。
  // 用注释钉住它，是为了让删掉 @ts-expect-error 的人先看见这条用例。
  const session = new Session('m');
  // @ts-expect-error append 的 role 已收窄，不接受 assistant
  session.append('assistant', '你好');
});

test('appendMessage 记录 tool 角色与 tool_call_id', () => {
  const session = new Session('m');
  session.appendMessage({ role: 'tool', content: '25°C, Sunny', tool_call_id: 'c1' });

  assert.deepStrictEqual(session.history(), [
    { role: 'tool', content: '25°C, Sunny', tool_call_id: 'c1' },
  ]);
});

test('appendAll 按顺序追加多条', () => {
  const session = new Session('m');
  session.appendAll([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } },
    ] },
    { role: 'tool', content: '"晴"', tool_call_id: 'c1' },
    { role: 'assistant', content: '晴天。' },
  ]);

  assert.strictEqual(session.history().length, 3);
});

test('改 history() 返回值里的 tool_calls 不影响会话状态', () => {
  const session = new Session('m');
  session.appendMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
  });

  const snapshot = session.history();
  const first = snapshot[0]!;
  if (first.role === 'assistant' && first.tool_calls) {
    // 深拷贝若退化成 {...m}，这一行会穿透改到会话内部
    first.tool_calls[0]!.function.name = 'tampered';
  }

  const again = session.history()[0]!;
  assert.strictEqual(again.role, 'assistant');
  assert.strictEqual(
    again.role === 'assistant' ? again.tool_calls![0]!.function.name : null,
    'weather',
  );
});

test('model 是构造时定的、只读', () => {
  const session = new Session('deepseek-v4-pro');
  assert.strictEqual(session.model, 'deepseek-v4-pro');
  // 只读是类型层面的：下一行若去掉注释，tsc 会报 Cannot assign to 'model'
  // session.model = 'other';
});
```

- [ ] **Step 5: 跑 session 测试**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/session.test.ts`
Expected: 全绿（9 条）

**注意**：此时 `test/deepseek.test.ts` 仍然红 —— 它要等 Task 3。**不要**在这一步动它。

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/core/types.ts demos/02-agent/apps/server/src/core/session.ts \
        demos/02-agent/apps/server/src/llm/client.ts demos/02-agent/apps/server/test/session.test.ts
git commit -m "feat(server): Message 改为可辨识联合，Session 退回纯类，LLMClient 收窄成单方法"
```

---

### Task 3: LLM 层——去流式、发 tools、解析 tool_calls

只动 `llm/deepseek.ts` 与它的测试。

**Files:**
- Modify: `demos/02-agent/apps/server/src/llm/deepseek.ts`
- Test: `demos/02-agent/apps/server/test/deepseek.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ToolCall` / `Tool` / `ChatOptions.tools` / `ChatResult`
- Produces: 一个只实现 `chat()`、会按线上包装层发送 `tools`、并正确解析 `tool_calls` 的客户端

- [ ] **Step 1: 重写 `src/llm/deepseek.ts`**

整个文件替换为：

```ts
// DeepSeek 的具体实现：把「消息数组」变成一次 HTTP 请求。
//
// 属于 llm 层（最底层），只依赖 core 的类型。
// 这一层**不打印任何东西**——打印不属于它，它保持安静才能在测试里被反复调用。
//
// 相对 01-llm 的版本，这里**删掉了全部流式代码**（chatStream / 空闲超时 /
// SSE 解析，见 spec D5）：本次不做流式，而下个里程碑做「流式 + 工具」时，
// 分片 tool_calls 的拼接本来就要另写一套，留着只是重写前的负担。

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
        // 与「连不上上游」（见 http/errors.ts）
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

- [ ] **Step 2: 瘦身 `test/deepseek.test.ts`**

先跑一遍看现状：

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: 失败 —— 一半是因为 `createDeepSeekClient` 现在只接受一个参数（旧测试传了 `idleTimeoutMs`），
一半是因为 `chatStream` 不再存在。

**删除所有 `chatStream` 相关的用例**（15 条，用 `grep -n "chatStream\|空闲超时\|SSE\|delta\|DONE" test/deepseek.test.ts` 找齐）。
它们测的能力本次整体砍掉了，留着只能是死代码。

**删除 `mockFetch` 的流式分支与 `ReadableStream` 相关的辅助函数**（若它们只被上面的用例用到）。

**改这一条**：`content 缺失时返回空串不崩溃` → 语义变了，改名并改断言：

```ts
test('content 缺失或为 null 时返回 null，而不是空串', async () => {
  globalThis.fetch = mockFetch(200, { choices: [{ message: {}, finish_reason: 'stop' }] });
  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(result.content, null, '兜底成空串会让「说了空话」与「没说话」无法区分');
});
```

**保留不动**这 7 条：`请求体包含 model 和 messages`、`成功时返回 content，抑制 reasoning_content`、
`非 2xx 抛出错误`、`fetch 抛错时向上冒泡，不被吞掉`、`错误体不是 JSON 时回落为原始文本`、
`options.model 覆盖构造时的默认模型`、`不传 options.model 时回落构造时的默认模型`。

- [ ] **Step 3: 追加新用例**

在 `test/deepseek.test.ts` 末尾追加：

```ts
test('带 tools 时请求体按线上的包装层级发送（type/function 两层）', async () => {
  let body: Record<string, unknown> = {};
  globalThis.fetch = mockFetch(
    200,
    { choices: [{ message: { content: '好' }, finish_reason: 'stop' }] },
    (init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    },
  );

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

  // 少包一层上游会 400 说 tools 结构不对，而报错不会提到「少包了一层」
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
  globalThis.fetch = mockFetch(
    200,
    { choices: [{ message: { content: '好' }, finish_reason: 'stop' }] },
    (init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    },
  );

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], { tools: [] });

  assert.ok(!('tools' in body), '空数组在部分 OpenAI 兼容实现上会 400，必须不发');
});

test('解析 tool_calls 与 finish_reason', async () => {
  globalThis.fetch = mockFetch(200, {
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
  });

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: '北京天气' }]);

  assert.strictEqual(result.content, null);
  assert.strictEqual(result.finish_reason, 'tool_calls');
  assert.deepStrictEqual(result.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
  ]);
});

test('finish_reason 缺失时回落 stop', async () => {
  globalThis.fetch = mockFetch(200, { choices: [{ message: { content: '好' } }] });

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.finish_reason, 'stop');
});

test('tool_calls 里混入一条坏的：丢掉坏的、保留好的', async () => {
  globalThis.fetch = mockFetch(200, {
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
  });

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.tool_calls?.length, 1);
  assert.strictEqual(result.tool_calls?.[0]?.id, 'c1');
});

test('tool_calls 全是坏的：当作没有 tool_calls', async () => {
  globalThis.fetch = mockFetch(200, {
    choices: [{ message: { content: '好', tool_calls: [{ id: 1 }] }, finish_reason: 'stop' }],
  });

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.tool_calls, undefined);
});

test('没有 tool_calls 时不带该字段', async () => {
  globalThis.fetch = mockFetch(200, {
    choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
  });

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.ok(!('tool_calls' in result));
});
```

**`mockFetch` 的签名**：本仓库已有的是 `(status, body)`。上面用到了第三个参数
`onRequest(init)`，所以先把它扩成 `(status, body, onRequest?)` —— 在构造 `Response` **之前**
调用 `onRequest(init)`。改完确认原有 7 条用例仍然通过。

- [ ] **Step 4: 跑单文件测试**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: 全绿（7 保留 + 1 改名 + 7 新增 = 15 条）

- [ ] **Step 5: 类型检查**

Run: `cd demos/02-agent/apps/server && pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/llm/deepseek.ts demos/02-agent/apps/server/test/deepseek.test.ts
git commit -m "feat(server): llm 层去流式、按线上层级发送 tools、解析并校验 tool_calls"
```

---

### Task 4: ToolRegistry 与三个工具

**Files:**
- Create: `demos/02-agent/apps/server/src/core/tool-registry.ts`
- Create: `demos/02-agent/apps/server/src/tools/{weather,time,calculator,registry}.ts`
- Test: `demos/02-agent/apps/server/test/tools-{weather,time,calculator,registry}.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Tool` / `ToolResult`
- Produces: `ToolDefinition`；`ToolRegistry`（`list()` / `execute(name, args)`）；
  `createToolRegistry()`；`weatherTool` / `timeTool` / `calculatorTool`

- [ ] **Step 1: 写 `src/core/tool-registry.ts`**

```ts
// 工具注册表的**接口**。与 LLMClient 是同一个套路：
// 接口在 core、实现在 tools、调用方只认接口。
//
// 这样 core 层不需要 import 任何具体工具，测试也能塞一个假注册表进来。
// 将来接入 MCP 时，只给 tools/registry.ts 的实现加一个 mount()，
// 这个接口不用动，core 与 llm 更不用动。

import type { Tool, ToolResult } from '@/core/types.ts';

/**
 * 一个工具：**声明**（发给模型看）+ **实现**（真要执行时跑的代码）。
 *
 * 两者放一起是刻意的：声明说错一个参数名，模型就会传错参数，
 * 而这两半分隔两地时最容易写歪的就是它们的一致性。
 */
export interface ToolDefinition {
  declaration: Tool;
  /**
   * 执行工具。`args` 是**模型给的、解析过的**参数，形状不可信 ——
   * 参数校验是每个工具自己的责任（校验不过返回 `{ok:false}`，不要抛）。
   *
   * 真抛了也不致命：调用方（core/agent.ts）会兜底成 `{ok:false}` 回喂模型。
   */
  run(args: unknown): ToolResult | Promise<ToolResult>;
}

/** 工具注册表：core 只认这个接口 */
export interface ToolRegistry {
  /** 序列化成请求体里的 `tools` 字段 */
  list(): Tool[];
  /** 按名派发。名字不存在时返回 `{ok:false}`，不抛错 */
  execute(name: string, args: unknown): Promise<ToolResult>;
}
```

- [ ] **Step 2: 写失败测试（weather）**

`test/tools-weather.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { weatherTool } from '@/tools/weather.ts';

test('Beijing 命中内置表', async () => {
  const result = await weatherTool.run({ city: 'Beijing' });
  assert.deepStrictEqual(result, {
    ok: true,
    value: { city: 'Beijing', temperature: '25°C', condition: 'Sunny' },
  });
});

test('城市名大小写与首尾空白不影响命中', async () => {
  const result = await weatherTool.run({ city: '  beijing  ' });
  assert.strictEqual(result.ok, true);
});

test('未收录的城市返回兜底值并注明是模拟数据', async () => {
  const result = await weatherTool.run({ city: 'Mars' });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { note?: string };
  assert.ok(typeof value.note === 'string' && value.note.includes('模拟数据'));
});

test('缺 city 参数返回 {ok:false} 而不是抛错', async () => {
  assert.strictEqual((await weatherTool.run({})).ok, false);
});

test('city 不是字符串返回 {ok:false}', async () => {
  assert.strictEqual((await weatherTool.run({ city: 42 })).ok, false);
});

test('args 不是对象也不抛错', async () => {
  assert.strictEqual((await weatherTool.run(null)).ok, false);
  assert.strictEqual((await weatherTool.run('Beijing')).ok, false);
});

test('声明里的 name 与 registry 注册名一致，required 标了 city', () => {
  assert.strictEqual(weatherTool.declaration.name, 'weather');
  assert.deepStrictEqual(weatherTool.declaration.parameters.required, ['city']);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/tools-weather.test.ts`
Expected: FAIL —— `Cannot find module '@/tools/weather.ts'`

- [ ] **Step 4: 写 `src/tools/weather.ts`**

```ts
// 查天气 —— **确定性 mock**，不联网、不需要 key。
//
// 本阶段的学习目标是 tool calling 这条链路本身（模型怎么开调用单、
// 程序怎么执行、结果怎么回喂），不是「怎么调第三方天气 API」。
// 用一个内置小表把网络这个变量消掉，失败原因才能收敛到链路自己身上。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

/** 内置的「天气数据库」。键是小写城市名 */
const WEATHER_TABLE: Record<string, { temperature: string; condition: string }> = {
  beijing: { temperature: '25°C', condition: 'Sunny' },
  shanghai: { temperature: '28°C', condition: 'Cloudy' },
  shenzhen: { temperature: '31°C', condition: 'Thunderstorm' },
  hangzhou: { temperature: '27°C', condition: 'Light Rain' },
  chengdu: { temperature: '23°C', condition: 'Overcast' },
};

/** 未收录城市的兜底值 */
const FALLBACK = { temperature: '22°C', condition: 'Partly Cloudy' };

const declaration: Tool = {
  name: 'weather',
  description: '查询某个城市今天的天气。需要知道某地天气时使用。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名，例如 Beijing、Shanghai' },
    },
    required: ['city'],
  },
};

export const weatherTool: ToolDefinition = {
  declaration,

  run(args: unknown): ToolResult {
    // 参数形状不可信 —— 模型可能传字符串、传 null、干脆不传。
    // 校验不过就返回错误文本，它会作为 tool 消息回喂给模型，让它自己改。
    if (typeof args !== 'object' || args === null) {
      return { ok: false, error: '参数必须是对象，且包含 city 字段' };
    }
    const city = (args as { city?: unknown }).city;
    if (typeof city !== 'string' || city.trim() === '') {
      return { ok: false, error: '缺少 city 参数，或 city 不是非空字符串' };
    }

    const trimmed = city.trim();
    const hit = WEATHER_TABLE[trimmed.toLowerCase()];

    if (!hit) {
      // 兜底也要**明说是模拟数据** —— 否则模型会把编出来的天气当事实转述给用户
      return {
        ok: true,
        value: { city: trimmed, ...FALLBACK, note: '模拟数据：该城市不在内置表中' },
      };
    }

    return { ok: true, value: { city: trimmed, ...hit } };
  },
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/tools-weather.test.ts`
Expected: 全绿

- [ ] **Step 6: 写 `src/tools/time.ts` 与它的测试**

`test/tools-time.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { timeTool } from '@/tools/time.ts';

test('返回可解析的 ISO 时间字符串', async () => {
  const result = await timeTool.run({});
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { now?: unknown };
  assert.strictEqual(typeof value.now, 'string');
  assert.ok(!Number.isNaN(Date.parse(value.now as string)));
});

test('忽略任何多余参数', async () => {
  assert.strictEqual((await timeTool.run({ unexpected: 'ignored' })).ok, true);
});

test('声明没有 required 参数', () => {
  assert.strictEqual(timeTool.declaration.name, 'get_time');
  assert.strictEqual(timeTool.declaration.parameters.required, undefined);
});
```

`src/tools/time.ts`：

```ts
// 取当前时间。无参数，因此没有参数校验可做 ——
// 它存在的意义是演示「零参数工具」在 schema 里长什么样。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

const declaration: Tool = {
  name: 'get_time',
  description: '获取当前的日期与时间。需要知道「现在」时使用。',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const timeTool: ToolDefinition = {
  declaration,

  run(): ToolResult {
    // 这个工具**不纯**（每次调用结果都不同），测试只能断言格式，不能断言具体值
    return { ok: true, value: { now: new Date().toISOString() } };
  },
};
```

- [ ] **Step 7: 写失败测试（calculator）**

`test/tools-calculator.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculatorTool } from '@/tools/calculator.ts';

async function calculate(expression: string) {
  return calculatorTool.run({ expression });
}

function valueOf(result: Awaited<ReturnType<typeof calculate>>): number {
  assert.strictEqual(result.ok, true);
  return result.ok ? (result.value as { result: number }).result : NaN;
}

test('四则运算与优先级', async () => {
  assert.deepStrictEqual(await calculate('1 + 2 * 3'), {
    ok: true,
    value: { expression: '1 + 2 * 3', result: 7 },
  });
});

test('括号改变优先级', async () => {
  assert.strictEqual(valueOf(await calculate('(1 + 2) * 3')), 9);
});

test('小数与一元负号', async () => {
  assert.strictEqual(valueOf(await calculate('1.5 * 2')), 3);
  assert.strictEqual(valueOf(await calculate('-4 + 1')), -3);
});

test('除零返回 {ok:false}，且错误文本包含表达式原文', async () => {
  const result = await calculate('1 / 0');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 / 0'));
});

test('字母被白名单拦下', async () => {
  assert.strictEqual((await calculate('alert(1)')).ok, false);
});

test('分号、反引号与属性访问被白名单拦下', async () => {
  for (const expression of ['1; process.exit(1)', '`1`', '1 .toString()']) {
    assert.strictEqual((await calculate(expression)).ok, false, `应被拒绝：${expression}`);
  }
});

test('括号不配对返回 {ok:false}', async () => {
  assert.strictEqual((await calculate('(1 + 2')).ok, false);
});

test('尾部有多余内容返回 {ok:false}', async () => {
  assert.strictEqual((await calculate('1 2')).ok, false);
});

test('缺 expression 参数返回 {ok:false}', async () => {
  assert.strictEqual((await calculatorTool.run({})).ok, false);
});

test('错误文本里带着表达式原文（模型据此才能改）', async () => {
  const result = await calculate('1 + ');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 + '));
});
```

- [ ] **Step 8: 写 `src/tools/calculator.ts`**

```ts
// 四则运算计算器。
//
// **不用 eval / new Function。** 模型给的表达式是外部输入，
// 直接喂给 eval 等于把一个任意代码执行的口子开在最不该开的地方。
// 这里改成：白名单正则拦一道 → 手写词法 → 递归下降求值。
//
// 这道防线本身也是教学内容：工具的参数是「不可信输入」，
// 哪怕它看起来只是一个算式。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

/**
 * 白名单：只允许数字、四个运算符、括号、小数点与空白。
 *
 * 它是**第一道**防线，作用是快速拒绝明显危险的东西（字母、分号、反引号）。
 * 它不是唯一防线 —— 真正保证求值安全的是下面的递归下降求值器：
 * 它只会做加减乘除，即使白名单被绕过也执行不了别的东西。
 */
const ALLOWED = /^[0-9+\-*/(). \t]+$/;

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' };

/** 词法分析。遇到白名单内的意外字符返回 null */
function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index]!;

    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '(' || char === ')') {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }

    // 数字：连续取 [0-9.]，交给 Number() 判断是否合法
    // （`1.2.3` 这种会被 Number 拒掉，所以这里不用自己写校验）
    if ((char >= '0' && char <= '9') || char === '.') {
      let literal = '';
      while (index < expression.length && /[0-9.]/.test(expression[index]!)) {
        literal += expression[index];
        index += 1;
      }
      const value = Number(literal);
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: 'num', value });
      continue;
    }

    return null;
  }

  return tokens;
}

/** 求值结果：成功给数值，失败给原因 */
type EvalResult = { ok: true; value: number } | { ok: false; reason: string };

/**
 * 递归下降求值。文法：
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := number | '(' expr ')' | '-' factor
 */
function evaluate(expression: string): EvalResult {
  if (!ALLOWED.test(expression)) {
    return { ok: false, reason: '表达式含不支持的字符（只允许数字、+ - * / ( ) 和空格）' };
  }

  const tokens = tokenize(expression);
  if (tokens === null || tokens.length === 0) {
    return { ok: false, reason: '表达式无法解析' };
  }

  let pos = 0;
  // 失败原因单独存：递归的每个分支都返回 number | null，
  // 用一个外部变量记住「具体为什么失败」，比到处传错误对象干净
  let reason = '表达式语法错误';

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;

    while (true) {
      const token = tokens[pos];
      if (token?.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      pos += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = token.value === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;

    while (true) {
      const token = tokens[pos];
      if (token?.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break;
      pos += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (token.value === '/') {
        if (right === 0) {
          reason = '除数不能为 0';
          return null;
        }
        left /= right;
      } else {
        left *= right;
      }
    }
    return left;
  }

  function parseFactor(): number | null {
    const token = tokens[pos];

    if (token === undefined) {
      reason = '表达式意外结束';
      return null;
    }

    if (token.kind === 'num') {
      pos += 1;
      return token.value;
    }

    if (token.value === '-') {
      pos += 1;
      const inner = parseFactor();
      return inner === null ? null : -inner;
    }

    if (token.value === '(') {
      pos += 1;
      const inner = parseExpr();
      if (inner === null) return null;
      const close = tokens[pos];
      if (close?.kind !== 'op' || close.value !== ')') {
        reason = '括号不配对';
        return null;
      }
      pos += 1;
      return inner;
    }

    reason = `意外的符号：${token.value}`;
    return null;
  }

  const value = parseExpr();

  if (value === null) return { ok: false, reason };
  // 多余的 token 说明整串没被消费完，例如 `1 2`
  if (pos !== tokens.length) return { ok: false, reason: '表达式尾部有多余内容' };
  if (!Number.isFinite(value)) return { ok: false, reason: '计算结果不是有限数' };

  return { ok: true, value };
}

const declaration: Tool = {
  name: 'calculator',
  description: '计算一个四则运算表达式。只支持 + - * / 与括号，例如 (1 + 2) * 3。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '要计算的表达式，例如 1 + 2 * 3' },
    },
    required: ['expression'],
  },
};

export const calculatorTool: ToolDefinition = {
  declaration,

  run(args: unknown): ToolResult {
    if (typeof args !== 'object' || args === null) {
      return { ok: false, error: '参数必须是对象，且包含 expression 字段' };
    }
    const expression = (args as { expression?: unknown }).expression;
    if (typeof expression !== 'string' || expression.trim() === '') {
      return { ok: false, error: '缺少 expression 参数，或它不是非空字符串' };
    }

    const original = expression.trim();
    const result = evaluate(original);

    if (!result.ok) {
      // **错误文本必须带上表达式原文** —— 它是模型唯一的纠错线索。
      // 只说「表达式非法」的话，模型不知道该改哪里，只能反复重试同一个式子。
      return { ok: false, error: `无法计算「${original}」：${result.reason}` };
    }

    return { ok: true, value: { expression: original, result: result.value } };
  },
};
```

- [ ] **Step 9: 跑测试**

Run:
```bash
cd demos/02-agent/apps/server
node --import ./loader.mjs --test test/tools-time.test.ts
node --import ./loader.mjs --test test/tools-calculator.test.ts
```
Expected: 两个文件全绿

- [ ] **Step 10: 写失败测试（registry）**

`test/tools-registry.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '@/tools/registry.ts';

test('list() 返回三份工具声明', () => {
  const names = createToolRegistry()
    .list()
    .map((tool) => tool.name)
    .sort();
  assert.deepStrictEqual(names, ['calculator', 'get_time', 'weather']);
});

test('每份声明都有非空 description 与 object 类型的 parameters', () => {
  for (const tool of createToolRegistry().list()) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺 description`);
    assert.strictEqual(tool.parameters.type, 'object');
  }
});

test('按名派发到对应工具', async () => {
  const result = await createToolRegistry().execute('weather', { city: 'Beijing' });
  assert.strictEqual(result.ok, true);
});

test('未知名返回 {ok:false} 而不是抛错', async () => {
  const result = await createToolRegistry().execute('no_such_tool', {});
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('no_such_tool'));
});

test('list() 每次返回新数组，外部改不动注册表', () => {
  const registry = createToolRegistry();
  registry.list().push({
    name: 'injected',
    description: 'x',
    parameters: { type: 'object', properties: {} },
  });
  assert.strictEqual(registry.list().length, 3);
});
```

- [ ] **Step 11: 写 `src/tools/registry.ts`**

```ts
// 工具注册表的实现。接口声明在 core/tool-registry.ts。
//
// 将来接入 MCP 时，在这个文件里加一个 mount()，把远端工具也塞进同一个 Map ——
// 接口不变、core 与 llm 不动。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition, ToolRegistry } from '@/core/tool-registry.ts';
import { weatherTool } from '@/tools/weather.ts';
import { timeTool } from '@/tools/time.ts';
import { calculatorTool } from '@/tools/calculator.ts';

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  for (const definition of [weatherTool, timeTool, calculatorTool]) {
    tools.set(definition.declaration.name, definition);
  }

  return {
    list(): Tool[] {
      // 返回新数组：调用方 push 一下就能改到注册表，那不是我们希望的可变面
      return [...tools.values()].map((definition) => definition.declaration);
    },

    async execute(name: string, args: unknown): Promise<ToolResult> {
      const definition = tools.get(name);
      if (!definition) {
        // 名字不存在是**正常结果**而不是异常：模型可能编出一个不存在的工具名，
        // 错误文本回喂给它，它下一轮就会改用正确的名字
        return { ok: false, error: `未知工具：${name}` };
      }

      // 这里**不** try/catch —— 工具自己抛出的异常由 core/agent.ts 统一兜底，
      // 「兜底」只在一处发生，行为才不会随调用方而变
      return await definition.run(args);
    },
  };
}
```

- [ ] **Step 12: 跑全部工具测试并类型检查**

Run:
```bash
cd demos/02-agent/apps/server
node --import ./loader.mjs --test test/tools-registry.test.ts
pnpm run typecheck
```
Expected: 全绿；typecheck 退出码 0

- [ ] **Step 13: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/core/tool-registry.ts demos/02-agent/apps/server/src/tools \
        demos/02-agent/apps/server/test/tools-*.test.ts
git commit -m "feat(server): 新增 ToolRegistry 接口与 weather / get_time / calculator 三个工具"
```

---

### Task 5: Agent 循环

本次的技术核心。注意 `AgentTurn` **没有 `steps`** —— 本轮调了哪些工具属于「怎么给人看」，
由 Task 6 的投影层从 `added` 推导（见 spec D4）。

**Files:**
- Create: `demos/02-agent/apps/server/src/core/prompt.ts`
- Create: `demos/02-agent/apps/server/src/core/agent.ts`
- Test: `demos/02-agent/apps/server/test/agent.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ChatResult` / `Message` / `ToolResult`；Task 4 的 `ToolRegistry`
- Produces: `SYSTEM_PROMPT`；`AgentTurn`（`final` / `added` / `stopReason`）；
  `runAgentTurn(client, registry, messages, options?)`；`runSessionTurn(session, client, registry, question, options)`

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

/** 默认的最大步数。对应 guides「Agent 为什么会无限循环」—— 循环必须有界 */
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

    // 判据是 **tool_calls 是否非空**，不是 finish_reason。
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
          // 工具抛异常也**不崩**：兜底成错误文本。这是「兜底」发生的唯一一处。
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
  // 不能留一条只有 tool_calls 的消息在末尾，那样的历史对 API 是非法的。
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
 * **这三行的顺序是语义，不是风格：**
 *
 * 1. `append('user', …)` 必须在 `toMessages()` **之前** —— 反过来的话，
 *    用户这句话根本没被发出去，而循环照样跑、照样有回答，只是答的是上一轮的问题。
 * 2. `appendAll(added)` 必须在**成功之后** —— 否则失败轮次会留下一条
 *    **伪造的 assistant 回答**（对齐 01-llm 的 D7）。
 *
 * 为什么单独一层而不是让 HTTP 路由写这三行：路由的职责是状态码与 JSON 形状，
 * 不是对话时序。把顺序敏感的语句内联进 async handler，是把 agent 语义
 * 与 HTTP 语义搅在一起 —— 而「别让展示层与 agent 层交汇太多」正是本次的改造目标之一。
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
Expected: 全绿

- [ ] **Step 6: 类型检查与全量测试**

Run: `cd demos/02-agent/apps/server && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/core/prompt.ts demos/02-agent/apps/server/src/core/agent.ts \
        demos/02-agent/apps/server/test/agent.test.ts
git commit -m "feat(server): 新增 Agent 循环，只产出事实（final/added/stopReason）"
```

---

### Task 6: 展示投影（`presentation/transcript.ts`）

**这一层是本次改造的边界所在**：它把 `Message[]` 变成给界面看的东西，
而 `core/` 完全不知道它的存在。

**Files:**
- Create: `demos/02-agent/apps/server/src/presentation/transcript.ts`
- Test: `demos/02-agent/apps/server/test/transcript.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Message`
- Produces: `TranscriptItem`；`foldTranscript(messages: Message[]): TranscriptItem[]`

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
  // 否则对话框里会多出一个空气泡
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

test('配不上对的 tool_calls 产出 ok: null（半截日志）', () => {
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
// 把投影放在 core 之外，agent 层就不必为了界面多返回任何字段（见 spec D4）。
//
// 实时路径（本轮新增）与历史路径（读回整段会话）共用这一个函数 ——
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
```
Expected: 三条都输出「干净」

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/presentation demos/02-agent/apps/server/test/transcript.test.ts
git commit -m "feat(server): 新增展示投影层，实时与历史路径共用 foldTranscript"
```

---

### Task 7: 会话注册表与 id

**Files:**
- Create: `demos/02-agent/apps/server/src/http/ids.ts`
- Create: `demos/02-agent/apps/server/src/http/session-registry.ts`
- Test: `demos/02-agent/apps/server/test/http-session-registry.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Session`
- Produces: `newSessionId()`；`SessionNotFoundError`；
  `SessionRegistry`（`create()` / `get(id)` / `run(id, fn)` / `size()`）；`createSessionRegistry(options)`

- [ ] **Step 1: 写 `src/http/ids.ts`**

```ts
// 会话 id：`YYYYMMDD-HHMMSS-xxxx`。
//
// 形状是**本地时间 + 4 位随机十六进制**：可读、按字典序排就是时间序，
// 随机后缀避免同一秒内建两个会话撞名。
//
// 因为本项目没有文件系统，**不需要路径穿越校验** —— id 只用来查 Map，
// 查不到就是 404。（01-llm 的那套白名单校验是给文件名用的，这里用不上。）

import { randomBytes } from 'node:crypto';

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function newSessionId(now: Date = new Date()): string {
  // 逐段取**本地时间**分量，不要用 toISOString() —— 后者是 UTC，
  // 东八区会得到早 8 小时的时间。那是个安静的错误：`ls` 出来看着也像那么回事。
  //
  // 注意 getMonth() 是 0 基的，所以要 +1。
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  return `${date}-${time}-${randomBytes(2).toString('hex')}`;
}
```

`now` 做成参数是为了让测试能喂固定值。

- [ ] **Step 2: 写失败测试**

`test/http-session-registry.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionNotFoundError, createSessionRegistry } from '@/http/session-registry.ts';

/** 递增的假 id 生成器，让每个会话都有稳定的名字 */
function counterIds(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `20260101-00000${index}-aaaa`;
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('create 返回会话与 id，get 能取回', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { session, id } = registry.create();

  assert.strictEqual(session.model, 'm');
  assert.strictEqual(registry.get(id), session);
});

test('get 未知 id 返回 null', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  assert.strictEqual(registry.get('nope'), null);
});

test('run 在未知 id 上抛 SessionNotFoundError', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  await assert.rejects(() => registry.run('nope', async () => 'x'), SessionNotFoundError);
});

test('同一 id 上的两个 run 串行执行，不交错', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { id } = registry.create();
  const events: string[] = [];

  const first = registry.run(id, async () => {
    events.push('A:start');
    await delay(30);
    events.push('A:end');
  });
  const second = registry.run(id, async () => {
    events.push('B:start');
    await delay(1);
    events.push('B:end');
  });

  await Promise.all([first, second]);

  assert.deepStrictEqual(events, ['A:start', 'A:end', 'B:start', 'B:end']);
});

test('不同 id 的 run 互不阻塞', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const a = registry.create();
  const b = registry.create();
  const events: string[] = [];

  const first = registry.run(a.id, async () => {
    events.push('A:start');
    await delay(30);
    events.push('A:end');
  });
  const second = registry.run(b.id, async () => {
    events.push('B:start');
    await delay(1);
    events.push('B:end');
  });

  await Promise.all([first, second]);

  assert.deepStrictEqual(events, ['A:start', 'B:start', 'B:end', 'A:end']);
});

test('前一个 run 失败不毒化这条链', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { id } = registry.create();

  const first = registry.run(id, async () => {
    throw new Error('第一段失败');
  });
  const second = registry.run(id, async () => '第二段成功');

  await assert.rejects(() => first, /第一段失败/);
  assert.strictEqual(await second, '第二段成功');
});

test('run 把会话传给回调', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { session, id } = registry.create();

  assert.strictEqual(await registry.run(id, async (passed) => passed), session);
});

test('超过 maxSessions 时淘汰最早创建的（FIFO）', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm', maxSessions: 2 });
  const first = registry.create();
  const second = registry.create();
  assert.strictEqual(registry.size(), 2);

  const third = registry.create();

  assert.strictEqual(registry.size(), 2);
  assert.strictEqual(registry.get(first.id), null, '最早的那个应被淘汰');
  assert.ok(registry.get(second.id));
  assert.ok(registry.get(third.id));
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/http-session-registry.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 写 `src/http/session-registry.ts`**

```ts
// 服务端的会话表：一个会话 id 对应一个 Session 实例。
//
// 两件事必须放在一起做，所以它们在同一个文件里：
//
//   1. 持有会话（Map + FIFO 上限）
//   2. **串行化同一会话上的请求**
//
// 第 2 条不是优化，是正确性：Session.append 是同步无锁的，而 runSessionTurn
// 中间有 await。两个请求同时在途时，两条 user 消息会都先落地，
// 第二条的 toMessages() 里就出现「assistant{tool_calls} 没有对应的 tool 回应」，
// 上游直接 400 —— 而那个报错完全不指向并发。

import { Session } from '@/core/session.ts';

/** 会话不存在。HTTP 层据此返回 404，与「服务端出错」区分开 */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`会话不存在：${id}`);
    this.name = 'SessionNotFoundError';
  }
}

export interface SessionRegistry {
  create(): { session: Session; id: string };
  /** 取会话；不存在返回 null */
  get(id: string): Session | null;
  /**
   * 在指定会话上串行执行 `fn`。
   *
   * 同一个 id 上的多次调用按发起顺序一个接一个跑，不同 id 互不影响。
   * 会话不存在时抛 `SessionNotFoundError`。
   */
  run<T>(id: string, fn: (session: Session) => Promise<T>): Promise<T>;
  /** 当前持有的会话数。**不暴露给 HTTP**，只给测试与诊断用 */
  size(): number;
}

export function createSessionRegistry(options: {
  newId: () => string;
  model: string;
  /** 上限；超出后按创建顺序淘汰最早的。默认 100 */
  maxSessions?: number;
}): SessionRegistry {
  const maxSessions = options.maxSessions ?? 100;

  // Map 保持插入顺序，所以「第一个键」就是最早创建的那个 —— FIFO 不需要额外的队列
  const sessions = new Map<string, Session>();
  /**
   * 每个会话的队尾。存进去的**一定是不会 reject 的承诺**：
   * 没人在等它的 promise 一旦 reject 就会触发 unhandledRejection。
   */
  const tails = new Map<string, Promise<void>>();

  const evictOldest = (): void => {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) return;
      sessions.delete(oldest.value);
      tails.delete(oldest.value);
    }
  };

  return {
    create() {
      const id = options.newId();
      const session = new Session(options.model);
      sessions.set(id, session);
      evictOldest();
      return { session, id };
    },

    get(id) {
      return sessions.get(id) ?? null;
    },

    async run<T>(id: string, fn: (session: Session) => Promise<T>): Promise<T> {
      const session = sessions.get(id);
      if (!session) throw new SessionNotFoundError(id);

      const previous = tails.get(id) ?? Promise.resolve();

      // 两个分支都调 fn：前一次的失败是**它的**失败，不该让这一次也失败
      const current = previous.then(
        () => fn(session),
        () => fn(session),
      );

      // 队尾存「忽略结果的版本」：只需要顺序，不要把上一轮的值或错误带下去
      tails.set(
        id,
        current.then(
          () => undefined,
          () => undefined,
        ),
      );

      return await current;
    },

    size() {
      return sessions.size;
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/http-session-registry.test.ts`
Expected: 全绿（8 条）

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/http demos/02-agent/apps/server/test/http-session-registry.test.ts
git commit -m "feat(server): 新增会话注册表（FIFO 上限 + 每会话串行锁）与会话 id 生成"
```

---

### Task 8: 错误映射

**Files:**
- Create: `demos/02-agent/apps/server/src/http/errors.ts`
- Test: `demos/02-agent/apps/server/test/http-errors.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `mapErrorToStatus(error: unknown): { status: number; code: string }`

- [ ] **Step 1: 写失败测试**

`test/http-errors.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapErrorToStatus } from '@/http/errors.ts';

test('上游返回错误响应 → 502', () => {
  const mapped = mapErrorToStatus(new Error('DeepSeek API error 401: invalid api key'));
  assert.strictEqual(mapped.status, 502);
  assert.strictEqual(mapped.code, 'upstream_error');
});

test('上游 401 绝不透出成 401（那是我们的 key 错了，不是用户没登录）', () => {
  for (const status of [401, 403, 429]) {
    const mapped = mapErrorToStatus(new Error(`DeepSeek API error ${status}: x`));
    assert.notStrictEqual(mapped.status, status);
    assert.strictEqual(mapped.status, 502);
  }
});

test('连不上上游 → 504', () => {
  assert.strictEqual(mapErrorToStatus(new TypeError('fetch failed')).status, 504);
  assert.strictEqual(mapErrorToStatus(new Error('ECONNREFUSED')).status, 504);
  assert.strictEqual(mapErrorToStatus(new Error('socket hang up')).status, 504);
});

test('未知错误 → 500', () => {
  const mapped = mapErrorToStatus(new Error('别的东西炸了'));
  assert.strictEqual(mapped.status, 500);
  assert.strictEqual(mapped.code, 'internal');
});

test('非 Error 的抛出物也能映射', () => {
  assert.strictEqual(mapErrorToStatus('字符串错误').status, 500);
  assert.strictEqual(mapErrorToStatus(null).status, 500);
});

test('返回值只可能是 500 / 502 / 504', () => {
  const samples: unknown[] = [
    new Error('DeepSeek API error 500: x'),
    new Error('fetch failed'),
    new Error('whatever'),
    'string',
    null,
    undefined,
    { weird: true },
  ];
  for (const sample of samples) {
    assert.ok([500, 502, 504].includes(mapErrorToStatus(sample).status));
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/http-errors.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写 `src/http/errors.ts`**

```ts
// 把任意异常映射成 HTTP 状态码。
//
// **不做错误类型体系。** llm/deepseek.ts 至今只抛裸 Error（消息里带着
// 上游状态码的字符串），引入带 code 的 LLMError 是 01-llm 明确推给 M6 的欠账，
// 本次只在 HTTP 边界做最小可区分的映射。

/**
 * 唯一一条硬约束：**上游的 status 绝不原样透出**。
 *
 * `res.status(401)` 会把「我们的 DeepSeek key 无效」变成
 * 「你这个浏览器用户没登录」，前端会去查一个根本不存在的登录态。
 * 上游状态码只允许出现在 message 文本里。
 */
export function mapErrorToStatus(error: unknown): { status: number; code: string } {
  const message = error instanceof Error ? error.message : String(error);

  // deepseek.ts 的非 2xx 抛错格式（见 llm/deepseek.ts）
  if (/^DeepSeek API error \d{3}:/.test(message)) {
    return { status: 502, code: 'upstream_error' };
  }

  // undici 的连接失败、DNS 失败、连接被中途掐断
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|aborted/i.test(message)) {
    return { status: 504, code: 'upstream_unreachable' };
  }

  return { status: 500, code: 'internal' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/http-errors.test.ts`
Expected: 全绿（6 条）

- [ ] **Step 5: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/http/errors.ts demos/02-agent/apps/server/test/http-errors.test.ts
git commit -m "feat(server): 新增 HTTP 错误映射（上游 status 不透出）"
```

---

### Task 9: 装 express，写 `http/app.ts`

**Files:**
- Modify: `demos/02-agent/apps/server/package.json`（加 `dependencies.express` 与 `devDependencies.@types/express`）
- Create: `demos/02-agent/apps/server/src/http/app.ts`
- Test: `demos/02-agent/apps/server/test/http-app.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `runSessionTurn` / `SYSTEM_PROMPT`；Task 6 的 `foldTranscript`；
  Task 7 的 `SessionRegistry` / `SessionNotFoundError`；Task 8 的 `mapErrorToStatus`
- Produces: `AppDeps`；`createApp(deps: AppDeps): Express`（**不 listen**）

- [ ] **Step 1: 改 `apps/server/package.json`**

```json
{
  "name": "server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/main.ts",
    "dev": "node --watch --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/main.ts",
    "test": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs --test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: 安装**

Run: `cd demos/02-agent && pnpm install`
Expected: `apps/server/node_modules/express` 出现，`pnpm-lock.yaml` 更新

- [ ] **Step 3: 写失败测试**

`test/http-app.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { createApp } from '@/http/app.ts';
import { createSessionRegistry } from '@/http/session-registry.ts';
import { createToolRegistry } from '@/tools/registry.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ChatResult } from '@/core/types.ts';

const SESSION_ID = '20260101-000000-aaaa';

/** 按顺序吐出预设响应的假 client */
function stubClient(results: ChatResult[]): LLMClient {
  let index = 0;
  return {
    async chat(): Promise<ChatResult> {
      const result = results[index];
      index += 1;
      if (!result) throw new Error('预设响应用完');
      return result;
    },
  };
}

const answer = (text: string): ChatResult => ({ content: text, finish_reason: 'stop' });

/**
 * 起一个临时端口的服务，跑完就关。
 *
 * `closeAllConnections()` 不能省：undici（Node 的 fetch）默认复用连接，
 * 而 server.close() 只停止接受新连接、会一直等现有连接结束 ——
 * 少这一行，整个测试文件会卡到超时，报错看起来像「测试挂死」。
 */
async function withServer(app: Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeApp(client: LLMClient) {
  const sessions = createSessionRegistry({ newId: () => SESSION_ID, model: 'deepseek-flash' });
  const app = createApp({
    client,
    registry: createToolRegistry(),
    sessions,
    model: 'deepseek-flash',
    systemPrompt: SYSTEM_PROMPT,
    logError: () => undefined,
  });
  return { app, sessions };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/sessions 建会话并返回 id 与模型', async () => {
  const { app, sessions } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/sessions', {});
    assert.strictEqual(response.status, 201);
    assert.deepStrictEqual(await response.json(), {
      sessionId: SESSION_ID,
      model: 'deepseek-flash',
    });
    assert.strictEqual(sessions.size(), 1);
  });
});

test('POST 消息返回本轮的展示项（工具轨迹 + 回答，不含用户那条）', async () => {
  const client = stubClient([
    {
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    answer('北京今天 25°C，晴天。'),
  ]);
  const { app } = makeApp(client);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, {
      message: '北京今天天气怎么样？',
    });

    assert.strictEqual(response.status, 200);
    const body = (await response.json()) as { items: unknown[]; stopReason: string };

    // 这一条是**前端类型的真正守卫**：键名与形状必须与 apps/web/src/types.ts 一致
    assert.deepStrictEqual(body, {
      items: [
        {
          kind: 'tool',
          name: 'weather',
          argumentsText: '{"city":"Beijing"}',
          ok: true,
          result: '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}',
        },
        { kind: 'assistant', text: '北京今天 25°C，晴天。' },
      ],
      stopReason: 'answered',
    });
  });
});

test('GET 历史返回整段会话的展示项', async () => {
  const client = stubClient([
    {
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    answer('北京今天 25°C，晴天。'),
  ]);
  const { app } = makeApp(client);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: '北京天气' });

    const response = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/messages`);
    assert.strictEqual(response.status, 200);

    const body = (await response.json()) as { items: Array<{ kind: string }> };
    assert.deepStrictEqual(
      body.items.map((item) => item.kind),
      ['user', 'tool', 'assistant'],
    );
  });
});

test('未知会话 → 404，code 是 session_not_found', async () => {
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    const post = await postJson(baseUrl, '/api/sessions/nope/messages', { message: 'hi' });
    assert.strictEqual(post.status, 404);
    assert.strictEqual(((await post.json()) as { error: { code: string } }).error.code, 'session_not_found');

    assert.strictEqual((await fetch(`${baseUrl}/api/sessions/nope/messages`)).status, 404);
  });
});

test('message 缺失或非法 → 400', async () => {
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    for (const body of [{}, { message: '' }, { message: 42 }, { message: '   ' }]) {
      const response = await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, body);
      assert.strictEqual(response.status, 400, `应拒绝：${JSON.stringify(body)}`);
    }
  });
});

test('不带 Content-Type 发请求 → 400（而不是 500）', async () => {
  // express 5 在没有 json content-type 时把 req.body 留成 undefined，
  // 直接取 req.body.message 会抛 TypeError 落到错误中间件变成 500
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      body: 'message=hi',
    });
    assert.strictEqual(response.status, 400);
  });
});

test('请求体不是合法 JSON → 400 invalid_body', async () => {
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ 坏掉的 json',
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(((await response.json()) as { error: { code: string } }).error.code, 'invalid_body');
  });
});

test('上游 401 → 502（不透出上游状态码）', async () => {
  const failing: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 401: invalid api key');
    },
  };
  const { app } = makeApp(failing);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: 'hi' });

    assert.strictEqual(response.status, 502);
    assert.strictEqual(((await response.json()) as { error: { code: string } }).error.code, 'upstream_error');
  });
});

test('连不上上游 → 504', async () => {
  const failing: LLMClient = {
    async chat() {
      throw new TypeError('fetch failed');
    },
  };
  const { app } = makeApp(failing);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: 'hi' });
    assert.strictEqual(response.status, 504);
  });
});

test('失败的一轮不写进会话（历史里只有 user）', async () => {
  const failing: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 500: boom');
    },
  };
  const { app } = makeApp(failing);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: 'hi' });

    const response = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/messages`);
    const body = (await response.json()) as { items: Array<{ kind: string }> };
    assert.deepStrictEqual(body.items.map((item) => item.kind), ['user']);
  });
});

test('未知路径 → JSON 404（不是 express 默认的 HTML 错误页）', async () => {
  // 返回 HTML 的话，前端 res.json() 会抛 SyntaxError，
  // 表现为一个完全不指向真正原因的解析错误
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/nope`);
    assert.strictEqual(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.strictEqual(((await response.json()) as { error: { code: string } }).error.code, 'not_found');
  });
});

test('上游收到的 messages 里带着 system 提示与本轮 user', async () => {
  const seen: Array<Array<{ role: string; content: unknown }>> = [];
  const client: LLMClient = {
    async chat(messages) {
      seen.push(messages.map((message) => ({ role: message.role, content: 'content' in message ? message.content : undefined })));
      return answer('好');
    },
  };
  const { app } = makeApp(client);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    await postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: '你好' });
  });

  assert.deepStrictEqual(seen[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '你好' },
  ]);
});

test('同一会话并发两个请求：第二个能看到第一个的结果（串行）', async () => {
  const seenMessages: string[][] = [];
  let call = 0;
  const client: LLMClient = {
    async chat(messages) {
      call += 1;
      seenMessages.push(
        messages.filter((m) => m.role === 'user').map((m) => (m.role === 'user' ? m.content : '')),
      );
      // 第一个请求故意慢一点，让第二个有机会插队
      await new Promise((resolve) => setTimeout(resolve, call === 1 ? 30 : 1));
      return answer(`第 ${call} 个回答`);
    },
  };
  const { app } = makeApp(client);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    await Promise.all([
      postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: '第一句' }),
      postJson(baseUrl, `/api/sessions/${SESSION_ID}/messages`, { message: '第二句' }),
    ]);
  });

  // 串行的话第二个请求能看见第一句与第一个回答；交错的话两条 user 会同时落地
  assert.deepStrictEqual(seenMessages[0], ['第一句'], '第一个请求不该看见第二句');
  assert.deepStrictEqual(seenMessages[1], ['第一句', '第二句'], '第二个请求必须看见第一轮的全部历史');
});
```

- [ ] **Step 4: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/http-app.test.ts`
Expected: FAIL —— `Cannot find module '@/http/app.ts'`

- [ ] **Step 5: 写 `src/http/app.ts`**

```ts
// HTTP 层的全部路由与中间件。**导出的是「造 app」而不是「跑 app」** ——
// 不在这里 listen，测试才能用临时端口把它跑起来、跑完就关。
//
// 这一层是唯一允许 import express 的地方；core / llm / tools / presentation
// 都不知道它的存在。

import express from 'express';
// 只当类型用的导入必须写 `import type`：Node 的原生类型擦除看不出
// `Request` 是个类型，会原样保留这条值导入，运行时抛
// 「does not provide an export named 'Request'」，而 tsc 完全放行。
import type { Express, NextFunction, Request, Response } from 'express';

import { runSessionTurn } from '@/core/agent.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import { foldTranscript } from '@/presentation/transcript.ts';
import { SessionNotFoundError } from '@/http/session-registry.ts';
import { mapErrorToStatus } from '@/http/errors.ts';
import type { SessionRegistry } from '@/http/session-registry.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { LLMClient } from '@/llm/client.ts';

export interface AppDeps {
  client: LLMClient;
  registry: ToolRegistry;
  sessions: SessionRegistry;
  /** 建会话时用的模型名 */
  model: string;
  systemPrompt?: string;
  maxSteps?: number;
  /** 服务端诊断日志。默认写 stderr；测试注入一个空实现以免污染输出 */
  logError?: (message: string) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
  const logError =
    deps.logError ??
    ((message: string) => {
      process.stderr.write(message + '\n');
    });
  const sessionPath = '/api/sessions/:id/messages';

  // 请求体限制：这个接口只收一句话，32KB 远远够用，
  // 顺带挡掉「发一个巨大 body 把内存吃掉」这种最朴素的情况
  app.use(express.json({ limit: '32kb' }));

  app.post('/api/sessions', (_req: Request, res: Response) => {
    const { session, id } = deps.sessions.create();
    res.status(201).json({ sessionId: id, model: session.model });
  });

  app.post(sessionPath, async (req: Request, res: Response) => {
    // express 5 在没有 `content-type: application/json` 时不给 req.body 兜底成 {}，
    // 而是留成 undefined —— 直接取 .message 会抛 TypeError 变成 500。
    // 所以这里必须先判 undefined 再判类型。
    const body = req.body as { message?: unknown } | undefined;
    if (typeof body?.message !== 'string' || body.message.trim() === '') {
      res.status(400).json({
        error: { code: 'invalid_message', message: 'message 必须是非空字符串' },
      });
      return;
    }
    const question = body.message.trim();
    const sessionId = req.params.id;

    try {
      const turn = await deps.sessions.run(sessionId, async (session) =>
        await runSessionTurn(session, deps.client, deps.registry, question, {
          systemPrompt,
          ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
        }),
      );

      res.json({
        // `items` 是**本轮新增**的展示项：工具轨迹 + 最终回答。
        // **不含用户那条** —— 前端已经知道自己发了什么，也已经先渲染出来了。
        // 整段会话的展示项由 GET 提供，两者同一个 foldTranscript，只差范围。
        items: foldTranscript(turn.added),
        stopReason: turn.stopReason,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: { code: 'session_not_found', message: error.message } });
        return;
      }
      // 其余交给错误中间件。express 5 会把 async handler 的 rejected promise
      // 自动转过去 —— 这正是选 express 5 而不是 4 的主要理由
      throw error;
    }
  });

  app.get(sessionPath, (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const session = deps.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        error: { code: 'session_not_found', message: `会话不存在：${sessionId}` },
      });
      return;
    }
    // 刻意**不加会话锁**：history() 返回的是深拷贝，读不会与在途的一轮打架；
    // 加锁反而会让一次刷新页面等完一个几十秒的回答
    res.json({ items: foldTranscript(session.history()) });
  });

  // 404 兜底。**不用 `app.get('*')`** —— express 5 的 path-to-regexp v8
  // 不再接受裸 `*`，会在启动时就抛「Missing parameter name」。
  // 用 app.use 更稳，而且必须返回 JSON：express 默认的 HTML 错误页会让
  // 前端的 res.json() 抛 SyntaxError，表现为一个完全不指向原因的解析错误。
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: '没有这个接口' } });
  });

  // 错误中间件：必须**恰好一个、注册在最后**，且是 4 参函数
  // （express 按函数 arity 识别它，写成 3 参会变成普通中间件）
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // body-parser 解析失败时抛的 SyntaxError **自带 status: 400**，
    // 不先放行它就会被当成服务端错误返回 500
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: { code: 'invalid_body', message: '请求体不是合法 JSON' },
      });
      return;
    }

    const mapped = mapErrorToStatus(error);
    const detail = error instanceof Error ? error.message : String(error);
    logError(`[http] ${mapped.status} ${mapped.code}: ${detail}`);
    res.status(mapped.status).json({ error: { code: mapped.code, message: detail } });
  });

  return app;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/http-app.test.ts`
Expected: 全绿（13 条）

**若卡住不返回**：说明 `closeAllConnections()` 没生效 —— 那是 undici keep-alive 挂住了
`server.close()`，报错会看起来像「测试挂死」。检查 `withServer` 的 finally 块。

- [ ] **Step 7: 类型检查与全量测试**

Run: `cd demos/02-agent/apps/server && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 8: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/package.json demos/02-agent/pnpm-lock.yaml \
        demos/02-agent/apps/server/src/http/app.ts demos/02-agent/apps/server/test/http-app.test.ts
git commit -m "feat(server): 引入 express 并实现 REST 接口（建会话 / 发消息 / 取历史）"
```

---

### Task 10: 进程入口、配置与服务端脚本

**Files:**
- Create: `demos/02-agent/apps/server/src/llm/config.ts`
- Create: `demos/02-agent/apps/server/src/main.ts`
- Modify: `demos/02-agent/apps/server/.env`
- Test: `demos/02-agent/apps/server/test/config.test.ts`、`test/main.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `createApp`；Task 7 的 `createSessionRegistry` / `newSessionId`
- Produces: `resolveConfig(env)`；`Config`；一个能 `pnpm start` 起来的服务端进程；
  环境变量 `AI_AGENT_PORT` / `AI_AGENT_HOST`

- [ ] **Step 1: 写失败测试（config）**

`test/config.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '@/llm/config.ts';

test('缺 DEEPSEEK_API_KEY 时抛错', () => {
  assert.throws(() => resolveConfig({}), /DEEPSEEK_API_KEY/);
});

test('key 是空串也算缺失（用 !apiKey 而不是 ??）', () => {
  assert.throws(() => resolveConfig({ DEEPSEEK_API_KEY: '' }), /DEEPSEEK_API_KEY/);
});

test('baseUrl 与 model 有默认值', () => {
  const config = resolveConfig({ DEEPSEEK_API_KEY: 'k' });
  assert.deepStrictEqual(config, {
    apiKey: 'k',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  });
});

test('环境变量覆盖默认值', () => {
  const config = resolveConfig({
    DEEPSEEK_API_KEY: 'k',
    DEEPSEEK_BASE_URL: 'https://example.test',
    AI_CHAT_MODEL: 'deepseek-v4-pro',
  });
  assert.strictEqual(config.baseUrl, 'https://example.test');
  assert.strictEqual(config.model, 'deepseek-v4-pro');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/config.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写 `src/llm/config.ts`**

```ts
// 配置解析：环境变量 → LLMClientConfig。
//
// 它住在 llm/ 而不是某个「入口」文件里，是因为它产出的就是
// 「怎么连 LLM 服务商」这件事的配置，而且是**纯函数** ——
// env 由参数传入，自己不读 process.env、不打印、不碰 IO，因此可以离线测。
//
// 做成参数而不是内部读 process.env，还有一个实际好处：
// 测试能构造任意环境，不必改全局状态。

import type { LLMClientConfig } from '@/llm/client.ts';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

/**
 * 从环境变量解析出客户端配置。
 *
 * @throws 缺少 `DEEPSEEK_API_KEY` 时抛错 —— 与其带着空 key 发请求、
 *   拿到一个 401 再猜原因，不如在启动时就死掉
 */
export function resolveConfig(env: NodeJS.ProcessEnv): LLMClientConfig {
  const apiKey = env.DEEPSEEK_API_KEY;
  // 用 `!apiKey` 而不是 `??`：空串也是「没配」，而 `'' ?? x` 会放行空串
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量（可写在 .env.local 里）');
  }

  return {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
    model: env.AI_CHAT_MODEL ?? DEFAULT_MODEL,
  };
}
```

- [ ] **Step 4: 跑 config 测试**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/config.test.ts`
Expected: 全绿（4 条）

- [ ] **Step 5: 写 `src/main.ts`**

```ts
// 服务端的进程入口。**整个 src/ 里只有这一个文件碰 process。**
//
// 它负责装配：把具体实现（DeepSeek client、真实工具注册表、会话表）
// 造出来交给 createApp；createApp 只认接口，所以测试能塞假的进去。

import { resolveConfig } from '@/llm/config.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import { createToolRegistry } from '@/tools/registry.ts';
import { createSessionRegistry } from '@/http/session-registry.ts';
import { createApp } from '@/http/app.ts';
import { newSessionId } from '@/http/ids.ts';

const DEFAULT_PORT = 3000;
/** 只监听回环地址。这是个本机开发工具，不是可暴露的服务（见 spec D17） */
const DEFAULT_HOST = '127.0.0.1';

let config;
try {
  config = resolveConfig(process.env);
} catch (error) {
  process.stderr.write(`[error] ${(error as Error).message}\n`);
  process.exit(1);
}

// 端口 0 表示「由内核分配一个空闲端口」—— 子进程测试靠这个避免端口冲突
let port = DEFAULT_PORT;
let host = DEFAULT_HOST;

port = Number(process.env.AI_AGENT_PORT ?? DEFAULT_PORT);
host = process.env.AI_AGENT_HOST ?? DEFAULT_HOST;

const sessions = createSessionRegistry({ newId: newSessionId, model: config.model });

const app = createApp({
  client: createDeepSeekClient(config),
  registry: createToolRegistry(),
  sessions,
  model: config.model,
});

const server = app.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  // 这一行走 **stdout**：它是服务端最主要的一条给人看的信息，
  // 而且测试要从这里读出「内核分了哪个端口」。
  // （01-llm 的 stdout/stderr 分流规矩不适用于服务端 —— 那边 stdout 要留给模型回答。）
  process.stdout.write(`[http] listening on http://${host}:${actualPort}\n`);
});

// 优雅退出：让子进程测试能干净地收掉它，也让 Ctrl+C 不留悬挂连接
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // close() 只停止接受新连接，keep-alive 的连接会拖住回调 ——
    // 主动断掉它们，否则 Ctrl+C 之后进程要等好几秒才退
    server.closeAllConnections();
  });
}
```

- [ ] **Step 6: 在 `apps/server/.env` 模板里补两行**

```
AI_AGENT_PORT=3000
AI_AGENT_HOST=127.0.0.1
```

- [ ] **Step 7: 写失败测试（main）**

`test/main.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * 子进程级集成测试：断言真实的启动行为与退出码。
 *
 * 为什么不直接用单元测试：把 process.exit(1) 改成 throw，单元测试依然全绿，
 * 而脚本与 CI 的判断依据已经坏了。
 */
function runServer(env: Record<string, string>) {
  let out = '';
  let err = '';
  const child = spawn(process.execPath, ['--import', './loader.mjs', 'src/main.ts'], {
    cwd: process.cwd(),
    // 用确定的 env，**不继承**父进程真实的 DEEPSEEK_API_KEY ——
    // 否则「缺 key 该退出」这类用例会被父进程的环境悄悄救活
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  return { child, stdout: () => out, stderr: () => err };
}

test('缺 DEEPSEEK_API_KEY 时退出码 1，错误走 stderr', async () => {
  const { child, stderr } = runServer({});

  const [code] = (await once(child, 'exit')) as [number];
  assert.strictEqual(code, 1);
  assert.match(stderr(), /DEEPSEEK_API_KEY/);
});

test('起来后在 stdout 打印真实端口，能真的服务，SIGTERM 能干净退出', async () => {
  const { child, stdout } = runServer({
    DEEPSEEK_API_KEY: 'test-key-not-used',
    AI_AGENT_PORT: '0',
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`没等到端口公告，stdout=${stdout()}`)), 10_000);
      const poll = setInterval(() => {
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout());
        if (match) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      }, 20);
    });

    assert.ok(port > 0, 'port 0 应被内核替换成真实端口');

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' });
    assert.strictEqual(response.status, 201);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
```

- [ ] **Step 8: 跑 main 测试**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/main.test.ts`
Expected: 全绿（2 条）

**若「缺 key」那条过不了**：多半是父进程的真实 `DEEPSEEK_API_KEY` 漏进了 `env` ——
检查 `runServer` 是把 `...env` 展开在最后、且没有整份继承 `process.env`。

- [ ] **Step 9: 手动冒烟**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm start &
sleep 1
id=$(curl -sX POST localhost:3000/api/sessions | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"北京今天天气怎么样？"}'
curl -s "localhost:3000/api/sessions/$id/messages"
kill %1
```
Expected: 第一条响应里 `items` 含 `weather` 轨迹与回答；第二条把三项都返回

- [ ] **Step 10: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 11: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server
git commit -m "feat(server): 新增进程入口与配置解析，服务端可独立启动"
```

---

### Task 11: 前端骨架

`apps/web` 是 workspace 里的一个包，依赖在**阶段根**一次装完。

**Files:**
- Create: `demos/02-agent/apps/web/{package.json,tsconfig.json,vite.config.ts,index.html}`
- Create: `demos/02-agent/apps/web/src/{main.tsx,App.tsx,styles.css}`

**Interfaces:**
- Consumes: 无
- Produces: 一个 `pnpm -F web build` 能过的空壳

- [ ] **Step 1: 写 `apps/web/package.json`**

```json
{
  "name": "web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.5.0",
    "vite": "^8.3.1"
  }
}
```

- [ ] **Step 2: 写 `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": []
  },
  "include": ["src", "vite.config.ts"]
}
```

`verbatimModuleSyntax` 与服务端那条「只当类型用的导入必须写 `import type`」是同一个教训，
这里直接在类型检查阶段强制它。`types: []` 也是刻意的 —— 前端**不应该**依赖 Node 的类型。

- [ ] **Step 3: 写 `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 前端一律用**相对路径** `/api/...`，dev 时由 Vite 反代到服务端。
      // 因此不需要 CORS 中间件；将来若改成 express.static 同源部署，
      // 前端代码一行都不用改。
      //
      // 这是整个前端里**唯一**允许出现服务端地址的地方。
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
```

- [ ] **Step 4: 写 `apps/web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ai-chat-agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 `apps/web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: 写 `apps/web/src/App.tsx` 空壳**

```tsx
export default function App() {
  return <main className="app">正在加载…</main>;
}
```

- [ ] **Step 7: 写 `apps/web/src/styles.css`**

配色沿用 `docs/how-agent-works.html` 的色板 —— 讲解页与界面用同一套颜色，
读文档与用界面的心智是一套。

```css
:root {
  --ground: #f4f5f7;
  --surface: #ffffff;
  --ink: #191c22;
  --ink-faint: #8a92a0;
  --line: #dce0e7;
  --user: #40454f;
  --user-bg: #f2f4f7;
  --llm: #3d50b4;
  --llm-bg: #e7eafb;
  --tool: #0e7c66;
  --tool-bg: #dff1ec;
  --warn: #a63b3b;
  --warn-bg: #faebeb;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ground: #11141a;
    --surface: #191d25;
    --ink: #e7eaf0;
    --ink-faint: #737c8c;
    --line: #2b313c;
    --user: #c6ccd6;
    --user-bg: #1b1f27;
    --llm: #93a2f0;
    --llm-bg: #1f2540;
    --tool: #5bc4a8;
    --tool-bg: #12291f;
    --warn: #e89393;
    --warn-bg: #35201f;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 15px;
  line-height: 1.6;
}

.app {
  display: flex;
  flex-direction: column;
  max-width: 760px;
  height: 100dvh;
  margin: 0 auto;
}

.app__header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}

.app__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.app__meta {
  color: var(--ink-faint);
  font-size: 13px;
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 20px 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 14px;
}

.notice button {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  opacity: 0.7;
}

.list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.list__empty {
  margin: auto;
  color: var(--ink-faint);
  text-align: center;
  font-size: 14px;
}

.bubble {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble--user {
  align-self: flex-end;
  background: var(--user-bg);
  color: var(--user);
  border: 1px solid var(--line);
}

.bubble--assistant {
  align-self: flex-start;
  background: var(--llm-bg);
  color: var(--llm);
}

.bubble--error {
  align-self: stretch;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 14px;
}

.tool {
  align-self: flex-start;
  max-width: 88%;
  padding: 8px 12px;
  border-left: 3px solid var(--tool);
  border-radius: 6px;
  background: var(--tool-bg);
  color: var(--tool);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

.tool__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.tool__badge {
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 11px;
  opacity: 0.8;
}

.tool__body {
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.9;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.composer__input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  resize: none;
}

.composer__input:focus {
  outline: 2px solid var(--llm);
  outline-offset: -1px;
}

.composer__send {
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  background: var(--llm);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.composer__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 8: 安装并验证**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm install
pnpm -F web typecheck
pnpm -F web build
```
Expected: 三条都成功，`apps/web/dist/` 生成

- [ ] **Step 9: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/web demos/02-agent/package.json demos/02-agent/pnpm-workspace.yaml demos/02-agent/pnpm-lock.yaml
git commit -m "feat(web): 前端骨架（React 19 + Vite 8，proxy 反代 /api）"
```

---

### Task 12: 前端契约、API 客户端与状态机

**Files:**
- Create: `demos/02-agent/apps/web/src/{types.ts,api.ts,chatReducer.ts}`

**Interfaces:**
- Consumes: Task 11 的骨架
- Produces: `TranscriptItem` / `SendMessageResponse` / `HistoryResponse` / `ApiErrorBody`；
  `ApiError`；`createSession()` / `sendMessage()` / `fetchHistory()`；
  `ChatState` / `ChatItem` / `Action` / `chatReducer` / `initialChatState`

- [ ] **Step 1: 写 `apps/web/src/types.ts`**

```ts
// 线上契约的**抄写**。
//
// 为什么不跨包 import 服务端的类型：那要把服务端的 @types/node 拖进前端 tsconfig，
// 而这份 tsconfig 刻意设了 `types: []` —— 前端不应依赖 Node 的类型。
// 而且线上契约本来就不是服务端的内部 `Message` 联合，它是 `TranscriptItem`，是另一个东西。
//
// 真正的守卫在 apps/server/test/http-app.test.ts：那里逐字断言了响应 JSON 的键与形状。
// 这份文件改了而那边没改，服务端测试不会红 —— 所以改这里之前先看一眼那份测试。

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** 模型给的原始 JSON 字符串 */
      argumentsText: string;
      /** true=成功，false=失败，null=没等到结果 */
      ok: boolean | null;
      result: string;
    };

/** `POST /api/sessions` 的响应 */
export interface CreateSessionResponse {
  sessionId: string;
  model: string;
}

/**
 * `POST /api/sessions/:id/messages` 的响应。
 *
 * `items` 是**本轮新增**的展示项（工具轨迹 + 回答），**不含用户那条** ——
 * 前端已经知道自己发了什么。整段会话由 `GET` 提供，两者同一种形状。
 */
export interface SendMessageResponse {
  items: TranscriptItem[];
  stopReason: 'answered' | 'max-steps';
}

/** `GET /api/sessions/:id/messages` 的响应。`items` 是**整段会话** */
export interface HistoryResponse {
  items: TranscriptItem[];
}

/** 所有非 2xx 响应的统一形状 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}
```

- [ ] **Step 2: 写 `apps/web/src/api.ts`**

```ts
// 与服务端说话的唯一入口。
//
// **路径一律是相对的**（`/api/...`）：dev 时由 Vite 的 proxy 反代到 :3000，
// 将来同源部署时不用改一行。写成 `http://localhost:3000/...` 会让 proxy 完全失效、
// 触发 CORS 报错，而那个报错会把人引向「加 cors 中间件」这个错误解法。

import type {
  ApiErrorBody,
  CreateSessionResponse,
  HistoryResponse,
  SendMessageResponse,
} from './types.ts';

const BASE = '/api';

/** 带状态码与业务 code 的错误，方便调用方区分「会话没了」与「其它失败」 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);

  if (!response.ok) {
    // 服务端保证错误体是 JSON；但万一不是（比如反向代理插了一页 HTML），
    // 也不能让 res.json() 的 SyntaxError 把真正的原因盖掉
    let code = 'unknown';
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // 保留上面的兜底文案
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

export async function createSession(): Promise<CreateSessionResponse> {
  return await request<CreateSessionResponse>('/sessions', { method: 'POST' });
}

export async function sendMessage(sessionId: string, message: string): Promise<SendMessageResponse> {
  return await request<SendMessageResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function fetchHistory(sessionId: string): Promise<HistoryResponse> {
  return await request<HistoryResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
}
```

`encodeURIComponent` 不是可省的礼节：会话 id 会被拼进 URL 路径，
虽然服务端生成的形状固定，但 `localStorage` 里的值是**用户可改的**。

- [ ] **Step 3: 写 `apps/web/src/chatReducer.ts`**

```ts
// 对话框的状态机。**纯函数、不 import React** ——
// 前端本次没有测试框架，拆成纯模块是为了将来补测试时不必重构（一笔明确的欠账）。

import type { TranscriptItem } from './types.ts';

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'tool'; name: string; argumentsText: string; ok: boolean | null; result: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'error'; text: string };

export interface ChatState {
  items: ChatItem[];
  status: 'idle' | 'sending';
  /** 顶部那条可关闭的提示（例如「会话已失效」） */
  notice: string | null;
  /** 生成稳定 id 用的计数器。放在 state 里，reducer 才能保持纯粹 */
  nextId: number;
}

// 注意这里**没有 sessionId**：它由 useChat 的 ref 持有。
// 放进 state 会是一份没人写的死状态 —— reducer 无权创建会话（那是网络请求），
// 而把同一个值存两处，迟早出现两者不一致的中间态。

export const initialChatState: ChatState = {
  items: [],
  status: 'idle',
  notice: null,
  nextId: 1,
};

export type Action =
  | { type: 'history/loaded'; items: TranscriptItem[] }
  | { type: 'session/lost'; notice: string }
  | { type: 'notice/dismiss' }
  | { type: 'user/send'; text: string }
  | { type: 'turn/success'; items: TranscriptItem[] }
  | { type: 'turn/error'; text: string };

/** 把服务端给的展示项转成带稳定 id 的本地项 */
function toChatItems(items: TranscriptItem[], startId: number): ChatItem[] {
  return items.map((item, offset) => {
    const id = `item-${startId + offset}`;
    if (item.kind === 'tool') {
      return {
        id,
        kind: 'tool' as const,
        name: item.name,
        argumentsText: item.argumentsText,
        ok: item.ok,
        result: item.result,
      };
    }
    return { id, kind: item.kind, text: item.text };
  });
}

export function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'history/loaded':
      // 整段替换：服务端是渲染顺序的唯一事实来源
      return {
        ...state,
        items: toChatItems(action.items, state.nextId),
        nextId: state.nextId + action.items.length,
      };

    case 'session/lost':
      // 会话在服务端没了（重启或淘汰）：清空界面并给一条提示。
      // **不自动新建会话** —— 新建推迟到用户下次发送时，
      // 否则每刷新一次页面，服务端就多一个没人用的会话（useChat 负责清 ref 与 localStorage）
      return { ...state, items: [], notice: action.notice, nextId: 1 };

    case 'notice/dismiss':
      return { ...state, notice: null };

    case 'user/send':
      return {
        ...state,
        status: 'sending',
        items: [...state.items, { id: `item-${state.nextId}`, kind: 'user', text: action.text }],
        nextId: state.nextId + 1,
      };

    case 'turn/success': {
      // 服务端回的是**本轮增量**：先是工具轨迹、最后是回答 —— 直接按序接在后面
      const appended = toChatItems(action.items, state.nextId);
      return {
        ...state,
        status: 'idle',
        items: [...state.items, ...appended],
        nextId: state.nextId + action.items.length,
      };
    }

    case 'turn/error':
      return {
        ...state,
        status: 'idle',
        items: [...state.items, { id: `item-${state.nextId}`, kind: 'error', text: action.text }],
        nextId: state.nextId + 1,
      };

    default: {
      // 穷尽性守卫：给 Action 加一个变体却忘了处理时，这行会编译报错
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
```

- [ ] **Step 4: 类型检查**

Run: `cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm -F web typecheck`
Expected: 退出码 0

- [ ] **Step 5: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/web/src/types.ts demos/02-agent/apps/web/src/api.ts demos/02-agent/apps/web/src/chatReducer.ts
git commit -m "feat(web): 线上契约、API 客户端与对话框状态机"
```

---

### Task 13: 前端组件与会话恢复

**Files:**
- Create: `demos/02-agent/apps/web/src/useChat.ts`
- Create: `demos/02-agent/apps/web/src/components/{MessageList,MessageBubble,ToolTrace,Composer}.tsx`
- Modify: `demos/02-agent/apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 12 的 `chatReducer` / `ApiError` / `createSession` / `sendMessage` / `fetchHistory`
- Produces: `useChat()`；四个组件；可用的 `App`

- [ ] **Step 1: 写 `apps/web/src/useChat.ts`**

```ts
// 把「reducer + 网络请求 + localStorage」粘在一起。
//
// 会话恢复的两个关键决定：
//   1. **首次发送时才建会话**，不是 mount 就建 —— 否则每刷新一次页面，
//      服务端就多一个没人用的会话（服务端虽然会 FIFO 淘汰，但那是兜底不是设计）
//   2. 历史读回 404（服务端重启或会话被淘汰）**不报错**，静默清掉本地 id
//      并给一条可关闭的提示；下一次发送会自动新建

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ApiError, createSession, fetchHistory, sendMessage } from './api.ts';
import { chatReducer, initialChatState } from './chatReducer.ts';

const STORAGE_KEY = 'ai-chat-agent.sessionId';

function readStoredSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式或被禁 cookie 时 localStorage 会抛 —— 那就当没有历史，不影响使用
    return null;
  }
}

function writeStoredSessionId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 存不上只是「下次刷新恢复不了」，不该让发送失败
  }
}

export function useChat() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  // 用 ref 而不是直接读 state.sessionId：send 每次渲染都会重建，
  // 但闭包里的 state 是**那一次渲染的**，长回答回来后可能已经过期
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const stored = readStoredSessionId();
    if (stored === null) return;

    let cancelled = false;
    void (async () => {
      try {
        const history = await fetchHistory(stored);
        if (cancelled) return;
        sessionIdRef.current = stored;
        dispatch({ type: 'history/loaded', items: history.items });
      } catch (error) {
        if (cancelled) return;
        // 只有「会话不存在」才静默降级；其它错误该让用户看见
        if (error instanceof ApiError && error.status === 404) {
          writeStoredSessionId(null);
          sessionIdRef.current = null;
          dispatch({
            type: 'session/lost',
            notice: '上一次的会话已失效（服务端可能重启过），下一条消息会开启新会话。',
          });
          return;
        }
        dispatch({
          type: 'turn/error',
          text: `读取历史失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === '' || state.status === 'sending') return;

      dispatch({ type: 'user/send', text: trimmed });

      try {
        let sessionId = sessionIdRef.current;
        if (sessionId === null) {
          const created = await createSession();
          sessionId = created.sessionId;
          sessionIdRef.current = sessionId;
          writeStoredSessionId(sessionId);
        }

        const result = await sendMessage(sessionId, trimmed);
        dispatch({ type: 'turn/success', items: result.items });
      } catch (error) {
        // 会话在发送途中没了：清掉，下一次发送会自己新建
        if (error instanceof ApiError && error.status === 404) {
          sessionIdRef.current = null;
          writeStoredSessionId(null);
        }
        dispatch({
          type: 'turn/error',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [state.status],
  );

  const dismissNotice = useCallback(() => dispatch({ type: 'notice/dismiss' }), []);

  return { state, send, dismissNotice };
}
```

- [ ] **Step 2: 写四个组件**

`apps/web/src/components/ToolTrace.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/**
 * 一次工具调用的轨迹。**这是本次改造最想让人看到的东西** ——
 * 模型开了什么调用单、程序传了什么参、工具回了什么。
 *
 * `ok` 为 null 表示「没等到结果」（半截历史），用中性标记而不是红叉 ——
 * 它既不是成功也不是失败。
 */
export function ToolTrace({ item }: { item: ToolItem }) {
  const badge = item.ok === null ? '无结果' : item.ok ? '成功' : '失败';
  return (
    <div className="tool">
      <div className="tool__head">
        <span>⚙ {item.name}</span>
        <span className="tool__badge">{badge}</span>
      </div>
      <div className="tool__body">{item.argumentsText}</div>
      {item.result !== '' && <div className="tool__body">→ {item.result}</div>}
    </div>
  );
}
```

`apps/web/src/components/MessageBubble.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';

type BubbleItem = Extract<ChatItem, { kind: 'user' | 'assistant' | 'error' }>;

export function MessageBubble({ item }: { item: BubbleItem }) {
  return <div className={`bubble bubble--${item.kind}`}>{item.text}</div>;
}
```

`apps/web/src/components/MessageList.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';
import { MessageBubble } from './MessageBubble.tsx';
import { ToolTrace } from './ToolTrace.tsx';

export function MessageList({ items, sending }: { items: ChatItem[]; sending: boolean }) {
  return (
    <div className="list">
      {items.length === 0 && !sending && (
        <p className="list__empty">
          问点什么吧。
          <br />
          试试「北京今天天气怎么样？」—— 会看到模型调用 weather 工具的完整轨迹。
        </p>
      )}

      {items.map((item) =>
        item.kind === 'tool' ? (
          <ToolTrace key={item.id} item={item} />
        ) : (
          <MessageBubble key={item.id} item={item} />
        ),
      )}

      {sending && <div className="bubble bubble--assistant">…</div>}
    </div>
  );
}
```

`apps/web/src/components/Composer.tsx`：

```tsx
import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  const submit = (): void => {
    if (disabled || text.trim() === '') return;
    onSend(text);
    setText('');
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    submit();
  };

  // Enter 发送、Shift+Enter 换行。textarea 默认行为是换行，
  // 所以要显式拦住不带修饰键的那一次
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        className="composer__input"
        rows={1}
        value={text}
        placeholder={disabled ? '等待回答…' : '输入消息，Enter 发送'}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="composer__send" type="submit" disabled={disabled || text.trim() === ''}>
        发送
      </button>
    </form>
  );
}
```

- [ ] **Step 3: 改 `apps/web/src/App.tsx`**

```tsx
import { Composer } from './components/Composer.tsx';
import { MessageList } from './components/MessageList.tsx';
import { useChat } from './useChat.ts';

export default function App() {
  const { state, send, dismissNotice } = useChat();

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">ai-chat-agent</h1>
        <span className="app__meta">阶段二 · 工具调用</span>
      </header>

      {state.notice !== null && (
        <div className="notice">
          <span>{state.notice}</span>
          <button type="button" onClick={dismissNotice} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}

      <MessageList items={state.items} sending={state.status === 'sending'} />
      <Composer disabled={state.status === 'sending'} onSend={(text) => void send(text)} />
    </main>
  );
}
```

- [ ] **Step 4: 类型检查与构建**

Run: `cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm -F web typecheck && pnpm -F web build`
Expected: 两条都成功

- [ ] **Step 5: 确认前端没有硬编码服务端地址**

Run:
```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent/apps/web
grep -rn "localhost:3000\|127.0.0.1:3000" src/ || echo "干净：src/ 里没有绝对地址"
```
Expected: 输出「干净：src/ 里没有绝对地址」

- [ ] **Step 6: 双进程手动冒烟**

```bash
# 终端 A
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm start
# 终端 B
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm -F web dev
```

浏览器打开 http://localhost:5173，逐条确认：

1. 问「北京今天天气怎么样？」→ 先出现 `⚙ weather` 轨迹块（含参数与结果），再出现回答气泡
2. 刷新页面：历史还在（`user / tool / assistant` 三种气泡都渲染出来）
3. 刷新三次，服务端会话数不涨（未发送时不该新建会话）
4. 杀掉服务端再刷新：出现「会话已失效」的可关闭提示，**不是白屏**
5. 此时再发一条消息：自动新建会话并正常回答

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/web
git commit -m "feat(web): 对话框组件、工具轨迹渲染与会话恢复"
```

---

### Task 14: 文档与既有产物同步

根 `AGENTS.md` 与根 `README.md` 已经在本计划之前改完了，本 Task 只负责 `demos/02-agent/` 自己的文档。

**Files:**
- Create: `demos/02-agent/{README.md,ARCHITECTURE.md,DECISIONS.md,EVALUATION.md}`、`docs/troubleshooting.md`
- Modify: `demos/02-agent/docs/how-agent-works.html`

**Interfaces:**
- Consumes: Task 1–13 的全部产物
- Produces: 五份文档

- [ ] **Step 1: 写 `README.md`**

头部必须是 `> 回答：这个项目怎么跑起来？`（与根 `AGENTS.md` 的职责表一致）。至少覆盖：

- 项目定位（阶段二 · Tool Calling · 前后端分离）
- 环境要求（Node ≥ 22、pnpm）
- **目录结构说明**：阶段根只有编排脚本与文档，两个应用在 `apps/` 下
- 环境变量表：`DEEPSEEK_API_KEY`（必需）/ `DEEPSEEK_BASE_URL` / `AI_CHAT_MODEL` /
  `AI_AGENT_PORT`（默认 3000）/ `AI_AGENT_HOST`（默认 127.0.0.1）
- 命令（**在阶段根执行**）：
  ```bash
  pnpm install         # 一次装完两个应用
  pnpm start           # 起服务端（:3000）
  pnpm -F web dev      # 起前端 dev server（:5173，/api 反代到 :3000）
  pnpm dev             # 并行起两个
  pnpm test            # 服务端测试
  pnpm run typecheck   # 两个应用都跑 tsc --noEmit
  pnpm -F web build    # 前端构建产物 → apps/web/dist
  ```
- 当前范围 / 尚未实现（照 `EVALUATION.md` 的未做清单列，**不要另写一份**）

- [ ] **Step 2: 写 `ARCHITECTURE.md`**

头部 `> 回答：这个系统由什么组成，一轮请求实际跑过了哪些步骤？`。至少覆盖：

- 分成图与依赖方向：`http → presentation → core → llm`、`tools → core`、`http → tools`
- 依赖规则表（允许 / 禁止），把 `express`、`node:fs`、`req`/`res`、`process.std*` 写进去
- **三条硬边界的依据**（谁在哪个文件里被强制、哪个测试钉住它）
- **一轮请求的完整数据流**：
  `POST /api/sessions/:id/messages` → `sessions.run`（串行锁）→ `runSessionTurn`
  → `client.chat(messages, {tools})` → 有 `tool_calls` → `registry.execute` → 回喂 → 收敛
  → `appendAll(added)` → `foldTranscript(turn.added)` → 200 JSON
- **`presentation` 这一层为什么存在** —— 它是本次改造的边界所在，
  说明「`Message` 是按模型需要组织的，展示项是按人的阅读顺序组织的」，
  以及实时路径与历史路径怎么共用同一个 `foldTranscript`
- `GET` 为什么**不加会话锁**
- 三个测试接缝各自长什么样

- [ ] **Step 3: 写 `DECISIONS.md`**

头部 `> 回答：为什么是这样设计的，放弃了什么？`。
**逐条抄 spec §17 的 D1–D21**，每条写：理由 / 放弃了什么 / 代价。不要只写结论。

- [ ] **Step 4: 写 `EVALUATION.md`**

头部 `> 回答：docs/ROADMAP.md 阶段的验收标准，现在达标到什么程度？`，并遵守本仓库的规矩：
**状态必须附证据，不接受「已完成」这类无证据的断言。**
「若某条验收项在路线里找不到落点，显式标出来」——这是这份文件最有价值的用途。

对上 ROADMAP 的**阶段 1**（本项目对应项）：

| 验收项 | 状态 | 证据 |
|---|---|---|
| 自己实现 Agent Loop | | `test/agent.test.ts` 的多步循环、`maxSteps` 恰好 N 次调用 |
| 自己定义 Tool | | `test/tools-registry.test.ts` 的三份 schema |
| 处理 Tool Result | | `test/agent.test.ts` 的回喂断言 |
| 实现基本任务循环 | | `test/http-app.test.ts` 的端到端天气轮 |
| 防止无限循环 | | `test/agent.test.ts` 的 `maxSteps` 用例 + `stopReason` |

再加一节 **「未做项与落点」**，逐条抄 spec §2 的「明确推迟」表。
**特别写清楚两件事**：① 会话只在服务端内存里，重启即丢；② 前端没有自动化测试。

- [ ] **Step 5: 写 `docs/troubleshooting.md`**

头部 `> 回答：遇到这个报错怎么定位和修？`。本次至少记这几条（每条都写
「问题 → 尝试 → 失败 → 原因 → 解决 → 经验」）：

- **服务端测试整个文件卡到超时** —— `server.close()` 被 undici 的 keep-alive 连接挂住；
  必须 `closeAllConnections()`
- **`import { Request } from 'express'` 运行时报「does not provide an export named」** ——
  只当类型用的导入没写 `import type`，而 `tsc --noEmit` 放行
- **`app.get('*')` 启动即抛「Missing parameter name」** —— express 5 的 path-to-regexp v8
  不再接受裸 `*`；404 兜底改用 `app.use`
- **不带 `Content-Type` 的 POST 返回 500 而不是 400** —— express 5 的 `req.body` 是 `undefined`
- **前端请求触发 CORS 报错** —— 多半是 `api.ts` 里写了绝对地址，绕过了 Vite proxy。
  正解不是加 `cors` 中间件
- 再把 01-llm 的三条**跨阶段通用**的坑复制过来：`@/` 别名与 loader、
  不用需要代码变换的 TS 特性、pnpm 的 `--` 不能带

- [ ] **Step 6: 改 `docs/how-agent-works.html`**

那份讲解页的「每个文件负责哪一步」表现在是按纯 CLI 写的。**逐行改成新结构**：

| 文件 | 负责什么 |
|---|---|
| `src/core/types.ts` | 定义 Message（含 tool 角色）、ToolCall、Tool |
| `src/core/tool-registry.ts` | ToolRegistry 接口：list() / execute() |
| `src/core/agent.ts` | runAgentTurn 循环：调 → 判断 → 执行 → 回喂，含 maxSteps |
| `src/core/session.ts` | 维护数组：append / appendMessage / appendAll / toMessages |
| `src/tools/*` | weather / get_time / calculator 的具体实现 |
| `src/llm/deepseek.ts` | 发 tools、解析 tool_calls / finish_reason |
| `src/http/app.ts` | 路由：把一轮请求交给 runSessionTurn，再把结果投影成 JSON |
| `src/presentation/transcript.ts` | 把 Message[] 折叠成展示项（实时与历史共用） |
| `apps/web/src/components/ToolTrace.tsx` | 把展示项渲染成工具轨迹气泡 |

并在「第一步」那张循环图下面补一句话：

> **Agent 只产出事实，界面的事归投影层。** `runAgentTurn` 返回的
> `final` / `added` / `stopReason` 里没有任何一个字段是为界面存在的；
> 「调了哪个工具、传了什么、成没成功」全部由 `presentation/transcript.ts`
> 从 `added` 推导出来。

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent
git commit -m "docs: 02-agent 的四件套、troubleshooting 与讲解页同步"
```

---

### Task 15: 端到端冒烟

**Files:** 无（只跑验证）

- [ ] **Step 1: 全量质量门**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm run typecheck
pnpm test
pnpm -F web build
```
Expected: 三条全绿。**把实际数字记下来**（通过用例数、构建产物大小）

- [ ] **Step 2: 确认密钥没被带进任何产物**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git status --short
git check-ignore -v demos/02-agent/apps/server/.env.local \
  demos/02-agent/apps/web/node_modules demos/02-agent/apps/web/dist
key=$(grep -h DEEPSEEK_API_KEY demos/02-agent/apps/server/.env.local | cut -d= -f2 | head -c 12)
grep -rn "$key" demos/02-agent/apps/server/src demos/02-agent/apps/web/src demos/02-agent/docs \
  2>/dev/null || echo "源码与文档里没有密钥"
```
Expected: `.env.local` / `node_modules` / `dist` 都被忽略；源码里搜不到密钥前缀

- [ ] **Step 3: 服务端 + 接口冒烟（真实 API）**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm start &
sleep 1
id=$(curl -sX POST localhost:3000/api/sessions | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
echo "=== 问天气 ==="
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"北京今天天气怎么样？"}'
echo
echo "=== 问算术（验证第二个工具） ==="
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"1+2*3 等于几"}'
echo
echo "=== 取历史 ==="
curl -s "localhost:3000/api/sessions/$id/messages"
kill %1
```
Expected: 每条响应里都能看到对应的工具轨迹；历史返回的 items 覆盖全部轮次

- [ ] **Step 4: 浏览器端到端**

```bash
pnpm start            # 终端 A
pnpm -F web dev       # 终端 B
```

逐条确认并**记录实际结果**：

1. http://localhost:5173 问「北京今天天气怎么样？」→ 先出现 `⚙ weather` 轨迹块，再出现回答
2. 问「1+2*3 等于几」→ 看到 `calculator` 轨迹
3. 问「现在几点」→ 看到 `get_time` 轨迹
4. 刷新页面 → 历史完整（三种气泡都在）
5. 连刷三次页面 → 服务端会话数不增长
6. 杀掉服务端 → 刷新页面出现「会话已失效」提示而不是白屏；再发消息能自动新建会话
7. 等待回答期间输入框是禁用的

- [ ] **Step 5: 如实报告**

按根 `AGENTS.md` 的格式给出：

```text
TypeCheck: PASS / FAIL / N/A
Lint:      N/A（本仓库未配置 linter）
Test:      PASS / FAIL / N/A
Build:     N/A（服务端 noEmit）／前端 vite build PASS
```

任何一条没达标就**照实写出来**，不要用「应该没问题」代替。

---

## 完成标准

- `pnpm run typecheck` 通过（两个应用）
- `pnpm test` 全绿
- `pnpm -F web build` 成功
- 浏览器跑通天气例子，且**工具轨迹可见**
- 五份文档（README / ARCHITECTURE / DECISIONS / EVALUATION / troubleshooting）与代码一致

**明确不达标的两项，报告时必须如实写出，不能用「测试全绿」掩盖：**

1. **前端没有自动化测试。** `apps/web/src/chatReducer.ts` 是纯函数、本来最容易测，
   但本次不引 vitest（spec D14）。它被拆成纯模块是**为了让将来补测试不必重构**，
   不是为了现在有覆盖。前端目前唯一的验证是 Task 13 Step 6 与 Task 15 Step 4 的手动冒烟。
2. **会话只在服务端内存里，重启即丢。** HTTP 的 `Session` 没有任何持久化，
   服务端一重启，浏览器 `localStorage` 里的 id 就失效（会走「会话已失效」的降级分支）。
   这是 spec D3 的有意取舍，但半年后回看时不能误以为「刷新不丢」等于「持久化」。


