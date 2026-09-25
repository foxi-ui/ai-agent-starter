# L1 · 骨架与类型契约 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**这是渐进步骤的第 1 步（共 6 步）。** 顺序与判据见 [`README.md`](./README.md)。

**Goal:** 在 `demos/02-agent/` 建起 pnpm monorepo 骨架，并把从 01-llm 复制的类型底座改造成本项目要的形状 —— `Message` 变成**可辨识联合**，`Session` 退回**纯类**，`LLMClient` 收窄成**单方法**。

**这一步学到什么：** `Message` 是**发给 API 的线格式**，不是随便一个数据结构。四种角色的字段并不相同（assistant 可能只有调用单没有正文、tool 必须说明在回应哪张单子），所以它必须是可辨识联合 —— 写成扁平 interface 用可选字段糊过去，「assistant 忘了带 `tool_calls`」这类 bug 会一路溜到运行时才暴露。

**Architecture:** 这一步只动 `core/` 与 `llm/` 的类型与状态，不碰网络、不碰 HTTP。`Session` 去掉了所有非必要的可变面（变更广播、`clear()`、`set model`），退回成一个无副作用的纯类 —— 这正是它最好测试的形态。

**Tech Stack:** Node 22（原生 TS 类型擦除，服务端无构建步骤）、pnpm workspace、`node --test`。

**Spec:** `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 §4（目录结构）、§5（类型契约）、§7（会话状态）、D1 / D6

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

  **⚠️ 例外：L1 与 L2 期间它们是红的**（即 Task 1–4）。原因：`llm/deepseek.ts` 是从 01-llm
  原样复制过来的，它 `import { parseSse } from '@/llm/sse.ts'` 是**值导入**，而 `sse.ts`
  按设计不复制 —— 它要到 **L3** 才被重写。所以在此之前：
  - **各 Task 自己的单文件测试是绿的**（`node --import ./loader.mjs --test test/<name>.test.ts`）
  - **全量 `pnpm test` 与 `pnpm run typecheck` 是红的**，红的是 deepseek 那一条链

  这是「复制起点后逐步改造」的必然中间态，**不是可以顺手修掉的东西** ——
  提前修它等于把 L3 的工作提前做掉。**L3 一结束就该全绿。**

## 起点状态（已实测 2026-09-25）

```text
工作目录       demos/02-agent/ —— 只有 docs/，无 package.json、无源码
               → 本步 Task 1 建 monorepo
