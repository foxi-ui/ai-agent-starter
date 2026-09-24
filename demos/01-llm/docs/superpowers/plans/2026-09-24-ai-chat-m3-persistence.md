# ai-chat M3（会话持久化）Implementation Plan

> **后续进展（2026-09-24 补记）**：本计划正文里「**本次不新增任何测试**（用户决定）」
> 是**执行本计划当时**的口径，**已不是现行规则**。测试欠账已在同一日还清：
> 用例数 91 → 167，并按 20 条变异检查验证。详见 `DECISIONS.md` D38。
> 正文其余内容保留原样，作为这份计划的历史记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话活过进程 —— 每场对话落成 `.sessions/<id>.jsonl`，`--resume <id>` 能接着上次聊，`/sessions` 能列出历史会话。

**Architecture:** 会话日志是**事件流**（`meta` / `message` / `model` / `clear` 四种记录），回放即重建。`Session` 在三个变更点（`append` / `clear` / `set model`）通过注入的 `onChange` 回调**广播**变更，cli 收到就追加一行 —— 广播让它从结构上不可能漏写。`core/journal.ts` 只放纯逻辑与 `SessionStore` 接口，唯一碰 `node:fs` 的是 `cli/store.ts`，于是 core 仍然不做 IO。

**Tech Stack:** Node 22（原生 TS 类型擦除，无构建步骤）、pnpm、`node --test`。零运行时依赖，仅用 `node:fs` / `node:path` / `node:crypto` 内置模块。

**Spec:** `demos/01-llm/docs/superpowers/specs/2026-09-24-ai-chat-m3-design.md`（本计划实现其全部内容）

## Global Constraints

- Node ≥ 22（本项目在 **v22.23.2** 验证）；**不引入构建步骤**
- ESM（`"type": "module"`）；包管理器 pnpm
- **零运行时依赖**；devDependency 仅 `typescript` + `@types/node`
- 分层单向：`cli → core → llm`；`llm` / `core` **不 import `node:readline`、不写 `process.stdout` / `process.stderr`**，本增量进一步延伸为 **core 不 import `node:fs`**
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。判断标准：删掉所有类型标注后仍是合法 JS 的，才能用。注意 `tsc --noEmit` 对它们**放行**，只有运行时才炸
- 源码用 `@/` 指向 `src/`；单文件跑测试必须带 loader：`node --import ./loader.mjs --test test/<name>.test.ts`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（会被 `node --test` 当测试跑并计入用例数）
- 所有命令在 `demos/01-llm/` 下执行
- **本次不新增任何测试**（用户决定）。但被签名变更打破的旧用例必须同步修好，`pnpm test` 保持 **91/91 全绿**
- 密钥只经环境变量；任何贴出来的输出先做泄漏扫描

## 起点状态（已实测）

```text
TypeCheck: 退出码 0
Test:      91/91 通过（config 3 / commands 14 / deepseek 23 / index 1 /
                       render 10 / repl 15 / session 6 / sse 12 / …）
git:       main 分支，最新提交 4d74a05（本计划依赖它已提交的 spec）
```

## Review Focus

本次**不写自动化测试**，所以下面这份清单改用**人工审查**兜底 —— 每条都在 Task 8 的冒烟步骤里有对应项。这是最可能被写错、且写错了不容易被察觉的地方：

1. **`--resume` 后模型真的记得之前说过什么** —— 光看到 `[resumed]` 打印出来不算数，要看回答里有没有复述之前的内容
2. **打开一次会话，日志不该变长** —— 回放若误走了广播，每恢复一条历史就多写一行，打开两次日志翻两番。看文件行数
3. **`--resume ../../etc/passwd` 必须被拦下且退出码 1** —— id 会被拼进文件路径，这是路径穿越
4. **写盘失败（只读目录、磁盘满）不能让对话崩掉，也不能一声不吭** —— 期望 stderr 恰好一行警告、对话继续
5. **`/clear` 之后 resume，被清掉的消息不该回来** —— 这正是选事件流而非纯消息格式的理由
6. **`pnpm start --resume xxx`（不带 `--`）** —— 参数可能被 pnpm 自己吃掉。实测确认，并按结果写进 README
7. **回归**：现有 91 个用例的**断言一句都不改**，全部继续通过

---

### Task 1: `core/journal.ts` —— 日志格式、解析、回放、id 工具

**Files:**
- Create: `demos/01-llm/src/core/journal.ts`

**Interfaces:**
- Consumes: `@/core/types.ts` 的 `Message` / `Role`（已存在，不改）
- Produces: `SessionChange`、`SessionRecord`、`SessionSummary`、`LoadedSession`、`SessionStore`（类型）；`serializeRecord`、`parseRecord`、`replay`、`makeSessionId`、`isValidSessionId`（函数）。后续所有任务都依赖这一组名字与签名

- [ ] **Step 1: 写文件**

