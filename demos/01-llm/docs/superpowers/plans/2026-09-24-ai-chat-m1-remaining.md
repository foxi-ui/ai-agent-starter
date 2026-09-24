# ai-chat M1 剩余缺口补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 M1（对话部分）验收标准中尚未落地的部分：错误输出分流到 stderr、为两条 Review Focus 缺口补自动化测试、同步文档，并完成唯一未验证的验收项（真实网络手动冒烟）。

**Architecture:** 不新增模块、不改变分层。改动局限在 `cli/`（把诊断输出与模型输出分成两条通道）与 `test/`（补 3 个用例 + 1 个集成测试文件）。`llm/`、`core/` 完全不动。

**Tech Stack:** Node 22（原生 TS 类型擦除）、pnpm、TypeScript（`tsc --noEmit`）、`node --test`、`node:child_process`（集成测试）。

**Spec:** `demos/01-llm/docs/superpowers/specs/2026-09-23-ai-chat-design.md`（尤其 §8 错误处理、§13 验收）

**上一份计划:** `demos/01-llm/docs/superpowers/plans/2026-09-23-ai-chat-conversation.md`（Task 1–6 已执行完毕）

---

## 背景：M1 完成度与缺口

M1 的代码骨架已全部落地并通过验证（`tsc --noEmit` 退出码 0；`node --test` 12/12 通过）。逐条比对 spec 与上一份计划的 Review Focus 后，仍有 4 处未闭合：

| # | 缺口 | 依据 | 类型 |
|---|---|---|---|
| G1 | 错误信息写到了 **stdout**，spec §8 明确要求 **stderr** | spec §8 / Review Focus #2 | 代码偏差 |
| G2 | Review Focus #1「缺 key → 退出码 1」只有 `resolveConfig` 的单元测试，**退出码本身无自动化覆盖** | Review Focus #1 | 测试缺口 |
| G3 | Review Focus #3「fetch 抛错」在 `deepseek.ts` 的真实路径**无测试**（现有用例是 fake client 抛错，绕过了 adapter） | Review Focus #3 | 测试缺口 |
| G4 | spec §13 第 3 条「真实网络手动冒烟」**未执行、无记录** | spec §13 | 验收缺口 |

另有两处**非缺口**，一并说明以免误判：

- `EVALUATION.md` 缺失 —— 上一份计划已声明依赖后续增量，本次也不做。
- `src/index.ts` 中 `runRepl(...)` 未 `await`、无 `.catch`。当前无可复现故障（stdin 持有事件循环；REPL 内部已捕获 `chat()` 全部异常）。属 M5「错误分类 + 退出码」的范围，**本次不动**——没有证据的改动不做。

### 已实测确认的偏差（G1 的证据）

```console
$ printf 'hi\n' | DEEPSEEK_API_KEY=bad-key pnpm start 1>out.txt 2>err.txt
$ cat out.txt
You:
[error] DeepSeek API error 401: Authentication Fails ...
$ cat err.txt      # 空
```

spec §8 写的是「打印错误到 **stderr**」。现有 `repl.ts` 只有一个注入的 `output` 通道，
测试里两条流是同一个，所以断言全绿却掩盖了偏差。

---

## Global Constraints

- Node ≥ 22（依赖原生类型擦除直接运行 `.ts`；本项目在 v22.23.2 验证）
- 零运行时依赖；devDependency 仅 `typescript`、`@types/node`
- ESM：`package.json` `"type": "module"`
- 目录：`demos/01-llm/` 为项目根，代码在 `src/`，测试在 `test/`
- 分层依赖单向：`cli → core → llm`；`llm`/`core` 不 import `node:readline`、不写 `process.stdout` / `process.stderr`。**本次把错误写入 `process.stderr`，写入方仍是 `cli/` 层，约束不变**
- 源码统一用 `@/` 别名指向 `src/`；`start` / `test` 脚本必须带 `--import ./loader.mjs`（Node 原生类型擦除不读 tsconfig 的 `paths`）
- 密钥只经环境变量注入：`.env` 只放占位符（入库），真实值放 `.env.local`（已在 `.gitignore`）
- 测试不得依赖真实网络。唯一例外是 Task 5 的手动冒烟，它**不进入 `pnpm test`**
- 所有验证命令在 `demos/01-llm/` 目录下执行

