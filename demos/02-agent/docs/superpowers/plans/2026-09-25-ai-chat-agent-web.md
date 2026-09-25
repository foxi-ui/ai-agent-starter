# ai-chat-agent 前后端分离改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把纯 CLI 的 Agent 项目改造成「CLI + HTTP 服务 + 浏览器聊天对话框」三段，两个入口共用同一个 Agent 循环，对话框能看到工具调用轨迹。

**Architecture:** 复制 01-llm 的 M3 底座后，`core/` 新增 Agent 循环与展示投影，`tools/` 新增三个无状态工具，`server/` 用 express 暴露 REST 接口，`web/` 是独立的 React + Vite 项目。CLI 与 HTTP 都调 `core/agent.ts` 的 `runSessionTurn`；分层约束是 `cli → core`、`server → core`、`tools → core`，且 `server` 与 `cli` 互不导入。

**Tech Stack:** Node 22（原生 TS 类型擦除，服务端无构建步骤）、pnpm、`node --test`、express 5；前端 `web/` 独立一套 React 19 + Vite 8 工具链。

**Spec:** `demos/02-agent/docs/superpowers/specs/2026-09-25-ai-chat-agent-web-design.md`（本计划实现其全部内容）

## Global Constraints

以下约束对**每一个** Task 都生效。数值与措辞抄自 spec 与根 `AGENTS.md`。

- **Node ≥ 22**（本项目在 v22.23.2 验证），依赖原生类型擦除直接运行 `.ts`，服务端**不引入构建步骤**
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。
  判断标准：删掉所有类型标注后仍是合法 JS 的，才能用
- **只当类型用的导入必须写 `import type`**，否则擦除阶段无法识别，运行时抛
  「does not provide an export named …」而 `tsc --noEmit` 放行
- **核心层零运行时依赖**：`core/` / `llm/` / `tools/` 不 import 任何第三方包
- **`server/` 层允许运行时依赖且必须登记**：当前唯一一条是 `express`（配套 `@types/express`）
- **分层单向依赖**：`cli → core → llm`、`server → core → llm`、`tools → core`；
  `core` **不 import `tools`**；`server` 与 `cli` **互不导入**
- `llm` / `core` 不 import `node:readline` / `node:fs` / `express`，
  **不写** `process.stdout` / `process.stderr`
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**；
  `start` / `start:server` / `test` **三个脚本都要带**
- ESM（`"type": "module"`）；包管理器 pnpm
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（裸 `node --test` 会匹配到它，静默撑大用例数）
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿

## 起点状态（已实测）

```text
工作目录       demos/02-agent/（当前只有 docs/，无 package.json、无 src/、无 test/）
基线仓库       demos/01-llm/   M1–M3 完成态，167 个测试用例全绿
Node           v22.23.2
pnpm           10.34.5
express        5.2.1（本次要装的运行时依赖）
@types/express 5.0.6
react          19.3.0 / vite 8.3.1（前端，独立安装）
git 分支       main（无 remote，直接在 main 上提交）
工作区         干净
```

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。**每一条都在下面指名的 Task 里有对应测试** —— 写测试时不要漏。

1. **老 `.jsonl` 会话文件的读取** —— 01-llm 已经写下的 3 个真实会话文件用的旧格式，
   `--resume` 必须仍能完整恢复。测试落点：Task 4 Step 1。
2. **`finish_reason: 'stop'` 但响应里带 `tool_calls`** —— 部分 OpenAI 兼容实现会这样返回；
   若循环条件看 `finish_reason` 就会漏调工具、把 `content: null` 当答案回给用户。
   测试落点：Task 7 Step 1 的 `stop` + `tool_calls` 用例。
3. **请求体不带 `Content-Type: application/json`** —— express 5 下 `req.body` 是 `undefined`，
   直接取 `.message` 会抛 `TypeError` 变成 500。期望行为是 400。测试落点：Task 12 Step 1。
4. **上游返回 401** —— 那是「我们的 key 配错了」，不是「浏览器用户没登录」。
   期望行为是响应 502，状态码不透出。测试落点：Task 11 Step 1。
5. **同一会话并发两个请求** —— 期望串行（`A…A…B…B`）而不是交错（`A B A B`）；
   交错会让 `toMessages()` 里出现没有 `tool` 回应的 `assistant{tool_calls}`，上游报 400 且错因完全不指向并发。
   测试落点：Task 9 Step 1。

---

### Task 1: 底座复制 + 工具链

从 01-llm 复制 M3 完成态底座，**不改编任何业务逻辑**。这一 Task 的唯一目的是让「复制无损」这件事可验证。

**Files:**
- Create: `demos/02-agent/package.json`、`tsconfig.json`、`loader.mjs`、`loader-hooks.mjs`、`.env`、`.env.local`、`.gitignore`
- Create: `demos/02-agent/src/**`（从 01-llm 复制）、`demos/02-agent/test/**`（从 01-llm 复制 11 个）
- Test: 复制来的 11 个 `*.test.ts`

**Interfaces:**
- Consumes: 无（这是起点）
- Produces: 一个能 `pnpm run typecheck` 通过、`pnpm test` **167/167** 通过的项目骨架；
  后续所有 Task 在这个骨架上做增量

- [ ] **Step 1: 复制文件**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
SRC=demos/01-llm
DST=demos/02-agent

# 工具链与配置
cp "$SRC/tsconfig.json" "$SRC/loader.mjs" "$SRC/loader-hooks.mjs" "$DST/"
cp "$SRC/.env" "$SRC/.env.local" "$DST/"

# 源码（保持目录结构）
mkdir -p "$DST/src/cli" "$DST/src/core" "$DST/src/llm"
cp "$SRC/src/index.ts"                                    "$DST/src/"
cp "$SRC/src/cli/config.ts" "$SRC/src/cli/args.ts" "$SRC/src/cli/store.ts" \
   "$SRC/src/cli/render.ts" "$SRC/src/cli/repl.ts"        "$DST/src/cli/"
cp "$SRC/src/core/types.ts" "$SRC/src/core/session.ts" \
   "$SRC/src/core/journal.ts" "$SRC/src/core/commands.ts" "$DST/src/core/"
cp "$SRC/src/llm/client.ts" "$SRC/src/llm/deepseek.ts" \
   "$SRC/src/llm/sse.ts"                                  "$DST/src/llm/"

# 测试（11 个）
mkdir -p "$DST/test"
cp "$SRC"/test/*.test.ts "$DST/test/"
```

**不要复制** `$SRC/.sessions/`（那是 01-llm 的运行时产物）、`$SRC/examples/`、`$SRC/pnpm-lock.yaml`。

- [ ] **Step 2: 改 package.json 的 name**

复制过来后，把 `"name": "ai-chat"` 改成 `"name": "ai-chat-agent"`。其余字段（`scripts`、`devDependencies`）**一个字都不要改**。

- [ ] **Step 3: 写 .gitignore**

```gitignore
# 会话日志：运行时产物，不该进仓库
.sessions/

# 前端：独立项目的依赖与构建产物
web/node_modules/
web/dist/
```

- [ ] **Step 4: 安装依赖**

Run: `cd demos/02-agent && pnpm install`
Expected: 成功，`node_modules/` 出现，`pnpm-lock.yaml` 生成

- [ ] **Step 5: 类型检查**

Run: `cd demos/02-agent && pnpm run typecheck`
Expected: 退出码 0，无输出

- [ ] **Step 6: 全量测试 —— 必须复现 167/167**

Run: `cd demos/02-agent && pnpm test`
Expected: `# pass 167` / `# fail 0`

**这是整个计划唯一一次能证明「复制无损」的机会。** 数字对不上就先解决再往下走 ——
少了说明文件没复制全，多了说明 `test/` 下混进了非 `*.test.ts` 的文件。

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent
git commit -m "chore: 复制 01-llm 的 M3 底座作为阶段二起点（167 用例无损）"
```

---

### Task 2: 类型契约——纯加法

给 `core/types.ts` 加工具相关的类型，**先不动 `Message`**。分两步是为了让「加字段是否破坏了既有消费方」在测试里暴露出来，而不是被联合类型的连锁改动淹没。

**Files:**
- Modify: `demos/02-agent/src/core/types.ts`

**Interfaces:**
- Consumes: Task 1 的骨架
- Produces: `ToolCall` / `Tool` / `ToolResult` / `FinishReason`（已有）/ `ChatResult.tool_calls` / `ChatOptions.tools`；
  这些名字被 Task 3、5、6、7 消费

- [ ] **Step 1: 修改 `Role` 与新增工具类型**

把 `src/core/types.ts` 的 `Role` 定义替换为：

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

在 `FinishReason` 之后、`StreamEvent` 之前插入：

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
 * 模型靠它决定「要不要调、调哪个、传什么参」。`parameters` 是 JSON Schema
 * 的最小子集：够用就好，MCP 阶段再扩。
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

- [ ] **Step 2: 扩展 `ChatResult` 与 `ChatOptions`**

`ChatResult` 替换为：

```ts
/**
 * `LLMClient.chat()` 的返回值。
 *
 * `content` 在工具调用轮次里可以是 `null` —— 模型那一轮没说话，只开了调用单。
 * 所以调用方**不能**假设它一定有正文。
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

- [ ] **Step 3: 类型检查**

Run: `cd demos/02-agent && pnpm run typecheck`
Expected: **FAIL** —— `ChatResult` 现在要求 `finish_reason`，而 `llm/deepseek.ts` 的
`chat()` 只返回 `{content}`；`cli/repl.ts` 的 fake client 也一样。

这正是这一步的意义：先让它红，看清有多少消费方。

- [ ] **Step 4: 把消费方改成最小可用**

给 `src/llm/deepseek.ts` 的 `chat()` 返回补上 `finish_reason`（本步先恒为 `'stop'`，
真正的解析在 Task 5）：

```ts
return { content, finish_reason: 'stop' };
```

同时补 `test/deepseek.test.ts`、`test/repl.test.ts` 里所有手写的 fake client 返回值 ——
把 `{ content: next() }` 改成 `{ content: next(), finish_reason: 'stop' }`。
用 `grep -n "content:" test/deepseek.test.ts test/repl.test.ts` 找齐，**数量以 grep 结果为准，不要凭印象**。

- [ ] **Step 5: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试仍 **167/167**

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/core/types.ts demos/02-agent/src/llm/deepseek.ts \
        demos/02-agent/test/deepseek.test.ts demos/02-agent/test/repl.test.ts
git commit -m "feat: 补工具调用相关类型（ToolCall / Tool / ToolResult），暂不动 Message"
```

---

### Task 3: `Message` 联合迁移（含日志格式升级）

本次对既有契约的唯一硬改动。`Message` 从扁平结构变成可辨识联合，连带 `Session`、`journal`、`render` 与 `repl` 都要跟上 —— `src/` 与 `test/` 同属一个 tsconfig，所以必须在同一个 Task 里改完。

**Files:**
- Modify: `demos/02-agent/src/core/types.ts`（`Message`）
- Modify: `demos/02-agent/src/core/journal.ts`（`MessageRecord` / `toRecord` / `toMessage` / `parseRecord` / `replay`）
- Modify: `demos/02-agent/src/core/session.ts`（`append` 收窄 / `appendMessage` / `appendAll` / `history` 深拷贝）
- Modify: `demos/02-agent/src/cli/render.ts`（`describeMessage` 处理 null 与 tool 行）
- Modify: `demos/02-agent/src/cli/repl.ts`（**最小改动**：`append('assistant', …)` 改走 `appendMessage`；完整改造在 Task 8）
- Test: `demos/02-agent/test/journal.test.ts`、`test/session.test.ts`、`test/render.test.ts`、`test/repl.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ToolCall` / `ToolResult`
- Produces: `Message` 联合；`MessageRecord`；`toRecord(message: Message): MessageRecord`；
  `toMessage(record: MessageRecord): Message`；`Session.append(role: 'system'|'user', content: string)`；
  `Session.appendMessage(message: Message): void`；`Session.appendAll(messages: Message[]): void`；
  `Session.history(): Message[]`（深拷贝）；`describeMessage(message: Message): string`

- [ ] **Step 1: 写失败测试（journal 的老格式兼容）**

在 `test/journal.test.ts` 末尾追加。这几条是 **Review Focus 第 1 条**的落点：

```ts
test('老格式的 message 行仍能解析（M3 写下的 .jsonl 必须可读）', () => {
  const line = '{"type":"message","role":"assistant","content":"你好"}';
  assert.deepStrictEqual(parseRecord(line), {
    type: 'message',
    role: 'assistant',
    content: '你好',
  });
});

test('老格式的行序列化后与原文字节一致（不引入 undefined 键）', () => {
  const line = '{"type":"message","role":"user","content":"北京"}';
  const record = parseRecord(line);
  assert.ok(record);
  assert.strictEqual(serializeRecord(record), line);
});

test('tool 角色的记录缺 tool_call_id 时判为坏行', () => {
  const line = '{"type":"message","role":"tool","content":"25°C"}';
  assert.strictEqual(parseRecord(line), null);
});

test('assistant 的 tool_calls 里有一项非法时整条判为坏行', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather' } }],
  });
  assert.strictEqual(parseRecord(line), null);
});

test('带 tool_calls 的 assistant 与随后的 tool 行能往返', () => {
  const record = {
    type: 'message' as const,
    role: 'assistant' as const,
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function' as const, function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
    ],
  };
  const roundTripped = parseRecord(serializeRecord(record));
  assert.deepStrictEqual(roundTripped, record);
});

test('replay 重建出工具轨迹，且不含日志的 type 键', () => {
  const records = [
    { type: 'meta' as const, id: '20260101-000000-aaaa', createdAt: '2026-01-01T00:00:00.000Z', model: 'm' },
    { type: 'message' as const, role: 'user' as const, content: '北京天气' },
    {
      type: 'message' as const,
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function' as const, function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    { type: 'message' as const, role: 'tool' as const, content: '25°C, Sunny', tool_call_id: 'c1' },
    { type: 'message' as const, role: 'assistant' as const, content: '北京今天 25°C，晴天。' },
  ];

  const { messages } = replay(records);

  assert.strictEqual(messages.length, 4);
  assert.deepStrictEqual(messages[2], { role: 'tool', content: '25°C, Sunny', tool_call_id: 'c1' });
  // 关键：重建出的 Message 上**不能**有日志才有的 `type` 键
  assert.ok(!('type' in messages[1]!));
  assert.deepStrictEqual(messages[1], {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
    ],
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/journal.test.ts`
Expected: FAIL —— `tool` 角色的行现在被判为坏行、`tool_calls` 被丢弃，至少 3 条用例红

- [ ] **Step 3: 改 `types.ts` 的 `Message`**

```ts
/**
 * 一条对话消息，也是发给 API 的最小单位。
 *
 * 它是**可辨识联合**而不是扁平结构：三种角色的字段并不相同 ——
 * assistant 可能只开调用单没有说话（`content` 为 `null`），
 * tool 必须说明自己在回应哪一张调用单（`tool_call_id`）。
 * 写成扁平 interface 用可选字段糊过去，会让「assistant 忘了带 tool_calls」
 * 这类 bug 一路溜到运行时才发现。
 */
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
```

- [ ] **Step 4: 改 `journal.ts`**

把 `SessionChange` 替换为下面两个类型 + 两个转换函数：

```ts
/**
 * 日志里的一条消息记录。
 *
 * 三种角色写成三种形状，而不是**嵌套**成一个 `{type:'message', message}`：
 * 嵌套会让 M3 已经写下的老行（`{"type":"message","role":"user","content":"…"}`）
 * 全部失效。现在老行在新格式下**完全合法**，字节级往返一致，
 * 所以既不需要版本号，也不需要考虑迁移。
 */
