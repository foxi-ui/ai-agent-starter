# ai-chat M3 · 设计文档（会话持久化）

- 日期：2026-09-24
- 状态：待 review
- 范围：M3 —— **会话落盘（JSONL 事件流）+ `--resume` + `/sessions` 命令**
- 前置：M1（非流式多轮 + 最小错误处理）、M2（streaming + `/clear` `/history` `/model`）已完成
- 约束来源：`AGENTS.md`（跨阶段技术约束）、`ARCHITECTURE.md`、`DECISIONS.md` D13 / D24 / D26

---

## 1. 背景与目标

M1 走通了「LLM API → 消息结构 → 上下文管理」，M2 补上 streaming 与进程内命令。
但**上下文只活在进程内存里** —— `src/core/session.ts` 的类注释里那句「持久化到磁盘属于后续增量」，就是本增量。

成功标准：

- 聊完一场，`.sessions/<id>.jsonl` 里能看到完整的对话记录
- `pnpm start --resume <id>` 能接着上次聊，模型确实知道之前说过什么
- `/sessions` 能列出历史会话，看得出哪个是当前会话
- **落盘失败不该毁掉正在进行的对话**

---

## 2. 范围界定

### 本次范围

- `src/core/journal.ts`【新】：记录类型、序列化、解析、回放、会话 id 的生成与校验、`SessionStore` 接口
- `src/cli/store.ts`【新】：`SessionStore` 的文件实现（唯一碰 `node:fs` 的地方）
- `src/cli/args.ts`【新】：命令行参数解析
- `src/core/session.ts`：新增可选的 `onChange` 回调（变更广播）与初始历史
- `src/core/commands.ts`：新增 `/sessions` 命令；`executeCommand` 增加依赖注入参数
- `src/cli/render.ts`：渲染 `/sessions` 的结果
- `src/cli/repl.ts`：组装（接 store、构造带广播的 Session、写盘失败的降级）
- `src/index.ts`：解析参数 → 新建或恢复 → 启动
- `.gitignore`、`README.md`、`ARCHITECTURE.md`、`DECISIONS.md` 同步

### 明确推迟（本次不实现、不设计细节）

- **跨会话 Token 账本** —— 归档蓝图 `archive/01-llm/01-full-design.md` 的 M3 写着「会话落盘 + `--resume` + 跨会话账本」，但账本需要 `usage` 字段，而它现在根本没被解析（`StreamEvent` 只有三种，见 D18）。**这是本次对归档蓝图的一处有意偏离**：账本随 M4 一起做。
- **上下文裁剪** —— 落盘之后会话文件会一直变长，`toMessages()` 会把全部历史发给模型。裁剪是 M4 的「上下文预算」，本次不碰。
- `--help` / `-h` 开关 —— 参数出错时的提示里会带用法，但不做专门的 help 入口。
- 会话的删除 / 重命名 / 导出 / 搜索。
- 并发保护 —— 两个进程同时 resume 同一个 id 会各自追加，本次不加锁。

### 本次不写自动化测试（特殊决定）

用户明确要求本增量**先不写单元测试**，出问题再分析解决。边界如下：

- **不新增任何 `*.test.ts`** —— journal / store / args / Session 广播 / `/sessions` 全部没有自动化覆盖
- **但被签名变更影响的旧用例必须同步修好**：`executeCommand` 多一个参数、`repl` 的 options 多几个字段，不改这两处旧测试会**当场跑不起来**（不是「没覆盖新功能」，是「旧功能也红了」）。目标是 `pnpm test` 仍然全绿

**这是一笔已知欠账，不是疏忽。** 半年后不能误以为持久化有测试覆盖。因此：

- 本文件 §12 保留「将来补测试时该测什么」的清单
- `DECISIONS.md` 记一条，README 的「当前能力边界」里也点明

---

## 3. 设计决策汇总

每条都记了**被放弃的选项**，因为决策过程不在代码里。

### D-M3-1. 落盘格式是**事件流**，不是纯消息

日志里每行一条记录，共四种：

```jsonc
{"type":"meta","id":"20260924-143022-a3f1","createdAt":"...","model":"deepseek-flash"}
{"type":"message","role":"user","content":"什么是闭包"}
{"type":"message","role":"assistant","content":"闭包是…"}
{"type":"model","model":"deepseek-v4-pro"}
{"type":"clear"}
```

