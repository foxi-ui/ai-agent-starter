# ai-chat 对话部分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CLI 模式下实现一个非流式多轮 AI 对话工具，直接调用 DeepSeek API，多轮上下文在内存中累积。

**Architecture:** 三层内核（`cli → core → llm`），依赖严格单向，`llm`/`core` 不碰 `process.stdout`。`llm` 层以 `LLMClient` 接口为边界，测试用替身替换，使 CLI 行为可在无网络下断言。骨架为后续 streaming/命令/落盘增量预留挂载点。

**Tech Stack:** Node 22（原生 TS 类型擦除）、pnpm（包管理器）、TypeScript（`tsc --noEmit` 做类型检查）、`node --test`、原生 `fetch`、`node:readline`。零运行时依赖；devDependency 仅 `typescript` + `@types/node`。

**Spec:** `demos/ai-chat/docs/superpowers/specs/2026-09-23-ai-chat-design.md`

## Global Constraints

- Node ≥ 22（依赖原生类型擦除直接运行 `.ts`）
- 零运行时依赖；devDependency 仅 `typescript`、`@types/node`
- ESM：`package.json` `"type": "module"`
- 目录：`demos/ai-chat/` 为项目根，代码在 `src/`，测试在 `test/`
- 分层依赖单向：`cli → core → llm`；`llm`/`core` 不 import `node:readline`、不写 `process.stdout`
- 环境变量：`DEEPSEEK_API_KEY`（必需）、`DEEPSEEK_BASE_URL`（可选，默认 `https://api.deepseek.com`）、`AI_CHAT_MODEL`（可选，默认 `deepseek-flash`）
- 密钥只经环境变量注入，禁止写进代码
- 所有验证命令在 `demos/ai-chat/` 目录下执行

## Review Focus

以下输入/场景是 spec 隐含、但逐条任务测试可能没覆盖到、最容易让使用者踩坑的点（按优先级排）：

1. **缺 `DEEPSEEK_API_KEY` 启动** → 期望：清晰提示后以退出码 1 退出，而不是抛 `undefined` 相关异常或卡住。
2. **API 返回非 2xx（如 401）** → 期望：打印错误到 stderr、不追加失败的 assistant 消息、继续 REPL 循环不崩溃。
3. **网络层异常（fetch 抛错，如 DNS/连接拒绝）** → 期望：同上，打印后继续循环。
4. **连续两轮对话后「总结刚才内容」** → 期望：`messages` 里按序包含 system + 上一轮 user/assistant + 当前 user，上下文未丢失。
5. **API 响应缺少 `choices[0].message.content`（空内容）** → 期望：不崩溃，打印空行或明确占位，而不是访问 `undefined` 抛错。

（每条对应的测试已落到拥有该代码的任务中。）

---

### Task 1: 项目脚手架与类型定义

**Files:**
- Create: `demos/ai-chat/package.json`
- Create: `demos/ai-chat/tsconfig.json`
- Create: `demos/ai-chat/src/core/types.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `Role = 'system' | 'user' | 'assistant'`
  - `interface Message { role: Role; content: string }`
  - `interface ChatResult { content: string }`（`LLMClient.chat` 的返回值，Task 2 定义接口，Task 4 消费）

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "ai-chat",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node src/index.ts",
    "test": "node --test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 写 `src/core/types.ts`**

```ts
export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

export interface ChatResult {
  content: string;
}
```

- [ ] **Step 4: 安装 devDependency 并跑类型检查**

Run: `pnpm install`
Expected: 安装 `typescript`、`@types/node` 成功，无错误。

Run: `pnpm run typecheck`
Expected: 退出码 0，无输出（`types.ts` 类型正确）。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json src/core/types.ts
git commit -m "chore: scaffold ai-chat project with types"
```

---

### Task 2: LLMClient 接口

**Files:**
- Create: `demos/ai-chat/src/llm/client.ts`

**Interfaces:**
- Consumes: `Message`（来自 `../core/types.ts`）
- Produces:
  - `interface LLMClient { chat(messages: Message[]): Promise<ChatResult> }`
  - `type LLMClientFactory = (env: { apiKey: string; baseUrl: string; model: string }) => LLMClient`