```ts
// 会话日志：记录格式、解析、回放，以及会话存储的接口。
//
// **纯逻辑** —— 这里不 import node:fs、不写 stdout/stderr。
// 真正读写文件的实现由 cli/store.ts 提供（实现下面这个 SessionStore 接口），
// 这样 core 层仍然可以在没有文件系统的前提下被推理和测试。
//
// 与 LLMClient 是同一个套路：接口在里层、实现在外层、调用方只认接口。

import type { Message, Role } from '@/core/types.ts';

/**
 * 会话状态的一次变更。
 *
 * `Session` 在三个变更点广播它，它同时也是日志里**除 meta 外的全部内容**。
 * 单独定义成一个联合（而不是直接复用 SessionRecord）是为了让 Session 的
 * 广播签名只覆盖「变更」，不含只在建文件时写一次的 meta。
 */
export type SessionChange =
  | { type: 'message'; role: Role; content: string }
  | { type: 'clear' }
  | { type: 'model'; model: string };

/** 日志里的一行 */
export type SessionRecord =
  | { type: 'meta'; id: string; createdAt: string; model: string }
  | SessionChange;

/**
 * 一个会话的概要，供 /sessions 展示。
 *
 * 刻意不含 createdAt：展示用的时间直接从 id 切（id 前 15 位就是本地时间），
 * 不必再经过 new Date(iso) + 时区换算 —— 那会让同一份文件在不同 TZ 的机器上
 * 显示成不同的时间，而 id 是死的、在哪台机器上都一样。
 */
export interface SessionSummary {
  id: string;
  /** `message` 记录的条数；`clear` / `model` 不算 */
  messageCount: number;
}

/** 一次 load 的结果 */
export interface LoadedSession {
  records: SessionRecord[];
  /** 被跳过的坏行数（JSON 解析失败、或形状不认识的行） */
  skipped: number;
}

/**
 * 会话存储的接缝。core 只认这个接口，实现由 cli 提供。
 *
 * 有了它，core 层完全不碰 node:fs；测试也能塞一个内存实现进来。
 */
export interface SessionStore {
  /** 创建会话文件并写入 meta 行；文件已存在时抛错（独占创建） */
  create(id: string, model: string): void;
  /** 追加一条变更记录；文件不存在时抛错 */
  append(id: string, change: SessionChange): void;
  /**
   * 读回全部记录。
   *
   * 「会话不存在」返回 null —— 那是正常分支，由调用方给出友好提示；
   * 其余 IO 错误（权限、目录不可读）**原样抛出**，两者不可混为一谈。
   */
  load(id: string): LoadedSession | null;
  /**
   * 列出全部会话，按 id 倒序（id 前缀是时间戳，故字典序倒序即时间倒序）。
   * 会话目录不存在时返回空数组，不抛错 —— 首次运行时目录还没被创建过。
   */
  list(): SessionSummary[];
}

/**
 * 会话 id 的形状：`YYYYMMDD-HHMMSS-xxxx`。
 *
 * 只允许数字、短横、小写十六进制 —— 不含 `/`、`.`，所以拼进路径时
 * 走不出会话目录。这是路径穿越的第一道防线（第二道在 cli/store.ts）。
 */
const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** 校验会话 id 是否合法。见 SESSION_ID_PATTERN 的说明 */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * 生成会话 id。
 *
 * @param now 当前时间；传入而不是内部取，测试才能喂固定值
 * @param suffix 4 位小写十六进制，避免同一秒内启动两次撞名
 */
export function makeSessionId(now: Date, suffix: string): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');

  // 逐段取本地时间分量，**不要用 toISOString()** —— 后者是 UTC，
  // 东八区会得到早 8 小时的文件名。那是个安静的错误：
  // `ls` 出来看着也像那么回事，只是时间对不上。
  //
  // 注意 getMonth() 是 0 基的，所以要 +1。
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;

  return `${date}-${time}-${suffix}`;
}

/**
 * 记录 → 一行文本（**不含换行符**）。
 *
 * 包一层而不是各处直接 JSON.stringify，是为了让「一行一条 JSON」这个格式
 * 只有一个落点 —— 将来要加字段或换格式，改这里就够了。
 */
export function serializeRecord(record: SessionRecord): string {
  return JSON.stringify(record);
}

/**
 * 一行文本 → 记录。空行或坏行返回 null，**不抛错**。
 *
 * 「坏行不抛错」是刻意的：进程被 kill 时会留下半行，文件也可能被人手改坏，
 * 一行损坏不该让整场会话不可恢复（对齐 spec 的 D-M3-6）。
 * 调用方通过计数得知跳过了多少行。
 */
export function parseRecord(line: string): SessionRecord | null {
  const trimmed = line.trim();
  // 空行不是坏行 —— 文件末尾那个换行 split 之后就是空串
  if (trimmed === '') return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // 非法 JSON：半行、或手改坏了
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  // 这里必须断言：JSON.parse 的返回值是 any，而我们刚刚确认过它是个普通对象。
  // 断言只用于把它降级成「键未知的对象」，之后每个字段都逐个 typeof 校验，
  // 没有一行代码相信 JSON 里的内容。
  const record = value as Record<string, unknown>;

  switch (record.type) {
    case 'meta':
      if (
        typeof record.id !== 'string' ||
        typeof record.createdAt !== 'string' ||
        typeof record.model !== 'string'
      ) {
        return null;
      }
      return { type: 'meta', id: record.id, createdAt: record.createdAt, model: record.model };

    case 'message': {
      const role = record.role;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
      if (typeof record.content !== 'string') return null;
      return { type: 'message', role, content: record.content };
    }

    case 'clear':
      return { type: 'clear' };

    case 'model':
      if (typeof record.model !== 'string') return null;
      return { type: 'model', model: record.model };

    default:
      // 不认识的 type 也当坏行跳过。将来真加了新记录类型，
      // 旧版本程序读到它会跳过而不是崩 —— 这条路径顺便充当了格式兼容位。
      return null;
  }
}

/**
 * 按顺序折叠记录，重建会话状态。
 *
 * @returns messages 重建出的历史；model 为 null 表示文件里既没有 meta
 *          也没有 model 记录（调用方回落到环境变量里的模型）
 */
export function replay(records: SessionRecord[]): {
  messages: Message[];
  model: string | null;
} {
  // 这两个变量就是本次回放的全部状态
  const messages: Message[] = [];
  let model: string | null = null;

  for (const record of records) {
    switch (record.type) {
      case 'meta':
        // 只有首个 meta 生效 —— 它是文件创建时写下的初始模型。
        // 后面若还有 meta（正常不会），不覆盖。
        if (model === null) model = record.model;
        break;

      case 'message':
        messages.push({ role: record.role, content: record.content });
        break;

      case 'model':
        model = record.model;
        break;

      case 'clear':
        // **只清消息、不清模型** —— 必须与 Session.clear() 的语义严格对齐：
        // `/clear` 清的是对话内容，不是会话配置（见 core/session.ts）。
        // 这里若顺手把 model 也置空，resume 出来的模型就会和清空前不一致。
        messages.length = 0;
        break;
    }
  }

  return { messages, model };
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm run typecheck`
Expected: 退出码 0，无输出

- [ ] **Step 3: 提交**

```bash
git add demos/01-llm/src/core/journal.ts
git commit -m "feat: 会话日志的记录类型、解析、回放与 id 工具"
```

---

### Task 2: `cli/args.ts` —— 命令行参数解析

**Files:**
- Create: `demos/01-llm/src/cli/args.ts`

**Interfaces:**
- Consumes: `isValidSessionId`（Task 1）
- Produces: `Args` 类型；`parseArgs(argv: string[]): Args` —— 非法输入抛 `Error`（消息里带用法）