export type MessageRecord =
  | { type: 'message'; role: 'system' | 'user'; content: string }
  | { type: 'message'; role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { type: 'message'; role: 'tool'; content: string; tool_call_id: string };

export type SessionChange =
  | MessageRecord
  | { type: 'clear' }
  | { type: 'model'; model: string };
```

`Message` 与 `MessageRecord` 的互转放在这里 —— 日志格式只在这一个文件里定义：

```ts
/**
 * `Message` → 日志记录。
 *
 * `tool_calls` **存在时才设键**：写成 `tool_calls: message.tool_calls`
 * 会给普通 assistant 消息加一个值为 `undefined` 的自有属性，
 * 而 `assert.deepStrictEqual` 是比较自有键的 —— 老行的往返一致性测试
 * 会因为一个看不见的键变红，看起来像格式不兼容，把人引向错误的修复方向。
 */
export function toRecord(message: Message): MessageRecord {
  if (message.role === 'assistant') {
    const record: MessageRecord = { type: 'message', role: 'assistant', content: message.content };
    if (message.tool_calls) {
      (record as { tool_calls?: ToolCall[] }).tool_calls = message.tool_calls;
    }
    return record;
  }
  if (message.role === 'tool') {
    return { type: 'message', role: 'tool', content: message.content, tool_call_id: message.tool_call_id };
  }
  return { type: 'message', role: message.role, content: message.content };
}

/**
 * 日志记录 → `Message`。**显式构造，不要 spread** ——
 * record 上带着日志才有的 `type: 'message'` 键，spread 进 Message
 * 会多出一个不属于它的字段，再发给 API 就成了未知字段。
 */
export function toMessage(record: MessageRecord): Message {
  if (record.role === 'assistant') {
    const message: Message = { role: 'assistant', content: record.content };
    if (record.tool_calls) {
      (message as { tool_calls?: ToolCall[] }).tool_calls = record.tool_calls;
    }
    return message;
  }
  if (record.role === 'tool') {
    return { role: 'tool', content: record.content, tool_call_id: record.tool_call_id };
  }
  return { role: record.role, content: record.content };
}
```

`parseRecord` 的 `case 'message'` 与 `case 'clear'` 之间插入两个新分支（注意 `case 'message'` 现在要按 role 分派）：

```ts
    case 'message': {
      const role = record.role;

      if (role === 'system' || role === 'user') {
        if (typeof record.content !== 'string') return null;
        return { type: 'message', role, content: record.content };
      }

      if (role === 'assistant') {
        // content 允许 null —— 工具调用轮次里模型没有说话
        if (record.content !== null && typeof record.content !== 'string') return null;
        const base = { type: 'message' as const, role, content: record.content };
        if (record.tool_calls === undefined) return base;
        const toolCalls = parseToolCalls(record.tool_calls);
        if (toolCalls === null) return null;
        return { ...base, tool_calls: toolCalls };
      }

      if (role === 'tool') {
        if (typeof record.content !== 'string' || typeof record.tool_call_id !== 'string') return null;
        return { type: 'message', role, content: record.content, tool_call_id: record.tool_call_id };
      }

      return null;
    }
```

`parseRecord` 之上加一个私有校验函数（**不导出**）：

```ts
/**
 * 校验 `tool_calls` 字段。合法则返回归一化后的数组，非法返回 null。
 *
 * 这里是「不相信 JSON 里的内容」的延续：模型或服务端给出缺 `id`、
 * 缺 `function.name` 的项时，绝不能放它进会话 —— 那会变成
 * `tool_call_id: undefined`，`JSON.stringify` 时键被丢掉，
 * 下一轮请求 400，而报错信息完全不指向真正的原因。
 */
function parseToolCalls(value: unknown): ToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const call = item as Record<string, unknown>;
    if (typeof call.id !== 'string') return null;
    if (typeof call.type !== 'string') return null;
    const fn = call.function;
    if (typeof fn !== 'object' || fn === null) return null;
    const fnRecord = fn as Record<string, unknown>;
    if (typeof fnRecord.name !== 'string' || typeof fnRecord.arguments !== 'string') return null;
    // type 归一化成 'function'：官方目前只有这一种，原样透出未知取值
    // 只会让下游多一层无意义的判断
    calls.push({
      id: call.id,
      type: 'function',
      function: { name: fnRecord.name, arguments: fnRecord.arguments },
    });
  }
  return calls;
}
```

`replay` 的 `case 'message'` 改为一行：

```ts
      case 'message':
        messages.push(toMessage(record));
        break;
```

顶部的 import 补 `ToolCall`：

```ts
import type { Message, Role, ToolCall } from '@/core/types.ts';
```

- [ ] **Step 5: 改 `session.ts`**

`append` 收窄、新增两个方法、`history` 深拷贝。把 `append` 替换为这三个方法：

```ts
  /**
   * 追加一条**用户或系统**消息。
   *
   * 参数只接受这两个角色是刻意的：assistant 消息可能带 `tool_calls`、
   * tool 消息必须带 `tool_call_id`，都不是 `(role, content)` 这种扁平签名
   * 写得出来的。收窄之后，「assistant 消息丢掉 tool_calls」这类 bug
   * **无法通过类型检查** —— 要写 assistant 只能走 appendMessage。
   */
  append(role: 'system' | 'user', content: string): void {
    this.appendMessage({ role, content });
  }

  /** 追加一条任意形状的消息（含 assistant{tool_calls} 与 tool） */
  appendMessage(message: Message): void {
    this.messages.push(message);
    // **先改内存、再广播**是刻意的顺序：广播的实现（写文件）抛错时，
    // 内存状态已经改好了，不会留下「推了一半」的中间态。
    // 磁盘落后于内存 + 一次警告，是选定的降级方向（见 cli/repl.ts）。
    this.onChange?.(toRecord(message));
  }

  /**
   * 批量追加。**只在整轮成功后调用一次**（见 core/agent.ts 的 runSessionTurn）——
   * 中途失败时一条都不该落进上下文，否则历史里会出现伪造的回答。
   */
  appendAll(messages: Message[]): void {
    for (const message of messages) this.appendMessage(message);
  }
```

`history()` 替换为：

```ts
  /**
   * 返回消息列表的**副本**，外部改不动内部状态。
   *
   * 必须是**深**拷贝：`tool_calls` 是数组、数组里还有 `function` 对象，
   * 只做 `{...m}` 的话，调用方一句
   * `h[0].tool_calls[0].function.name = 'x'` 就穿透改了会话状态。
   * （M1 时 Message 还是扁平结构，那时 `{...m}` 是完备的；
   * 加了嵌套字段之后它不再完备，这一行必须跟着升级。）
   */
  history(): Message[] {
    return this.messages.map(cloneMessage);
  }
```

文件末尾（类之外）加：

```ts
/**
 * 复制一条消息，含嵌套的 `tool_calls`。
 *
 * 写成独立函数而不是内联在 history() 里，是因为它同时被 toMessages()
 * 的调用方（若将来需要）复用 —— 更重要的是让「Message 有嵌套字段」
 * 这件事在类型层面看得见：将来再加嵌套字段，改这一处。
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

import 补 `toRecord`：

```ts
import { toRecord } from '@/core/journal.ts';
import type { SessionChange } from '@/core/journal.ts';
```

- [ ] **Step 6: 改 `render.ts` 的 `describeMessage`**

`renderCommandResult` 的 `history` 分支现在要处理三种消息。新增一个导出函数并在该分支调用它：

```ts
/**
 * 把一条消息压成 /history 用的一行文本。
 *
 * assistant 的 `content` 可能是 `null`（那一轮只开了调用单没有说话），
 * 直接 `truncate(message.content)` 会抛 `Cannot read properties of null` ——
 * 而 `/history` 是用户手敲才触发的冷路径，只有用过工具的长会话才会踩到。
 */
export function describeMessage(message: Message): string {
  switch (message.role) {
    case 'assistant': {
      const parts: string[] = [];
      const text = message.content;
      if (text !== null && text !== '') parts.push(truncate(text));
      if (message.tool_calls) {
        const names = message.tool_calls.map((call) => call.function.name).join(', ');
        parts.push(`[调用工具] ${names}`);
      }
      return parts.join(' ');
    }
    case 'tool':
      return `[工具结果] ${truncate(message.content)}`;
    default:
      return truncate(message.content);
  }
}
```

`renderCommandResult` 里原来那行 `truncate(message.content)` 换成 `describeMessage(message)`。
import 补 `Message` 类型。

- [ ] **Step 7: 改 `repl.ts` 的最小必要处**

`session.append('assistant', text)` 改为：

```ts
session.appendMessage({ role: 'assistant', content: text });
```

**只改这一处**。repl 的整体改造（注入 registry、走 runSessionTurn）在 Task 8。

- [ ] **Step 8: 补 session 与 render 的测试**

`test/session.test.ts` 追加（**Review Focus 第 1 条之外的第二处落点**）：

```ts
test('改 history() 返回值的 tool_calls 不影响会话状态', () => {
  const session = new Session('m');
  session.appendMessage({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } },
    ],
  });

  const snapshot = session.history();
  snapshot[0]!.role === 'assistant' &&
    snapshot[0]!.tool_calls![0]!.function.name === 'weather' &&
    (snapshot[0]!.tool_calls![0]!.function.name = 'tampered');

  const again = session.history();
  assert.strictEqual(again[0]!.role, 'assistant');
  assert.strictEqual(
    again[0]!.role === 'assistant' ? again[0]!.tool_calls![0]!.function.name : null,
    'weather',
  );
});

test('appendMessage 广播的是日志记录，且 tool_calls 存在时才带键', () => {
  const changes: SessionChange[] = [];
  const session = new Session('m', { onChange: (change) => changes.push(change) });

  session.appendMessage({ role: 'assistant', content: '你好' });
  session.appendMessage({ role: 'tool', content: '25°C', tool_call_id: 'c1' });

  assert.deepStrictEqual(changes[0], { type: 'message', role: 'assistant', content: '你好' });
  assert.ok(!('tool_calls' in (changes[0] as object)));
  assert.deepStrictEqual(changes[1], {
    type: 'message',
    role: 'tool',
    content: '25°C',
    tool_call_id: 'c1',
  });
});
```

`test/render.test.ts` 追加：

```ts
test('describeMessage 处理 assistant 的 content 为 null', () => {
  assert.strictEqual(
    describeMessage({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    }),
    '[调用工具] weather',
  );
});