**放弃：只存 `{"role","content"}`。** 那样格式最简、回放就是直接拼数组；但 `/clear` 之后旧消息仍留在文件里，`--resume` 会把用户**明确清掉**的内容又恢复回来 —— 这是语义错误，不是取舍。`/model` 的切换同样无处安放。

**代价**：解析侧要认四种记录，回放要按顺序折叠（`clear` 清空之前攒的、`model` 覆盖当前模型）。

### D-M3-2. `Session` 广播变更，cli 负责落盘

`Session` 的三个变更点改完状态后调用注入的 `onChange(change)`；cli 收到就把这行追加进文件。

**为什么不是 repl 手动写**：四个变更点里有**两个藏在 `executeCommand` 内部**（`/clear` 调 `session.clear()`、`/model <name>` 写 `session.model`）。repl 看不见它们，只能靠 `result.kind === 'cleared'` 反推。靠「记得写」的写法，漏一处就是「磁盘悄悄落后于内存」——而且这种 bug 很难测出来。广播让它从结构上不可能漏。

**放弃：包一层 `JournaledSession` 组合类。** 理论上最解耦，但 `Session` 带 `private` 字段，TypeScript 的结构化兼容会失效，于是 `executeCommand(…, session: Session)` 的参数类型必须改成接口 —— 改动面反而比广播更大。

**代价与守住的边界**：

- `Session` 不再是「无副作用」的纯类，它的类注释必须重写（现在的注释正以「没有副作用」立论）
- **回调可选**：不传就完全退回原来的纯行为，所以 `session.test.ts` 的旧用例一行都不用改
- **core 不 import `node:fs`** —— 它只调一个注入进来的函数。`AGENTS.md` 的分层约束（`llm`/`core` 不写 stdout/stderr）在这里延伸为「core 不做 IO」

### D-M3-3. 落盘位置：项目内 `.sessions/`

默认 `.sessions`，环境变量 `AI_CHAT_HOME` 可覆盖。

**放弃：`~/.ai-chat/sessions/`** —— 跨项目共用、不污染仓库，但想看内容得跳出仓库，对学习项目不直观。
**放弃：`$XDG_DATA_HOME/ai-chat/`** —— 最正统，但 macOS 上落到 `~/.local/share/...`，又长又不直观，还要多一层「未设时回落」的逻辑。

**代价**：目录跟着 **cwd** 走 —— 换个目录启动就是另一份会话。这条写进 README，否则会被当成 bug。

`.sessions/` 加进 `.gitignore`（会话内容不该进仓库）。

### D-M3-4. 会话文件在**启动时立即创建**（写 meta 行）

**理由有二**：

1. 启动时要把本次 id 打到 stderr 供 `--resume` 用。若文件还不存在，用户拿着这个 id 去 resume 会得到「会话不存在」—— 自相矛盾的体验。
2. 「目录不可写」这类错误应当在启动时就暴露，而不是聊到一半才发现存不了。

**放弃：延迟到第一条记录才建文件。** 好处是不留空文件，但上面两个问题都会回来。

**代价**：启动后立刻 Ctrl+D 会留下一个只有 meta 行的文件。可接受（一行，且 `/sessions` 里显示 0 条）。

**打开方式必须是 `wx`（独占创建），不能用 `w`。** `w` 会**静默截断**已存在的文件 —— 万一 id 撞名（随机后缀只有 4 位十六进制），用户的旧会话会被无声抹掉。`wx` 在文件已存在时抛错，由启动流程报出来（此时是「致命」档：stderr + 退出码 1）。

### D-M3-5. `--resume` 的 id 走白名单校验

id 格式固定为 `YYYYMMDD-HHMMSS-xxxx`（`xxxx` 为 4 位小写十六进制），校验用：

```ts
/^\d{8}-\d{6}-[0-9a-f]{4}$/
```

**为什么必须校验**：id 来自命令行，会被拼进文件路径。`--resume ../../etc/passwd` 就是一次路径穿越。见 `~/.claude/rules/global/security.md`「文件操作必须检查路径穿越」。

**纵深防御**：store 在拼接之后还会用 `path.resolve` 确认结果确实落在会话目录内。正则将来若被放宽，这一层仍然挡得住。

### D-M3-6. 坏行跳过，不因一行坏掉丢掉整个会话