- [ ] **Step 1: 写文件**

```ts
// 命令行参数解析。
//
// 单独一个文件、纯函数、抛错而不打印：这样它能在不碰 process 的前提下被推理。
// 「把错误信息写出去 + 设退出码」留在 src/index.ts（唯一允许碰 process 的地方）。

import { isValidSessionId } from '@/core/journal.ts';

/** 本次启动的形态：开新会话，或恢复一个已存在的会话 */
export type Args = { kind: 'fresh' } | { kind: 'resume'; id: string };

/** 用法提示。出错时附在错误信息后面 —— 用户看到的第一眼就知道该怎么写 */
const USAGE = '用法：pnpm start [-- --resume <会话 id>]';

/**
 * 解析 `process.argv.slice(2)`（即去掉 node 与脚本路径之后的部分）。
 *
 * @throws 参数非法时抛出 Error，消息里带一行用法
 */
export function parseArgs(argv: string[]): Args {
  if (argv.length === 0) return { kind: 'fresh' };

  const [flag] = argv;

  // 未知参数**必须报错，不能忽略**。
  // 反例：`--resum xxx`（少一个 e）若被静默忽略，程序会开一个全新会话，
  // 用户以为续上了、实际上前面聊的全丢了 —— 这种失败没有任何提示，
  // 比直接报错糟糕得多。
  if (flag !== '--resume') {
    throw new Error(`未知参数：${flag}\n${USAGE}`);
  }

  if (argv.length === 1) {
    throw new Error(`--resume 需要一个会话 id\n${USAGE}`);
  }

  if (argv.length > 2) {
    throw new Error(`参数过多：${argv.slice(2).join(' ')}\n${USAGE}`);
  }

  // 走到这里 argv.length 必为 2
  const id = argv[1];

  // id 会被拼进文件路径，所以必须过白名单。
  // `--resume ../../etc/passwd` 就是一次路径穿越 —— 见 core/journal.ts 的
  // SESSION_ID_PATTERN 与 cli/store.ts 的第二道防线。
  if (!isValidSessionId(id)) {
    throw new Error(`会话 id 不合法：${id}\n${USAGE}`);
  }

  return { kind: 'resume', id };
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 3: 提交**

```bash
git add demos/01-llm/src/cli/args.ts
git commit -m "feat: --resume 的命令行参数解析"
```

---

### Task 3: `cli/store.ts` —— 唯一碰 `node:fs` 的地方

**Files:**
- Create: `demos/01-llm/src/cli/store.ts`

**Interfaces:**
- Consumes: `parseRecord` / `serializeRecord` / `isValidSessionId`（Task 1）；`SessionStore` / `LoadedSession` / `SessionChange` / `SessionRecord` / `SessionSummary`（Task 1 的类型）
- Produces: `createFileStore(dir: string): SessionStore`

- [ ] **Step 1: 写文件**

```ts
// 会话存储的文件实现 —— 全项目唯一读写会话日志的地方。
//
// 放在 cli 层而不是 core：core 不做 IO（它只认 core/journal.ts 里的
// SessionStore 接口），这样解析与回放逻辑仍然可以脱离文件系统被推理。
//
// 文件名即会话 id：<id>.jsonl。id 的格式保证了它不含路径分隔符。

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  isValidSessionId,
  parseRecord,
  serializeRecord,
  type LoadedSession,
  type SessionChange,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from '@/core/journal.ts';

const FILE_SUFFIX = '.jsonl';

/** meta 记录在联合里的具体类型，用于给 Array.find 写类型谓词 */
type MetaRecord = Extract<SessionRecord, { type: 'meta' }>;

export function createFileStore(dir: string): SessionStore {
  // 目录可能还不存在 —— 会话目录是运行时产物，不在仓库里。
  // recursive: true 让「已存在」不报错，于是不需要先 existsSync 判断
  // （那样还得处理 TOCTOU，虽然这里无所谓，但少一个分支）。
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true });
  };

  /**
   * id → 绝对路径，顺带确认它没跑到目录外面去。
   *
   * 第一道防线是 isValidSessionId 的白名单正则，这里是第二道。
   * 两道都要有：正则保证「现在的 id 长什么样」，这道保证「即使将来
   * 正则被放宽、或有人绕过了正则，也走不出会话目录」。
   */
  const pathOf = (id: string): string => {
    if (!isValidSessionId(id)) {
      throw new Error(`会话 id 不合法：${id}`);
    }
    const root = resolve(dir);
    const full = resolve(root, id + FILE_SUFFIX);
    if (!full.startsWith(root + sep)) {
      throw new Error(`会话路径越界：${id}`);
    }
    return full;
  };

  const create = (id: string, model: string): void => {
    ensureDir();
    const meta: SessionRecord = {
      type: 'meta',
      id,
      // 存 UTC 的 ISO 串：它是无歧义的机器可读时间。
      // 给人看的时间不走这里，走 id（见 core/journal.ts 的说明）。
      createdAt: new Date().toISOString(),
      model,
    };
    // flag 'wx' = **独占创建**：文件已存在就抛错，绝不覆盖。
    // 用默认的 'w' 会在 id 撞名时静默截断掉已有会话 —— 那是数据丢失，
    // 而且用户要过很久才会发现。宁可让启动失败。
    writeFileSync(pathOf(id), serializeRecord(meta) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
  };

  const append = (id: string, change: SessionChange): void => {
    ensureDir();
    appendFileSync(pathOf(id), serializeRecord(change) + '\n', { encoding: 'utf8' });
  };

  const load = (id: string): LoadedSession | null => {
    const path = pathOf(id);

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      // 只有「文件不存在」才是正常分支，返回 null 让调用方给友好提示；
      // 权限之类的 IO 错误必须抛出去 —— 把它伪装成「会话不存在」会让人
      // 去查一个根本不存在的问题（文件明明就在那儿）。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const records: SessionRecord[] = [];
    let skipped = 0;

    for (const line of text.split('\n')) {
      const record = parseRecord(line);
      if (record !== null) {
        records.push(record);
        continue;
      }
      // 空行不算坏行：文件末尾那个换行 split 之后就是一个空串
      if (line.trim() !== '') skipped += 1;
    }

    return { records, skipped };
  };

  const list = (): SessionSummary[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // 首次运行时目录还没被创建过，这是正常情况而不是错误
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const summaries: SessionSummary[] = [];

    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;

      const id = name.slice(0, -FILE_SUFFIX.length);
      // 不是本工具命名的文件，跳过（比如别人放进来的笔记）
      if (!isValidSessionId(id)) continue;

      let loaded: LoadedSession | null;
      try {
        loaded = load(id);
      } catch {
        // 单个文件读不了就跳过，而不是让整条 /sessions 失败 ——
        // 一个坏文件不该毁掉整个列表。注意 resume 那条路径仍会如实报错，
        // 因为它只读一个文件、且用户明确指名了它。
        continue;
      }
      if (loaded === null) continue;

      summaries.push({
        id,
        messageCount: loaded.records.filter((record) => record.type === 'message').length,
      });
    }

    // id 以 YYYYMMDD-HHMMSS 开头，所以字典序倒序就是时间倒序。
    // 用 id 排序而不是文件 mtime：mtime 会被人手动 mv、cp 之类的操作改掉。
    summaries.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    return summaries;
  };

  return { create, append, load, list };
}
```

> `pathOf` 里两处都要看住：`resolve(root, id + FILE_SUFFIX)` 负责拼出绝对路径，`full.startsWith(root + sep)` 负责确认它没跑出去。**`sep` 不能省** —— 只比 `startsWith(root)` 的话，`/tmp/sessions-evil` 这种同前缀的兄弟目录也会被放行。

- [ ] **Step 2: 类型检查**

Run: `pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 3: 临时手工验证（不写测试文件，用一次性脚本）**