## Review Focus

改完之后，以下输入/场景是「测试可能覆盖不到、但使用者一定会踩」的点，请手动确认：

1. **`pnpm start > answers.txt`** → `answers.txt` 里**只有模型回答与提示符**，不出现任何 `[error]` 行。
   （`pnpm` 自己的命令横幅会出现在文件开头，那是 pnpm 的输出；用 `pnpm --silent start` 可完全消除。）
2. **缺 `DEEPSEEK_API_KEY` 启动** → 中文提示出现在 **stderr**，**stdout 为空**，**退出码 1**。
3. **`fetch` 抛错（ECONNREFUSED / DNS 失败）** → 异常**原样冒泡**出 `deepseek.ts`，不被吞成空 `content`，能到达 REPL 的 `catch`。
4. **错误体不是 JSON（如 502 返回 HTML）** → 抛出的错误里带**原始 body 文本**，而不是 `SyntaxError: Unexpected token '<'`。
5. **回归** → 现有 12 个用例保持全绿，`tsc --noEmit` 保持退出码 0。

---

### Task 1: 错误输出分流到 stderr

**Files:**
- Modify: `demos/01-llm/src/cli/repl.ts`（`ReplOptions` 增字段；新增 `writeError`；`catch` 分支改用它）
- Modify: `demos/01-llm/src/index.ts`（传入 `process.stderr`）
- Test: `demos/01-llm/test/repl.test.ts`（全量重写：3 个既有用例适配双通道 + 新增 1 个分流用例）

**Interfaces:**
- Consumes: `LLMClient`（`@/llm/client.ts`）、`Session`（`@/core/session.ts`）
- Produces:
  - `interface ReplOptions { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; errorOutput: NodeJS.WritableStream; prompt: string }`
  - `runRepl(client: LLMClient, options: ReplOptions): Promise<void>`（签名不变，`ReplOptions` 多一个**必填**字段）

> **注意**：`errorOutput` 是必填字段。这是刻意的——加上它就是为了让「忘记分流」在类型检查阶段就暴露，而不是等到用户重定向 stdout 时才发现。

- [ ] **Step 1: 改测试，先让它失败**

