# ai-chat M2b（命令层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话在进程内可控 —— `/clear` 清空上下文、`/history` 查看历史、`/model` 查看与中途切换模型。

**Architecture:** 命令拆成两半。`core/commands.ts` 只做**解析 + 改 `Session` + 返回结构化结果**（纯逻辑，全部可离线测）；`cli/render.ts` 负责**把结果打印出来**。之所以拆开，是因为 `core` 不许写 stdout（分层单向 `cli → core → llm`）。命令在 `session.append('user', …)` **之前**处理，因此永不进入对话上下文。

**Tech Stack:** Node 22（原生 TS 类型擦除）、pnpm、`node --test`。零运行时依赖。

**Spec:** `demos/01-llm/docs/superpowers/specs/2026-09-24-ai-chat-m2-design.md`（本计划实现其 §3 D-M2-8 ~ D-M2-10、§10、§6 的 `core/commands.ts` 与 `Session` 部分）

**前置计划:** `2026-09-24-ai-chat-m2a-streaming.md` —— **必须先完成 M2a**。它落地了本计划依赖的两样东西：`Session` 的 `model` 字段（构造函数已改为 `constructor(model: string)`）与 `ChatOptions` 的 per-call 模型传递。本计划**不再改动** `llm/` 任何文件。

## Global Constraints

- Node ≥ 22（本项目在 **v22.23.2** 验证）；**不引入构建步骤**
- ESM（`"type": "module"`）；包管理器 pnpm
- **零运行时依赖**；devDependency 仅 `typescript` + `@types/node`
- 分层单向：`cli → core → llm`；`llm` / `core` **不 import `node:readline`、不写 `process.stdout` / `process.stderr`**
- 源码用 `@/` 指向 `src/`；单文件跑测试用 `node --import ./loader.mjs --test test/<name>.test.ts`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（会被 `node --test` 当测试跑并计入用例数）
- 所有验证命令在 `demos/01-llm/` 下执行；测试不依赖真实网络
- **命令永不进入对话上下文**

## 起点状态（M2a 完成后）

```text
TypeCheck: 退出码 0
Test:      54/54 通过
           config 3 / deepseek 20 / index 1 / render 10 / repl 7 / session 3 / sse 12
Session:   构造函数已是 constructor(model: string)，已有 model getter/setter
```

## 输出分流规则（本计划的关键约束）

| 流 | 内容 |
| --- | --- |
| **stdout** | 用户主动要看的：模型回答 + **命令结果**（`/history` 列表、`/model` 当前模型、`/clear` 反馈） |
| **stderr** | 用户没主动要的：错误、`[思考中…]`、截断警告、**未知命令提示** |

## Review Focus

1. **`/clear` 之后下一轮请求的 `messages` 只剩 `[system, 当前提问]`** —— 历史真的清了
2. **命令不进入上下文**：输入 `/history` 后问一个问题，该请求的 `messages` 里**没有** `/history` 这条 user 消息
3. **`/model deepseek-v4-pro` 之后下一轮请求真的带上了新模型**（看 `options.model`，不是只看回显）
4. **`pnpm --silent start > answers.txt`** → `/history` 的结果出现在文件里，未知命令的提示**不**出现在文件里
5. **未知命令不发请求**：`/foo` 之后不应有任何 fetch
6. **回归**：M2a 的全部用例保持通过

---

### Task 1: `Session` 增加 `clear()` 与 `history()`

**Files:**
- Modify: `demos/01-llm/src/core/session.ts`
- Test: `demos/01-llm/test/session.test.ts`（追加 2 例）

**Interfaces:**
- Consumes: 无
- Produces:
  - `Session.clear(): number` —— 清空消息，返回清掉的条数，**不影响当前模型**
  - `Session.history(): Message[]` —— 返回消息列表的**副本**

> 这两个方法是 `/clear` 与 `/history` 的全部数据需求。它们放在 `Session` 而不是命令层，是因为「清空会话」和「读会话快照」本身就是会话状态的操作。
>
> `clear()` 返回条数是为了让反馈能说「已清空 N 条消息」而不是干巴巴的「已清空」——用户需要知道到底清掉了什么。