test('describeMessage 渲染 tool 消息', () => {
  assert.strictEqual(
    describeMessage({ role: 'tool', content: '25°C, Sunny', tool_call_id: 'c1' }),
    '[工具结果] 25°C, Sunny',
  );
});
```

- [ ] **Step 9: 跑单文件测试**

Run:
```bash
cd demos/02-agent
node --import ./loader.mjs --test test/journal.test.ts
node --import ./loader.mjs --test test/session.test.ts
node --import ./loader.mjs --test test/render.test.ts
```
Expected: 三个文件全绿

- [ ] **Step 10: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿（用例数 = 167 + 本 Task 新增的 9 条）

- [ ] **Step 11: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src demos/02-agent/test
git commit -m "feat: Message 改为可辨识联合，会话日志格式同步升级（老文件向后兼容）"
```

---

### Task 4: LLM 层发送 tools、解析 tool_calls

只改 `llm/deepseek.ts` 的 `chat()` 方法。`chatStream()` 与 `llm/sse.ts` **一个字都不改** ——
它们本次无调用方，为后续流式里程碑保留。

**Files:**
- Modify: `demos/02-agent/src/llm/deepseek.ts`（只改 `chat()`）
- Test: `demos/02-agent/test/deepseek.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ToolCall` / `ChatOptions.tools` / `ChatResult`
- Produces: 一个会发送 `tools`、并正确解析 `tool_calls` 与 `finish_reason` 的 `chat()`

- [ ] **Step 1: 写失败测试**

在 `test/deepseek.test.ts` 末尾追加：

```ts
test('带 tools 时请求体按线上的包装层级发送（type/function 两层）', async () => {
  let body: Record<string, unknown> = {};
  globalThis.fetch = mockFetch(200, {
    choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
  }, (init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  });

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

  // 线上格式是 { type:'function', function:{ name, description, parameters } }，
  // 而内部那个 Tool 是扁平的。少包一层，上游会直接 400 说 tools 结构不对
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
  globalThis.fetch = mockFetch(200, {
    choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
  }, (init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  });

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
            { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
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

test('文本回答的 content 仍是字符串（回归）', async () => {
  globalThis.fetch = mockFetch(200, {
    choices: [{ message: { content: '闭包是…' }, finish_reason: 'stop' }],
  });

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.content, '闭包是…');
});
```

`mockFetch` 的签名本仓库已有，若当前版本不接受第三个回调参数，把它扩成
`mockFetch(status, body, onRequest?)`，在构造 `Response` 之前调用 `onRequest(init)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: FAIL —— `tools` 没被发送、`tool_calls` 没被解析

- [ ] **Step 3: 改 `chat()` 的请求体**

把 `chat()` 里的 `body:` 一行替换为：

```ts
        // 有工具才带 tools 字段。**空数组按「不带」处理** ——
        // 部分 OpenAI 兼容实现会对 `tools: []` 直接 400，
        // 而「传了一个空列表」与「这次不传工具」在语义上本来就是一回事。
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          ...(options?.tools && options.tools.length > 0
            ? { tools: toWireTools(options.tools) }
            : {}),
        }),
```

- [ ] **Step 4: 改 `chat()` 的响应解析**

把 `data` 的声明与 `content` 那几行替换为：

```ts
      // 响应形状大致是：
      // { choices: [ { message: { content, reasoning_content, tool_calls }, finish_reason } ] }
      // 这里故意只声明我们真正要用的字段
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
      const content = choice?.message?.content ?? null;
      const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);

      // finish_reason 缺失时按 stop（宽松：服务端新增取值时原样传出，不做白名单校验）
      const finish_reason = (choice?.finish_reason ?? 'stop') as FinishReason;

      return {
        content,
        finish_reason,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
```

模块内（`createDeepSeekClient` 之外）新增两个私有函数。第一个是**易漏的一层包装**：

```ts
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
 * 而报错信息里不会提到「少包了一层」。实施时对着 DeepSeek 官方文档再核一遍这个层级。
 */
function toWireTools(tools: Tool[]) {
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
 * 策略是**丢弃非法项、保留合法项**，与 journal.ts 的 parseToolCalls 不同 ——
 * 那边是「一条非法就整条记录判坏」（日志要么完整要么不可信），
 * 这边是「尽量用上模型给的东西」（丢一条总比整轮不调工具强）。
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
      // type 归一化为 'function'：官方目前只有这一种，原样透出未知取值
      // 只会让下游多一层无意义的判断
      type: 'function',
      function: { name: fnRecord.name, arguments: fnRecord.arguments },
    });
  }
  return calls;
}
```

import 补 `ToolCall`：

```ts
import type {
  ChatOptions,
  Message,
  ChatResult,
  FinishReason,
  StreamEvent,
  Tool,
  ToolCall,
} from '@/core/types.ts';
```

- [ ] **Step 5: 跑单文件测试**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: 全绿

- [ ] **Step 6: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/llm/deepseek.ts demos/02-agent/test/deepseek.test.ts
git commit -m "feat: llm 层发送 tools 声明并解析 tool_calls / finish_reason"
```

---

### Task 5: ToolRegistry 接口与三个工具

新增 `core/tool-registry.ts`（接口，第三个测试接缝）与 `tools/`（实现）。

**Files:**
- Create: `demos/02-agent/src/core/tool-registry.ts`
- Create: `demos/02-agent/src/tools/weather.ts`、`time.ts`、`calculator.ts`、`registry.ts`
- Test: `demos/02-agent/test/tools-weather.test.ts`、`test/tools-time.test.ts`、`test/tools-calculator.test.ts`、`test/tools-registry.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Tool` / `ToolResult`
- Produces: `ToolDefinition`；`ToolRegistry`（`list(): Tool[]` / `execute(name, args): Promise<ToolResult>`）；
  `createToolRegistry(): ToolRegistry`；`weatherTool` / `timeTool` / `calculatorTool`

- [ ] **Step 1: 写 `core/tool-registry.ts`（接口 + 定义形状）**

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

test('城市名大小写与空白不影响命中', async () => {
  const result = await weatherTool.run({ city: '  beijing  ' });
  assert.strictEqual(result.ok, true);
});

test('未收录的城市返回兜底值并注明是模拟数据', async () => {
  const result = await weatherTool.run({ city: 'Mars' });
  assert.strictEqual(result.ok, true);
  assert.ok(result.ok && typeof (result.value as { note?: string }).note === 'string');
});

test('缺 city 参数返回 {ok:false} 而不是抛错', async () => {
  const result = await weatherTool.run({});
  assert.strictEqual(result.ok, false);
});

test('city 不是字符串返回 {ok:false}', async () => {
  const result = await weatherTool.run({ city: 42 });
  assert.strictEqual(result.ok, false);
});

test('声明里的 name 与 registry 注册名一致', () => {
  assert.strictEqual(weatherTool.declaration.name, 'weather');
  assert.deepStrictEqual(weatherTool.declaration.parameters.required, ['city']);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/tools-weather.test.ts`
Expected: FAIL —— `Cannot find module '@/tools/weather.ts'`

- [ ] **Step 4: 写 `tools/weather.ts`**

```ts
// 查天气 —— **确定性 mock**，不联网、不需要 key。
//
// 阶段二的学习目标是 tool calling 这条链路本身（模型怎么开调用单、
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
  description: '查询某个城市今天的天气。需要知道城市名时使用。',
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

    const key = city.trim().toLowerCase();
    const hit = WEATHER_TABLE[key];

    if (!hit) {
      // 兜底也要**明说是模拟数据** —— 否则模型会把编出来的天气当事实转述给用户
      return {
        ok: true,
        value: { city: city.trim(), ...FALLBACK, note: '模拟数据：该城市不在内置表中' },
      };
    }

    return { ok: true, value: { city: city.trim(), ...hit } };
  },
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/tools-weather.test.ts`
Expected: 全绿

- [ ] **Step 6: 写 `tools/time.ts` 与它的测试**

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
  const result = await timeTool.run({ unexpected: 'ignored' });
  assert.strictEqual(result.ok, true);
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

test('四则运算与优先级', async () => {
  const result = await calculate('1 + 2 * 3');
  assert.deepStrictEqual(result, { ok: true, value: { expression: '1 + 2 * 3', result: 7 } });
});

test('括号改变优先级', async () => {
  const result = await calculate('(1 + 2) * 3');
  assert.ok(result.ok && (result.value as { result: number }).result === 9);
});

test('小数与一元负号', async () => {
  const first = await calculate('1.5 * 2');
  assert.ok(first.ok && (first.value as { result: number }).result === 3);
  const second = await calculate('-4 + 1');
  assert.ok(second.ok && (second.value as { result: number }).result === -3);
});

test('除零返回 {ok:false}，且错误文本包含表达式原文', async () => {
  const result = await calculate('1 / 0');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 / 0'));
});

test('字母被白名单拦下', async () => {
  const result = await calculate('alert(1)');
  assert.strictEqual(result.ok, false);
});

test('分号与反引号被白名单拦下', async () => {
  for (const expr of ['1; process.exit(1)', '`1`', '1 .toString()']) {
    const result = await calculate(expr);
    assert.strictEqual(result.ok, false, `应被拒绝：${expr}`);
  }
});

test('语法错误（括号不配对）返回 {ok:false}', async () => {
  const result = await calculate('(1 + 2');
  assert.strictEqual(result.ok, false);
});

test('缺 expression 参数返回 {ok:false}', async () => {
  const result = await calculatorTool.run({});
  assert.strictEqual(result.ok, false);
});
```

- [ ] **Step 8: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/tools-calculator.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 9: 写 `tools/calculator.ts`**

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
  // 失败原因单独存：递归下降的每个分支都返回 number | null，
  // 用一个外部变量记住「具体为什么失败」，比到处传错误对象干净
  let reason = '表达式语法错误';

  const peek = (): Token | undefined => tokens[pos];

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;

    while (true) {
      const token = peek();
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
      const token = peek();
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

- [ ] **Step 10: 跑测试确认通过**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/tools-calculator.test.ts test/tools-time.test.ts`
Expected: 全绿

- [ ] **Step 11: 写失败测试（registry）**

`test/tools-registry.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '@/tools/registry.ts';

test('list() 返回三份工具声明', () => {
  const registry = createToolRegistry();
  const names = registry.list().map((tool) => tool.name);
  assert.deepStrictEqual(names.sort(), ['calculator', 'get_time', 'weather']);
});

test('每份声明都有非空 description 与 object 类型的 parameters', () => {
  const registry = createToolRegistry();
  for (const tool of registry.list()) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺 description`);
    assert.strictEqual(tool.parameters.type, 'object');
  }
});

test('按名派发到对应工具', async () => {
  const registry = createToolRegistry();
  const result = await registry.execute('weather', { city: 'Beijing' });
  assert.strictEqual(result.ok, true);
});

test('未知名返回 {ok:false} 而不是抛错', async () => {
  const registry = createToolRegistry();
  const result = await registry.execute('no_such_tool', {});
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

- [ ] **Step 12: 写 `tools/registry.ts`**

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

- [ ] **Step 13: 跑测试确认通过**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/tools-registry.test.ts`
Expected: 全绿

- [ ] **Step 14: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 15: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/core/tool-registry.ts demos/02-agent/src/tools demos/02-agent/test/tools-*.test.ts
git commit -m "feat: 新增 ToolRegistry 接口与 weather / get_time / calculator 三个工具"
```

---

### Task 6: Agent 循环

本次的技术核心。`core/prompt.ts` 承载 `SYSTEM_PROMPT`（**必须从 `cli/repl.ts` 搬出来** ——
否则 `server/` 导入它会连带把 `node:readline` 拖进服务端进程），`core/agent.ts` 承载循环与编排。

**Files:**
- Create: `demos/02-agent/src/core/prompt.ts`
- Create: `demos/02-agent/src/core/agent.ts`
- Test: `demos/02-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ChatResult` / `Message` / `ToolCall` / `ToolResult`；Task 5 的 `ToolRegistry`
- Produces: `SYSTEM_PROMPT`；`ToolStep`；`AgentTurn`；`AgentOptions`；
  `runAgentTurn(client, registry, messages, options?): Promise<AgentTurn>`；
  `runSessionTurn(session, client, registry, question, options): Promise<AgentTurn>`

- [ ] **Step 1: 写 `core/prompt.ts`**

```ts
// 系统提示。**放在 core 而不是 cli** 是必须的：
// 服务端（server/）也要用它，而若从 cli/repl.ts 导入，
// 服务端进程就会连带加载 node:readline —— 能跑，但分层被悄悄破坏。

/**
 * 系统提示词。
 *
 * 每次请求都作为第一条消息重新带上，不存在 Session 里（见 core/session.ts）。
 * 末句「需要时可调用工具」是阶段二相对阶段一唯一的改动。
 */
export const SYSTEM_PROMPT = '你是 CLI AI 助手，简洁直接地回答问题。需要时可调用工具。';
```

- [ ] **Step 2: 写失败测试（agent）**

`test/agent.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn, runSessionTurn } from '@/core/agent.ts';
import { Session } from '@/core/session.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ChatOptions, ChatResult, Message } from '@/core/types.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { ToolResult } from '@/core/types.ts';

/** 按顺序吐出预设响应，并记录每次收到的 messages */
function fakeClient(results: ChatResult[]): { client: LLMClient; seen: Message[][] } {
  const seen: Message[][] = [];
  let index = 0;
  return {
    seen,
    client: {
      async chat(messages: Message[], _options?: ChatOptions): Promise<ChatResult> {
        seen.push(messages.map((message) => ({ ...message })));
        const result = results[index];
        index += 1;
        if (!result) throw new Error('fakeClient 的预设响应用完了');
        return result;
      },
      // eslint 不需要：本文件用不到流式，留一个空实现满足接口
      async *chatStream() {
        throw new Error('本测试不使用流式');
      },
    },
  };
}

function fakeRegistry(
  behavior: Record<string, () => ToolResult | Promise<ToolResult>>,
): ToolRegistry {
  return {
    list: () => [{ name: 'weather', description: 'x', parameters: { type: 'object', properties: {} } }],
    async execute(name: string, args: unknown): Promise<ToolResult> {
      const handler = behavior[name];
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
  assert.deepStrictEqual(turn.steps, []);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(turn.added.length, 1);
});

test('一轮工具后收敛：added 里有 assistant{tool_calls} + tool + 最终 assistant', async () => {
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
  assert.strictEqual(turn.added.length, 3);
  assert.deepStrictEqual(turn.added[0], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } }],
  });
  assert.deepStrictEqual(turn.added[1], {
    role: 'tool',
    tool_call_id: 'c1',
    content: '{"temperature":"25°C","condition":"Sunny"}',
  });
  assert.deepStrictEqual(turn.added[2], { role: 'assistant', content: '北京今天 25°C，晴天。' });

  assert.strictEqual(turn.steps.length, 1);
  assert.strictEqual(turn.steps[0]!.name, 'weather');
  assert.strictEqual(turn.steps[0]!.ok, true);
  assert.deepStrictEqual(turn.steps[0]!.args, { city: 'Beijing' });
  assert.strictEqual(turn.steps[0]!.argumentsText, '{"city":"Beijing"}');
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
  assert.strictEqual(turn.steps.length, 2);
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

  assert.strictEqual(turn.steps.length, 2);
  const toolMessages = turn.added.filter((message) => message.role === 'tool');
  assert.deepStrictEqual(toolMessages.map((m) => (m.role === 'tool' ? m.tool_call_id : '')), ['c1', 'c2']);
});