JSON 解析失败、或形状不认识的行：**静默跳过并计数**，resume 时 stderr 警告一次。

与 M2 的「坏 chunk 跳过」同一取舍（D23 的意图）。进程被 kill 时写下的**半行**走同一条路径 —— 这正是不做单元测试时最容易漏掉的情形，见 §12。

**放弃：遇到坏行直接报错退出。** 一行损坏就让整场会话不可恢复，代价和收益不成比例。

### D-M3-7. 写盘失败分两档

| 时机 | 处理 | 理由 |
| --- | --- | --- |
| 建文件 / 写 meta 失败 | **致命**：stderr + 退出码 1 | 早点死。存不了的会话没必要开始 |
| 后续 `append` 失败 | stderr 警告**一次**，对话继续 | 磁盘满不该打断正在进行的对话 |

「警告一次」是刻意的：每轮都刷同一句警告会把屏幕占满，反而看不见别的。

**绝不静默**也是刻意的：写盘失败却一声不吭，用户会以为存下来了 —— 那比直接报错更糟。

**放弃：一律致命**（对话被打断）、**一律静默**（用户被误导）。

### D-M3-8. `/sessions` 给当前会话打 `*` 标记

`executeCommand` 通过依赖注入拿到 `currentSessionId`，不在 `Session` 里存 id。

**放弃：把 id 放进 `Session`。** 归档蓝图 §3 确实把「会话 id」列为 `Session` 的职责，但 `Session` 自己一次都用不到它 —— 只有渲染 `/sessions` 需要。为此给 `Session` 加一个只读字段，不如从 deps 传。

### D-M3-9. 命令需要外部数据时走依赖注入

```ts
executeCommand(name, argument, session, deps)   // deps: { store, currentSessionId }
```

`core` 不碰 IO，`/sessions` 要的会话列表由注入的 `store` 提供。这与 `LLMClient`（接口在 `llm/client.ts`、实现在 `llm/deepseek.ts`、测试塞假的）是同一个套路。

**代价**：`commands.test.ts` 的每个调用点都要补一个 `deps` 参数（本次要改的旧测试之一）。

---

## 4. 架构与数据流

### 启动

```text
pnpm start [--resume <id>]
  │
  ├─ resolveConfig(process.env)          // 缺 key → stderr + exit 1（M1 既有行为）
  ├─ parseArgs(process.argv.slice(2))    // 参数非法 → stderr + exit 1
  ├─ store = createFileStore(env.AI_CHAT_HOME ?? '.sessions')
  │
  ├─ 分支 A：新会话
  │    ├─ id    = makeSessionId(new Date(), randomHex(2))
  │    ├─ store.create(id, config.model)   // 立刻写 meta 行；失败 → stderr + exit 1
  │    ├─ messages = []，model = config.model
  │    └─ stderr: [session] <id>
  │
  └─ 分支 B：--resume <id>
       ├─ store.load(id)
       │    ├─ null            → stderr「会话不存在」+ exit 1
       │    └─ {records, skipped}
       │         ├─ skipped > 0 → stderr 警告一次
       │         └─ {messages, model} = replay(records)
       ├─ model = replay 出的模型 ?? config.model
       └─ stderr: [resumed] <id>（N 条消息）
  │
  └─ runRepl(client, { input, output, errorOutput, prompt, model, store, sessionId, history })
        │
        └─ new Session(model, { history, onChange })
             onChange = 把 change 追加进文件；append 抛错时警告一次并继续
```

**顺序是有讲究的**：`resolveConfig` 在 `parseArgs` 之前。缺 key 与参数写错同时发生时，先报缺 key —— 保持 M1 的既有行为不变。两者都在创建任何文件之前退出。

### 一轮对话

```text
You: 什么是闭包
  │
  ├─ session.append('user', '什么是闭包')
  │     ├─ messages.push(...)               ← 内存先改
  │     └─ onChange({type:'message', role:'user', …})
  │           └─ store.append(id, change)   → 文件追加一行
  │
  ├─ client.chatStream(...) → renderer → stdout
  │
  └─ session.append('assistant', text)
        └─ 同上，追加第二行

You: /clear
  │
  └─ executeCommand → session.clear()
        ├─ messages = []                    ← 内存先改
        └─ onChange({type:'clear'})         → 追加 {"type":"clear"}
```