用下面的内容**整体替换** `test/repl.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runRepl, SYSTEM_PROMPT } from '@/cli/repl.ts';
import type { LLMClient } from '@/llm/client.ts';

function collector(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { chunks, stream };
}

// 造出 output / errorOutput 两条独立通道并分别捕获，
// 这样才能断言「回答走 stdout、错误走 stderr」。
// 初版只有一个流，导致「错误写错流」这一偏差在测试里看不出来。
function captureOutput() {
  const out = collector();
  const err = collector();
  return {
    chunks: out.chunks,
    stream: out.stream,
    errChunks: err.chunks,
    errStream: err.stream,
  };
}

function fakeClient(answers: Array<string | Error>): LLMClient {
  let i = 0;
  return {
    async chat() {
      const a = answers[i++];
      if (a instanceof Error) throw a;
      return { content: a ?? '' };
    },
  };
}

function inputFrom(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n'));
}

test('一问一答并打印回答', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client = fakeClient(['你好']);
  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
  });
  assert.ok(chunks.some((c) => c.includes('你好')));
  assert.ok(chunks.some((c) => c.includes('You: ')));
  // 一切正常时 stderr 应当完全安静
  assert.deepEqual(errChunks, []);
});

test('错误写 stderr，不污染 stdout', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client = fakeClient([new Error('DeepSeek API error 401: Invalid API key')]);
  await runRepl(client, {
    input: inputFrom(['第一问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
  });
  const err = errChunks.join('');
  assert.ok(err.startsWith('[error]'));
  assert.ok(err.includes('Invalid API key'));
  // stdout 里除了提示符，不应出现任何错误信息——
  // 否则 `pnpm start > answers.txt` 会把报错混进回答文件
  assert.ok(!chunks.join('').includes('Invalid API key'));
});

test('非 2xx 错误不崩溃，继续下一轮', async () => {
  const { chunks, stream, errStream } = captureOutput();
  const client = fakeClient([new Error('DeepSeek API error 401: Invalid API key'), '恢复']);
  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
  });
  const joined = chunks.join('');
  assert.ok(joined.includes('恢复'));
});

test('多轮对话上下文按序累积', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const client: LLMClient = {
    async chat(messages) {
      sent.push(messages);
      return { content: 'ok' };
    },
  };
  const { stream, errStream } = captureOutput();
  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '第二问' },
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import ./loader.mjs --test test/repl.test.ts`
Expected: **1 个用例 FAIL，3 个 PASS**。失败的是 `错误写 stderr，不污染 stdout`，
失败原因：`errChunks` 为空（`err.startsWith('[error]')` 落空），且 `chunks` 里出现了 `Invalid API key`。
其余 3 个用例不依赖双通道，因此照旧通过。

> **必须带 `--import ./loader.mjs`**（本文档所有「单文件跑测试」的命令同理）：
> 测试文件用 `@/` 别名导入源码，而 Node 原生类型擦除不读 tsconfig 的 `paths`。
> 少了这个标志会整文件失败在 `ERR_MODULE_NOT_FOUND: Cannot find package '@/cli'`，
> 而不是报告「1 个用例失败」——这一点在执行时踩过一次。

同时确认类型层面也是红的：

Run: `pnpm run typecheck`
Expected: FAIL —— `errorOutput` 不在 `ReplOptions` 里（`Object literal may only specify known properties`）。

> 本项目由 Node 直接运行 `.ts`，类型错误不会阻止 `node --test` 执行，
> 所以「运行期红」和「类型期红」要分别确认。

- [ ] **Step 3: 改 `src/cli/repl.ts` —— 给 `ReplOptions` 加通道**

把：

```ts
/** 运行 REPL 需要的输入输出通道与提示符 */
export interface ReplOptions {
  /** 从哪里读用户输入（真实运行时是 process.stdin） */
  input: NodeJS.ReadableStream;
  /** 往哪里写回答（真实运行时是 process.stdout） */
  output: NodeJS.WritableStream;
  /** 提示符，例如 'You: ' */
  prompt: string;
}
```

替换为：

```ts
/** 运行 REPL 需要的输入输出通道与提示符 */
export interface ReplOptions {
  /** 从哪里读用户输入（真实运行时是 process.stdin） */
  input: NodeJS.ReadableStream;
  /** 往哪里写模型回答（真实运行时是 process.stdout） */
  output: NodeJS.WritableStream;
  /**
   * 往哪里写错误与诊断信息（真实运行时是 process.stderr）。
   *
   * 与 output 分开是刻意的：stdout 只承载模型回答，
   * 这样 `pnpm start > answers.txt` 得到的文件是干净的回答，
   * 不会混进报错；管道里也能按流分别过滤。
   * 声明为必填字段，是为了让「忘记分流」在编译期就暴露。
   */
  errorOutput: NodeJS.WritableStream;
  /** 提示符，例如 'You: ' */
  prompt: string;
}
```

- [ ] **Step 4: 改 `src/cli/repl.ts` —— 新增 `writeError`**

在 `write` 定义之后追加：

```ts
  // 统一在这里补换行，省得每个调用点都自己写 '\n'
  const write = (text: string) => {
    options.output.write(text + '\n');
  };

  // 诊断信息的专用通道。与 write 对称，但写到 stderr
  const writeError = (text: string) => {
    options.errorOutput.write(text + '\n');
  };
```