test('arguments 不是合法 JSON：错误文本回喂，不崩', async () => {
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
  assert.strictEqual(turn.steps[0]!.ok, false);
  assert.ok(turn.steps[0]!.parseError);
  assert.strictEqual(turn.steps[0]!.args, undefined);
  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('JSON'));
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

  assert.strictEqual(turn.steps[0]!.ok, false);
  assert.strictEqual(turn.steps[0]!.result, '上游超时');
  assert.strictEqual(turn.final.content, '工具挂了，我直接答。');
});

test('未知名工具：错误文本回喂', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'nope', '{}'),
    answer('好，我不用工具了。'),
  ]);

  const turn = await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(turn.steps[0]!.ok, false);
  assert.ok(turn.steps[0]!.result.includes('nope'));
});

test('finish_reason 是 stop 但带 tool_calls：仍要执行工具', async () => {
  // 有些 OpenAI 兼容实现会这样返回。若循环条件看 finish_reason，
  // 就会漏调工具、把 content: null 当成最终答案回给用户（前端显示空气泡）。
  const { client } = fakeClient([
    { content: null, finish_reason: 'stop', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
    ] },
    answer('北京今天 25°C，晴天。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '25°C, Sunny' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '北京天气' }]);

  assert.strictEqual(turn.steps.length, 1, '必须执行了工具');
  assert.strictEqual(turn.final.content, '北京今天 25°C，晴天。');
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

test('输入 messages 不被修改', async () => {
  const { client } = fakeClient([answer('好')]);
  const input: Message[] = [{ role: 'user', content: 'hi' }];
  const snapshot = JSON.stringify(input);

  await runAgentTurn(client, fakeRegistry({}), input);

  assert.strictEqual(JSON.stringify(input), snapshot);
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

test('runSessionTurn：本轮失败时一条都不追加（除 user 外）', async () => {
  const client: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 500: boom');
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
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
  const seenOptions: Array<ChatOptions | undefined> = [];
  const client: LLMClient = {
    async chat(_messages, options) {
      seenOptions.push(options);
      return answer('好');
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
    },
  };
  const session = new Session('deepseek-v4-pro');

  await runSessionTurn(session, client, fakeRegistry({}), 'hi', { systemPrompt: SYSTEM_PROMPT });

  assert.strictEqual(seenOptions[0]?.model, 'deepseek-v4-pro');
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/agent.test.ts`
Expected: FAIL —— `Cannot find module '@/core/agent.ts'`

- [ ] **Step 4: 写 `core/agent.ts`**

```ts
// Agent 循环：把「调模型 → 执行工具 → 回喂 → 再调模型」这件事写成有界的循环。
//
// 两个函数，两种粒度：
//   runAgentTurn   —— 纯函数，只吃 messages、不改 Session，便于离线断言
//   runSessionTurn —— 薄薄一层编排，把一轮对话与 Session 的读写绑在一起
//
// 为什么要有第二层：那三行的**顺序**本身就是语义（见 runSessionTurn 的注释）。

import type { ChatResult, Message, ToolResult } from '@/core/types.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { Session } from '@/core/session.ts';

/** 默认的最大步数。对应 guides「Agent 为什么会无限循环」—— 循环必须有界 */
const DEFAULT_MAX_STEPS = 6;

/** 跑满步数时追加的提示语 */
const MAX_STEPS_NOTICE = '（已达最大步数，停止）';

/**
 * 一次工具调用的完整记录，**给人看的投影**。
 *
 * 它和服务端最终响应里的 `items` 是同一类东西：`added` 是给会话的真相，
 * 这个是给界面/终端的展示。两者都返回，是因为从 added 反推要重新
 * JSON.parse 一遍参数、重新判定成败，等于把循环里的判断抄第二遍。
 */
export interface ToolStep {
  /** 第几步（1 起） */
  index: number;
  /** 对应哪张调用单 */
  callId: string;
  name: string;
  /** 模型给的原始 JSON 字符串，原样透出 */
  argumentsText: string;
  /** 解析成功时才有 */
  args?: Record<string, unknown>;
  /** `JSON.parse` 失败的原因。与「工具执行失败」是两回事，展示上要能区分 */
  parseError?: string;
  ok: boolean;
  /** 回喂模型的那份文本（成功=JSON、失败=错误文本） */
  result: string;
  /** 耗时毫秒。**唯一非确定字段**，测试不得断言其值 */
  ms: number;
}

/** 一轮对话的产出 */
export interface AgentTurn {
  /** 最终回答 */
  final: ChatResult;
  /** 本轮新追加的消息（assistant{tool_calls} + tool 结果 + 最终 assistant） */
  added: Message[];
  /** 给人看的工具轨迹 */
  steps: ToolStep[];
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
  const steps: ToolStep[] = [];
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
      return { final: result, added, steps, stopReason: 'answered' };
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
      const startedAt = Date.now();
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

      const content = toToolContent(outcome);
      const toolMessage: Message = { role: 'tool', tool_call_id: call.id, content };
      working.push(toolMessage);
      added.push(toolMessage);

      steps.push({
        index: steps.length + 1,
        callId: call.id,
        name: call.function.name,
        argumentsText: call.function.arguments,
        ...(parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)
          ? { args: parsed.value as Record<string, unknown> }
          : {}),
        ...(parsed.ok ? {} : { parseError: parsed.error }),
        ok: outcome.ok,
        result: content,
        ms: Date.now() - startedAt,
      });
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
    steps,
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
 * 2. `appendAll(added)` 必须在**成功之后** —— 放在 try 之外或之前，
 *    失败轮次会留下一条**伪造的 assistant 回答**（M1 的 D7）。
 *
 * 两个入口（CLI 与 HTTP）各写一遍就是两次写反的机会，而写反了都只是
 * 「行为微妙不对」，不崩、不报错、测试不专门盯就看不出来。
 * 抽成一处之后，它**结构上不可能被写反** —— 与 onChange 广播（D29）是同一个理由。
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

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/agent.test.ts`
Expected: 全绿

- [ ] **Step 6: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/core/prompt.ts demos/02-agent/src/core/agent.ts demos/02-agent/test/agent.test.ts
git commit -m "feat: 新增 Agent 循环 runAgentTurn 与会话编排 runSessionTurn"
```

---

### Task 7: CLI 切到 Agent 循环（非流式）

删掉流式渲染器，`repl.ts` 的一轮改为调 `runSessionTurn`。**这是本次唯一一处行为倒退** ——
CLI 失去逐字输出（见 spec D3）。`llm/sse.ts` 与 `chatStream()` 保留，只是没有调用方。

**Files:**
- Modify: `demos/02-agent/src/cli/render.ts`（**删** `StreamRenderer` / `createStreamRenderer` / `ANSWER_PREFIX` 的流式用法；**加** `renderToolStep` / `renderAnswer`）
- Modify: `demos/02-agent/src/cli/repl.ts`
- Modify: `demos/02-agent/src/index.ts`
- Test: `demos/02-agent/test/render.test.ts`、`test/repl.test.ts`、`test/index.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `runSessionTurn` / `AgentTurn` / `SYSTEM_PROMPT`
- Produces: `renderToolStep(step, {output})`；`renderAnswer(turn, {output, errorOutput})`；
  `runRepl(client, registry, options)`

- [ ] **Step 1: 写失败测试（render）**

在 `test/render.test.ts` 里**删除**所有针对 `createStreamRenderer` 的用例（`grep -n createStreamRenderer test/render.test.ts` 找齐），
然后追加：

```ts
test('renderToolStep 打印工具名、参数与结果', () => {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  renderToolStep(
    {
      index: 1,
      callId: 'c1',
      name: 'weather',
      argumentsText: '{"city":"Beijing"}',
      args: { city: 'Beijing' },
      ok: true,
      result: '{"temperature":"25°C","condition":"Sunny"}',
      ms: 3,
    },
    { output },
  );

  assert.match(chunks.join(''), /weather/);
  assert.match(chunks.join(''), /Beijing/);
  assert.ok(chunks.join('').endsWith('\n'));
});

test('renderToolStep 失败时标出失败并带上错误文本', () => {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  renderToolStep(
    {
      index: 1,
      callId: 'c1',
      name: 'calculator',
      argumentsText: '{"expression":"1/0"}',
      args: { expression: '1/0' },
      ok: false,
      result: '无法计算「1/0」：除数不能为 0',
      ms: 1,
    },
    { output },
  );

  assert.match(chunks.join(''), /失败/);
  assert.match(chunks.join(''), /除数不能为 0/);
});

test('renderAnswer 打印 AI: 前缀，回答走 stdout', () => {
  const out: string[] = [];
  const err: string[] = [];
  const output = collector(out);
  const errorOutput = collector(err);

  renderAnswer(
    { final: { content: '北京今天 25°C，晴天。', finish_reason: 'stop' }, added: [], steps: [], stopReason: 'answered' },
    { output, errorOutput },
  );

  assert.strictEqual(out.join(''), 'AI: 北京今天 25°C，晴天。\n');
  assert.strictEqual(err.join(''), '');
});

test('renderAnswer：content 为 null 时只打印前缀', () => {
  const out: string[] = [];
  renderAnswer(
    { final: { content: null, finish_reason: 'stop' }, added: [], steps: [], stopReason: 'answered' },
    { output: collector(out), errorOutput: collector([]) },
  );
  assert.strictEqual(out.join(''), 'AI: \n');
});

test('renderAnswer：answered + length 才警告截断', () => {
  const err: string[] = [];
  renderAnswer(
    { final: { content: '半句', finish_reason: 'length' }, added: [], steps: [], stopReason: 'answered' },
    { output: collector([]), errorOutput: collector(err) },
  );
  assert.match(err.join(''), /截断/);
});

test('renderAnswer：max-steps 时**不**报截断（那是循环到顶，不是被截断）', () => {
  const err: string[] = [];
  const turn = {
    final: { content: '（已达最大步数，停止）', finish_reason: 'length' as const },
    added: [],
    steps: [],
    stopReason: 'max-steps' as const,
  };

  renderAnswer(turn, { output: collector([]), errorOutput: collector(err) });

  assert.strictEqual(err.join(''), '', 'max-steps 与「回答被截断」是两回事，不能共用同一句警告');
});
```

`collector` 是本文件里已有的 `Writable` 收集器；若没有，按 Step 1 上面第一个用例的写法加一个：

```ts
function collector(chunks: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/render.test.ts`
Expected: FAIL —— `renderToolStep` / `renderAnswer` 未导出

- [ ] **Step 3: 改 `render.ts`**

**删除**：`StreamRenderer` 接口、`createStreamRenderer` 函数、`StreamEvent` 的 import。
`ANSWER_PREFIX` **保留**（`renderAnswer` 要用）。

在 `ANSWER_PREFIX` 之后加：

```ts
/**
 * 打印一轮里的**一条工具轨迹**。
 *
 * 走 **stdout**：这是用户主动要看的输出（工具调了没有、传了什么、成了没有），
 * 与错误、警告这些「用户没主动要的」区分开。
 *
 * 参数优先用解析后的对象渲染（`{"city":"Beijing"}` 比模型原始串更好读）；
 * 解析失败时回落到原始串 —— 那正是模型出错的那一刻，原文本身就是线索。
 */
export function renderToolStep(
  step: ToolStep,
  options: { output: NodeJS.WritableStream },
): void {
  const args = step.args ? JSON.stringify(step.args) : step.argumentsText;
  const verdict = step.ok ? '' : '失败：';
  options.output.write(`[工具] ${step.name}(${args}) → ${verdict}${truncate(step.result)}\n`);
}

/**
 * 打印一轮的最终回答。
 *
 * 非流式下没有「第一段正文到达」这个时机，所以前缀与正文一起写出 ——
 * 形状与流式路径保持一致（`AI: <正文>` 后跟一个换行）。
 *
 * 截断警告只在 `answered` 时打：`max-steps` 的 `finish_reason` 也是 `length`
 * （循环到顶了），但那是「循环没收敛」，不是「回答被截断」，共用一句话会误导。
 */
export function renderAnswer(
  turn: AgentTurn,
  options: { output: NodeJS.WritableStream; errorOutput: NodeJS.WritableStream },
): void {
  options.output.write(`${ANSWER_PREFIX}${turn.final.content ?? ''}\n`);

  if (turn.stopReason === 'answered' && turn.final.finish_reason === 'length') {
    options.errorOutput.write('[警告] 回答被截断（finish_reason=length）\n');
  }
}
```

import 改为：

```ts
import type { CommandResult } from '@/core/commands.ts';
import { COMMAND_NAMES } from '@/core/commands.ts';
import type { AgentTurn, ToolStep } from '@/core/agent.ts';
import type { Message } from '@/core/types.ts';
```

- [ ] **Step 4: 改 `repl.ts`**

删除 `SYSTEM_PROMPT` 的定义与导出（它已经搬到 `core/prompt.ts`），改为 import。
`ReplOptions` 不变，`runRepl` 签名加一个位置参数：

```ts
export async function runRepl(
  client: LLMClient,
  registry: ToolRegistry,
  options: ReplOptions,
): Promise<void> {
```

主循环里，把 `session.append('user', question)` 到 `finally { renderer.finish(); }` 这一整段
（约 143–189 行）**整段替换**为：

```ts
      // 一轮对话的全部编排都在 runSessionTurn 里：写 user → 跑 Agent 循环 →
      // 成功后才把 added 写回会话。失败时它抛出，此时会话里只留下 user 那一条，
      // 不会残留半截工具痕迹（M1 的 D7）。
      try {
        const turn = await runSessionTurn(session, client, registry, question, {
          systemPrompt: SYSTEM_PROMPT,
        });

        // 工具轨迹走 stdout：用户主动要看的
        for (const step of turn.steps) {
          renderToolStep(step, { output: options.output });
        }
        renderAnswer(turn, { output: options.output, errorOutput: options.errorOutput });
      } catch (error) {
        // 最小错误处理：打印错误后继续循环，不崩溃也不污染上下文。
        // 走 stderr：stdout 只留给模型回答、命令结果与工具轨迹。
        writeError(`[error] ${(error as Error).message}`);
      }
```

import 改为：

```ts
import { renderAnswer, renderCommandResult, renderToolStep, renderUnknownCommand } from '@/cli/render.ts';
import { runSessionTurn } from '@/core/agent.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
```

**注**：`[思考中…]` 本次不再打印（非流式下它只能在等待结束后出现，没有信息量）。
这条与 spec §2 的「明确推迟」一致。

- [ ] **Step 5: 改 `index.ts`**

装配点补上注册表（依赖注入多一个接缝）：

```ts
runRepl(createDeepSeekClient(config), createToolRegistry(), {
  input: process.stdin,
  // 模型回答、命令结果与工具轨迹 → stdout
  output: process.stdout,
  // 错误与诊断 → stderr，两条流互不污染
  errorOutput: process.stderr,
  prompt: 'You: ',
  model,
  sessionId,
  history,
  store,
});
```

import 补：

```ts
import { createToolRegistry } from '@/tools/registry.ts';
```

- [ ] **Step 6: 改 `test/repl.test.ts` 的 fake client 与断言**

- `import { SYSTEM_PROMPT } from '@/cli/repl.ts'` → `from '@/core/prompt.ts'`
- `runRepl(client, options)` 的所有调用补上第二个参数 `createToolRegistry()`（或用 `fakeRegistry`）
- fake client 现在只被 `chat()` 调用。**`chatStream` 不能删** —— `LLMClient` 接口要求两个方法都在，
  删了类型检查过不去。把它改成 `async *chatStream() { throw new Error('本测试不使用流式'); }`，
  真正的回答改由 `async chat()` 返回 `{ content, finish_reason: 'stop' }`

用 `grep -n "runRepl(" test/repl.test.ts` 核对调用点数，**数量以 grep 结果为不准凭印象**。

- [ ] **Step 7: 追加集成用例（fake client + fake registry 的天气流程）**

在 `test/repl.test.ts` 追加：

```ts
test('问天气：先打印工具轨迹，再打印最终答案', async () => {
  const results: ChatResult[] = [
    {
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    { content: '北京今天 25°C，晴天。', finish_reason: 'stop' },
  ];
  let index = 0;
  const client: LLMClient = {
    async chat() {
      const result = results[index];
      index += 1;
      if (!result) throw new Error('预设响应用完');
      return result;
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
    },
  };

  const out: string[] = [];
  await runRepl(client, createToolRegistry(), {
    input: Readable.from(['北京今天天气怎么样？\n']),
    output: collector(out),
    errorOutput: collector([]),
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: '20260101-000000-aaaa',
    history: [],
    store: fakeStore(),
  });

  const text = out.join('');
  assert.match(text, /\[工具\] weather/);
  assert.match(text, /Beijing/);
  assert.ok(text.indexOf('[工具]') < text.indexOf('AI: 北京今天 25°C，晴天。'), '轨迹必须在答案之前');
  assert.match(text, /AI: 北京今天 25°C，晴天。/);
});
```

- [ ] **Step 8: 跑单文件测试**

Run:
```bash
cd demos/02-agent
node --import ./loader.mjs --test test/render.test.ts
node --import ./loader.mjs --test test/repl.test.ts
```
Expected: 全绿

- [ ] **Step 9: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿（用例数应比 Task 1 的 167 少 10 条左右 ——
`createStreamRenderer` 的用例被删了，这是预期的）

- [ ] **Step 10: 手动冒烟（终端）**

```bash
cd demos/02-agent
printf '北京今天天气怎么样？\n' | pnpm --silent start
```
Expected: stdout 先出现 `[工具] weather({"city":"Beijing"}) → …`，再出现 `AI: 北京今天 25°C，晴天。`
（真实 API 才会走工具；若没配 `.env.local` 会看到 `[error]`）

- [ ] **Step 11: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/cli demos/02-agent/src/index.ts demos/02-agent/test/render.test.ts demos/02-agent/test/repl.test.ts
git commit -m "refactor: CLI 改走 Agent 循环（非流式），新增工具轨迹渲染"
```

---

### Task 8: 会话注册表与 id

服务端要多会话，而 `Session` 实例目前只在 `runRepl` 内部构造、随进程结束销毁。这一 Task 补上
`Map<sessionId, Session>`、FIFO 上限、以及**同一会话的串行锁**。

**Files:**
- Create: `demos/02-agent/src/server/ids.ts`
- Create: `demos/02-agent/src/server/session-registry.ts`
- Test: `demos/02-agent/test/server-session-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 复制来的 `core/session.ts`、`core/journal.ts` 的 `makeSessionId`
- Produces: `newSessionId(): string`；`SessionNotFoundError`；`SessionRegistry`
  （`create()` / `get(id)` / `run(id, fn)` / `size()`）；`createSessionRegistry(options)`

- [ ] **Step 1: 写 `server/ids.ts`**

```ts
// 服务端的会话 id 生成。
//
// 复用 core/journal.ts 的 makeSessionId，而不是另发明一套 ——
// 两个入口用同一种 id 形状，Web 建的会话将来能被 CLI 的 --resume 认识。
// makeSessionId 刻意把 now 与 suffix 做成参数，就是为了让这里注入随机源。

import { randomBytes } from 'node:crypto';
import { makeSessionId } from '@/core/journal.ts';

export function newSessionId(): string {
  return makeSessionId(new Date(), randomBytes(2).toString('hex'));
}
```

- [ ] **Step 2: 写失败测试**

`test/server-session-registry.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionNotFoundError,
  createSessionRegistry,
} from '@/server/session-registry.ts';

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
  await assert.rejects(
    () => registry.run('nope', async () => 'x'),
    SessionNotFoundError,
  );
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

  const seen = await registry.run(id, async (passed) => passed);

  assert.strictEqual(seen, session);
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

test('会话模型沿用注册表配置', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'deepseek-v4-pro' });
  assert.strictEqual(registry.create().session.model, 'deepseek-v4-pro');
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server-session-registry.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 写 `server/session-registry.ts`**

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
// CLI 靠 REPL 的串行 await 天然规避了这个问题，服务端没有这个保护。

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

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server-session-registry.test.ts`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/server demos/02-agent/test/server-session-registry.test.ts
git commit -m "feat: 新增服务端会话注册表（FIFO 上限 + 每会话串行锁）"
```

---

### Task 9: 展示投影 `core/transcript.ts`

实时路径（本轮工具轨迹）与历史路径（`GET` 取回整段会话）用**同一种**展示项，
前端因此只需要一套渲染逻辑。

**Files:**
- Create: `demos/02-agent/src/core/transcript.ts`
- Test: `demos/02-agent/test/transcript.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Message`；Task 6 的 `ToolStep`
- Produces: `TranscriptItem`；`foldTranscript(messages: Message[]): TranscriptItem[]`；
  `stepsToTranscript(steps: ToolStep[]): TranscriptItem[]`

- [ ] **Step 1: 写失败测试**

`test/transcript.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { foldTranscript, stepsToTranscript } from '@/core/transcript.ts';
import type { Message } from '@/core/types.ts';

test('user 与有正文的 assistant 各自成项', () => {
  const items = foldTranscript([
    { role: 'system', content: '被忽略' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ]);

  assert.deepStrictEqual(items, [
    { kind: 'user', text: '你好' },
    { kind: 'assistant', text: '你好呀' },
  ]);
});

test('只有 tool_calls 没有正文的 assistant 不产出 assistant 项', () => {
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

  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(items[0], { kind: 'user', text: '北京天气' });
  assert.deepStrictEqual(items[1], {
    kind: 'tool',
    name: 'weather',
    argumentsText: '{"city":"Beijing"}',
    ok: true,
    result: '{"temperature":"25°C"}',
  });
});

test('失败的工具结果（不是 JSON）标记为 ok: false', () => {
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

  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0]!.kind, 'assistant');
  assert.strictEqual(items[1]!.kind, 'tool');
});

test('空历史折叠成空数组', () => {
  assert.deepStrictEqual(foldTranscript([]), []);
});

test('stepsToTranscript 把本轮轨迹转成展示项', () => {
  const items = stepsToTranscript([
    {
      index: 1,
      callId: 'c1',
      name: 'weather',
      argumentsText: '{"city":"Beijing"}',
      args: { city: 'Beijing' },
      ok: true,
      result: '"25°C, Sunny"',
      ms: 3,
    },
  ]);

  assert.deepStrictEqual(items, [
    {
      kind: 'tool',
      name: 'weather',
      argumentsText: '{"city":"Beijing"}',
      ok: true,
      result: '"25°C, Sunny"',
    },
  ]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/transcript.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写 `core/transcript.ts`**

```ts
// 把消息数组折叠成**给界面看的展示项**。
//
// 为什么要有这一层：`Message` 是发给 API 的线格式，它按「模型需要什么」
// 组织（assistant{tool_calls} 与 tool 是两条独立消息）；而界面要的是
// 「一次工具调用连它的结果」这样的一整块。两者的形状天然不同，
// 与其让前端自己拼，不如在服务端投影一次。
//
// 实时路径（本轮工具轨迹）与历史路径（读回整段会话）共用这里的形状，
// 前端因此只需要一套渲染逻辑。

import type { Message } from '@/core/types.ts';
import type { ToolStep } from '@/core/agent.ts';

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** 模型给的原始 JSON 字符串 */
      argumentsText: string;
      /** true=成功，false=失败，**null=没等到结果**（半截日志、或本轮被打断） */
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
 * 之所以要这样反推而不是在消息里存一个标记位：`Message` 是发给 API 的
 * 线格式，多一个字段就是给上游发未知字段。宁可在这里多一层判断。
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
  /** 已产出但还没等到结果的工具项，按 tool_call_id 索引 */
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

/** 把本轮的工具轨迹转成展示项。字段一一对应，不做判断 */
export function stepsToTranscript(steps: ToolStep[]): TranscriptItem[] {
  return steps.map((step) => ({
    kind: 'tool' as const,
    name: step.name,
    argumentsText: step.argumentsText,
    ok: step.ok,
    result: step.result,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/transcript.test.ts`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/core/transcript.ts demos/02-agent/test/transcript.test.ts
git commit -m "feat: 新增展示投影 foldTranscript，实时与历史路径共用一种形状"
```

---

### Task 10: 错误映射

**Files:**
- Create: `demos/02-agent/src/server/errors.ts`
- Test: `demos/02-agent/test/server-errors.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `mapErrorToStatus(error: unknown): { status: number; code: string }`

- [ ] **Step 1: 写失败测试**

`test/server-errors.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapErrorToStatus } from '@/server/errors.ts';

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
  assert.strictEqual(mapErrorToStatus(new Error('流空闲超时（30s 无数据），已中断')).status, 504);
});

test('未知错误 → 500', () => {
  const mapped = mapErrorToStatus(new Error('别的东西炸了'));
  assert.strictEqual(mapped.status, 500);
  assert.strictEqual(mapped.code, 'internal');
});

test('非 Error 的抛出物也能映射', () => {
  assert.strictEqual(mapErrorToStatus('字符串错误').status, 500);
});

test('返回值只可能是 500 / 502 / 504', () => {
  const samples: unknown[] = [
    new Error('DeepSeek API error 500: x'),
    new Error('fetch failed'),
    new Error('whatever'),
    'string',
    null,
    undefined,
  ];
  for (const sample of samples) {
    assert.ok([500, 502, 504].includes(mapErrorToStatus(sample).status));
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server-errors.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写 `server/errors.ts`**

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

  // undici 的连接失败、本项目的流空闲超时、以及被中断的连接
  if (/fetch failed|流空闲超时|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|aborted/i.test(message)) {
    return { status: 504, code: 'upstream_unreachable' };
  }

  return { status: 500, code: 'internal' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server-errors.test.ts`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/src/server/errors.ts demos/02-agent/test/server-errors.test.ts
git commit -m "feat: 新增 HTTP 错误映射（上游 status 不透出）"
```

---

### Task 11: 装 express，写 `server/app.ts`

**Files:**
- Modify: `demos/02-agent/package.json`（加 `dependencies.express` 与 `devDependencies.@types/express`）
- Create: `demos/02-agent/src/server/app.ts`
- Test: `demos/02-agent/test/server.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `runSessionTurn` / `SYSTEM_PROMPT`；Task 8 的 `SessionRegistry` / `SessionNotFoundError`；
  Task 9 的 `foldTranscript` / `stepsToTranscript`；Task 10 的 `mapErrorToStatus`
- Produces: `AppDeps`；`createApp(deps: AppDeps): Express`（**不 listen**）

- [ ] **Step 1: 改 `package.json`**

```json
  "dependencies": {
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
```

`scripts` 先不动（`start:server` 在 Task 12 加）。

- [ ] **Step 2: 安装**

Run: `cd demos/02-agent && pnpm install`
Expected: `express` 出现在 `node_modules/`，`pnpm-lock.yaml` 更新

- [ ] **Step 3: 写失败测试**

`test/server.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { createApp } from '@/server/app.ts';
import { createSessionRegistry } from '@/server/session-registry.ts';
import { createToolRegistry } from '@/tools/registry.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ChatResult, Message } from '@/core/types.ts';

/** 一轮固定回答的假 client */
function stubClient(results: ChatResult[]): LLMClient {
  let index = 0;
  return {
    async chat(): Promise<ChatResult> {
      const result = results[index];
      index += 1;
      if (!result) throw new Error('预设响应用完');
      return result;
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
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
  const sessions = createSessionRegistry({ newId: () => '20260101-000000-aaaa', model: 'deepseek-flash' });
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
    assert.deepStrictEqual(await response.json(), { sessionId: '20260101-000000-aaaa', model: 'deepseek-flash' });
    assert.strictEqual(sessions.size(), 1);
  });
});

test('POST 消息返回 reply 与本轮工具轨迹', async () => {
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
    const response = await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', {
      message: '北京今天天气怎么样？',
    });

    assert.strictEqual(response.status, 200);
    const body = (await response.json()) as {
      reply: string;
      items: unknown[];
      stopReason: string;
      model: string;
    };

    assert.strictEqual(body.reply, '北京今天 25°C，晴天。');
    assert.strictEqual(body.stopReason, 'answered');
    assert.strictEqual(body.model, 'deepseek-flash');
    // 这一条是**前端类型的真正守卫**：键名与形状必须与 web/src/types.ts 一致
    assert.deepStrictEqual(body.items, [
      {
        kind: 'tool',
        name: 'weather',
        argumentsText: '{"city":"Beijing"}',
        ok: true,
        result: '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}',
      },
    ]);
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
    await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', { message: '北京天气' });

    const response = await fetch(`${baseUrl}/api/sessions/20260101-000000-aaaa/messages`);
    assert.strictEqual(response.status, 200);

    const body = (await response.json()) as { sessionId: string; model: string; items: Array<{ kind: string }> };
    assert.strictEqual(body.sessionId, '20260101-000000-aaaa');
    assert.strictEqual(body.model, 'deepseek-flash');
    assert.deepStrictEqual(
      body.items.map((item) => item.kind),
      ['user', 'tool', 'assistant'],
    );
  });
});

test('未知会话 → 404', async () => {
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    const post = await postJson(baseUrl, '/api/sessions/nope/messages', { message: 'hi' });
    assert.strictEqual(post.status, 404);

    const get = await fetch(`${baseUrl}/api/sessions/nope/messages`);
    assert.strictEqual(get.status, 404);

    const body = (await post.json()) as { error: { code: string } };
    assert.strictEqual(body.error.code, 'session_not_found');
  });
});

test('message 缺失 → 400', async () => {
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});

    for (const body of [{}, { message: '' }, { message: 42 }, { message: '   ' }]) {
      const response = await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', body);
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
    const response = await fetch(`${baseUrl}/api/sessions/20260101-000000-aaaa/messages`, {
      method: 'POST',
      body: 'message=hi',
    });
    assert.strictEqual(response.status, 400);
  });
});

test('请求体不是合法 JSON → 400', async () => {
  const { app } = makeApp(stubClient([]));

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await fetch(`${baseUrl}/api/sessions/20260101-000000-aaaa/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ 坏掉的 json',
    });
    assert.strictEqual(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.strictEqual(body.error.code, 'invalid_body');
  });
});

test('上游 401 → 502（不透出上游状态码）', async () => {
  const failing: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 401: invalid api key');
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
    },
  };
  const { app } = makeApp(failing);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', { message: 'hi' });

    assert.strictEqual(response.status, 502);
    const body = (await response.json()) as { error: { code: string } };
    assert.strictEqual(body.error.code, 'upstream_error');
  });
});

test('连不上上游 → 504', async () => {
  const failing: LLMClient = {
    async chat() {
      throw new TypeError('fetch failed');
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
    },
  };
  const { app } = makeApp(failing);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    const response = await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', { message: 'hi' });
    assert.strictEqual(response.status, 504);
  });
});

test('失败的一轮不写进会话（历史里只有 user）', async () => {
  const failing: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 500: boom');
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
    },
  };
  const { app } = makeApp(failing);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', { message: 'hi' });

    const response = await fetch(`${baseUrl}/api/sessions/20260101-000000-aaaa/messages`);
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
    const body = (await response.json()) as { error: { code: string } };
    assert.strictEqual(body.error.code, 'not_found');
  });
});

test('上游收到的 messages 里带着 system 提示与本轮 user', async () => {
  const seen: Message[][] = [];
  const client: LLMClient = {
    async chat(messages) {
      seen.push(messages);
      return answer('好');
    },
    async *chatStream() {
      throw new Error('本测试不使用流式');
    },
  };
  const { app } = makeApp(client);

  await withServer(app, async (baseUrl) => {
    await postJson(baseUrl, '/api/sessions', {});
    await postJson(baseUrl, '/api/sessions/20260101-000000-aaaa/messages', { message: '你好' });
  });

  assert.deepStrictEqual(seen[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '你好' },
  ]);
});
```

- [ ] **Step 4: 运行确认失败**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server.test.ts`
Expected: FAIL —— `Cannot find module '@/server/app.ts'`

- [ ] **Step 5: 写 `server/app.ts`**

```ts
// HTTP 层的全部路由与中间件。**导出的是「造 app」而不是「跑 app」** ——
// 不在这里 listen，测试才能用临时端口把它跑起来、跑完就关。
//
// 这一层是唯一允许 import express 的地方；core / llm / tools 都不知道它的存在。

import express from 'express';
// 只当类型用的导入必须写 `import type`：Node 的原生类型擦除看不出
// `Request` 是个类型，会原样保留这条值导入，运行时抛
// 「does not provide an export named 'Request'」，而 tsc 完全放行。
import type { Express, NextFunction, Request, Response } from 'express';

import { runSessionTurn } from '@/core/agent.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import { foldTranscript, stepsToTranscript } from '@/core/transcript.ts';
import { SessionNotFoundError } from '@/server/session-registry.ts';
import { mapErrorToStatus } from '@/server/errors.ts';
import type { SessionRegistry } from '@/server/session-registry.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { LLMClient } from '@/llm/client.ts';

export interface AppDeps {
  client: LLMClient;
  registry: ToolRegistry;
  sessions: SessionRegistry;
  /** 建会话时用的模型名（也就是 config.model） */
  model: string;
  systemPrompt?: string;
  maxSteps?: number;
  /** 服务端诊断日志。默认写 stderr；测试注入一个空实现以免污染输出 */
  logError?: (message: string) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
  const logError = deps.logError ?? ((message: string) => {
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
      let model = deps.model;
      const turn = await deps.sessions.run(sessionId, async (session) => {
        model = session.model;
        return await runSessionTurn(session, deps.client, deps.registry, question, {
          systemPrompt,
          ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
        });
      });

      res.json({
        reply: turn.final.content ?? '',
        // items 是**本轮**的工具轨迹（不是整段会话）——
        // 前端已经知道自己发了什么，只需要这一段增量
        items: stepsToTranscript(turn.steps),
        stopReason: turn.stopReason,
        model,
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
    res.json({
      sessionId,
      model: session.model,
      items: foldTranscript(session.history()),
    });
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

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server.test.ts`
Expected: 全绿

**若卡住不返回**：说明 `closeAllConnections()` 没生效 —— 那是 undici keep-alive 挂住了
`server.close()`，报错会看起来像「测试挂死」。检查 `withServer` 的 finally 块。

- [ ] **Step 7: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

**若类型检查报 express 相关的错**：先看 `@types/express` 是否装在了 devDependencies，
以及 `import type { Request }` 有没有写成值导入（那是 R1）。

- [ ] **Step 8: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/package.json demos/02-agent/pnpm-lock.yaml \
        demos/02-agent/src/server/app.ts demos/02-agent/test/server.test.ts
git commit -m "feat: 引入 express 并实现 REST 接口（建会话 / 发消息 / 取历史）"
```

---

### Task 12: HTTP 入口与配置搬迁

`server/main.ts` 是服务端的进程入口（相当于 CLI 的 `src/index.ts`）。
它需要读环境变量，而 `resolveConfig` 现在住在 `cli/config.ts` ——
**server 不能 import cli**，所以把它搬到 `core/config.ts`。

搬得动是因为它本来就满足 core 的约束：`resolveConfig(env)` 把 env 作为**参数**收进来，
自己不读 `process.env`、不打印、不碰 IO。

**Files:**
- Move: `demos/02-agent/src/cli/config.ts` → `demos/02-agent/src/core/config.ts`
- Modify: `demos/02-agent/src/index.ts`（import 路径）、`demos/02-agent/test/config.test.ts`（import 路径）
- Create: `demos/02-agent/src/server/main.ts`
- Modify: `demos/02-agent/package.json`（加 `start:server` 脚本）
- Test: `demos/02-agent/test/server-main.test.ts`

**Interfaces:**
- Consumes: Task 11 的 `createApp`；Task 8 的 `createSessionRegistry` / `newSessionId`；
  `core/config.ts` 的 `resolveConfig`
- Produces: 一个能 `pnpm start:server` 起来的进程；环境变量 `AI_AGENT_PORT` / `AI_AGENT_HOST`

- [ ] **Step 1: 搬 config**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
git mv src/cli/config.ts src/core/config.ts
```

改 `src/index.ts` 与 `test/config.test.ts` 里的导入路径：
`@/cli/config.ts` → `@/core/config.ts`。用 `grep -rn "cli/config" src test` 找齐。

同时把 `core/config.ts` 顶部的文件注释补一句搬迁理由：

```ts
// 配置解析：环境变量 → Config。**纯函数**（env 由参数传入），
// 所以它住在 core 而不是 cli —— CLI 与 HTTP 两个入口都要用它，
// 而 server 不允许 import cli。
```

- [ ] **Step 2: 改 `package.json` 的 scripts**

```json
  "scripts": {
    "start": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/index.ts",
    "start:server": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/server/main.ts",
    "test": "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs --test",
    "typecheck": "tsc --noEmit"
  },
```

**三个跑 `.ts` 的脚本都必须带 `--import ./loader.mjs`**，漏一个就是「测试过但起不来」。

- [ ] **Step 3: 在 `.env` 模板里补两行**

```
AI_AGENT_PORT=3000
AI_AGENT_HOST=127.0.0.1
```

- [ ] **Step 4: 写 `server/main.ts`**

```ts
// HTTP 服务端的进程入口。相当于 CLI 的 src/index.ts：
// 唯一碰 process 的地方，负责装配依赖并把它们交给 createApp。
//
// 装配点在这里，而不是在 app.ts 里 —— app.ts 只认接口，
// 所以测试能塞假的 client / registry 进去。

import { resolveConfig } from '@/core/config.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import { createToolRegistry } from '@/tools/registry.ts';
import { createSessionRegistry } from '@/server/session-registry.ts';
import { createApp } from '@/server/app.ts';
import { newSessionId } from '@/server/ids.ts';

const DEFAULT_PORT = 3000;
/** 只监听回环地址。这是个本机开发工具，不是可暴露的服务（见 spec D22） */
const DEFAULT_HOST = '127.0.0.1';

let port = DEFAULT_PORT;
let host = DEFAULT_HOST;
let config;

try {
  config = resolveConfig(process.env);
} catch (error) {
  process.stderr.write(`[error] ${(error as Error).message}\n`);
  process.exit(1);
}

// 端口 0 表示「由内核分配一个空闲端口」—— 子进程测试靠这个避免端口冲突
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
  // 这行走 **stdout**：它是服务端最主要的一条给人看的信息，
  // 而且测试要从这里读出「内核分了哪个端口」。
  // （CLI 的 stdout/stderr 分流规矩不适用于服务端 —— 那边 stdout 要留给模型回答。）
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

- [ ] **Step 5: 写失败测试**

`test/server-main.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * 子进程级集成测试：断言真实的启动行为与退出码。
 *
 * 为什么不直接用单元测试：把 process.exit(1) 改成 throw，单元测试依然全绿，
 * 而脚本与 CI 的判断依据已经坏了（这条教训来自 01-llm 的 test/index.test.ts）。
 */
function runServer(env: Record<string, string>): {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
} {
  let out = '';
  let err = '';
  const child = spawn(
    process.execPath,
    ['--import', './loader.mjs', 'src/server/main.ts'],
    {
      cwd: process.cwd(),
      // 用确定的 env，不继承父进程真实的 DEEPSEEK_API_KEY ——
      // 否则「缺 key 该退出」这类用例会被父进程的环境悄悄救活
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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

test('起来后在 stdout 打印真实端口，SIGTERM 能干净退出', async () => {
  const { child, stdout } = runServer({
    DEEPSEEK_API_KEY: 'test-key-not-used',
    AI_AGENT_PORT: '0',
  });

  try {
    // 等那行 `[http] listening on http://127.0.0.1:PORT`
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

    // 真打一次接口，证明它确实在服务
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' });
    assert.strictEqual(response.status, 201);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
```

- [ ] **Step 6: 跑测试**

Run: `cd demos/02-agent && node --import ./loader.mjs --test test/server-main.test.ts`
Expected: 全绿

**若「缺 key」那条用例意外通过不了**：多半是父进程的真实 `DEEPSEEK_API_KEY` 漏进了 `env` ——
检查 `runServer` 是把 `...env` 展开在最后、且没有整份继承 `process.env`。

- [ ] **Step 7: 手动冒烟**

```bash
cd demos/02-agent
pnpm start:server &
curl -sX POST localhost:3000/api/sessions
# → {"sessionId":"2026...","model":"deepseek-flash"}
curl -sX POST localhost:3000/api/sessions/<上面返回的 id>/messages \
     -H 'content-type: application/json' -d '{"message":"北京今天天气怎么样？"}'
# → {"reply":"北京今天 25°C，晴天。","items":[{"kind":"tool",...}],"stopReason":"answered",...}
curl -s localhost:3000/api/sessions/<id>/messages
kill %1
```

- [ ] **Step 8: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 9: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent
git commit -m "feat: 新增 HTTP 服务端入口，config 从 cli 搬到 core（server 不得 import cli）"
```

---

### Task 13: 前端骨架

`web/` 是**完全独立的 pnpm 项目**：自己的 `package.json`、`pnpm-lock.yaml`、`tsconfig.json`，
不做 workspace（根 `AGENTS.md` 明文「各阶段是独立项目，根目录没有 `package.json`」）。

**Files:**
- Create: `demos/02-agent/web/package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`
- Create: `demos/02-agent/web/src/main.tsx`、`App.tsx`、`styles.css`

**Interfaces:**
- Consumes: 无
- Produces: 一个 `pnpm --dir web run build` 能过的空壳；`App` 默认导出

- [ ] **Step 1: 写 `web/package.json`**

```json
{
  "name": "ai-chat-agent-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@10.34.5",
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

- [ ] **Step 2: 写 `web/tsconfig.json`**

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

`verbatimModuleSyntax` 与服务端的那条 R1 是同一个教训：只当类型用的导入必须写 `import type`，
这里直接在类型检查阶段强制它。`types: []` 是刻意的 —— 前端**不应该**依赖 Node 的类型，
漏写 `@types/node` 时反而能早一点暴露「这份代码跑在浏览器里」。

- [ ] **Step 3: 写 `web/vite.config.ts`**

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
      // 这是整个前端里**唯一**允许出现服务端地址的地方（见 spec R12）。
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
```

- [ ] **Step 4: 写 `web/index.html`**

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

- [ ] **Step 5: 写 `web/src/main.tsx`**

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

- [ ] **Step 6: 写 `web/src/App.tsx`（先放一个空壳，Task 15 填内容）**

```tsx
export default function App() {
  return <main className="app">正在加载…</main>;
}
```

- [ ] **Step 7: 写 `web/src/styles.css`**

配色沿用 `docs/how-agent-works.html` 的色板（那份讲解页与服务端无关，但两边颜色一致，
读文档与用界面的心智是一套）。

```css
:root {
  --ground: #f4f5f7;
  --surface: #ffffff;
  --surface-sunk: #edeff3;
  --ink: #191c22;
  --ink-soft: #5b6270;
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
  --shadow: 0 1px 2px rgba(20, 24, 33, 0.06), 0 4px 12px rgba(20, 24, 33, 0.05);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ground: #11141a;
    --surface: #191d25;
    --surface-sunk: #151920;
    --ink: #e7eaf0;
    --ink-soft: #9ba3b2;
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
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid currentColor;
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
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent/web
pnpm install
pnpm run typecheck
pnpm run build
```
Expected: 三条都成功，`web/dist/` 生成

- [ ] **Step 9: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/web
git commit -m "feat(web): 前端骨架（React 19 + Vite 8，独立项目、proxy 反代 /api）"
```

---

### Task 14: 前端契约、API 客户端与状态机

**Files:**
- Create: `demos/02-agent/web/src/types.ts`、`api.ts`、`chatReducer.ts`

**Interfaces:**
- Consumes: Task 13 的骨架
- Produces: `TranscriptItem` / `SendMessageResponse` / `HistoryResponse` / `ApiErrorBody`；
  `ApiError`；`createSession()` / `sendMessage()` / `fetchHistory()`；
  `ChatState` / `ChatItem` / `Action` / `chatReducer` / `initialChatState`

- [ ] **Step 1: 写 `web/src/types.ts`**

```ts
// 线上契约的**抄写**。
//
// 为什么不跨项目 import 服务端的类型：那要把服务端的 @types/node 拖进前端 tsconfig、
// `@/` 别名要在两边各配一次，而且**线上契约本来就不是服务端的内部 Message 联合** ——
// 它是 TranscriptItem，是另一个东西。共享是假共享。
//
// 真正的守卫在 test/server.test.ts：那里逐字断言了响应 JSON 的键与形状。
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

/** `POST /api/sessions/:id/messages` 的响应。`items` 只是**本轮**的工具轨迹 */
export interface SendMessageResponse {
  reply: string;
  items: TranscriptItem[];
  stopReason: 'answered' | 'max-steps';
  model: string;
}

/** `GET /api/sessions/:id/messages` 的响应。`items` 是**整段会话** */
export interface HistoryResponse {
  sessionId: string;
  model: string;
  items: TranscriptItem[];
}

/** 所有非 2xx 响应的统一形状 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}
```

- [ ] **Step 2: 写 `web/src/api.ts`**

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

export async function sendMessage(
  sessionId: string,
  message: string,
): Promise<SendMessageResponse> {
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

`encodeURIComponent` 不是可省的礼节：会话 id 会被拼进 URL 路径，虽然服务端生成的 id
形状固定（`YYYYMMDD-HHMMSS-xxxx`），但 localStorage 里的值是**用户可改的**。

- [ ] **Step 3: 写 `web/src/chatReducer.ts`**

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
  sessionId: string | null;
  /** 顶部那条可关闭的提示（例如「会话已失效，已新建」） */
  notice: string | null;
  /** 生成稳定 id 用的计数器。放在 state 里，reducer 才能保持纯粹 */
  nextId: number;
}

export const initialChatState: ChatState = {
  items: [],
  status: 'idle',
  sessionId: null,
  notice: null,
  nextId: 1,
};

export type Action =
  | { type: 'history/loaded'; sessionId: string; items: TranscriptItem[] }
  | { type: 'session/lost'; notice: string }
  | { type: 'notice/dismiss' }
  | { type: 'user/send'; text: string }
  | { type: 'turn/success'; items: TranscriptItem[]; reply: string }
  | { type: 'turn/error'; text: string };

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
      return {
        ...state,
        sessionId: action.sessionId,
        items: toChatItems(action.items, state.nextId),
        nextId: state.nextId + action.items.length,
      };

    case 'session/lost':
      // 会话在服务端没了（重启或淘汰）：清掉本地那份 id，
      // **不自动新建** —— 新建推迟到用户下次发送时，否则每次刷新都会多出一个会话
      return { ...state, sessionId: null, items: [], notice: action.notice, nextId: 1 };

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
      // 先把服务端给的工具轨迹铺进去，再放最终回答 ——
      // 顺序就是它们发生的顺序
      const appended = toChatItems(action.items, state.nextId);
      const nextId = state.nextId + action.items.length;
      return {
        ...state,
        status: 'idle',
        items: [
          ...state.items,
          ...appended,
          { id: `item-${nextId}`, kind: 'assistant', text: action.reply },
        ],
        nextId: nextId + 1,
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

Run: `cd demos/02-agent/web && pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 5: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/web/src/types.ts demos/02-agent/web/src/api.ts demos/02-agent/web/src/chatReducer.ts
git commit -m "feat(web): 线上契约、API 客户端与对话框状态机"
```

---

### Task 15: 前端组件与会话恢复

**Files:**
- Create: `demos/02-agent/web/src/useChat.ts`
- Create: `demos/02-agent/web/src/components/MessageList.tsx`、`MessageBubble.tsx`、`ToolTrace.tsx`、`Composer.tsx`
- Modify: `demos/02-agent/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 14 的 `chatReducer` / `ApiError` / `createSession` / `sendMessage` / `fetchHistory`
- Produces: `useChat()`；四个组件；可用的 `App`

- [ ] **Step 1: 写 `web/src/useChat.ts`**

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
        sessionIdRef.current = history.sessionId;
        dispatch({ type: 'history/loaded', sessionId: history.sessionId, items: history.items });
      } catch (error) {
        if (cancelled) return;
        // 只有「会话不存在」才静默降级；网络错误该让用户看见
        if (error instanceof ApiError && error.status === 404) {
          writeStoredSessionId(null);
          sessionIdRef.current = null;
          dispatch({ type: 'session/lost', notice: '上一次的会话已失效（服务端可能重启过），下一条消息会开启新会话。' });
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
        dispatch({ type: 'turn/success', items: result.items, reply: result.reply });
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

`web/src/components/ToolTrace.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/**
 * 一次工具调用的轨迹。**这是本次改造最想让人看到的东西** ——
 * 模型开了什么调用单、程序传了什么参、工具回了什么。
 *
 * `ok` 为 null 表示「没等到结果」（半截日志），用中性标记而不是红叉 ——
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

`web/src/components/MessageBubble.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';

type BubbleItem = Extract<ChatItem, { kind: 'user' | 'assistant' | 'error' }>;

export function MessageBubble({ item }: { item: BubbleItem }) {
  return <div className={`bubble bubble--${item.kind}`}>{item.text}</div>;
}
```

`web/src/components/MessageList.tsx`：

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

`web/src/components/Composer.tsx`：

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

- [ ] **Step 3: 改 `web/src/App.tsx`**

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

Run: `cd demos/02-agent/web && pnpm run typecheck && pnpm run build`
Expected: 两条都成功

- [ ] **Step 5: 检查没有把服务端地址写进前端**

Run: `cd demos/02-agent/web && grep -rn "localhost:3000\|127.0.0.1:3000" src/ || echo "干净：src/ 里没有绝对地址"`
Expected: 输出「干净：src/ 里没有绝对地址」

- [ ] **Step 6: 双进程手动冒烟**

```bash
# 终端 A
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm start:server

# 终端 B
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent/web && pnpm dev
```

浏览器打开 http://localhost:5173，问「北京今天天气怎么样？」，逐条确认：

1. 先出现一个 `⚙ weather` 的工具轨迹块（写着参数 `{"city":"Beijing"}` 与结果），再出现回答气泡
2. 刷新页面：历史还在（会看到 GET 把 `user / tool / assistant` 三项都渲染出来）
3. 刷新三次，服务端会话数不涨（未发送时不该新建会话）
4. 杀掉服务端再刷新页面：出现一条「会话已失效」的可关闭提示，**不是白屏**
5. 此时再发一条消息：自动新建会话并正常回答

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/web
git commit -m "feat(web): 对话框组件、工具轨迹渲染与会话恢复"
```

---

### Task 16: 文档四件套与既有产物同步

根 `AGENTS.md` 的约束改写与根 `README.md` 的阶段状态**已经在本计划之前改完了**，
本 Task 只负责 `demos/02-agent/` 自己的文档。

**Files:**
- Create: `demos/02-agent/README.md`、`ARCHITECTURE.md`、`DECISIONS.md`、`EVALUATION.md`、`docs/troubleshooting.md`
- Modify: `demos/02-agent/docs/how-agent-works.html`（「每个文件负责哪一步」表补两行）

**Interfaces:**
- Consumes: Task 1–15 的全部产物
- Produces: 五份文档

- [ ] **Step 1: 写 `README.md`**

头部必须是 `> 回答：这个项目怎么跑起来？`（与根 `AGENTS.md` 的职责表一致）。内容至少覆盖：

- 项目定位（阶段二 · Tool Calling · 前后端分离）
- 环境要求（Node ≥ 22、pnpm、`web/` 需单独 `pnpm install`）
- 环境变量表：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `AI_CHAT_MODEL`，
  以及新增的 `AI_AGENT_PORT` / `AI_AGENT_HOST`（默认 3000 / 127.0.0.1）
- 三个入口的命令：
  ```bash
  pnpm start                    # CLI（终端对话）
  pnpm start --resume <id>      # 恢复会话（注意不带 --，见 troubleshooting T13）
  pnpm start:server             # HTTP 服务端
  cd web && pnpm install && pnpm dev   # 前端 dev server
  pnpm test / pnpm run typecheck
  ```
- **两次 `pnpm install`** 的原因（服务端与 `web/` 是彼此独立的项目）
- 前端构建：`pnpm --dir web run build` → `web/dist`（运行时产物，不入库）
- 目录结构表
- 当前范围 / 尚未实现（照 `EVALUATION.md` 的未做清单列，不要另写一份）

- [ ] **Step 2: 写 `ARCHITECTURE.md`**

头部 `> 回答：这个系统由什么组成，一轮请求实际跑过了哪些步骤？`。至少覆盖：

- 分层图与依赖方向（`cli → core → llm`、`server → core → llm`、`tools → core`；server 与 cli 互不导入）
- 依赖规则表（允许 / 禁止），把新增的 `express` 与 `node:fs` 约束写进去
- 三条硬边界的**依据**（谁在哪个文件里被强制）
- **一轮请求的完整数据流**，两条都要走一遍：
  - 浏览器：`POST /api/sessions/:id/messages` → `sessions.run`（串行锁）→ `runSessionTurn`
    → `client.chat(messages, {tools})` → 有 `tool_calls` → `registry.execute` → 回喂 → 收敛
    → `appendAll` → `stepsToTranscript` → 200 JSON
  - CLI：`readline` 读一行 → 命令分支 → `runSessionTurn` → `renderToolStep` × N → `renderAnswer`
- 标注两者**汇合在哪**（`core/agent.ts` 的 `runSessionTurn`）与**分叉在哪**（一个打印、一个序列化 JSON）
- `GET /api/sessions/:id/messages` 为什么**不加会话锁**
- 三个测试接缝（`LLMClient` / `SessionStore` / `ToolRegistry`）各自长什么样

- [ ] **Step 3: 写 `DECISIONS.md`**

头部 `> 回答：为什么是这样设计的，放弃了什么？`。
**逐条抄 spec §20 的 D1–D22**，每条写：理由 / 放弃了什么 / 代价。不要只写结论。

另外补三条**实施过程中才会浮现**的决策（这些不在 spec 里，但现在确实这么做了）：

- **config 从 `cli/` 搬到 `core/`** —— 因为 `server` 不允许 import `cli`，
  而 `resolveConfig` 本来就满足 core 的约束（env 由参数传入、不读 `process.env`、不打印）。
  代价：与 01-llm 的目录结构出现一处有意偏离。
- **`cli/render.ts` 的 `createStreamRenderer` 已删除** —— 与 spec D10 一致，此处记下实际动作。
- **`[思考中…]` 本次不再打印** —— 非流式下它只能在等待结束后出现。

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
| 实现基本任务循环 | | `test/server.test.ts` 的端到端天气轮 |
| 防止无限循环 | | `test/agent.test.ts` 的 `maxSteps` 用例 + `stopReason` |

再加一节 **「未做项与落点」**，逐条抄 spec §2 的「明确推迟」表。

- [ ] **Step 5: 写 `docs/troubleshooting.md`**

头部 `> 回答：遇到这个报错怎么定位和修？`。本次至少记这几条（每条都要写
「问题 → 尝试 → 失败 → 原因 → 解决 → 经验」）：

- **T1 服务端测试整个文件卡到超时** —— `server.close()` 被 undici 的 keep-alive 连接挂住；
  必须 `closeAllConnections()`。症状看起来像「测试挂死」，不像「close 没写对」
- **T2 `import { Request } from 'express'` 运行时报「does not provide an export named」** ——
  只当类型用的导入没写 `import type`，而 `tsc --noEmit` 放行
- **T3 `app.get('*')` 启动即抛「Missing parameter name」** —— express 5 的 path-to-regexp v8
  不再接受裸 `*`；404 兜底改用 `app.use`
- **T4 不带 `Content-Type` 的 POST 返回 500 而不是 400** —— express 5 的 `req.body` 是 `undefined`
- **T5 前端请求触发 CORS 报错** —— 多半是 `api.ts` 里写了绝对地址，绕过了 Vite proxy。
  正解不是加 `cors` 中间件
- 另外把 01-llm 的 T4（`@/` 别名与 loader）、T11（不用代码变换的 TS 特性）、T13（`--` 不能带）
  三条**跨阶段通用的坑**复制过来 —— 新项目最容易漏的正是它们

- [ ] **Step 6: 改 `docs/how-agent-works.html`**

那份讲解页的「每个文件负责哪一步」表现在是这样的（按纯 CLI 写的）：

| 文件 | 负责什么 |
|---|---|
| `src/cli/repl.ts` | 每轮调 runAgentTurn、打印、报错 |

补两行，并改掉 `runAgentTurn` 那行的说明（现在两个入口都走 `runSessionTurn`）：

| 文件 | 负责什么 |
|---|---|
| `src/server/app.ts` | HTTP 路由：把一轮请求交给同一个 runSessionTurn，再把结果序列化成 JSON |
| `web/src/components/ToolTrace.tsx` | 把服务端回的 items 渲染成工具轨迹气泡 |

并在「第一步」那张循环图下面补一句话：

> **同一条循环，两种前端。** CLI 与浏览器都调 `core/agent.ts` 的 `runSessionTurn`，
> 区别只在最后一步：一个把轨迹打到终端，一个把它塞进 HTTP 响应。

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent
git commit -m "docs: 02-agent 的四件套、troubleshooting 与讲解页同步"
```

---

### Task 17: 端到端冒烟

**Files:** 无（只跑验证）

**Interfaces:**
- Consumes: Task 1–16 的全部产物
- Produces: 一份如实记录的结果

- [ ] **Step 1: 全量质量门**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm run typecheck
pnpm test
cd web && pnpm run typecheck && pnpm run build
```
Expected: 三条全绿。**把实际数字记下来**（通过用例数、构建产物大小）

- [ ] **Step 2: 确认密钥没被带进任何产物**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git status --short
git check-ignore -v demos/02-agent/.env.local demos/02-agent/.sessions demos/02-agent/web/node_modules demos/02-agent/web/dist
grep -rn "$(grep -h DEEPSEEK_API_KEY demos/02-agent/.env.local | cut -d= -f2 | head -c 12)" \
  demos/02-agent/src demos/02-agent/web/src demos/02-agent/docs 2>/dev/null || echo "源码与文档里没有密钥"
```
Expected: `.env.local` / `.sessions` / `node_modules` / `dist` 都被忽略；源码里搜不到密钥前缀

- [ ] **Step 3: CLI 入口（真实 API）**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
printf '北京今天天气怎么样？\n' | pnpm --silent start 1>out.txt 2>err.txt
echo "--- stdout ---"; cat out.txt
echo "--- stderr ---"; cat err.txt
```
Expected: stdout 里先有 `[工具] weather({"city":"Beijing"}) → …`，再有 `AI: 北京今天 25°C，晴天。`

- [ ] **Step 4: CLI 会话恢复（验证日志格式升级真的向后兼容）**

```bash
# 用一个新的会话跑一轮，记下 stderr 里的 [session] <id>
printf '我叫小明\n' | pnpm --silent start 1>/dev/null 2>session.txt
id=$(grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{4}' session.txt | head -1)
printf '我叫什么？\n' | pnpm --silent start --resume "$id"
```
Expected: 第二次回答里带出「小明」—— 说明 tool 消息与普通消息都正确落盘并回放

再顺手验一遍**老文件**（这是 Review Focus 第 1 条）：

```bash
cp ../01-llm/.sessions/*.jsonl .sessions/ 2>/dev/null && ls -la .sessions/
# 挑一个 01-llm 留下的旧 id 跑（那是本改造之前写下的格式）
```
Expected: 不报错、不出现「跳过了 N 行坏行」的警告，历史能正常恢复

- [ ] **Step 5: HTTP 接口（真实 API）**

```bash
pnpm start:server &
sleep 1
id=$(curl -sX POST localhost:3000/api/sessions | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"北京今天天气怎么样？"}'
curl -s "localhost:3000/api/sessions/$id/messages"
kill %1
```
Expected: 第一条响应里有 `items` 含 `weather` 轨迹与 `reply`；第二条把三项都返回

- [ ] **Step 6: 浏览器端到端**

```bash
pnpm start:server            # 终端 A
cd web && pnpm dev           # 终端 B
```
逐条确认并记录实际结果：

1. http://localhost:5173 问「北京今天天气怎么样？」→ 先出现 `⚙ weather` 轨迹块，再出现回答
2. 问「1+2*3 等于几」→ 看到 `calculator` 轨迹
3. 问「现在几点」→ 看到 `get_time` 轨迹
4. 刷新页面 → 历史完整（user / tool / assistant 三种气泡都在）
5. 连刷三次页面 → 服务端会话数不增长
6. 杀掉服务端 → 刷新页面出现「会话已失效」提示而不是白屏；再发消息能自动新建会话
7. 输入框在等待回答期间是禁用的

- [ ] **Step 7: 如实报告**

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

- `pnpm run typecheck` 通过（服务端）；`pnpm --dir web run typecheck` 通过（前端）
- `pnpm test` 全绿
- `pnpm --dir web run build` 成功
- 浏览器与 CLI 两个入口都能跑通天气例子，且**轨迹可见**
- 五份文档（README / ARCHITECTURE / DECISIONS / EVALUATION / troubleshooting）与代码一致

**明确不达标的一项：前端没有自动化测试。**
`web/src/chatReducer.ts` 是纯函数、本来最容易测，但本次不引 vitest（spec D19）。
它被拆成纯模块是**为了让将来补测试不必重构**，不是为了现在有覆盖。
同理，`.env.local` 之外的真实 API 冒烟全部是手动的，不进 `pnpm test`。

半年后回看这份计划时，不能把「测试全绿」理解成「整个项目都有测试覆盖」——
服务端有，前端没有，这个差别要一直写在 `EVALUATION.md` 里。