```bash
cd demos/01-llm
node --import ./loader.mjs --input-type=module -e "
import { createFileStore } from './src/cli/store.ts';
import { makeSessionId } from './src/core/journal.ts';
const store = createFileStore('/tmp/ai-chat-probe');
const id = makeSessionId(new Date(), 'beef');
store.create(id, 'deepseek-flash');
store.append(id, { type: 'message', role: 'user', content: '你好' });
store.append(id, { type: 'clear' });
console.log(store.load(id));
console.log(store.list());
try { store.load('../../etc/passwd'); } catch (e) { console.log('已拦下:', e.message); }
"
```

Expected：打印出 `{ records: [meta, message, clear], skipped: 0 }`、`[ { id: '…-beef', messageCount: 1 } ]`、`已拦下: 会话 id 不合法`。验证完删掉 `/tmp/ai-chat-probe`。

- [ ] **Step 4: 提交**

```bash
git add demos/01-llm/src/cli/store.ts
git commit -m "feat: 会话日志的文件存储实现，含路径穿越防护"
```

---

### Task 4: `core/session.ts` —— 变更广播

**Files:**
- Modify: `demos/01-llm/src/core/session.ts`

**Interfaces:**
- Consumes: `SessionChange`（Task 1）
- Produces: `SessionOptions`；`Session` 构造函数变为 `constructor(model: string, options?: SessionOptions)`。**方法签名一个都不变** —— `append` / `toMessages` / `model` / `clear` / `history` 全部保持原样

- [ ] **Step 1: 改类注释**

把文件开头第 1–4 行的注释替换为：

```ts
// 会话状态：按顺序累积对话消息。
//
// 只负责「记住说过什么」，不碰网络、也不负责打印。
//
// 默认仍然是**无副作用**的纯类：不传 onChange 时，它的行为与 M1 完全一致。
// 需要落盘时由调用方注入一个回调，三个变更点改完状态就广播一次 ——
// 广播比「调用方记得在每处补写」可靠，因为 `/clear` 与 `/model <name>`
// 是 executeCommand **内部**改的状态，调用方看不见它们。
```

- [ ] **Step 2: 加 `SessionOptions` 并改构造函数**

在 `import type { Message, Role } …` 下面加一行 import：

```ts
import type { SessionChange } from '@/core/journal.ts';
```

在 `export class Session {` 之前插入：

```ts
/** 构造 Session 时的可选项 */
export interface SessionOptions {
  /** 回放得到的历史消息。不传即空会话 */
  history?: Message[];
  /** 变更广播。不传则完全退回「无副作用」的纯行为 */
  onChange?: (change: SessionChange) => void;
}
```

把字段声明与构造函数改成：

```ts
  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[];

  /**
   * 本会话当前使用的模型。
   *
   * 它属于「会话状态」而不是「client 配置」——`/model` 能中途切换它，
   * 每次请求再把它作为 per-call 参数传给 client。
   */
  private currentModel: string;

  /** 变更广播回调；不传就是 undefined，此时这个类与 M1 的行为完全一致 */
  private onChange?: (change: SessionChange) => void;

  /**
   * @param model 初始模型，通常来自 `resolveConfig` 的 `config.model`
   * @param options 初始历史与变更广播，都可选
   */
  constructor(model: string, options: SessionOptions = {}) {
    // 刻意不用 `constructor(private currentModel: string)` 这种参数属性写法：
    // 本项目靠 Node 的原生类型擦除直接跑 .ts，而擦除模式（strip-only）
    // 不支持 TS 独有的参数属性语法，会在运行时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    // 注意 tsc --noEmit 不会拦下它 —— 类型检查能过、运行才炸，所以只能靠这条注释守着。
    this.currentModel = model;

    // 回放结果直接铺成初始状态，**不经过 append**。
    // 这是必须的：构造时若也广播，每恢复一条历史就多写一行日志 ——
    // 打开一次会话，文件就翻一倍。
    //
    // 复制一份而不是直接引用调用方的数组，免得外部还拿着它改。
    this.messages = options.history ? [...options.history] : [];

    this.onChange = options.onChange;
  }
```

- [ ] **Step 3: 三个变更点各加一次广播**

`append` 改成：

```ts
  append(role: Role, content: string): void {
    this.messages.push({ role, content });
    // **先改内存、再广播**是刻意的顺序：广播的实现（写文件）抛错时，
    // 内存状态已经改好了，不会留下「推了一半」的中间态。
    // 磁盘落后于内存 + 一次警告，是选定的降级方向（见 cli/repl.ts）。
    this.onChange?.({ type: 'message', role, content });
  }
```

`set model` 改成：

```ts
  /** 切换当前模型；只影响后续请求，不改动已有消息 */
  set model(name: string) {
    this.currentModel = name;
    this.onChange?.({ type: 'model', model: name });
  }
```

