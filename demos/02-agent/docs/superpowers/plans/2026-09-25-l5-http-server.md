# L5 · HTTP 服务端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**这是渐进步骤的第 5 步（共 6 步）。** 顺序与判据见 [`README.md`](./README.md)。
**前置：L1–L4 已完成**（Agent 循环已能离线跑通）。

**Goal:** 给核心套上 **HTTP 边界** —— 会话状态（含并发保护）、错误映射、express 路由、进程入口。做完这一步，`pnpm start` 起得来、`curl` 打得通，响应 JSON 里躺着工具轨迹。

**这一步学到什么：**

1. **会话表必须自己管并发。** `Session.append` 是同步无锁的，而一轮对话中间有 `await`。两个请求同时在途时，两条 `user` 消息会先落地，第二条的 `toMessages()` 里就出现「`assistant{tool_calls}` 没有对应的 `tool` 回应」，上游直接 400 —— **而那个报错完全不指向并发**。这一条不是优化，是正确性。
2. **上游的 HTTP 状态码绝不能原样透出。** `res.status(401)` 会把「我们的 DeepSeek key 无效」变成「你这个浏览器用户没登录」，前端会去查一个根本不存在的登录态。
3. **进程边界只有一处。** `src/main.ts` 是**唯一**碰 `process` 的文件；`http/app.ts` 要写日志也得由调用方把 `logError` 注入进来。
4. **express 5 与 4 有两处会咬人的差别**：它的 async handler 抛出的 promise 会**自动**转给错误中间件（这正是选 5 的理由）；但 `app.get('*')` 会启动即抛，`req.body` 可能是 `undefined`。

**Architecture:** `http → presentation → core → llm`，外加 `http → tools`。`createApp(deps)` 返回 app 而**不 listen** —— 测试才能用临时端口把它跑起来、跑完就关。三个测试接缝在这一步全部到位：`LLMClient`、`ToolRegistry`、`createApp(deps)` + `listen(0)`。

**Tech Stack:** `express@5.2.1`（运行时）+ `@types/express@5.0.6`（dev）—— **本仓库第一个运行时依赖**；测试**不引 `supertest`**，用 `app.listen(0,'127.0.0.1')` + Node 原生 `fetch`。

**Spec:** `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 §3（硬约束）、§11（HTTP 层）、§13（错误处理）；D12、D16、D17

## Global Constraints

以下约束对**每一个** Task 都生效，六份计划里都完整重复一遍。

- **Node ≥ 22**（本项目在 v22.23.2 验证），依赖原生类型擦除直接运行 `.ts`，服务端**不引入构建步骤**
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。
  判断标准：删掉所有类型标注后仍是合法 JS 的，才能用
- **只当类型用的导入必须写 `import type`**，否则擦除阶段无法识别，运行时抛
  「does not provide an export named …」而 `tsc --noEmit` 放行
- **`core/` / `llm/` / `tools/` / `presentation/` 零第三方依赖**，只用 `node:` 内置模块与全局 `fetch`
- **`http/` 层允许运行时依赖且必须登记**：当前唯一一条是 `express`（配套 `@types/express`）。
  **本步正是引入它的地方** —— 新增任何运行时依赖都要在 `DECISIONS.md` 里登记
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
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。
**本步相关的三条：**

1. **请求体不带 `Content-Type: application/json`** —— express 5 下 `req.body` 是 `undefined`，
   直接取 `.message` 会抛 `TypeError` 变成 500。期望行为是 **400**。测试落点：Task 10 Step 3。
2. **上游返回 401** —— 那是「我们的 key 配错了」，不是「浏览器用户没登录」。
   期望行为：响应 **502**，上游状态码只允许出现在 message 文本里。测试落点：Task 9 Step 1。
3. **同一会话并发两个请求** —— 期望**串行**（`A…A…B…B`）而不是交错（`A B A B`）。
   测试落点：Task 8 Step 2（注册表层）与 Task 10 Step 3（HTTP 层）。

---

### Task 8: 会话注册表与会话 id

对应 spec §11 的实现要点 3、4、5：**同一会话串行化**、id 形状、Map 的 FIFO 上限。

**Files:**
- Create: `demos/02-agent/apps/server/src/http/ids.ts`
- Create: `demos/02-agent/apps/server/src/http/session-registry.ts`
- Test: `demos/02-agent/apps/server/test/http-session-registry.test.ts`

**Interfaces:**
- Consumes: L1 的 `Session`
- Produces: `newSessionId(now?)`；`SessionNotFoundError`；
  `SessionRegistry`（`create()` / `get(id)` / `run(id, fn)` / `size()`）；`createSessionRegistry(options)`

- [ ] **Step 1: 写 `src/http/ids.ts`**

```ts
// 会话 id：`YYYYMMDD-HHMMSS-xxxx`（本地时间 + 4 位随机十六进制），
// 可读、按字典序排就是时间序，随机后缀避免同一秒内建两个会话撞名（spec §11 要点 4）。
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