**「内存先改，再广播」是刻意的顺序**：`store.append` 抛错时，内存状态已经改好了。磁盘落后于内存（并已警告），但内存自身始终自洽 —— 不会出现「消息推了一半」的中间态。

**失败轮次仍然不落 assistant 行**：D7 保持不变。请求失败时 `session.append('assistant', …)` 根本不执行，所以文件里留下的是一条 user 记录后面直接跟下一条 —— 这正是日志该有的样子（如实记录发生了什么）。

---

## 5. 目录结构

```text
01-llm/
  .sessions/              # 【新】会话日志（被 .gitignore 忽略）
    <id>.jsonl
  src/
    index.ts              # 【改】解析参数 → 新建/恢复 → 启动
    cli/
      args.ts             # 【新】parseArgs：argv → { fresh } | { resume, id }
      config.ts           # 不变
      repl.ts             # 【改】接 store / sessionId / history，组装 onChange
      render.ts           # 【改】渲染 /sessions 结果
      store.ts            # 【新】createFileStore：唯一碰 node:fs 的地方
    core/
      journal.ts          # 【新】记录类型 + 序列化/解析/回放 + id 工具 + SessionStore 接口
      session.ts          # 【改】新增可选 onChange 与初始历史
      commands.ts         # 【改】新增 /sessions；executeCommand 增加 deps
      types.ts            # 不变
    llm/                  # 不变
  test/                   # 只修被签名变更打破的旧用例，不新增文件
```

---

## 6. 类型定义

### `core/journal.ts`

```ts
import type { Message, Role } from '@/core/types.ts';

/** 会话状态的一次变更。Session 广播它，它也是日志里除 meta 外的全部内容 */
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
 * 刻意**不含 createdAt**：展示用的时间直接从 id 切（id 前 15 位就是本地时间），
 * 不必再经过 `new Date(iso)` + 时区换算 —— 那会让同一份文件在不同 TZ 的机器上
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
  /** 被跳过的坏行数（解析失败或形状不认识） */
  skipped: number;
}

/**
 * 会话存储的接缝。core 只认这个接口，实现由 cli 提供 ——
 * 与 LLMClient 同一个套路，好处是 core 层完全不碰 node:fs。
 */
export interface SessionStore {
  /** 创建会话文件并写入 meta 行；文件已存在时抛错（独占创建，见 D-M3-4） */
  create(id: string, model: string): void;
  /** 追加一条变更记录；文件不存在时抛错 */
  append(id: string, change: SessionChange): void;
  /**
   * 读回全部记录。**「会话不存在」返回 null**（这是正常分支，由调用方给友好提示）；
   * 其余 IO 错误（权限、目录不可读）原样抛出 —— 两者不可混为一谈
   */
  load(id: string): LoadedSession | null;
  /**
   * 列出全部会话，按 id 倒序（id 前缀是时间戳，故字典序倒序即时间倒序）。
   * **会话目录不存在时返回空数组**，不抛错 —— 首次运行时目录还没被创建过
   */
  list(): SessionSummary[];
}

/** 记录 → 一行文本（不含换行符） */
export function serializeRecord(record: SessionRecord): string;
/** 一行文本 → 记录；空行或坏行返回 null */
export function parseRecord(line: string): SessionRecord | null;
/** 按顺序折叠记录，重建会话状态 */
export function replay(records: SessionRecord[]): { messages: Message[]; model: string | null };
/** 生成会话 id：YYYYMMDD-HHMMSS-xxxx（本地时间） */
export function makeSessionId(now: Date, suffix: string): string;
/** 校验会话 id 是否合法（防路径穿越） */
export function isValidSessionId(id: string): boolean;
```

### `core/session.ts` 改动

只在构造签名上，**方法签名一个都不变**：

```ts
export interface SessionOptions {
  /** 回放得到的历史消息。不传即空会话 */
  history?: Message[];
  /** 变更广播。不传则完全退回原来的纯行为（现有测试因此不用改） */
  onChange?: (change: SessionChange) => void;
}

constructor(model: string, options: SessionOptions = {}) { … }
```

三个变更点各自在**改完状态之后**调用 `this.onChange?.(…)`：

| 方法 | 广播内容 | 顺序 |
| --- | --- | --- |
| `append(role, content)` | `{type:'message', role, content}` | push 之后 |
| `clear()` | `{type:'clear'}` | 置空之后 |
| `set model(name)` | `{type:'model', model:name}` | 赋值之后 |