- [ ] **Step 5: 改 `src/cli/repl.ts` —— `catch` 分支改用 `writeError`**

把：

```ts
    } catch (error) {
      // 最小错误处理：打印错误后继续循环。
      // 不崩溃，也不污染上下文——失败的轮次不留 assistant 消息。
      write(`[error] ${(error as Error).message}`);
    }
```

替换为：

```ts
    } catch (error) {
      // 最小错误处理：打印错误后继续循环。
      // 不崩溃，也不污染上下文——失败的轮次不留 assistant 消息。
      // 走 stderr：stdout 只留给模型回答，重定向时不被诊断信息污染。
      writeError(`[error] ${(error as Error).message}`);
    }
```

- [ ] **Step 6: 改 `src/index.ts` —— 传入 `process.stderr`**

把：

```ts
runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: ',
});
```

替换为：

```ts
runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  // 模型回答 → stdout
  output: process.stdout,
  // 错误与诊断 → stderr，两条流互不污染
  errorOutput: process.stderr,
  prompt: 'You: ',
});
```

- [ ] **Step 7: 跑测试与类型检查确认通过**

Run: `node --import ./loader.mjs --test test/repl.test.ts`
Expected: PASS（4 个用例）

Run: `pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 8: 手动确认分流真的生效**

Run:

```bash
printf 'hi\n' | DEEPSEEK_API_KEY=bad-key pnpm start 1>/tmp/out.txt 2>/tmp/err.txt; echo "exit=$?"
echo "--- stdout ---"; cat /tmp/out.txt
echo "--- stderr ---"; cat /tmp/err.txt
```

Expected: `stdout` 只有 `You: `；`stderr` 是 `[error] DeepSeek API error 401: ...`。

> **实测补充**：用 `pnpm start` 时 stdout 开头还会有 pnpm 自己打印的
> `> ai-chat@1.0.0 start ...` 命令横幅——**那是 pnpm 的输出，不是本程序的**。
> 想拿到完全干净的文件用 `pnpm --silent start`，实测 stdout 恰好只有 `You: `。
> 这一条已记入 `DECISIONS.md` 的 D13。

- [ ] **Step 9: Commit**

```bash
git add src/cli/repl.ts src/index.ts test/repl.test.ts
git commit -m "fix: route REPL error output to stderr"
```

---

### Task 2: 补 `deepseek.ts` 的两条异常路径测试

**Files:**
- Modify: `demos/01-llm/test/deepseek.test.ts`（在文件末尾追加 2 个用例）
- 不改动任何源码 —— 本任务只补测试。若某条断言失败，说明发现了真实缺陷，**停下来报告，不要为了让测试变绿而改测试**。

**Interfaces:**
- Consumes: `createDeepSeekClient`（`@/llm/deepseek.ts`）、文件内已有的 `mockFetch` / `jsonResponse` / `config` 三个局部辅助
- Produces: 无（纯测试）

- [ ] **Step 1: 追加两条失败用例**

在 `test/deepseek.test.ts` 末尾追加：

```ts
test('fetch 抛错时向上冒泡，不被吞掉', async () => {
  // 模拟网络层失败（DNS 解析失败 / 连接被拒）：fetch 本身 reject。
  // 这一层刻意不 catch——吞掉异常会让上层看到一个假的空回答，
  // 反而掩盖故障。交给 REPL 的 try/catch 决定怎么显示。
  mockFetch(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:443');
  });

  const client = createDeepSeekClient(config);
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    /ECONNREFUSED/,
  );
});