- [ ] **Step 1: 写失败测试**

在 `demos/01-llm/test/session.test.ts` 末尾追加：

```ts
test('clear 清空消息并返回条数，不影响当前模型', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');
  s.append('assistant', 'b');

  assert.equal(s.clear(), 2);
  assert.deepEqual(s.toMessages(''), []);
  // 清的是对话，不是会话配置
  assert.equal(s.model, 'deepseek-flash');
  // 再清一次返回 0，不报错
  assert.equal(s.clear(), 0);
});

test('history 返回副本，改它不影响会话内部', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  const snapshot = s.history();
  assert.deepEqual(snapshot, [{ role: 'user', content: 'a' }]);

  snapshot.push({ role: 'user', content: '偷偷加的' });
  assert.equal(s.history().length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/session.test.ts`
Expected: FAIL —— `s.clear is not a function` / `s.history is not a function`

- [ ] **Step 3: 实现**

在 `src/core/session.ts` 的 `set model` 之后、类结束之前插入：

```ts
  /**
   * 清空所有消息，返回清掉的条数。
   *
   * 不影响当前模型 —— `/clear` 清的是对话内容，不是会话配置。
   * 返回条数是为了让调用方能给出「已清空 N 条消息」这种有信息量的反馈。
   */
  clear(): number {
    const removed = this.messages.length;
    this.messages = [];
    return removed;
  }

  /**
   * 返回消息列表的**副本**。
   *
   * 返回副本而不是内部数组的引用：`/history` 的渲染只需要读，
   * 让它拿到引用就等于开了一个「顺手改到会话状态」的口子。
   */
  history(): Message[] {
    return this.messages.slice();
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/session.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: Commit**

```bash
git add src/core/session.ts test/session.test.ts
git commit -m "feat: add Session.clear and Session.history"
```

---

### Task 2: 命令解析与执行

**Files:**
- Create: `demos/01-llm/src/core/commands.ts`
- Test: `demos/01-llm/test/commands.test.ts`

**Interfaces:**
- Consumes: `Session`（`@/core/session.ts`，Task 1 的 `clear()` / `history()` / `model`）、`Message`（`@/core/types.ts`）
- Produces:
  - `type CommandName = 'clear' | 'history' | 'model'`
  - `const COMMAND_NAMES: readonly CommandName[]`
  - `type ParsedCommand = { kind: 'none' } | { kind: 'known'; name: CommandName; argument: string } | { kind: 'unknown'; input: string }`
  - `type CommandResult = { kind: 'cleared'; removed: number } | { kind: 'history'; messages: Message[] } | { kind: 'model-current'; model: string } | { kind: 'model-changed'; model: string }`
  - `function parseCommand(line: string): ParsedCommand`
  - `function executeCommand(name: CommandName, argument: string, session: Session): CommandResult`

> **为什么 `ParsedCommand` 是三态而不是「命令 / null」**：以 `/` 开头但名字不认识（`/foo`）需要与「不是命令」（`今天天气怎么样`）区分开 —— 前者要报「未知命令」，后者要发给模型。用 `null` 表达不了这个区别。
>
> **`/model` 不校验模型名**。理由：避免维护一份会过期的模型清单（`AI_CHAT_MODEL` 也没有校验）。写错的模型名会在下一次请求时由 API 报错，走现有错误路径到 stderr。这是**有意选择**，不是遗漏。

- [ ] **Step 1: 写失败测试 `test/commands.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, executeCommand, COMMAND_NAMES } from '@/core/commands.ts';
import { Session } from '@/core/session.ts';

test('不以 / 开头不是命令', () => {
  assert.deepEqual(parseCommand('今天天气怎么样'), { kind: 'none' });
  // 「/」不在行首也不算命令
  assert.deepEqual(parseCommand('路径是 a/b'), { kind: 'none' });
  assert.deepEqual(parseCommand('  '), { kind: 'none' });
});