**只读操作绝不广播**：`toMessages()`、`history()`、`get model` 一次都不调 `onChange`。`/model`（无参数）是纯查询，绝不能因为查了一下就多写一行日志。

**构造函数也绝不广播**：`options.history` 是「回放结果」，直接作为初始状态塞进去，不经过三个变更点、不产生任何 `onChange`。

这条是**必须的**，不是优化：resume 时如果构造也广播，每恢复一条历史消息就会往文件里再写一行 —— 打开一次会话，日志就翻一倍。

### `core/commands.ts` 改动

```ts
export type CommandName = 'clear' | 'history' | 'model' | 'sessions';
export const COMMAND_NAMES: readonly CommandName[] = ['clear', 'history', 'model', 'sessions'];

export interface CommandDeps {
  store: SessionStore;
  /** 当前会话的 id，用于在 /sessions 列表里打 * 标记 */
  currentSessionId: string;
}

export type CommandResult =
  | { kind: 'cleared'; removed: number }
  | { kind: 'history'; messages: Message[] }
  | { kind: 'model-current'; model: string }
  | { kind: 'model-changed'; model: string }
  | { kind: 'sessions'; sessions: SessionSummary[]; currentId: string };

export function executeCommand(
  name: CommandName,
  argument: string,
  session: Session,
  deps: CommandDeps,
): CommandResult;
```

`renderCommandResult` 里那个 `never` 穷尽性守卫会强制这次给 `sessions` 补上渲染分支 —— 这正是它存在的意义。

### `cli/args.ts`

```ts
export type Args = { kind: 'fresh' } | { kind: 'resume'; id: string };

/** 解析 argv（不含 node 与脚本路径）。非法则抛 Error，消息里带用法 */
export function parseArgs(argv: string[]): Args;
```

### `cli/store.ts`

```ts
/** 会话目录的实现。dir 由调用方给出（测试可指向临时目录） */
export function createFileStore(dir: string): SessionStore;
```

### `cli/repl.ts` 改动

`ReplOptions` 增加三个字段：

```ts
export interface ReplOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  prompt: string;
  model: string;
  /** 【新】本次会话的 id */
  sessionId: string;
  /** 【新】恢复出来的历史；新会话传 [] */
  history: Message[];
  /** 【新】会话存储 */
  store: SessionStore;
}
```

---

## 7. JSONL 格式契约

- **编码** UTF-8；**每行一个 JSON 对象**；行尾 `\n`；文件末尾**有**换行（最后一行不是半行）
- **第一行必须是 `meta`**，由 `create()` 写入
- 字段名固定，不设版本号字段 —— 本次只有一种格式，加版本号是 YAGNI。将来真要变格式，靠 `type` 不认识即跳过这条已有路径兼容

| 记录 | 何时写 |
| --- | --- |
| `meta` | 会话创建时，一次 |
| `message` | 每次 `session.append(...)` |
| `model` | 每次 `/model <name>` 切换成功 |
| `clear` | 每次 `/clear` |

**回放规则**（纯函数，按行顺序折叠）：

```text
messages = []
model    = null

for each record:
  meta    → 若 model 仍为 null，取它的 model（首个 meta 生效）
  message → messages.push({ role, content })
  model   → model = record.model
  clear   → messages = []
```

回放结束后由调用方决定：`model` 为 `null`（文件里没有 meta 也没有 model 记录）时回落到 `config.model`。

**注意 `clear` 只清消息、不清模型** —— 与 `/clear` 和 `/model` 在内存里的语义严格对齐（`Session.clear()` 明确不影响当前模型）。

---

## 8. 会话 id 与路径安全

**格式**：`YYYYMMDD-HHMMSS-xxxx`

- 时间部分取**本地时间**（不是 UTC）—— 用户 `ls` 时看到的应该是自己挂钟上的时间
- **实现上必须用 `getFullYear` / `getMonth` / `getDate` / `getHours` 逐段取，不能用 `toISOString()`** —— 后者是 UTC，会让东八区的会话按早 8 小时命名。这是个安静的错，`ls` 出来看着也像那么回事
- `xxxx` 是 2 字节随机数的十六进制（`crypto.randomBytes(2).toString('hex')`），避免同一秒内启动两次撞名
- 随机部分由调用方传入 `makeSessionId(now, suffix)`，这样测试可以喂固定值、不依赖随机