- [ ] **Step 1: 写 `src/llm/client.ts`**

```ts
import type { ChatResult, Message } from '../core/types.ts';

export interface LLMClient {
  chat(messages: Message[]): Promise<ChatResult>;
}

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type LLMClientFactory = (config: LLMClientConfig) => LLMClient;
```

- [ ] **Step 2: 跑类型检查**

Run: `pnpm run typecheck`
Expected: 退出码 0（纯类型文件）。

- [ ] **Step 3: Commit**

```bash
git add src/llm/client.ts
git commit -m "feat: define LLMClient interface"
```

---

### Task 3: Session 会话状态

**Files:**
- Create: `demos/ai-chat/src/core/session.ts`
- Test: `demos/ai-chat/test/session.test.ts`

**Interfaces:**
- Consumes: `Message`、`Role`（来自 `./types.ts`）
- Produces:
  - `class Session { append(role: Role, content: string): void; toMessages(systemPrompt: string): Message[] }`

- [ ] **Step 1: 写失败测试 `test/session.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/core/session.ts';

test('append 按序保存消息', () => {
  const s = new Session();
  s.append('user', '什么是 React Server Components？');
  s.append('assistant', '它是……');
  assert.deepEqual(s.toMessages(''), [
    { role: 'user', content: '什么是 React Server Components？' },
    { role: 'assistant', content: '它是……' },
  ]);
});

test('toMessages 把 system 放在最前', () => {
  const s = new Session();
  s.append('user', '总结刚才内容');
  assert.deepEqual(s.toMessages('你是 CLI AI 助手'), [
    { role: 'system', content: '你是 CLI AI 助手' },
    { role: 'user', content: '总结刚才内容' },
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/session.test.ts`
Expected: FAIL（`Cannot find module '../src/core/session.ts'`）

- [ ] **Step 3: 实现 `src/core/session.ts`**

```ts
import type { Message, Role } from './types.ts';

export class Session {
  private messages: Message[] = [];

  append(role: Role, content: string): void {
    this.messages.push({ role, content });
  }

  toMessages(systemPrompt: string): Message[] {
    const messages: Message[] = [];
    if (systemPrompt !== '') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    return messages.concat(this.messages);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/session.test.ts`
Expected: PASS（2 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts test/session.test.ts
git commit -m "feat: add session message accumulation"
```

---

### Task 4: DeepSeek adapter

**Files:**
- Create: `demos/ai-chat/src/llm/deepseek.ts`
- Test: `demos/ai-chat/test/deepseek.test.ts`

**Interfaces:**
- Consumes: `LLMClient`、`LLMClientConfig`（来自 `./client.ts`）、`Message`（来自 `../core/types.ts`）
- Produces: `function createDeepSeekClient(config: LLMClientConfig): LLMClient`

- [ ] **Step 1: 写失败测试 `test/deepseek.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekClient } from '../src/llm/deepseek.ts';

function mockFetch(
  handler: (url: string, init: Parameters<typeof fetch>[1]) => Promise<Response>,
) {
  globalThis.fetch = handler as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const config = {
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
};

test('请求体包含 model 和 messages', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    capturedInit = init;
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: '你好' } }],
    });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }]);

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  const headers = capturedInit!.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer test-key');
});

test('成功时返回 content，抑制 reasoning_content', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '最终回答',
            reasoning_content: '思考过程应被抑制',
          },
        },
      ],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(result, { content: '最终回答' });
});

test('非 2xx 抛出错误', async () => {
  mockFetch(async () =>
    jsonResponse({ error: { message: 'Invalid API key' } }, 401),
  );

  const client = createDeepSeekClient(config);
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    /Invalid API key/,
  );
});