test('已知命令解析出名字与参数', () => {
  assert.deepEqual(parseCommand('/clear'), { kind: 'known', name: 'clear', argument: '' });
  assert.deepEqual(parseCommand('/history'), { kind: 'known', name: 'history', argument: '' });
  assert.deepEqual(parseCommand('/model'), { kind: 'known', name: 'model', argument: '' });
  assert.deepEqual(parseCommand('/model deepseek-v4-pro'), {
    kind: 'known',
    name: 'model',
    argument: 'deepseek-v4-pro',
  });
});

test('前后空白被忽略，参数内部空白保留', () => {
  assert.deepEqual(parseCommand('  /clear  '), { kind: 'known', name: 'clear', argument: '' });
  assert.deepEqual(parseCommand('/model   deepseek-v4-pro   '), {
    kind: 'known',
    name: 'model',
    argument: 'deepseek-v4-pro',
  });
});

test('只有 /model 的参数允许含空格（原样保留，不校验）', () => {
  assert.deepEqual(parseCommand('/model a b'), {
    kind: 'known',
    name: 'model',
    argument: 'a b',
  });
});

test('未知命令与空命令报 unknown，原样保留输入', () => {
  assert.deepEqual(parseCommand('/foo'), { kind: 'unknown', input: '/foo' });
  assert.deepEqual(parseCommand('/'), { kind: 'unknown', input: '/' });
  assert.deepEqual(parseCommand('  /foo bar  '), { kind: 'unknown', input: '/foo bar' });
});

test('COMMAND_NAMES 与识别结果一致', () => {
  for (const name of COMMAND_NAMES) {
    assert.deepEqual(parseCommand(`/${name}`), { kind: 'known', name, argument: '' });
  }
});

test('executeCommand /clear 清空并返回条数', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');
  s.append('assistant', 'b');

  assert.deepEqual(executeCommand('clear', '', s), { kind: 'cleared', removed: 2 });
  assert.deepEqual(s.toMessages(''), []);
});

test('executeCommand /history 返回当前消息', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  assert.deepEqual(executeCommand('history', '', s), {
    kind: 'history',
    messages: [{ role: 'user', content: 'a' }],
  });
});

test('executeCommand /history 空会话返回空数组', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('history', '', s), { kind: 'history', messages: [] });
});

test('executeCommand /model 无参数是查询', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '', s), {
    kind: 'model-current',
    model: 'deepseek-flash',
  });
});

test('executeCommand /model 带参数是切换，且真的改到 Session', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', 'deepseek-v4-pro', s), {
    kind: 'model-changed',
    model: 'deepseek-v4-pro',
  });
  assert.equal(s.model, 'deepseek-v4-pro');
});

test('/model 不校验名字（有意为之）', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '随便写的名字', s), {
    kind: 'model-changed',
    model: '随便写的名字',
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/commands.test.ts`
Expected: FAIL —— `Cannot find package '@/core'` 指向的 `commands.ts` 不存在

- [ ] **Step 3: 实现 `src/core/commands.ts`**

```ts
// 斜杠命令的解析与执行。
//
// 这一层只做三件事：解析输入、改 Session、返回**结构化结果**。
// 它**不打印任何东西** —— core 层不许写 stdout/stderr，
// 「把结果变成文字」是 cli/render.ts 的职责。
//
// 好处：命令的全部行为都能在无 IO 的情况下断言。

import type { Message } from '@/core/types.ts';
import type { Session } from '@/core/session.ts';

/** 当前支持的命令名 */
export type CommandName = 'clear' | 'history' | 'model';

/**
 * 全部可用命令。
 *
 * 未知命令的提示文案由它拼出来（见 `cli/render.ts`），
 * 所以新增命令只要改这一处。
 */
export const COMMAND_NAMES: readonly CommandName[] = ['clear', 'history', 'model'];

/**
 * 一行输入的解析结果。
 *
 * 三态而不是「命令 / null」：以 `/` 开头但名字不认识（`/foo`）必须与
 * 「不是命令」（`今天天气怎么样`）区分开 —— 前者要报未知命令，
 * 后者要发给模型。用 null 表达不了这个区别。
 */
export type ParsedCommand =
  | { kind: 'none' }
  | { kind: 'known'; name: CommandName; argument: string }
  | { kind: 'unknown'; input: string };

/** 命令执行的结果，供 cli 层渲染 */
export type CommandResult =
  | { kind: 'cleared'; removed: number }
  | { kind: 'history'; messages: Message[] }
  | { kind: 'model-current'; model: string }
  | { kind: 'model-changed'; model: string };

/**
 * 解析一行输入。
 *
 * 识别规则：`line.trim()` 以 `/` 开头即视为命令尝试。
 *
 * @param line 原始输入行
 */
export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return { kind: 'none' };

  const body = trimmed.slice(1);
  // 名字到第一个空白为止，其余全是参数
  const spaceAt = body.search(/\s/);
  const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
  const argument = spaceAt === -1 ? '' : body.slice(spaceAt).trim();

  if ((COMMAND_NAMES as readonly string[]).includes(name)) {
    return { kind: 'known', name: name as CommandName, argument };
  }
  return { kind: 'unknown', input: trimmed };
}