**路径安全**（两道）：

1. `isValidSessionId(id)` 白名单正则。不通过 → 不合法，报错退出
2. store 拼出路径后用 `path.resolve` 确认结果仍在会话目录内。正则将来被放宽时这一层仍然挡得住

`--resume ../../etc/passwd`、`--resume 'a/b'`、`--resume ''` 都必须被第一道拦下。

---

## 9. CLI 参数契约

| 输入 | 结果 |
| --- | --- |
| （无参数） | `{ kind: 'fresh' }` |
| `--resume <合法 id>` | `{ kind: 'resume', id }` |
| `--resume`（无值） | 抛错：`--resume 需要一个会话 id` |
| `--resume <非法 id>` | 抛错：`会话 id 不合法：<id>` |
| `--resume <id> <多余参数>` | 抛错：参数过多 |
| 任何未知参数（`--resum`、`-x`…） | 抛错：`未知参数：<arg>` |

**所有抛错消息都附一行用法**：

```text
用法：pnpm start [--resume <会话 id>]
```

**为什么未知参数要报错而不是忽略**：`--resum xxx`（少一个 e）若被静默忽略，就会**悄悄开一个全新会话**，用户以为resume上了、实际前面聊的全丢了。宁可报错。

**实测结论（2026-09-24 实施时改）**：原文写「`--resume` 可能被 pnpm 自己吃掉，要用
`pnpm start -- --resume xxx`」—— **实测正好相反**。pnpm 10.34.5 与 node v22.23.2
都会把 `--` **原样**作为 `argv[0]` 传给脚本，于是程序报 `未知参数：--` 并退出码 1；
不加 `--` 的 `pnpm start --resume xxx` 才正常工作（`--resume` 不会被 pnpm 吃掉）。

| 命令 | 脚本收到的 argv | 结果 |
| --- | --- | --- |
| `pnpm start -- --resume <id>` | `['--', '--resume', '<id>']` | ❌ 未知参数：`--` |
| `pnpm start --resume <id>` | `['--resume', '<id>']` | ✅ |

这条**不再需要「实施时实测确认」**，已写进 README 与 `docs/troubleshooting.md` T13。

---

## 10. `/sessions` 命令契约

| 输入 | 输出（stdout） |
| --- | --- |
| `/sessions`，有会话 | 每行一个会话，**新的在前** |
| `/sessions`，无会话 | `(还没有历史会话)` |
| `/sessions extra` | 忽略多余参数（与 `/model` 的处理一致，不报错） |

**格式**（当前会话行首是 `*`，其余行首是两个空格以对齐）：

```text
* 20260924-143022-a3f1  09-24 14:30  6 条
  20260923-101500-7c2e  09-23 10:15  12 条
```

- 时间列从 id 里就地解析（`YYYYMMDD-HHMMSS` → `MM-DD HH:MM`），显示**本地时间**
- 条数 = 该文件里 `message` 记录的条数（**不是**总行数，`clear` / `model` 不算）

**`messageCount` 需要逐个读文件**，所以 `/sessions` 是 O(会话数) 次读取。这个量级（几十个文件）完全无所谓；若将来上千，再考虑在 meta 里维护索引。

---

## 11. 错误与边界

| 场景 | 行为 | 退出码 |
| --- | --- | --- |
| `--resume` 的 id 非法 | stderr：`会话 id 不合法：<id>` | 1 |
| `--resume` 的会话文件不存在 | stderr：`会话不存在：<id>（会话目录：<dir>）` | 1 |
| 参数未知 / 缺值 | stderr：错误 + 用法 | 1 |
| 创建会话文件失败（目录只读等） | stderr：`无法创建会话文件：<原因>` | 1 |
| 加载会话时读到坏行 | stderr 警告一次：`[警告] 已跳过 N 行无法解析的记录`，其余照常恢复 | 0 |
| 加载时文件读取失败（权限） | stderr + 退出 | 1 |
| 对话中途 `append` 失败 | stderr 警告一次，**对话继续** | 0 |
| 会话目录不存在 | `create` 时自动 `mkdir -p` | — |
| 会话文件为空（0 字节） | 视为空会话，正常恢复 | 0 |
| 文件只有 meta 行 | 正常恢复，0 条消息 | 0 |

**退出码 1 的三种情况都发生在发起任何网络请求之前**，所以针对它们的子进程测试不触网（见 §12 的旧测试维护）。