`now` 做成参数是为了让测试能喂固定值 —— **Step 2 里有对应的用例**，
不要让它变成一个「说了能测但没人测」的参数。

- [ ] **Step 2: 写失败测试**

`test/http-session-registry.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionNotFoundError, createSessionRegistry } from '@/http/session-registry.ts';
import { newSessionId } from '@/http/ids.ts';

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
  // Review Focus 第 3 条：交错会让 toMessages() 里出现没有 tool 回应的
  // assistant{tool_calls}，上游 400 且错因完全不指向并发
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

test('newSessionId 的形状是 YYYYMMDD-HHMMSS-xxxx', () => {
  const id = newSessionId(new Date(2026, 8, 25, 9, 5, 3));
  // 月份是 0 基的，传 8 表示 9 月；各段都要补零
  assert.match(id, /^20260925-090503-[0-9a-f]{4}$/);
});

test('newSessionId 取的是**本地时间**，不是 UTC', () => {
  // 用 toISOString() 会得到 UTC，东八区会早 8 小时 —— 那是个安静的错误
  const local = new Date(2026, 0, 1, 0, 30, 0);
  assert.match(newSessionId(local), /^20260101-003000-/);
});

test('同一时刻生成的两个 id 不会撞（随机后缀）', () => {
  const now = new Date(2026, 8, 25, 9, 5, 3);
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId(now)));
  assert.ok(ids.size > 1, '50 次里应当出现不同的后缀');
});

test('按字典序排就是时间序', () => {
  const earlier = newSessionId(new Date(2026, 8, 25, 9, 5, 3));
  const later = newSessionId(new Date(2026, 8, 25, 10, 5, 3));
  assert.ok(earlier < later, '字典序必须与时间序一致（spec §11 要点 4）');
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
// 第 2 条不是优化，是正确性（spec §11 要点 3）：Session.append 是同步无锁的，
// 而 runSessionTurn 中间有 await。两个请求同时在途时，两条 user 消息会都先落地，
// 第二条的 toMessages() 里就出现「assistant{tool_calls} 没有对应的 tool 回应」，
// 上游直接 400 —— 而那个报错完全不指向并发。
// 锁必须与 Map 在同一个持有者手里，才有地方存这条链。

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
  /** 上限；超出后按创建顺序淘汰最早的。默认 100（spec D16） */
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
Expected: 全绿（12 条 = 注册表 8 条 + 会话 id 4 条）

- [ ] **Step 6: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/http demos/02-agent/apps/server/test/http-session-registry.test.ts
git commit -m "feat(server): 新增会话注册表（FIFO 上限 + 每会话串行锁）与会话 id 生成"
```

---

### Task 9: 错误映射

对应 spec §11 的状态码表与「上游 status 绝不原样透出」这条硬约束。