基线仓库       demos/01-llm/    M1–M3 完成态，实测 167 个用例全绿（duration 1273ms）
复制来源       01-llm 的 4 个文件：core/types.ts、core/session.ts、llm/client.ts、llm/deepseek.ts
Node           v22.23.2
pnpm           10.34.5
git 分支       main（无 remote，直接在 main 上提交）
```

---

### Task 1: monorepo 骨架 + 复制起点

建 pnpm workspace，复制 01-llm 的**两个测试文件**作为起点。
这一 Task 结束时 `pnpm test` 应该是**红的**，但红的范围比想象中小得多 ——
具体是什么、为什么，见 Step 6（**已实测，不要照直觉猜**）。

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
    "dev": "pnpm --parallel --filter \"./apps/*\" dev",
    "test": "pnpm --filter server test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

阶段根**不放源码也不放依赖**：它只是编排。这条对应 spec §4 的目录结构说明与 D21。

**`dev` 的 filter 必须写 `"./apps/*"`，不能写 `"./*"`** —— 实测（pnpm 10.34.5）：
`--filter "./*"` 输出 `No projects matched the filters`，它匹配的是**根包自身**而非 workspace 子包；
`"./apps/*"` 才能匹配到两个应用。写错的后果是 `pnpm dev` 静默什么都不启动，
而 spec §15 要求的「一条命令并行起服务端 + 前端」因此失效。

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
`examples/`、`.sessions/`，也不要复制其余 9 个测试文件 —— 它们测的都是本项目已砍掉的东西（spec D2 / D3 / D5）。
复制范围**严格限定为这 4 个源文件 + 2 个测试文件**（spec D1）。

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

**三个脚本都必须带 `--import ./loader.mjs`**（`src/main.ts` 这一步还不存在，先放着 —— L5 才建）。

- [ ] **Step 4: 写 `apps/server/.gitignore`**

```gitignore
.env.local
```

（仓库根的 `.gitignore` 已覆盖 `.env.local`，这里只是让子项目单独取出时也自包含。
`.sessions/` 本项目不存在，不写。）

- [ ] **Step 5: 安装**

Run: `cd demos/02-agent && pnpm install`
Expected: 成功；`node_modules/` 出现（workspace 根一份 + `apps/server` 的软链），`pnpm-lock.yaml` 生成

- [ ] **Step 6: 跑测试，确认失败清单**

Run: `cd demos/02-agent && pnpm test`
Expected: **红**。但**只有 `test/deepseek.test.ts` 死**，`test/session.test.ts` 是 **12/12 全过**。

**这与直觉相反，值得理解**（下面两条都已在 01-llm 上实测确认）：

1. `session.ts` 里的 `import type { SessionChange } from '@/core/journal.ts'` 是 **type-only** ——
   原生类型擦除会整条删掉它，运行时根本不加载 `journal.ts`，所以复制过来照样能跑。
2. `deepseek.ts` 里的 `import { parseSse } from '@/llm/sse.ts'` 是**值导入** ——
   擦除阶段看不出它没被用到，于是运行时真的去加载不存在的 `sse.ts`，
   `test/deepseek.test.ts` 在**加载期**就死：`ENOENT ... src/llm/sse.ts`。

所以「失败清单会枚举出后续要改的东西」**并不成立** —— deepseek 那个文件在加载期就死了，
一条用例都没跑到。**这是预期起点，不要在这里修任何东西。**

顺带记住：同一次复制在 `tsc --noEmit` 下会报 **3 条 TS2307**
（`src/core/session.ts`、`test/session.test.ts`、`src/llm/deepseek.ts` 各一条）。
其中前两条在 Task 2 就被修掉，**第三条要留到 L3 重写 `deepseek.ts` 时才消失** ——
这就是 Global Constraints 里那个例外的由来。

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
- Produces: `Role`（4 值）；`ToolCall`；`Tool`；`ToolResult`；`Message`（可辨识联合）；
  `ChatResult`（含 `tool_calls` / `finish_reason`）；`ChatOptions.tools`；
  `LLMClient.chat()`；`Session`（`model` / `append` / `appendMessage` / `appendAll` / `toMessages` / `history`）

- [ ] **Step 1: 改 `src/core/types.ts`**

`Role` 替换为（spec §5）：

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

在 `FinishReason` 之后新增三个类型（spec §5）：

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

**删除 `StreamEvent`** 及其上方的注释块（整块删，spec D5）。

- [ ] **Step 2: 改 `src/llm/client.ts`**

整个文件替换为：

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

**删除 `LLMClientFactory`** —— 01-llm 里它从未被使用过，是纯文档型导出（spec §5）。
**删除所有与 `chatStream` / `StreamEvent` 有关的签名与注释。**

- [ ] **Step 3: 改 `src/core/session.ts`**

整个文件替换为：

```ts
// 会话状态：按顺序累积对话消息。
//
// 只负责「记住说过什么」，不碰网络、不负责打印、也不落盘。
//
// 相对 01-llm 的版本，这里**不复制三样**（见 spec D6）：
//   - `onChange` 变更广播：它的唯一用途是落盘，而本项目不做持久化（D3）
//   - `clear()`：唯一调用方是 `/clear` 命令，而本项目不做 CLI（D2）
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

复制过来的文件有 12 个用例。**逐条删除下列 8 条**（它们测的都是本项目删掉的能力）：

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
  // 深拷贝若退化成 {...m}，这一条会红
  const session = new Session('m');
  session.appendMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
  });

  const snapshot = session.history();
  const first = snapshot[0]!;
  if (first.role === 'assistant' && first.tool_calls) {
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

**注意**：此时 `test/deepseek.test.ts` 仍然红 —— 它要等 **L3**。
**不要**在这一步动它（原因见本文件 Global Constraints 的例外说明）。

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/core/types.ts demos/02-agent/apps/server/src/core/session.ts \
        demos/02-agent/apps/server/src/llm/client.ts demos/02-agent/apps/server/test/session.test.ts
git commit -m "feat(server): Message 改为可辨识联合，Session 退回纯类，LLMClient 收窄成单方法"
```

---

## L1 的验证：你这一步看见了什么

1. **跑单文件测试**，确认绿：

   ```bash
   cd demos/02-agent/apps/server
   node --import ./loader.mjs --test test/session.test.ts
   ```
   Expected: `# pass 9`

2. **亲眼看见类型防线起作用** —— 把 `session.append('assistant', 'x')` 那行的
   `@ts-expect-error` 注释删掉，再跑 `pnpm run typecheck`。
   Expected: 报 `Argument of type '"assistant"' is not assignable to parameter of type '"system" | "user"'`。
   看完把 `@ts-expect-error` 加回去。**这就是「assistant 消息丢掉 `tool_calls`」在本项目里
   根本写不出来的原因** —— 它不是一个约定，是一条编译错误。

3. **接受一条已知的红**：`pnpm test` 与 `pnpm run typecheck` 此刻仍然是红的，
   红的只有 `src/llm/deepseek.ts` 那一条链（它 import 的 `sse.ts` 没复制过来）。
   它要到 **L3** 才被重写。不要去修它。

**下一步** → [`l2-tools-and-slice.md`](./2026-09-25-l2-tools-and-slice.md)：在这一堆类型上，
把「工具」这一层建起来，并且**不接模型**就把它整条走通一遍。