---

## 12. 验证策略（M3 实施时无自动化覆盖）

> **后续进展（2026-09-24 补记）**：本节描述的「本次无自动化覆盖」是 **M3 实施当时**的状态
> —— 那是用户当时明确要求的取舍（见 `DECISIONS.md` D37）。欠账已在同一日还清：
> 下表的补测清单逐条落地为 `test/journal.test.ts` / `test/store.test.ts` / `test/args.test.ts`，
> 另扩充了 `session` / `commands` / `repl` / `render` / `index` 五个既有文件，
> 用例数 91 → 167，并以 20 条变异检查确认这些用例真的会失败。
> 详见 `DECISIONS.md` D38（含两条由此发现、尚未修复的生产缺陷）。
> 本节其余内容保留原样，作为这份 spec 的历史记录。

### 每次改动都要跑

```bash
pnpm run typecheck     # tsc --noEmit，退出码 0
pnpm test              # 旧用例全绿（用例数不变）※ 该限制已于补测后解除，见本节补记
```

### 手动冒烟（真实网络，不进 CI）

按 `~/.claude/rules/global/testing.md` 的分层，本次新增功能只有手动这一层。顺序：

```bash
# 1) 新会话：跑一轮，拿到 id
printf '用一句话说明什么是闭包\n' | pnpm --silent start 1>out.txt 2>err.txt
#    err.txt 应含 [session] <id>

# 2) 检查落盘内容
cat .sessions/<id>.jsonl
#    应恰好三行：meta / message(user) / message(assistant)
#    且最后一行有换行（用 `tail -c 1 file | xxd` 确认）

# 3) 恢复并追问：模型应记得闭包这个主题
printf '用一句话总结我们刚才聊的\n' | pnpm --silent start --resume <id> 1>out2.txt 2>err2.txt
#    err2.txt 应含 [resumed] <id>（2 条消息）
#    out2.txt 的回答应能复述「闭包」
#    且 .sessions/<id>.jsonl 变成 5 行

# 4) /sessions
printf '/sessions\n' | pnpm --silent start
#    当前会话那行带 *，条数正确

# 5) /clear 与 /model 落盘
printf '/clear\n/model deepseek-v4-pro\n' | pnpm --silent start --resume <id>
#    文件尾部追加 {"type":"clear"} 与 {"type":"model",...}

# 6) 路径穿越被拦
pnpm start --resume ../../etc/passwd ; echo "exit=$?"    # 期望 exit=1

# 7) 写盘失败降级（只读目录）
AI_CHAT_HOME=/tmp/readonly-sessions pnpm start   # 先 chmod 555 该目录
#    期望 stderr 一行警告、对话仍能继续
```

**密钥不得进会话**：真实 key 只从 `.env.local` 读，任何贴出来的输出前先做泄漏扫描（对照 `~/.claude/rules/global/security.md`）。

### 将来补测试时该测什么（清单，本次不做）—— ✅ 已还清

留着，免得下次从零想（**已于 2026-09-24 全部落地，见本节开头的补记**）：

| 文件 | 用例 |
| --- | --- |
| `journal.test.ts` | 四种记录序列化/解析往返；空行与坏行返回 null；`replay` 的 clear 清空、model 覆盖、meta 定初始、三者交错；`makeSessionId` 的格式与本地时区；`isValidSessionId` 白名单（含 `../`、`a/b`、空串、大写十六进制、长度不符） |
| `store.test.ts` | 临时目录真写文件（不 mock fs）：create 写出 meta、append 追加、load 往返、list 的摘要与倒序、不存在的 id → null、坏行计入 skipped、目录不存在时自动创建、路径穿越被拒 |
| `args.test.ts` | 空 → fresh；合法 resume；缺值/非法 id/多余参数/未知参数各自抛错且消息含用法 |
| `session.test.ts` | 三个变更点各广播一次；只读操作零广播；`history` 预置消息；`onChange` 抛错时内存状态仍已更新 |
| `commands.test.ts` | `/sessions` 的空表、非空、当前标记 |
| `repl.test.ts` | 一轮对话后 store 收到 2 条；`/clear` 收到 clear；只读命令零写；append 抛错 → 只警告一次且对话继续 |
| `index.test.ts` | `--resume` 非法 id / 不存在的 id → 退出码 1 |