**Files:**
- Create: `demos/02-agent/apps/server/src/http/errors.ts`
- Test: `demos/02-agent/apps/server/test/http-errors.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）；识别的是 L3 抛的 `DeepSeek API error <status>: …` 消息前缀
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
  // Review Focus 第 2 条
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
// **不引入错误类型体系**（spec §11）：llm/deepseek.ts 至今只抛裸 Error
// （消息里带着上游状态码的字符串），引入带 code 的 LLMError 是 01-llm
// 明确推给 M6 的欠账，本项目只在 HTTP 边界做最小可区分的映射。

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

### Task 10: 装 express，写 `http/app.ts`

本仓库**第一个运行时依赖**（spec D12）。选 express 5 的决定性理由是
**它的 async handler 的 rejected promise 会自动转给错误中间件**，4 需要手写包装。

**Files:**
- Modify: `demos/02-agent/apps/server/package.json`（加 `dependencies.express` 与 `devDependencies.@types/express`）
- Create: `demos/02-agent/apps/server/src/http/app.ts`
- Test: `demos/02-agent/apps/server/test/http-app.test.ts`

**Interfaces:**
- Consumes: L4 的 `runSessionTurn` / `SYSTEM_PROMPT` / `foldTranscript`；
  Task 8 的 `SessionRegistry` / `SessionNotFoundError`；Task 9 的 `mapErrorToStatus`；
  L2 的 `createToolRegistry`（测试里用）；L1 的 `LLMClient`
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
  // Review Focus 第 1 条：express 5 在没有 json content-type 时把 req.body
  // 留成 undefined，直接取 req.body.message 会抛 TypeError 落到错误中间件变成 500
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
// 不在这里 listen，测试才能用临时端口把它跑起来、跑完就关（spec §11 要点 1）。
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

/**
 * 两个会话路由的路径参数。
 *
 * express 5 的 `ParamsDictionary` 是 `{[key: string]: string | string[]}` ——
 * 因为同一个参数可以重复出现（`/a/:b+`），那时拿到的是数组。
 * 本项目只有 `:id` 这一个单值参数，所以在这里显式收窄成 `string`，
 * 而不是在每个用到的地方写一次类型断言。
 */
type SessionParams = { id: string };

export interface AppDeps {
  client: LLMClient;
  registry: ToolRegistry;
  sessions: SessionRegistry;
  /** 建会话时用的模型名 */
  model: string;
  systemPrompt?: string;
  maxSteps?: number;
  /**
   * 服务端诊断日志。**必填、且由调用方注入** ——
   * 这里刻意**不给**一个写 `process.stderr` 的默认实现：
   * spec §3 的硬约束是「只有 `src/main.ts` 碰 `process`」，
   * 而 `http/` 里出现 `process.stderr` 就把那条约束破了（哪怕只在一个兜底分支里）。
   * 由 main.ts 注入真实现、测试注入空实现，这一层就永远不碰 process。
   */
  logError: (message: string) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
  const logError = deps.logError;
  const sessionPath = '/api/sessions/:id/messages';

  // 请求体限制：这个接口只收一句话，32KB 远远够用，
  // 顺带挡掉「发一个巨大 body 把内存吃掉」这种最朴素的情况
  app.use(express.json({ limit: '32kb' }));

  app.post('/api/sessions', (_req: Request, res: Response) => {
    const { session, id } = deps.sessions.create();
    res.status(201).json({ sessionId: id, model: session.model });
  });

  app.post(sessionPath, async (req: Request<SessionParams>, res: Response) => {
    // express 5 在没有 `content-type: application/json` 时不给 req.body 兜底成 {}，
    // 而是留成 undefined —— 直接取 .message 会抛 TypeError 变成 500。
    // 所以这里必须先判 undefined 再判类型（spec §11 的 4→5 陷阱之一）。
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
        // 整段会话的展示项由 GET 提供，两者同一个 foldTranscript，只差范围（spec §9）。
        items: foldTranscript(turn.added),
        stopReason: turn.stopReason,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: { code: 'session_not_found', message: error.message } });
        return;
      }
      // 其余交给错误中间件。express 5 会把 async handler 的 rejected promise
      // 自动转过去 —— 这正是选 express 5 而不是 4 的主要理由（spec D12）
      throw error;
    }
  });

  app.get(sessionPath, (req: Request<SessionParams>, res: Response) => {
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
  // 不再接受裸 `*`，会在启动时就抛「Missing parameter name」（spec §11 的另一个 4→5 陷阱）。
  // 用 app.use 更稳，而且必须返回 JSON：express 默认的 HTML 错误页会让
  // 前端的 res.json() 抛 SyntaxError，表现为一个完全不指向原因的解析错误。
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: '没有这个接口' } });
  });

  // 错误中间件：必须**恰好一个、注册在最后**，且是 4 参函数
  // （express 按函数 arity 识别它，写成 3 参会变成普通中间件）
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // body-parser 解析失败时抛的 SyntaxError **自带 status: 400**，
    // 不先放行它就会被当成服务端错误返回 500（spec §13）
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

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 8: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/package.json demos/02-agent/pnpm-lock.yaml \
        demos/02-agent/apps/server/src/http/app.ts demos/02-agent/apps/server/test/http-app.test.ts
git commit -m "feat(server): 引入 express 并实现 REST 接口（建会话 / 发消息 / 取历史）"
```