`clear` 改成：

```ts
  clear(): number {
    const removed = this.messages.length;
    this.messages = [];
    this.onChange?.({ type: 'clear' });
    return removed;
  }
```

> **`get model`、`toMessages()`、`history()` 一行都不要动。** 它们是只读操作，绝不能广播 —— 尤其 `/model`（无参数）走的是 `get model`，只查一下不该往日志里写东西。现有用例 `executeCommand /model 查询分支一次都不写 session.model` 正是钉这条的。

- [ ] **Step 4: 跑旧测试，确认一条都没坏**

Run: `pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；**91/91 通过**。构造函数新增的参数是可选的，所以 `new Session('deepseek-flash')` 这类旧调用一行都不用改

- [ ] **Step 5: 提交**

```bash
git add demos/01-llm/src/core/session.ts
git commit -m "feat: Session 支持变更广播与初始历史，默认行为不变"
```

---

### Task 5: `/sessions` 命令（core + render）并修 `commands.test.ts`

**Files:**
- Modify: `demos/01-llm/src/core/commands.ts`
- Modify: `demos/01-llm/src/cli/render.ts`
- Modify: `demos/01-llm/test/commands.test.ts`（只补 `deps` 参数，**断言一句不改**）

**Interfaces:**
- Consumes: `SessionSummary` / `SessionStore`（Task 1）
- Produces: `CommandDeps`；`CommandName` 增加 `'sessions'`；`CommandResult` 增加 `{ kind: 'sessions'; sessions: SessionSummary[]; currentId: string }`；`executeCommand(name, argument, session, deps)`

- [ ] **Step 1: 改 `core/commands.ts` 的类型**

顶部 import 加一行：

```ts
import type { SessionSummary, SessionStore } from '@/core/journal.ts';
```

命令名与清单：

```ts
/** 当前支持的命令名 */
export type CommandName = 'clear' | 'history' | 'model' | 'sessions';

/**
 * 全部可用命令。
 *
 * 未知命令的提示文案由它拼出来（见 `cli/render.ts`），
 * 所以新增命令只要改这一处。
 */
export const COMMAND_NAMES: readonly CommandName[] = ['clear', 'history', 'model', 'sessions'];
```

结果联合加一个成员：

```ts
  | { kind: 'model-changed'; model: string }
  | { kind: 'sessions'; sessions: SessionSummary[]; currentId: string };
```

新增依赖注入类型（放在 `CommandResult` 之前）：

```ts
/**
 * 命令层需要的外部依赖。
 *
 * `/sessions` 要读会话目录，而 core 层不做 IO —— 所以由调用方把
 * 已经构造好的 store 传进来。与 LLMClient 同一个套路：
 * 接口在里层、实现在外层、调用方只认接口。
 */