**旧测试的维护（本次要做）**：

- `test/commands.test.ts` —— 每个 `executeCommand(...)` 调用点补 `deps` 参数（塞一个假的 store + 一个 id）
- `test/repl.test.ts` —— `runRepl` 的 options 补 `store` / `sessionId` / `history`（塞假 store）
- 其余测试文件**不动**

**注意 `test/` 下不放非 `*.test.ts` 文件**（已实测：`node --test` 会把它们当测试跑并计入用例数）。因此假 store 只能写在这两个文件各自的局部，不做共享 helper。

---

## 13. 注释要求（本次特别强调）

本增量新增的 IO 与回放逻辑，**注释要解释「为什么」，而不是复述代码**。必须写清楚的点：

- `core/journal.ts` —— 为什么是事件流而不是纯消息（D-M3-1）；回放为什么 `clear` 不清模型；`isValidSessionId` 为什么必须存在（路径穿越）
- `core/session.ts` —— 类注释**必须重写**：现在的注释以「没有副作用」立论，而广播回调推翻了它。新注释要说明「默认仍然是纯的，副作用由注入的回调承担」，并解释为什么「内存先改、再广播」
- `cli/store.ts` —— 两道路径校验各自挡什么；为什么坏行跳过而不是报错；`create` 为什么用 `wx` 而不是 `w`
- `cli/repl.ts` —— 为什么写盘失败只警告一次；为什么内存状态先于广播
- `cli/args.ts` —— 为什么未知参数必须报错（静默会丢会话）
- `src/index.ts` —— 为什么 `resolveConfig` 排在 `parseArgs` 前面

既有代码里那些「别顺手改成 X」的守卫注释（如 `toMessages()` 的浅拷贝、`/model` 的查询分支）**一条都不要动**。

---

## 14. 验收

```text
TypeCheck: pnpm run typecheck → 退出码 0
Lint:      N/A（本仓库未配置 linter）
Test:      pnpm test → 旧用例全绿（用例数不变，未覆盖本次新增功能）
           ※ M3 实施当时的验收口径；补测后为 167/167 覆盖新增功能，见 §12 补记
Build:     N/A（noEmit，Node 直接运行 .ts）
```

外加 §12 的 7 项手动冒烟全部通过。

---

## 15. 文档同步

跟代码同一次改动一起更新（`AGENTS.md` 的要求）：

| 文档 | 改什么 |
| --- | --- |
| `.gitignore` | 加 `.sessions/` |
| `README.md` | 「常用命令」补 `--resume` 用法与 `pnpm start --` 的坑；「REPL 命令」补 `/sessions`；「项目结构」补三个新文件与 `.sessions/`；「当前能力边界」把「会话持久化」从「尚未实现」移到「已实现」，并**点明本次无自动化测试** |
| `ARCHITECTURE.md` | 模块依赖图补 `journal` / `store` / `args`；「运行时数据流」补 §4 的启动流程与一轮落盘路径；说明 core 仍然不碰 IO（fs 在 cli） |
| `DECISIONS.md` | 追加 D28–D36：事件流格式、Session 广播、落盘位置、启动即建文件、id 白名单、坏行跳过、写盘失败分档、`/sessions` 的 `*`、命令依赖注入；另加一条记「本次不做自动化测试」及其欠账 |
| `EVALUATION.md` | **不改**。它的验收表对应 `docs/ROADMAP.md` 阶段 0 的 6 条，会话持久化不在其中（它不是那 6 条之一）。这一点在实施时确认一次，不要顺手加条目 |
| `docs/troubleshooting.md` | 实施过程中若踩到新坑（例如 `pnpm start --resume` 被 pnpm 吃掉），随手追加一条 |

---

## 16. 实施顺序（供 writing-plans 参考）

按依赖关系，每一步都能独立跑 `typecheck`：

```text
1. core/journal.ts            —— 纯逻辑，不依赖任何现有文件
2. cli/store.ts               —— 实现 SessionStore，只依赖 journal
3. cli/args.ts                —— 纯函数，独立
4. core/session.ts            —— 加广播（旧测试应仍然全绿）
5. core/commands.ts + render  —— 加 /sessions（同步修 commands.test.ts）
6. cli/repl.ts + index.ts     —— 组装（同步修 repl.test.ts）
7. .gitignore + 四份文档
8. 手动冒烟 §12 的 7 项
```