test('错误体不是 JSON 时回落为原始文本', async () => {
  // 官方未给出错误响应体的字段名（见 docs/01-full-design.md §12），
  // 所以 JSON 解析失败必须优雅回落到原始 body，
  // 而不是把 SyntaxError 抛出去、让调用方看不到真正的状态码与原因。
  mockFetch(async () =>
    new Response('<html>502 Bad Gateway</html>', { status: 502 }),
  );

  const client = createDeepSeekClient(config);
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    /502 Bad Gateway/,
  );
});
```

- [ ] **Step 2: 跑测试**

Run: `node --import ./loader.mjs --test test/deepseek.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 3: Commit**

```bash
git add test/deepseek.test.ts
git commit -m "test: cover fetch rejection and non-JSON error body"
```

---

### Task 3: 集成测试 —— 缺 key 时的退出码与输出流

**Files:**
- Create: `demos/01-llm/test/index.test.ts`

**Interfaces:**
- Consumes: `src/index.ts`（作为子进程运行，`cwd` 为项目根）
- Produces: 无（集成测试）

> **为什么必须开子进程**：退出码是进程级行为，`resolveConfig` 的单元测试断言不了它。
> 这是 Review Focus #1 唯一无法用单元测试覆盖的点。

> **为什么用相对路径 `./loader.mjs` 而不是 `@/`**：本测试文件只用 `node:` 内置模块，
> 不引用项目源码，因此**不需要**别名解析，也不会因为 loader 配置变化而失效。

- [ ] **Step 1: 写失败的集成测试**

创建 `test/index.test.ts`：

```ts
// 入口文件的集成测试：真的把 src/index.ts 当子进程跑一遍。
//
// 退出码是进程级行为，单元测试断言不了——只能起一个真实进程观察。
// 本用例不触网：缺少 API key 时程序在发起请求之前就退出了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 以本文件位置推导项目根，而不是依赖 cwd——
// 测试运行器可能从子目录派生进程。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--import', './loader.mjs', 'src/index.ts'],
      {
        cwd: projectRoot,
        env,
        // stdin 用 ignore：程序读不到输入会立刻结束，不会挂住测试
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('缺少 DEEPSEEK_API_KEY 时提示到 stderr 并以退出码 1 退出', async () => {
  // 复制一份环境变量再删掉 key，而不是直接传 {}：
  // `pnpm test` 会加载 .env / .env.local，父进程里可能已经存在真实 key，
  // 必须显式删除才是「模拟未配置」。
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;

  const result = await runCli(env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /DEEPSEEK_API_KEY/);
  // stdout 必须干净：此时还没有任何模型回答，
  // 提示信息跑到 stdout 会让 `> answers.txt` 收到一行垃圾
  assert.equal(result.stdout, '');
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `node --import ./loader.mjs --test test/index.test.ts`
Expected: PASS（1 个用例）。本文件只用 `node:` 内置模块，其实不带 loader 也能跑，
这里统一写法以免复制命令时踩坑。

（此用例的预期行为当前实现已经满足，因此它不会先失败——它的价值在于**锁住**这个行为，防止后续重构（例如把 `process.exit(1)` 换成 `throw`）悄悄改掉退出码。）

- [ ] **Step 3: 跑全量测试**

Run: `pnpm test`
Expected: PASS（session 2 + deepseek 6 + repl 4 + config 3 + index 1 = **16 个用例**）

- [ ] **Step 4: Commit**

```bash
git add test/index.test.ts
git commit -m "test: verify missing-key exit code via subprocess"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `demos/01-llm/HOW-IT-WORKS.md`
- Modify: `demos/01-llm/README.md`
- Modify: `demos/01-llm/DECISIONS.md`

**Interfaces:**
- Consumes: 无（纯文档，引用已完成代码）
- Produces: 与代码一致的文档

- [ ] **Step 1: 改 `HOW-IT-WORKS.md` 的数据流图**

把：

```text
  ├─ 成功：session.append('assistant', content) → 打印 content
  └─ 失败：打印 [error] ... → 不 append（上下文保持干净）
```

替换为：