---

### Task 11: 进程入口、配置与服务端脚本

对应 spec §3 的「只有 `src/main.ts` 碰 `process`」。

**Files:**
- Create: `demos/02-agent/apps/server/src/llm/config.ts`
- Create: `demos/02-agent/apps/server/src/main.ts`
- Modify: `demos/02-agent/apps/server/.env`
- Test: `demos/02-agent/apps/server/test/config.test.ts`、`test/main.test.ts`

**Interfaces:**
- Consumes: Task 10 的 `createApp`；Task 8 的 `createSessionRegistry` / `newSessionId`；
  L1 的 `LLMClientConfig`；L2 的 `createToolRegistry`；L3 的 `createDeepSeekClient`
- Produces: `resolveConfig(env: NodeJS.ProcessEnv): LLMClientConfig`；一个能 `pnpm start` 起来的服务端进程；
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
import type { LLMClientConfig } from '@/llm/client.ts';

const DEFAULT_PORT = 3000;
/** 只监听回环地址。这是个本机开发工具，不是可暴露的服务（spec D17） */
const DEFAULT_HOST = '127.0.0.1';

/**
 * 读配置。缺 key 就让进程在**启动时**死掉 ——
 * 带着空 key 起来只会让第一次请求拿到一个 401 再回头猜原因。
 *
 * 写成独立函数而不是内联的 try/catch：`process.exit` 的类型是 `never`，
 * 于是这个函数在所有路径上都满足「有返回值」，不必引入一个可空的 `let config`。
 */
function loadConfig(): LLMClientConfig {
  try {
    return resolveConfig(process.env);
  } catch (error) {
    process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const config = loadConfig();

// 端口 0 表示「由内核分配一个空闲端口」—— 子进程测试靠这个避免端口冲突
const port = Number(process.env.AI_AGENT_PORT ?? DEFAULT_PORT);
const host = process.env.AI_AGENT_HOST ?? DEFAULT_HOST;

const sessions = createSessionRegistry({ newId: newSessionId, model: config.model });

const app = createApp({
  client: createDeepSeekClient(config),
  registry: createToolRegistry(),
  sessions,
  model: config.model,
  // 诊断日志的真实实现放在入口 —— 这是 `src/` 里唯一允许碰 process 的文件，
  // 也是 `http/app.ts` 的 logError 之所以必填的原因
  logError: (message: string) => {
    process.stderr.write(message + '\n');
  },
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

- [ ] **Step 9: 类型检查与全量测试**

Run: `cd demos/02-agent && pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试全绿（服务端累计 **121 条**）

- [ ] **Step 10: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server
git commit -m "feat(server): 新增进程入口与配置解析，服务端可独立启动"
```

---

## L5 的验证：你这一步看见了什么

1. **全量门 + curl 冒烟**（真实 API，**单独跑**）：

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
   Expected: 每条响应里都能看到对应的工具轨迹；历史返回的 items 覆盖全部轮次。

2. **亲眼看见「上游状态码不透出」** —— 把 `.env.local` 里的 key 改坏一位，重启，再发一次消息：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "localhost:3000/api/sessions/$id/messages" \
     -H 'content-type: application/json' -d '{"message":"你好"}'
   ```
   Expected: `502`，**不是 401**。换回来。

3. **亲眼看见 404 分支**（会话 id 随便造一个）：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "localhost:3000/api/sessions/nope/messages"
   ```
   Expected: `404`。

**下一步** → [`l6-web-and-docs.md`](./2026-09-25-l6-web-and-docs.md)：把它接到浏览器上，
让工具轨迹真的显示出来。