/**
 * 执行一个已知命令。
 *
 * @param name 命令名
 * @param argument 参数（可能为空串）
 * @param session 被操作的会话；`/clear` 与 `/model` 会改它
 */
export function executeCommand(
  name: CommandName,
  argument: string,
  session: Session,
): CommandResult {
  switch (name) {
    case 'clear':
      return { kind: 'cleared', removed: session.clear() };

    case 'history':
      return { kind: 'history', messages: session.history() };

    case 'model':
      // 无参数 = 查询；有参数 = 切换
      if (argument === '') {
        return { kind: 'model-current', model: session.model };
      }
      // 刻意不校验名字：维护一份模型清单必然会过期，
      // 写错的模型名交给下一次请求的 API 报错（走 stderr 的现有错误路径）
      session.model = argument;
      return { kind: 'model-changed', model: argument };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/commands.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: 跑类型检查与全量测试**

Run: `pnpm run typecheck`
Expected: 退出码 0

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: Commit**

```bash
git add src/core/commands.ts test/commands.test.ts
git commit -m "feat: add slash command parsing and execution"
```

---

### Task 3: 命令结果的渲染

**Files:**
- Modify: `demos/01-llm/src/cli/render.ts`
- Test: `demos/01-llm/test/render.test.ts`（追加 6 例）

**Interfaces:**
- Consumes: `CommandResult` / `COMMAND_NAMES`（Task 2）
- Produces:
  - `function renderCommandResult(result: CommandResult, options: { output: NodeJS.WritableStream }): void`
  - `function renderUnknownCommand(input: string, options: { errorOutput: NodeJS.WritableStream }): void`

> 命令结果走 **stdout**、未知命令走 **stderr**。理由见本计划开头的分流规则。
>
> `/history` 每条截断到 200 字符：一个不截断的 `/history` 在长会话里会刷屏几百行，反而看不清。

- [ ] **Step 1: 写失败测试**

在 `demos/01-llm/test/render.test.ts` 末尾追加（并给顶部 import 补上 `renderCommandResult, renderUnknownCommand`）：

```ts
test('renderCommandResult /clear 反馈条数', () => {
  const out = collector();
  renderCommandResult({ kind: 'cleared', removed: 3 }, { output: out.stream });
  assert.equal(out.chunks.join(''), '已清空 3 条消息。\n');
});

test('renderCommandResult /model 查询与切换', () => {
  const a = collector();
  renderCommandResult({ kind: 'model-current', model: 'deepseek-flash' }, { output: a.stream });
  assert.equal(a.chunks.join(''), '当前模型：deepseek-flash\n');

  const b = collector();
  renderCommandResult({ kind: 'model-changed', model: 'deepseek-v4-pro' }, { output: b.stream });
  assert.equal(b.chunks.join(''), '已切换模型：deepseek-v4-pro\n');
});

test('renderCommandResult /history 编号列出，带角色前缀', () => {
  const out = collector();
  renderCommandResult(
    {
      kind: 'history',
      messages: [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '回答' },
      ],
    },
    { output: out.stream },
  );
  assert.equal(out.chunks.join(''), '1. [user] 问题\n2. [assistant] 回答\n');
});

test('renderCommandResult /history 空会话给明确提示', () => {
  const out = collector();
  renderCommandResult({ kind: 'history', messages: [] }, { output: out.stream });
  assert.equal(out.chunks.join(''), '(当前会话没有消息)\n');
});

test('renderCommandResult /history 每条截断到 200 字符', () => {
  const out = collector();
  const long = 'x'.repeat(250);
  renderCommandResult(
    { kind: 'history', messages: [{ role: 'user', content: long }] },
    { output: out.stream },
  );
  const text = out.chunks.join('');
  assert.equal(text, `1. [user] ${'x'.repeat(200)}…\n`);
});

test('renderUnknownCommand 写 stderr，可用列表来自 COMMAND_NAMES', () => {
  const err = collector();
  renderUnknownCommand('/foo', { errorOutput: err.stream });
  assert.equal(
    err.chunks.join(''),
    '未知命令：/foo。可用：/clear /history /model\n',
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/render.test.ts`
Expected: FAIL —— `renderCommandResult is not a function`

- [ ] **Step 3: 实现**

把 `src/cli/render.ts` 的导入改为：

```ts
import type { StreamEvent } from '@/core/types.ts';
import { COMMAND_NAMES, type CommandResult } from '@/core/commands.ts';
```

在文件末尾追加：

```ts
/** `/history` 里每条消息最多显示多少字符 */
const HISTORY_PREVIEW_CHARS = 200;

function truncate(text: string): string {
  if (text.length <= HISTORY_PREVIEW_CHARS) return text;
  return `${text.slice(0, HISTORY_PREVIEW_CHARS)}…`;
}

/**
 * 渲染命令的执行结果。
 *
 * 走 **stdout**：这是用户主动索要的输出，`pnpm start > answers.txt` 里
 * 应该能看到它（与错误、思考指示这些「用户没主动要的」区分开）。
 */
export function renderCommandResult(
  result: CommandResult,
  options: { output: NodeJS.WritableStream },
): void {
  const write = (text: string): void => {
    options.output.write(text + '\n');
  };

  switch (result.kind) {
    case 'cleared':
      write(`已清空 ${result.removed} 条消息。`);
      return;

    case 'model-current':
      write(`当前模型：${result.model}`);
      return;

    case 'model-changed':
      write(`已切换模型：${result.model}`);
      return;

    case 'history': {
      if (result.messages.length === 0) {
        write('(当前会话没有消息)');
        return;
      }
      result.messages.forEach((message, index) => {
        write(`${index + 1}. [${message.role}] ${truncate(message.content)}`);
      });
      return;
    }
  }
}

/**
 * 渲染未知命令的提示。
 *
 * 走 **stderr**：这是错误，不是用户要的输出。
 */
export function renderUnknownCommand(
  input: string,
  options: { errorOutput: NodeJS.WritableStream },
): void {
  // 可用列表由 COMMAND_NAMES 拼出来，**不硬编码**——
  // 硬编码的话，以后新增命令时这行提示不会跟着更新
  const available = COMMAND_NAMES.map((name) => `/${name}`).join(' ');
  options.errorOutput.write(`未知命令：${input}。可用：${available}\n`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/render.test.ts`
Expected: PASS（16 个用例）

- [ ] **Step 5: 跑类型检查与全量测试**

Run: `pnpm run typecheck`
Expected: 退出码 0

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: Commit**

```bash
git add src/cli/render.ts test/render.test.ts
git commit -m "feat: render command results and unknown-command hints"
```

---

### Task 4: repl 接入命令

**Files:**
- Modify: `demos/01-llm/src/cli/repl.ts`
- Test: `demos/01-llm/test/repl.test.ts`（追加 4 例）

**Interfaces:**
- Consumes: `parseCommand` / `executeCommand`（Task 2）、`renderCommandResult` / `renderUnknownCommand`（Task 3）
- Produces: 无新增导出

> **命令必须在 `session.append('user', …)` 之前处理**。否则 `/clear` 会作为一条 user 消息留在刚被它清空的历史里；`/history` 会让模型看到「用户查了历史」，污染后续推理。
>
> **未知命令不发请求**。它连 `chatStream` 都不该碰。

- [ ] **Step 1: 写失败测试**

在 `demos/01-llm/test/repl.test.ts` 末尾追加：

```ts
test('/clear 之后下一轮的 messages 只剩 system 与当前提问', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const { chunks, stream, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['第一问', '/clear', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  assert.equal(sent.length, 2);
  // 第二问发出时历史已被清空 —— /clear 生效了
  assert.deepEqual(sent[1], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '第二问' },
  ]);
  assert.ok(chunks.join('').includes('已清空'));
});

test('命令本身不进入上下文', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const { stream, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['/history', '问题']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  // /history 只触发一次请求（就是「问题」那次），且历史里没有 /history
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '问题' },
  ]);
});

test('/model 切换后下一轮请求带上新模型', async () => {
  const models: Array<string | undefined> = [];
  const { stream, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(_messages, options) {
      models.push(options?.model);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['第一问', '/model deepseek-v4-pro', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro']);
});

test('未知命令走 stderr，且不触发请求', async () => {
  let calls = 0;
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream() {
      calls += 1;
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['/foo']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
  });

  assert.equal(calls, 0);
  assert.ok(errChunks.join('').includes('未知命令'));
  assert.ok(!chunks.join('').includes('未知命令'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/repl.test.ts`
Expected: FAIL —— `/clear` 被执行成一次提问（`sent.length` 为 3 而非 2），`/foo` 触发了请求

- [ ] **Step 3: 实现**

把 `src/cli/repl.ts` 的导入改为：

```ts
import { createInterface } from 'node:readline';
import { Session } from '@/core/session.ts';
import { parseCommand, executeCommand } from '@/core/commands.ts';
import { createStreamRenderer } from '@/cli/render.ts';
import { renderCommandResult, renderUnknownCommand } from '@/cli/render.ts';
import type { LLMClient } from '@/llm/client.ts';
```

在 `repl.ts` 的 `while (true)` 循环里，把空行检查（`if (question === '') continue;`）之后、
`session.append('user', question)` **之前**插入：

```ts
    // 命令必须在 append 之前处理，所以它永远不会进入对话上下文。
    // 否则 `/clear` 会作为一条 user 消息留在刚被它清空的历史里，
    // `/history` 会让模型看到「用户查了历史」。
    const parsed = parseCommand(question);

    if (parsed.kind === 'unknown') {
      // 未知命令不发请求，走 stderr（它是错误，不是用户要的输出）
      renderUnknownCommand(parsed.input, { errorOutput: options.errorOutput });
      continue;
    }

    if (parsed.kind === 'known') {
      const result = executeCommand(parsed.name, parsed.argument, session);
      // 命令结果走 stdout：用户主动索要的输出
      renderCommandResult(result, { output: options.output });
      continue;
    }
```

（把两行 render 的导入合并成一行：

```ts
import { createStreamRenderer, renderCommandResult, renderUnknownCommand } from '@/cli/render.ts';
```

）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/repl.test.ts`
Expected: PASS（以实际输出为准；Task 4 新增 4 个用例）

- [ ] **Step 4b: 顺手清掉两处 M2a 遗留（都在本任务已改的 `repl.ts` 里）**

这两处由 M2a Task 6 的审查发现，当时因「只替换提问处理段」的范围划定未动。本任务本来就在改这个文件，
在此一并处理最省事。

**① 删除已成死代码的局部助手 `write`**（约 55–57 行）。它唯一的调用点是 M2a 之前的
`write(\`AI: ${result.content}\`)`；Task 6 把回答改走渲染器后它就没人用了。
`tsconfig` 未开 `noUnusedLocals`，**所以 typecheck 不会报** —— 只能靠人发现。
同时改掉紧跟其后 `writeError` 注释里「与 write 对称」那半句（`write` 没了，对称也就无从谈起）。

> **注意**：命令结果的打印**不走**这个 `write` —— 它走 `cli/render.ts` 的 `renderCommandResult`。
> 所以删掉它不会影响本任务的任何功能。

**② 修正 `writePrompt()` 上方那句注释**。它现在写的是：

```ts
      // 写在读取之前而不是本轮处理之后：EOF 时就不会多出一个孤零零的提示符
```

**但实测相反**（2026-09-24 复核）：提示符写在读取之前，而 EOF 只有读的时候才知道，
所以**最后一次提示符必然已经写出** —— `stdout` 以 `You: ` 结尾。这正是 `DECISIONS.md` D15
「已知边界」记录的行为，也是 `test/repl.test.ts` 里 `'You: AI: 你好\nYou: '` 那条断言钉住的形状。
注释与行为相反，比没有注释更坏。改为准确表述，例如：

```ts
      // 每次读取尝试前各写一次。注意：EOF 前那次也会写出，所以输出以 `You: ` 结尾
      // —— 这是 D15 的「已知边界」，不是 bug
```

**两个动作都不改变行为**，改完 `pnpm test` 应仍然全绿、用例数不变。

- [ ] **Step 5: 跑类型检查与全量测试**

Run: `pnpm run typecheck`
Expected: 退出码 0

Run: `pnpm test`
Expected: PASS（全绿）

- [ ] **Step 6: 手动验证分流（真实网络，需 key）**

Run:

```bash
printf '/history\n/model\n/model deepseek-v4-pro\n/foo\n用一句话说明什么是闭包\n' | \
  pnpm --silent start 1>"$CLAUDE_JOB_DIR/tmp/out.txt" 2>"$CLAUDE_JOB_DIR/tmp/err.txt"; echo "exit=$?"
echo "--- stdout ---"; cat "$CLAUDE_JOB_DIR/tmp/out.txt"
echo "--- stderr ---"; cat "$CLAUDE_JOB_DIR/tmp/err.txt"
```

Expected:
- stdout：`You: ` 提示、`(当前会话没有消息)`、`当前模型：deepseek-flash`、`已切换模型：deepseek-v4-pro`、一段回答
- stderr：`未知命令：/foo。可用：/clear /history /model`（+ 可能的 `[思考中…]`）
- **stdout 里没有 `未知命令`**

> ⚠️ 这一步会发**真实请求**。未获用户确认不要执行；跳过时在最终报告里如实标注「未验证」。

- [ ] **Step 7: Commit**

```bash
git add src/cli/repl.ts test/repl.test.ts
git commit -m "feat: handle slash commands in the REPL"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `demos/01-llm/HOW-IT-WORKS.md`
- Modify: `demos/01-llm/DECISIONS.md`
- Modify: `demos/01-llm/README.md`
- Modify: `README.md`（仓库根，阶段目录表的状态列）

**Interfaces:**
- Consumes: 无（纯文档）
- Produces: 与代码一致的文档

- [ ] **Step 1: 在 `HOW-IT-WORKS.md` 的数据流图后加一节**

在「流式：屏幕上看到的 ≠ 模型记得的」之后插入：

```markdown
## 命令：为什么它们不进上下文

`/clear` `/history` `/model` 在 `session.append('user', …)` **之前**被处理，
因此**永远不进入对话历史**。

这不是优化，是必须的：`/clear` 若先进历史再清空，那条 `/clear` 就留在了
刚被它清空的历史里；`/history` 若进历史，下一轮模型会看到「用户查了历史」。

处理路径（两条流的分工见 D13 / D-M2-10）：

```text
以 / 开头
  ├─ 名字不认识 → renderUnknownCommand → stderr，continue（不发请求）
  └─ 名字认识   → executeCommand(name, argument, session) → CommandResult
                   → renderCommandResult → stdout
                   → continue（不 append，不发请求）
```

`/clear` 清的是**对话内容**，不影响当前模型 —— 会话配置与对话历史是两回事。
```

- [ ] **Step 2: 在 `DECISIONS.md` 末尾追加 D23–D25**

```markdown
---

## D23. 命令逻辑在 `core/`，打印在 `cli/`

**决策**：`core/commands.ts` 只做「解析 + 改 Session + 返回结构化结果」，
`cli/render.ts` 负责把结果变成文字。

**理由**：`core` 不许写 stdout（分层单向 `cli → core → llm`）。
拆开后命令的全部行为都能在无 IO 的情况下断言 —— 12 个 `commands.test.ts`
用例没有一个需要捕获输出。

**代价**：多一层 `CommandResult` 联合类型与一个渲染分支。换来的是命令逻辑完全可测。

---

## D24. 命令永不进入对话上下文

**决策**：命令在 `session.append('user', …)` **之前**处理。

**理由**：这不是优化，是必须的。

- `/clear` 若先进历史再清空，那条 `/clear` 就留在了刚被它清空的历史里
- `/history` 若进历史，下一轮模型会看到「用户查了历史」，污染推理
- `/model` 若进历史，模型会以为用户在跟它讨论模型名

**代价**：`repl.ts` 的循环里多两个 `continue` 分支。

---

## D25. 命令结果走 stdout，未知命令走 stderr

**决策**：把 D13 的规则细化为两条线 ——

| 流 | 内容 |
| --- | --- |
| stdout | 用户**主动要看的**：模型回答 + 命令结果 |
| stderr | 用户**没主动要的**：错误、`[思考中…]`、截断警告、未知命令提示 |

**理由**：D13 原来的表述是「stdout 只承载模型回答」。但 `/history` 是用户显式索要的
输出，`pnpm start > answers.txt` 里看不到它反而反直觉 —— 用户要的东西应该出现在
他重定向的文件里。

**代价**：规则从「一条线」变成「要看用户是否主动索要」，判断成本略高。
但未知命令这类错误仍走 stderr，边界是清楚的。
```

- [ ] **Step 3: 改 `demos/01-llm/README.md`**

在「常用命令」表之后插入一节：

```markdown
## REPL 命令

| 命令 | 作用 |
| --- | --- |
| `/clear` | 清空当前会话的消息（不影响当前模型） |
| `/history` | 列出当前会话的消息，每条截断到 200 字符 |
| `/model` | 显示当前模型 |
| `/model <name>` | 切换模型，立即对后续请求生效 |

命令**不进入对话上下文**，也不会被发给模型。`/model` 不校验模型名 ——
写错的名字会在下一次请求时由 API 报错（走 stderr）。
```

把「当前能力边界 · 已实现」里补一条：

```markdown
- REPL 命令：`/clear` `/history` `/model`
```

把「尚未实现」列表里的 `命令：/clear /history /model /usage` 改为：

```markdown
- 命令：`/usage`（Token 统计尚未实现，属 M4）
```

把测试数量更新为实际值（Task 4 结束时是 **78**）。

- [ ] **Step 4: 改仓库根 `README.md` 的阶段目录表**

把 `demos/01-llm/` 一行的状态列改为：

```markdown
| `demos/01-llm/` | ai-chat | 阶段 0 · 实践项目 1（AI Chat） | 进行中：M1、M2 完成，M3–M7 待做 |
```

- [ ] **Step 5: 最终验证**

Run: `pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

Run: `grep -c '^```' HOW-IT-WORKS.md DECISIONS.md README.md ../../README.md`
Expected: 每个文件的 ``` 数量都是偶数

- [ ] **Step 6: Commit**

```bash
git add HOW-IT-WORKS.md DECISIONS.md README.md
git commit -m "docs: record slash command design and boundaries"
git add ../../README.md
git commit -m "docs: update stage status for M2"
```

---

## 完成标准

```text
TypeCheck: pnpm run typecheck  → 退出码 0
Lint:      N/A（本仓库未配置 linter）
Test:      pnpm test           → 全绿
Build:     N/A（noEmit，无构建产物）
冒烟:      Task 4 Step 6 —— 需用户确认后才执行；跳过则如实标注「未验证」
```