```text
  ├─ 成功：session.append('assistant', content) → 打印 content 到 stdout
  └─ 失败：打印 [error] ... 到 stderr → 不 append（上下文保持干净）
```

- [ ] **Step 2: 改 `HOW-IT-WORKS.md` 的错误处理表与「两个细节」**

在错误处理表格后、`两个细节：` 之前插入一段：

```markdown
**输出去向**：模型回答走 **stdout**，错误与诊断走 **stderr**。
因此 `pnpm start > answers.txt` 得到的文件里只有回答；
`pnpm start 2>/dev/null` 也能单独屏蔽报错。

`ReplOptions` 因此有两个输出通道（`output` / `errorOutput`），
且都是必填字段——忘记分流会在类型检查阶段被拦下。
```

- [ ] **Step 3: 改 `HOW-IT-WORKS.md` 的「验证方式」表**

把：

```markdown
| 行为 | 测试 |
| --- | --- |
| 消息按序累积、`system` 在最前 | `test/session.test.ts` |
| 请求体 / 响应解析 / 401 抛错 / 空 content | `test/deepseek.test.ts`（mock `globalThis.fetch`） |
| 一问一答、报错后继续、多轮上下文形状 | `test/repl.test.ts`（fake `LLMClient`） |
| 缺 key 抛错、默认值、环境变量覆盖 | `test/config.test.ts` |
```

替换为：

```markdown
| 行为 | 测试 |
| --- | --- |
| 消息按序累积、`system` 在最前 | `test/session.test.ts` |
| 请求体 / 响应解析 / 401 抛错 / 空 content / fetch 抛错 / 非 JSON 错误体 | `test/deepseek.test.ts`（mock `globalThis.fetch`） |
| 一问一答、错误写 stderr 不污染 stdout、报错后继续、多轮上下文形状 | `test/repl.test.ts`（fake `LLMClient`） |
| 缺 key 抛错、默认值、环境变量覆盖 | `test/config.test.ts` |
| 缺 key 时 stderr 提示 + 退出码 1 | `test/index.test.ts`（子进程集成测试） |
```

- [ ] **Step 4: 改 `README.md` 的常用命令表**

把：

```markdown
| `pnpm test` | 运行全部测试（`node --test`，当前 12 个用例） |
```

替换为：

```markdown
| `pnpm test` | 运行全部测试（`node --test`，当前 16 个用例） |
```

- [ ] **Step 5: 改 `README.md` 的「当前能力边界 · 已实现」**

把：

```markdown
- 最小错误处理：API 报错打印后继续循环，不崩溃、不污染上下文
```

替换为：

```markdown
- 最小错误处理：API 报错打印到 **stderr** 后继续循环，不崩溃、不污染上下文；
  模型回答走 stdout，两条流互不干扰（`pnpm start > answers.txt` 只拿到回答）
```

- [ ] **Step 6: 改 `README.md` 的项目结构**

在 `test/` 列表末尾追加一行（放在 `config.test.ts` 之后）：

```text
    index.test.ts       # 入口集成测试（子进程，验证退出码）
```

- [ ] **Step 7: 在 `DECISIONS.md` 末尾追加 D13**