export interface CommandDeps {
  store: SessionStore;
  /** 当前会话的 id，用于在 /sessions 列表里打 * 标记 */
  currentSessionId: string;
}
```

- [ ] **Step 2: 改 `executeCommand` 的签名与分支**

```ts
export function executeCommand(
  name: CommandName,
  argument: string,
  session: Session,
  deps: CommandDeps,
): CommandResult {
```

在 `switch` 里 `case 'model'` 之后追加：

```ts
    case 'sessions':
      // 列表来自注入的 store —— core 自己一个文件都不读
      return {
        kind: 'sessions',
        sessions: deps.store.list(),
        currentId: deps.currentSessionId,
      };
```

> 这个 `switch` 没有 `default`，它的穷尽性守卫是**返回注解** `: CommandResult`（见文件里已有的那段说明）—— 新增命令名却忘了在这里处理时编译器会报 TS2366。

- [ ] **Step 3: 给 `renderCommandResult` 加渲染分支**

在 `cli/render.ts` 的 `switch` 里，`case 'history'` 之后、`default` 之前插入：

```ts
    case 'sessions': {
      if (result.sessions.length === 0) {
        write('(还没有历史会话)');
        return;
      }
      for (const session of result.sessions) {
        // 当前会话行首打 *，其余行首补一个空格，这样两列对齐
        const marker = session.id === result.currentId ? '*' : ' ';
        write(
          `${marker} ${session.id}  ${formatSessionTime(session.id)}  ${session.messageCount} 条`,
        );
      }
      return;
    }
```

在 `truncate()` 函数附近新增：

```ts
/**
 * 从会话 id 里切出 `MM-DD HH:MM` 供展示。
 *
 * 直接切片而不是解析 meta 里的 createdAt：id 里的时间**本来就是本地时间**
 * （见 core/journal.ts 的 makeSessionId），切片零换算、且在哪台机器上都一样。
 * 走 createdAt 则要 new Date(iso) 再取本机时区，同一份文件换个 TZ 就显示成
 * 另一个时间 —— 列表是拿来比对的，那样很别扭。
 *
 * id 的格式已由 isValidSessionId 保证，所以这里的切片不会越界。
 */
function formatSessionTime(id: string): string {
  // YYYYMMDD-HHMMSS-xxxx
  // 0123456789...
  return `${id.slice(4, 6)}-${id.slice(6, 8)} ${id.slice(9, 11)}:${id.slice(11, 13)}`;
}
```

> `cli/render.ts` **不需要新增 import**：这个分支只从 `result` 上取字段，而 `CommandResult` 已经由第 12 行的既有 import 带进来了。

- [ ] **Step 4: 修 `test/commands.test.ts` —— 只补 `deps`，断言不动**

在文件顶部 import 区加：

```ts
import type { SessionStore } from '@/core/journal.ts';
```

在第一个 `test(...)` 之前加一个局部假实现（**不要放到 `test/` 下的独立文件里**，那会被 `node --test` 当成测试文件）：

```ts
// 假 store：/sessions 命令唯一需要的外部依赖。
// 本次不给它加断言 —— 只为了让现有的 executeCommand 调用点能编译通过。
function fakeStore(): SessionStore {
  return {
    create() {},
    append() {},
    load() {
      return null;
    },
    list() {
      return [];
    },
  };
}

const deps = { store: fakeStore(), currentSessionId: '20260924-143022-a3f1' };
```

然后把该文件里**每一处** `executeCommand(...)` 调用的最后一个参数后面补上 `, deps`。共 8 处：

| 行 | 调用 |
| --- | --- |
| 58 | `executeCommand('clear', '', s)` |
| 66 | `executeCommand('history', '', s)` |
| 74 | `executeCommand('history', '', s)` |
| 79 | `executeCommand('model', '', s)` |
| 87 | `executeCommand('model', 'deepseek-v4-pro', s)` |
| 96 | `executeCommand('model', '随便写的名字', s)` |
| 109 | `executeCommand('model', '', s)` |
| 144 | `executeCommand('model', '', s)` |

**断言一律不动**（`assert.deepEqual(executeCommand('clear', '', s, deps), …)` 的期望值保持原样）。这一步的验收标准就是「改完 91 个用例仍然全绿、一条断言都没被改过」。

- [ ] **Step 5: 跑测试**

Run: `pnpm run typecheck && pnpm test`
Expected: 退出码 0；**91/91 通过**（用例数不变）

- [ ] **Step 6: 提交**

```bash
git add demos/01-llm/src/core/commands.ts demos/01-llm/src/cli/render.ts demos/01-llm/test/commands.test.ts
git commit -m "feat: /sessions 命令列出历史会话，当前会话打 * 标记"
```

---

### Task 6: `cli/repl.ts` + `src/index.ts` 组装，并修 `repl.test.ts`

**Files:**
- Modify: `demos/01-llm/src/cli/repl.ts`
- Modify: `demos/01-llm/src/index.ts`
- Modify: `demos/01-llm/test/repl.test.ts`（15 处 `runRepl(` 调用各补三个字段，**断言一句不改**）

**Interfaces:**
- Consumes: 前五个任务的全部产物
- Produces: `ReplOptions` 增加 `sessionId` / `history` / `store`；`runRepl` 签名不变

- [ ] **Step 1: 改 `cli/repl.ts` 的 `ReplOptions`**

```ts
export interface ReplOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  prompt: string;
  /** 会话的初始模型，通常来自 resolveConfig 的 config.model */
  model: string;
  /** 本次会话的 id，落盘时用它定位文件 */
  sessionId: string;
  /** 恢复出来的历史消息；新会话传空数组 */
  history: Message[];
  /** 会话存储。落盘失败时的降级策略见下面的 onChange */
  store: SessionStore;
}
```

顶部 import 补：

```ts
import type { Message } from '@/core/types.ts';
import type { SessionStore } from '@/core/journal.ts';
```

- [ ] **Step 2: 改 `runRepl` 里的会话构造与命令调用**

把 `const session = new Session(options.model);` 替换为：

```ts
  // 落盘失败的降级：**只警告一次**。
  // 每轮都刷同一句会把屏幕占满，反而看不见别的；
  // 但绝不能静默 —— 那会让人以为存下来了，比直接报错更糟。
  let warnedWriteFailure = false;
  const reportWriteFailure = (error: unknown): void => {
    if (warnedWriteFailure) return;
    warnedWriteFailure = true;
    writeError(
      `[警告] 会话写入失败，本次对话将不再记录到磁盘：${(error as Error).message}`,
    );
  };

  // 整段对话的消息记录，循环期间一直被复用。
  //
  // onChange 就是「落盘」这件事的全部入口：Session 改完状态就喊一声，
  // 这里把这行追加进文件。之所以不让 repl 在每个变更点手动写，
  // 是因为 /clear 与 /model <name> 是 executeCommand **内部**改的状态，
  // 这里看不见它们 —— 靠记得写的写法迟早漏。
  const session = new Session(options.model, {
    history: options.history,
    onChange: (change) => {
      try {
        options.store.append(options.sessionId, change);
      } catch (error) {
        // 磁盘满、只读目录之类的问题不该打断正在进行的对话：
        // 内存照常往前走，只是磁盘落后了。
        reportWriteFailure(error);
      }
    },
  });
```

> `writeError` 定义在 `const session = …` **之前**，注意保持顺序（先 `const writeError = …` 再构造 session）。

把命令调用改成：

```ts
        const result = executeCommand(parsed.name, parsed.argument, session, {
          store: options.store,
          currentSessionId: options.sessionId,
        });
```

- [ ] **Step 3: 重写 `src/index.ts`**

```ts
// 程序入口：解析配置与参数 → 新建或恢复会话 → 组装依赖 → 启动 REPL。
//
// 这里是唯一允许直接接触 process 的地方
// （读环境变量与命令行、读写标准输入输出、决定退出码）。

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { runRepl } from '@/cli/repl.ts';
import { resolveConfig, type Config } from '@/cli/config.ts';
import { parseArgs, type Args } from '@/cli/args.ts';
import { createFileStore } from '@/cli/store.ts';
import { replay, makeSessionId, type LoadedSession } from '@/core/journal.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import type { Message } from '@/core/types.ts';

/** 会话目录的默认位置。跟着 cwd 走，可用 AI_CHAT_HOME 覆盖 */
const DEFAULT_SESSION_DIR = '.sessions';

// 配置与参数一起解析。
//
// **顺序是刻意的**：resolveConfig 排在 parseArgs 前面 ——
// 缺 key 与参数写错同时发生时先报缺 key，保持 M1 的既有行为不变。
// 两者都在创建任何文件之前退出。
let config: Config;
let args: Args;
try {
  config = resolveConfig(process.env);
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  // 错误信息写给 stderr 而不是 stdout，避免污染正常输出。
  // 退出码 1 表示失败，脚本和 CI 靠它判断这次运行是否正常
  console.error((error as Error).message);
  process.exit(1);
}

const sessionDir = process.env.AI_CHAT_HOME ?? DEFAULT_SESSION_DIR;
const store = createFileStore(sessionDir);

let sessionId: string;
let model: string;
let history: Message[];

if (args.kind === 'resume') {
  sessionId = args.id;
  model = config.model;
  history = [];

  let loaded: LoadedSession | null = null;
  try {
    loaded = store.load(sessionId);
  } catch (error) {
    console.error(`无法读取会话文件：${(error as Error).message}`);
    process.exit(1);
  }

  if (loaded === null) {
    // 不偷偷开一个新会话 —— 用户明确指名了要续哪个，
    // 静默换成新会话会把他前面聊的内容全丢掉，且他未必立刻发现
    console.error(`会话不存在：${sessionId}（会话目录：${resolve(sessionDir)}）`);
    process.exit(1);
  }

  if (loaded.skipped > 0) {
    // 坏行不致命：一行损坏不该让整场会话不可恢复
    console.error(`[警告] 已跳过 ${loaded.skipped} 行无法解析的记录`);
  }

  const replayed = replay(loaded.records);
  history = replayed.messages;
  // 文件里没记过模型（没有 meta 也没有 model 记录）时回落到环境变量的模型
  model = replayed.model ?? config.model;

  console.error(`[resumed] ${sessionId}（${history.length} 条消息）`);
} else {
  // 随机后缀避免同一秒内启动两次撞名
  sessionId = makeSessionId(new Date(), randomBytes(2).toString('hex'));
  model = config.model;
  history = [];

  try {
    store.create(sessionId, model);
  } catch (error) {
    // 建不了文件就别开始了：这场对话注定存不下来，早点死比聊完才发现好
    console.error(`无法创建会话文件：${(error as Error).message}`);
    process.exit(1);
  }

  console.error(`[session] ${sessionId}`);
}

// 依赖注入：工厂造出具体客户端，再交给 runRepl。
// runRepl 只认 LLMClient 接口，所以这里换成任何实现都能跑。
runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  // 模型回答与命令结果 → stdout
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

> `[session]` / `[resumed]` / `[警告]` 三行都走 **stderr**：它们是诊断信息，不是用户要的输出。stdout 仍然只承载模型回答与命令结果（D13 / D26）。

- [ ] **Step 4: 修 `test/repl.test.ts` —— 只补三个字段，断言不动**

在文件顶部 import 区加：

```ts
import type { SessionStore } from '@/core/journal.ts';
```

在 `fakeClient` 函数之后加一个局部假 store：

```ts
// 假 store：本次不落盘的断言，只为了让 runRepl 的 options 凑齐。
// 它必须**不抛错** —— 真 store 在磁盘出问题时会抛，那是 repl 的降级路径，
// 不属于这两个既有用例要覆盖的行为。
function fakeStore(): SessionStore {
  return {
    create() {},
    append() {},
    load() {
      return null;
    },
    list() {
      return [];
    },
  };
}
```

然后在该文件**每一处** `runRepl(client, { … })` 的 options 对象里补三行（共 **15 处**，用 `grep -n "runRepl(" test/repl.test.ts` 核对数量）。每处的 `prompt: 'You: ',` 之后插入：

```ts
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
```

**断言一律不动。** 这些用例断言的是 stdout/stderr 的内容，加了假 store 之后落盘只是空操作，输出形状一字不变。

- [ ] **Step 5: 跑测试**

Run: `pnpm run typecheck && pnpm test`
Expected: 退出码 0；**91/91 通过**

- [ ] **Step 6: 手动验证一条最小链路（不触网）**

```bash
cd demos/01-llm
# 缺 key 时仍然在创建任何文件之前退出，且不留下 .sessions 目录
DEEPSEEK_API_KEY= pnpm --silent start ; echo "exit=$?"
ls -d .sessions 2>/dev/null && echo "不该存在！" || echo "未创建会话目录 ✓"

# 非法 id 必须在触网前被拦下
DEEPSEEK_API_KEY=test pnpm --silent start -- --resume ../../etc/passwd ; echo "exit=$?"
```

Expected：两次都 `exit=1`，第二次的 stderr 里有 `会话 id 不合法` 与用法提示；`.sessions` 目录始终没被创建。

- [ ] **Step 7: 提交**

```bash
git add demos/01-llm/src/cli/repl.ts demos/01-llm/src/index.ts demos/01-llm/test/repl.test.ts
git commit -m "feat: 接上会话落盘与 --resume 的组装"
```

---

### Task 7: 忽略规则与四份文档

**Files:**
- Create: `demos/01-llm/.gitignore`
- Modify: `demos/01-llm/README.md`
- Modify: `demos/01-llm/ARCHITECTURE.md`
- Modify: `demos/01-llm/DECISIONS.md`
- Modify: `demos/01-llm/docs/troubleshooting.md`（仅当 Task 8 踩到新坑）

**Interfaces:**
- Consumes: 前六个任务的实现
- Produces: 无代码接口

- [ ] **Step 1: 建 `demos/01-llm/.gitignore`**

```gitignore
# 会话日志：运行时产物，不该进仓库
.sessions/
```

> **为什么新建一个项目级 `.gitignore` 而不是改根目录那份**：根 `.gitignore` 当前有未提交的用户改动，动它会把别人的改动混进本次提交。项目级 `.gitignore` 自包含，互不干扰。

- [ ] **Step 2: 改 `README.md`**

- 「常用命令」表下补一段 `--resume` 的用法，含 **`pnpm start -- --resume <id>`** 必须带 `--` 的说明（Task 8 实测后按实际结果写）
- 「REPL 命令」表加一行：`| /sessions | 列出历史会话，当前会话带 * 标记 |`
- 「项目结构」的 `src/` 树里补 `cli/args.ts`、`cli/store.ts`、`core/journal.ts` 三个新文件与各自的职责注释（照现有条目的写法），并在根补 ` .sessions/` 一行
- 「当前能力边界」把 **会话持久化（JSONL 落盘、`--resume`）从「尚未实现」移到「已实现」**，并在已实现列表里**显式写明本次没有自动化测试**：

```
- 会话持久化：JSONL 事件流落在 `.sessions/`，`--resume` 恢复，`/sessions` 列出。
  **本次未补自动化测试**，验证靠手动冒烟，欠账与将来的补测清单见
  `docs/superpowers/specs/2026-09-24-ai-chat-m3-design.md` §12
```

- [ ] **Step 3: 改 `ARCHITECTURE.md`**

- 模块依赖图补上 `journal`（core，纯）、`store`（cli，IO）、`args`（cli，纯）
- 「运行时数据流」补两段：**启动**（配置 → 参数 → 建/读会话文件 → 启动 REPL）与**一轮对话的落盘路径**（`session.append` → 广播 → `store.append` → 追加一行）
- 明确记一句：core 仍然不做 IO，`node:fs` 只出现在 `cli/store.ts`

- [ ] **Step 4: 改 `DECISIONS.md`**

追加 D28–D37（编号接在 D27 之后，格式照现有条目：决策 + **被放弃的选项** + 代价）：

```text
D28  会话日志是事件流（meta/message/model/clear），不是纯消息
D29  Session 广播变更、cli 落盘；不采用「repl 手动写」
D30  落盘位置：项目内 .sessions/，AI_CHAT_HOME 可覆盖（跟 cwd 走是已知代价）
D31  启动即建文件写 meta（放弃延迟创建）；用 'wx' 独占创建防撞名时静默截断
D32  会话 id 白名单校验 + 路径包含检查两道防线
D33  坏行跳过并计数，不因一行坏掉丢掉整个会话
D34  写盘失败分两档：建文件失败致命，append 失败警告一次后继续
D35  /sessions 给当前会话打 *；id 不进 Session，走 CommandDeps
D36  命令需要外部数据时走依赖注入（CommandDeps），core 不碰 IO
D37  **本次不写自动化测试** —— 决策、欠账与将来的补测清单
```

D37 要如实写清：这是用户的明确要求，代价是 M3 全部新增行为没有自动化覆盖，落点见 spec §12。

> **`EVALUATION.md` 不要动。** 它的验收表对应 `docs/ROADMAP.md` 阶段 0 的 6 条标准，而会话持久化**不是那 6 条之一** —— 往里加条目会让它和 ROADMAP 对不上。这是 spec §15 明确写过的，实施完再确认一次。

- [ ] **Step 5: 提交**

```bash
git add demos/01-llm/.gitignore demos/01-llm/README.md demos/01-llm/ARCHITECTURE.md demos/01-llm/DECISIONS.md
git commit -m "docs: M3 会话持久化的文档同步与忽略规则"
```

---

### Task 8: 手动冒烟（真实网络）

**Files:** 无代码改动；若踩到新坑则追加 `demos/01-llm/docs/troubleshooting.md`

**Interfaces:**
- Consumes: 全部实现
- Produces: 验收证据

> **密钥纪律**：真实 key 只从 `.env.local` 读（已 gitignore）。任何要贴出来的输出先做泄漏扫描，确认不含 key 片段。

- [ ] **Step 1: 新会话跑一轮**

```bash
cd demos/01-llm
printf '用一句话说明什么是闭包\n' | pnpm --silent start 1>out.txt 2>err.txt; echo "exit=$?"
cat err.txt        # 期望含 [session] <id>，取这个 id 备用
```

- [ ] **Step 2: 检查落盘内容**

```bash
cat .sessions/<id>.jsonl
# 期望恰好三行：meta / message(user) / message(assistant)
tail -c 1 .sessions/<id>.jsonl | xxd    # 期望末字节是 0a（最后一行有换行）
```

- [ ] **Step 3: 恢复并追问（Review Focus 第 1 条）**

```bash
printf '用一句话总结我们刚才聊的\n' | pnpm --silent start -- --resume <id> 1>out2.txt 2>err2.txt
cat err2.txt        # 期望 [resumed] <id>（2 条消息）
cat out2.txt        # 回答里应能复述「闭包」—— 这才证明历史真的带过去了
wc -l .sessions/<id>.jsonl   # 期望 5 行
```

- [ ] **Step 4: 打开一次不该让日志变长（Review Focus 第 2 条）**

```bash
before=$(wc -l < .sessions/<id>.jsonl)
printf '嗯\n' | pnpm --silent start -- --resume <id> >/dev/null 2>&1
after=$(wc -l < .sessions/<id>.jsonl)
echo "before=$before after=$after"   # 期望 after = before + 2（一问一答），而不是 before × 2
```

- [ ] **Step 5: `/sessions`**

```bash
printf '/sessions\n' | pnpm --silent start
# 期望：当前会话那行行首是 *，时间列是 MM-DD HH:MM，条数与文件里的 message 行数一致
```

- [ ] **Step 6: `/clear` 与 `/model` 落盘，且 clear 后 resume 不复活旧消息（Review Focus 第 5 条）**

```bash
printf '/clear\n/model deepseek-v4-pro\n' | pnpm --silent start -- --resume <id>
tail -2 .sessions/<id>.jsonl          # 期望 {"type":"clear"} 与 {"type":"model",...}
printf '刚才我们聊了什么\n' | pnpm --silent start -- --resume <id>
# 期望模型答不上来（历史已被 clear 清空）—— 这正是不用纯消息格式的理由
```

- [ ] **Step 7: 路径穿越与写盘失败（Review Focus 第 3、4 条）**

```bash
pnpm start -- --resume ../../etc/passwd ; echo "exit=$?"        # 期望 exit=1

mkdir -p /tmp/readonly-sessions && chmod 555 /tmp/readonly-sessions
printf '你好\n' | AI_CHAT_HOME=/tmp/readonly-sessions pnpm --silent start 1>/dev/null 2>err3.txt
cat err3.txt    # 期望恰好一行 [警告] 会话写入失败…，且对话本身正常完成
chmod 755 /tmp/readonly-sessions && rm -rf /tmp/readonly-sessions
```

- [ ] **Step 8: 确认 `pnpm start --resume <id>`（不带 `--`）的实际行为（Review Focus 第 6 条）**

```bash
pnpm start --resume 20260924-143022-a3f1 ; echo "exit=$?"
```

按实测结果把结论写进 README 的 `--resume` 小节。若 pnpm 把参数吃掉了，就说清楚必须用 `--`；若没吃掉，两种写法都写上。

- [ ] **Step 9: 清理临时文件**

```bash
rm -f out.txt err.txt out2.txt err2.txt err3.txt
git status --short     # 确认没有把 .sessions/ 或临时文件带进版本控制
```

- [ ] **Step 10: 提交（若有 troubleshooting 追加）**

```bash
git add demos/01-llm/docs/troubleshooting.md
git commit -m "docs: 记录 M3 实施中踩到的坑"
```

（本步无新增内容时跳过，不要提交空 commit。）

---

## 完成标准

```text
TypeCheck: pnpm run typecheck → 退出码 0
Lint:      N/A（本仓库未配置 linter）
Test:      pnpm test → 91/91（用例数不变，且断言一句未改）
Build:     N/A（noEmit，Node 直接运行 .ts）
Smoke:     Task 8 的 10 步全部通过
```

**明确不达标的一项**：M3 新增行为**没有自动化测试覆盖**。这是本增量的已知欠账（见 `DECISIONS.md` D37 与 spec §12），报告时必须如实写出，不能用「测试全绿」掩盖它。