test('content 缺失时返回空串不崩溃', async () => {
  mockFetch(async () => jsonResponse({ choices: [{}] }));
  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(result, { content: '' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/deepseek.test.ts`
Expected: FAIL（`Cannot find module '../src/llm/deepseek.ts'`）

- [ ] **Step 3: 实现 `src/llm/deepseek.ts`**

```ts
import type { ChatResult, LLMClient, LLMClientConfig } from './client.ts';
import type { Message } from '../core/types.ts';

export function createDeepSeekClient(config: LLMClientConfig): LLMClient {
  const url = `${config.baseUrl}/chat/completions`;

  return {
    async chat(messages: Message[]): Promise<ChatResult> {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, messages }),
      });

      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        throw new Error(
          `DeepSeek API error ${response.status}: ${detail}`,
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices[0]?.message?.content ?? '';
      return { content };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/deepseek.test.ts`
Expected: PASS（4 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/llm/deepseek.ts test/deepseek.test.ts
git commit -m "feat: add DeepSeek client (non-streaming)"
```

---

### Task 5: REPL 主循环与入口

**Files:**
- Create: `demos/ai-chat/src/cli/repl.ts`
- Create: `demos/ai-chat/src/cli/config.ts`
- Create: `demos/ai-chat/src/index.ts`
- Test: `demos/ai-chat/test/repl.test.ts`
- Test: `demos/ai-chat/test/config.test.ts`

**Interfaces:**
- Consumes: `LLMClient`（来自 `../llm/client.ts`）、`Session`（来自 `../core/session.ts`）、`createDeepSeekClient`（来自 `../llm/deepseek.ts`）
- Produces:
  - `function runRepl(client: LLMClient, options: ReplOptions): Promise<void>`
  - `interface ReplOptions { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; prompt: string }`
  - `const SYSTEM_PROMPT = '你是 CLI AI 助手，简洁直接地回答问题。'`
  - `interface Config { apiKey: string; baseUrl: string; model: string }`
  - `function resolveConfig(env: NodeJS.ProcessEnv): Config`

- [ ] **Step 1: 写失败测试 `test/repl.test.ts`**

用 fake `LLMClient` + 可写流捕获输出，覆盖：正常一问一答、非 2xx 不崩溃并继续、fetch 抛错不崩溃并继续。

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runRepl, SYSTEM_PROMPT } from '../src/cli/repl.ts';
import type { LLMClient } from '../src/llm/client.ts';

function captureOutput(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { chunks, stream };
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
  const { chunks, stream } = captureOutput();
  const client = fakeClient(['你好']);
  await runRepl(client, { input: inputFrom(['hi']), output: stream, prompt: 'You: ' });
  assert.ok(chunks.some((c) => c.includes('你好')));
  assert.ok(chunks.some((c) => c.includes('You: ')));
});

test('非 2xx 错误不崩溃，继续下一轮', async () => {
  const { chunks, stream } = captureOutput();
  const client = fakeClient([new Error('DeepSeek API error 401: Invalid API key'), '恢复']);
  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    prompt: 'You: ',
  });
  const joined = chunks.join('');
  assert.ok(joined.includes('Invalid API key'));
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
  const { stream } = captureOutput();
  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
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

Run: `node --test test/repl.test.ts`
Expected: FAIL（`Cannot find module '../src/cli/repl.ts'`）

- [ ] **Step 3: 实现 `src/cli/repl.ts`**

```ts
import { createInterface } from 'node:readline';
import { Session } from '../core/session.ts';
import type { LLMClient } from '../llm/client.ts';

export const SYSTEM_PROMPT = '你是 CLI AI 助手，简洁直接地回答问题。';

export interface ReplOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  prompt: string;
}

export async function runRepl(
  client: LLMClient,
  options: ReplOptions,
): Promise<void> {
  const session = new Session();
  const rl = createInterface({ input: options.input, output: options.output });

  const write = (text: string) => {
    options.output.write(text + '\n');
  };

  write(options.prompt);

  // for await 逐行处理：每行的异步工作 await 完成后才进入下一行，
  // 循环在输入流关闭（rl 触发 close）时自然结束，避免异步竞态。
  for await (const line of rl) {
    const question = line.trim();
    if (question === '') continue;

    session.append('user', question);
    try {
      const result = await client.chat(session.toMessages(SYSTEM_PROMPT));
      session.append('assistant', result.content);
      write(result.content);
    } catch (error) {
      write(`[error] ${(error as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/repl.test.ts`
Expected: PASS（3 个测试通过）

- [ ] **Step 5: 写失败测试 `test/config.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/cli/config.ts';

test('缺少 apiKey 抛错', () => {
  assert.throws(() => resolveConfig({}), /DEEPSEEK_API_KEY/);
});

test('默认值生效', () => {
  const c = resolveConfig({ DEEPSEEK_API_KEY: 'k' });
  assert.equal(c.baseUrl, 'https://api.deepseek.com');
  assert.equal(c.model, 'deepseek-flash');
});

test('环境变量覆盖默认值', () => {
  const c = resolveConfig({
    DEEPSEEK_API_KEY: 'k',
    DEEPSEEK_BASE_URL: 'https://example.com',
    AI_CHAT_MODEL: 'deepseek-v4-pro',
  });
  assert.equal(c.baseUrl, 'https://example.com');
  assert.equal(c.model, 'deepseek-v4-pro');
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node --test test/config.test.ts`
Expected: FAIL（`Cannot find module '../src/cli/config.ts'`）

- [ ] **Step 7: 实现 `src/cli/config.ts`**

```ts
export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量，请先设置后重试。');
  }
  return {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: env.AI_CHAT_MODEL ?? 'deepseek-flash',
  };
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test test/config.test.ts`
Expected: PASS（3 个测试通过）

- [ ] **Step 9: 实现 `src/index.ts` 入口**

```ts
import { runRepl } from './cli/repl.ts';
import { resolveConfig, type Config } from './cli/config.ts';
import { createDeepSeekClient } from './llm/deepseek.ts';

let config: Config;
try {
  config = resolveConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: ',
});
```

- [ ] **Step 10: 跑全部测试 + 类型检查**

Run: `pnpm test`
Expected: PASS（session 2 + deepseek 4 + repl 3 + config 3 = 12 个测试）

Run: `pnpm run typecheck`
Expected: 退出码 0

- [ ] **Step 11: 手动冒烟（真实网络，需 key）**

Run: `DEEPSEEK_API_KEY=你的key pnpm start`
Expected: 进入 REPL，提问后打印回答（非流式）；连续问「总结刚才内容」能引用上一轮。

Run: `pnpm start`（不带 key）
Expected: 打印「缺少 DEEPSEEK_API_KEY…」并以退出码 1 退出。

- [ ] **Step 12: Commit**

```bash
git add src/cli/repl.ts src/cli/config.ts src/index.ts test/repl.test.ts test/config.test.ts
git commit -m "feat: add REPL loop, config resolution, and entrypoint"
```

---

### Task 6: 项目文档

**Files:**
- Create: `demos/ai-chat/README.md`
- Create: `demos/ai-chat/ARCHITECTURE.md`
- Create: `demos/ai-chat/HOW-IT-WORKS.md`
- Create: `demos/ai-chat/DECISIONS.md`

**Interfaces:**
- Consumes: 无（纯文档，引用已完成代码）
- Produces: 项目文档四件套（本增量不含 EVALUATION，因依赖 token 统计等后续增量）

- [ ] **Step 1: 写 `README.md`**

内容：项目简介、环境变量说明、运行方式（`pnpm start`）、测试（`pnpm test`）、类型检查（`pnpm run typecheck`）、当前能力边界（仅对话部分）。

- [ ] **Step 2: 写 `ARCHITECTURE.md`**

内容：三层内核图、依赖方向、各文件职责表（`src/cli` `src/core` `src/llm`）、`LLMClient` 接口边界。

- [ ] **Step 3: 写 `HOW-IT-WORKS.md`**

内容：一轮对话的完整数据流（readline → session.append → toMessages → fetch → content → append），消息结构 `{ role, content }`，DeepSeek 的 `content` 与 `reasoning_content` 区别，最小错误处理策略。

- [ ] **Step 4: 写 `DECISIONS.md`**

内容：记录本次的关键决策与理由——零运行时依赖、手写 fetch 而非 SDK、三层内核而非单文件、非流式先行、固定 `deepseek-flash`、v1 不做自动重试、thinking 默认开启但只打印 `content`。

- [ ] **Step 5: 最终验证**

Run: `pnpm run typecheck && pnpm test`
Expected: 全绿，退出码 0。

- [ ] **Step 6: Commit**

```bash
git add README.md ARCHITECTURE.md HOW-IT-WORKS.md DECISIONS.md
git commit -m "docs: add ai-chat project documentation"
```

---