```markdown
---

## D13. 错误输出走 stderr，与模型回答分流

**决策**：`ReplOptions` 增加必填的 `errorOutput`，REPL 捕获到的错误写 stderr；
`output`（stdout）**只承载模型回答**。`index.ts` 传入 `process.stderr`。

**理由**

- spec §8 明确要求「打印错误到 stderr」，而初版实现把它写进了 `output`。
  在测试里两条通道是同一个注入流，所以**12 个用例全绿却掩盖了这个偏差**——
  直到手动执行 `pnpm start 1>out.txt 2>err.txt` 才暴露（`out.txt` 里有报错，`err.txt` 是空的）。
- 分流后 `pnpm start > answers.txt` 得到的文件里只有回答；
  管道场景下也能按流分别过滤（例如 `2>/dev/null` 屏蔽诊断信息）。

**代价**：`ReplOptions` 多一个必填字段，调用点与测试都要同步传参
（生产调用点只有一个：`src/index.ts`）。

**顺带记下的教训**：注入单一输出流做断言时，「写错流」这类偏差是**测不出来**的。
把两条流都做成注入参数，才能让分流本身成为可断言的行为。

---

## D14. 用子进程集成测试锁住退出码

**决策**：新增 `test/index.test.ts`，用 `node:child_process` 真的跑一遍
`src/index.ts`，断言「缺 key → stderr 有提示 + stdout 为空 + 退出码 1」。

**理由**：退出码是**进程级**行为。`resolveConfig` 的单元测试只能断言「会抛错」，
断言不了「进程最终以 1 退出」——把 `process.exit(1)` 改成 `throw` 或删掉 catch，
单元测试依然全绿，而脚本和 CI 的判断依据已经坏了。

**代价**：测试多起一个 Node 进程（约百毫秒），且依赖 `--import ./loader.mjs` 的路径正确。
本用例不触网（缺 key 时程序在发起请求前就退出），因此不会让测试变慢或不稳定。
```

- [ ] **Step 8: 最终验证**

Run: `pnpm run typecheck && pnpm test`
Expected: typecheck 退出码 0；测试 16/16 通过

- [ ] **Step 9: Commit**

```bash
git add HOW-IT-WORKS.md README.md DECISIONS.md
git commit -m "docs: record stderr split and exit-code coverage"
```

---

### Task 5: 真实网络手动冒烟（spec §13 第 3 条）

**Files:**
- 无代码改动。本任务只做验证与记录。

**Interfaces:**
- Consumes: `pnpm start`、`.env.local` 中的真实 key
- Produces: M1 第 3 条验收项的结论

> ⚠️ **执行前需用户确认**：这一步会向 DeepSeek 发出**真实请求**（消耗账号余额、
> 把提问内容发送到第三方服务）。密钥取自 `.env.local`。未获确认不要执行。
> 这是 spec 里唯一不进 `pnpm test` 的验收项，也正是它当初被漏掉的原因。

- [ ] **Step 1: 确认密钥已就绪（不打印密钥本身）**

Run:

```bash
awk -F= '/^DEEPSEEK_API_KEY=/{printf "len=%d\n", length($2)}' .env.local
```

Expected: 输出一个大于 20 的长度值（说明 `.env.local` 里是真实 key，不是占位符）。

- [ ] **Step 2: 跑两轮真实对话**

Run:

```bash
printf '什么是 React Server Components？\n用一句话总结刚才的内容\n' | pnpm start
```

Expected: 两段回答依次打印；第二段能**引用第一段的主题**（而不是回答「你没有告诉我任何内容」）——这是「多轮上下文」端到端的证据。

- [ ] **Step 3: 判断结果**

- **通过**：第二段回答明确提到了 React Server Components（或其要点）→ M1 第 3 条验收项闭合。
- **不通过**：第二段回答声称没有上下文 / 要求重复问题 → **停下来，不要改代码**。
  按 `superpowers:systematic-debugging` 定位（最可能的怀疑点：`toMessages` 未带上历史、
  或 readline 异步迭代器提前结束），并报告。

- [ ] **Step 4: 记录结论**

把冒烟结果（命令、观察到的现象、是否通过）写进最终报告。
**不**新建文档文件——本次已在 Task 4 同步了三份文档，再加一份属于超范围。

- [ ] **Step 5: 无代码改动，无需 commit**

---

## 完成标准

```text
TypeCheck: pnpm run typecheck  → 退出码 0
Lint:      N/A（项目未配置 linter，devDependency 仅 typescript + @types/node）
Test:      pnpm test           → 16/16 通过
Build:     N/A（noEmit，Node 直接运行 .ts，无构建产物）
冒烟:      Task 5 两轮真实对话 → 第二段引用第一段主题
```
