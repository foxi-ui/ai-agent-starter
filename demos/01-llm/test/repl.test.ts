import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runRepl, SYSTEM_PROMPT } from '@/cli/repl.ts';
import { DEFAULT_MAX_CONTEXT } from '@/cli/args.ts';
import type { SessionChange, SessionStore } from '@/core/journal.ts';
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
  const next = (): string => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return a ?? '';
  };

  return {
    async chat() {
      return { content: next() };
    },
    async *chatStream() {
      // 抛错要发生在 yield 之前，才能模拟「一开始就失败」
      const content = next();
      yield { type: 'text-delta', text: content };
      yield { type: 'done', reason: 'stop' };
    },
  };
}

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

function inputFrom(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n'));
}

/** 记录型假 store：捕获每次 append 的 (会话 id, 变更)，供断言落盘内容 */
function recordingStore(): {
  store: SessionStore;
  writes: Array<{ id: string; change: SessionChange }>;
} {
  const writes: Array<{ id: string; change: SessionChange }> = [];
  return {
    writes,
    store: {
      create() {},
      append(id, change) {
        writes.push({ id, change });
      },
      load() {
        return null;
      },
      list() {
        return [];
      },
    },
  };
}

/** 每次 append 都抛错的假 store，用来走「落盘失败降级」那条路径 */
function failingStore(message: string): { store: SessionStore; attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    store: {
      create() {},
      append() {
        attempts += 1;
        throw new Error(message);
      },
      load() {
        return null;
      },
      list() {
        return [];
      },
    },
  };
}

test('一问一答：输出是 You:/AI: 交替的对话记录', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client = fakeClient(['你好']);
  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    model: 'deepseek-flash',
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });
  // 逐字节断言，而不是 some() + includes()：
  // 后者对「有几个提示符」「有没有 AI: 」都恒为真。
  // 正是这个弱点让 M1 的三处输出偏差全绿通过（见 DECISIONS D15）。
  //
  // 关于结尾多出的那个 `You: `：提示符写在每次读取之前，而 EOF 只有在读的时候
  // 才知道，所以最后一次提示符已经写出去了。文档没有规定退出时的行为，
  // 这里选择「接受」而不是为它引入 TTY 判断（见报告的待确认项）。
  //
  // 管道里没有终端回显，所以问题的文字不会出现在输出里 ——
  // 真实 TTY 下提示符后面会跟着用户输入的回显（`You: 什么是...`）。
  assert.equal(chunks.join(''), 'You: AI: 你好\nYou: ');
  // 一切正常时 stderr 应当完全安静
  assert.deepEqual(errChunks, []);
});

test('多轮：每一问前都有 You: 提示符，每一答前都有 AI: 前缀', async () => {
  const { chunks, stream, errStream } = captureOutput();
  const client = fakeClient(['回答一', '回答二']);
  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    model: 'deepseek-flash',
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });
  assert.equal(chunks.join(''), 'You: AI: 回答一\nYou: AI: 回答二\nYou: ');
});

test('失败轮次不输出 AI: 前缀', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client = fakeClient([new Error('DeepSeek API error 401: Invalid API key')]);
  await runRepl(client, {
    input: inputFrom(['第一问']),
    output: stream,
    errorOutput: errStream,
    model: 'deepseek-flash',
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });
  // 关键：绝不能留下一个「有 AI: 但后面什么都没有」的空壳。
  // stdout 里只有两个提示符（第二个是 EOF 前写出的那个），没有任何 AI:。
  assert.equal(chunks.join(''), 'You: You: ');
  assert.ok(!chunks.join('').includes('AI:'));
  assert.ok(errChunks.join('').includes('Invalid API key'));
});

test('错误写 stderr，不污染 stdout', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client = fakeClient([new Error('DeepSeek API error 401: Invalid API key')]);
  await runRepl(client, {
    input: inputFrom(['第一问']),
    output: stream,
    errorOutput: errStream,
    model: 'deepseek-flash',
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
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
    model: 'deepseek-flash',
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });
  const joined = chunks.join('');
  assert.ok(joined.includes('恢复'));
});

test('多轮对话上下文按序累积', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const client: LLMClient = {
    async chat() {
      return { content: 'ok' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };
  const { stream, errStream } = captureOutput();
  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    model: 'deepseek-flash',
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '第二问' },
  ]);
});

test('正文逐字写 stdout，思考指示只写 stderr', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream() {
      yield { type: 'reasoning-delta', text: '想一下' };
      yield { type: 'text-delta', text: '你' };
      yield { type: 'text-delta', text: '好' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  const out = chunks.join('');
  assert.ok(out.includes('你好'));
  assert.ok(!out.includes('想一下'));
  assert.equal(errChunks.join(''), '[思考中…]\n');
});

test('流中途失败：不追加 assistant，且补上收尾换行', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: '半截' };
      throw new Error('流空闲超时（30s 无数据），已中断');
    },
  };

  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  const out = chunks.join('');
  // 半截答案留在了屏幕上，但补了换行（否则第二个提示符会接在后面）
  assert.ok(out.includes('半截\n'));
  assert.ok(errChunks.join('').includes('空闲超时'));

  // 关键：第二轮的 messages 里没有那条失败的回答
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '第一问' },
    { role: 'user', content: '第二问' },
  ]);
});

test('流中途失败：收尾换行写在该行的错误之前（跨流字节顺序）', async () => {
  // 两条流指向**同一个**收集器：分流本身另有上面几条用例钉住，
  // 这条只关心跨流的字节顺序 —— 把 catch 里那次 `renderer.finish()` 拿掉，
  // 报错就会粘在半截回答后面（`半截[error] boom`），而不是另起一行。
  const { chunks, stream } = collector();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream() {
      yield { type: 'text-delta', text: '半截' };
      throw new Error('boom');
    },
  };

  await runRepl(client, {
    input: inputFrom(['第一问']),
    output: stream,
    errorOutput: stream,
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.equal(chunks.join(''), 'You: AI: 半截\n[error] boom\nYou: ');
});

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
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
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
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  // /history 只触发一次请求（就是「问题」那次），且历史里没有 /history
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '问题' },
  ]);
});

// 这条用例由两处合并而来（见 Task 4 Step 4c）：旧的「每轮都把当前模型作为请求参数传下去」
// 只喂一行输入、只钉住第一轮，被这里的第二轮完全覆盖，故只留这一条 ——
// 它同时钉住「首次请求用初始模型」与「/model 切换后立即生效」。
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
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
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
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.equal(calls, 0);
  assert.ok(errChunks.join('').includes('未知命令'));
  assert.ok(!chunks.join('').includes('未知命令'));
});

// 上一条只喂一行，钉住了「未知命令不发请求」，但钉不住「提示之后循环还在」——
// 把未知命令分支的 `continue` 改成 `break`，其余用例依旧全绿。
// 这里再喂一行：只有循环没退出，第二行才会走到请求。
test('未知命令之后循环继续，不是 break 出 REPL', async () => {
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
    input: inputFrom(['/foo', '问题']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  // 恰好一次：未知命令那次没发，第二行的「问题」发了
  assert.equal(calls, 1);
  assert.ok(errChunks.join('').includes('未知命令'));
  assert.ok(!chunks.join('').includes('未知命令'));
});

test('/history 的列表走 stdout', async () => {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client = fakeClient(['ok']);

  await runRepl(client, {
    input: inputFrom(['第一问', '/history']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    sessionId: '20260924-143022-a3f1',
    history: [],
    store: fakeStore(),
    model: 'deepseek-flash',
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  // 只断言「命令被执行了」（下一轮 messages 里没有 /history）是不够的：
  // 把 renderCommandResult 的输出改道 stderr，那条用例照样全绿 ——
  // 命令结果和模型回答一样落在 stdout，得直接断言。
  const out = chunks.join('');
  assert.ok(out.includes('1. [user] 第一问'));
  assert.ok(out.includes('2. [assistant] ok'));
  assert.deepEqual(errChunks, []);
});

// ── 会话落盘（onChange → store.append）──────────────────────────────────
//
// Session 在三个变更点广播，repl 收到就追加一行。下面几条钉住这条接线：
// 广播漏接、接错会话 id、或漏掉某一个变更点，都会在这里现形。

const SESSION_ID = '20260924-143022-a3f1';

test('一轮对话落两条记录：user 与 assistant，用的是本次会话的 id', async () => {
  const { store, writes } = recordingStore();
  const { stream, errStream } = captureOutput();

  await runRepl(fakeClient(['你好']), {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.deepEqual(writes, [
    { id: SESSION_ID, change: { type: 'message', role: 'user', content: 'hi' } },
    { id: SESSION_ID, change: { type: 'message', role: 'assistant', content: '你好' } },
  ]);
});

test('/clear 与 /model 的变更也落盘（它们在 executeCommand 内部改状态）', async () => {
  // 这条是「广播」这个设计的立论所在：/clear 与 /model <name> 改的是
  // executeCommand **内部**的 Session，repl 在调用处看不见这两次变更。
  // 靠「调用方记得在每处补写」必然漏掉它们；靠 Session 广播则结构上不可能漏。
  const { store, writes } = recordingStore();
  const { stream, errStream } = captureOutput();

  await runRepl(fakeClient(['ok']), {
    input: inputFrom(['问题', '/clear', '/model deepseek-v4-pro']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.deepEqual(
    writes.map((w) => w.change),
    [
      { type: 'message', role: 'user', content: '问题' },
      { type: 'message', role: 'assistant', content: 'ok' },
      { type: 'clear' },
      { type: 'model', model: 'deepseek-v4-pro' },
    ],
  );
});

test('只读命令一条记录都不写', async () => {
  const { store, writes } = recordingStore();
  const { stream, errStream } = captureOutput();

  await runRepl(fakeClient([]), {
    input: inputFrom(['/history', '/model', '/sessions']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  // 只读命令若也写盘，日志会莫名其妙地变长，而这些行在回放时什么也不做
  assert.deepEqual(writes, []);
});

test('落盘失败：stderr 恰好一行警告，且对话继续（内存照常前进）', async () => {
  // M3 的降级约定（D34）：append 失败是非致命的 —— 磁盘满、目录只读
  // 不该打断正在进行的对话。但绝不能静默，那会让人以为存下来了。
  const { store, attempts } = failingStore('EACCES: permission denied');
  const { chunks, stream, errChunks, errStream } = captureOutput();

  const sent: Array<{ role: string; content: string }[]> = [];
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: '回答' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['第一问', '第二问']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  // 警告只出一次：每轮都刷同一句会把屏幕占满，反而看不见别的
  const errLines = errChunks.join('').split('\n').filter((line) => line !== '');
  assert.equal(errLines.length, 1, `stderr 应当恰好一行：${JSON.stringify(errChunks.join(''))}`);
  assert.match(errLines[0], /\[警告\]/);
  assert.match(errLines[0], /EACCES: permission denied/);

  // 「只警告一次」不等于「只尝试一次」：每次变更仍然都试过写盘（2 轮 × 2 条）
  assert.equal(attempts(), 4);

  // 对话没被打断，两轮都发出了请求
  assert.equal(sent.length, 2);
  // 内存照常前进：第二轮仍带着第一轮的上下文 —— 磁盘落后，但对话是连贯的
  assert.deepEqual(sent[1], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '第二问' },
  ]);
  // 屏幕上两轮都有回答
  assert.equal(chunks.join(''), 'You: AI: 回答\nYou: AI: 回答\nYou: ');
});

test('传入的 history 流进第一轮请求（--resume 后「模型记得」的离线代理）', async () => {
  // 真实网络下的判据是「模型能复述之前聊过什么」，那测不了。这里测的是它的**前提**：
  // 回放出来的历史必须真的进到第一次请求的 messages 里。
  // 若 history 只铺进了 Session 却没被 toMessages 带上，这条会红。
  const sent: Array<{ role: string; content: string }[]> = [];
  const { store } = recordingStore();
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
    input: inputFrom(['用一句话总结我们刚才聊的']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [
      { role: 'user', content: '用一句话说明什么是闭包' },
      { role: 'assistant', content: '闭包是函数与其词法作用域的组合' },
    ],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.deepEqual(sent[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '用一句话说明什么是闭包' },
    { role: 'assistant', content: '闭包是函数与其词法作用域的组合' },
    { role: 'user', content: '用一句话总结我们刚才聊的' },
  ]);
});

// ── M4a：上下文预算与 --no-thinking ────────────────────────────────────
//
// 这一节要同时钉住两件事：**发出去的东西变了**，而**记住的东西没变**。
// 只测 fitToBudget 的返回值是不够的 —— 那测不到 repl 有没有把裁剪接错线。

test('maxContext 生效：发给模型的是裁过的，落盘的仍是完整历史', async () => {
  const sent: Array<{ role: string; content: string }[]> = [];
  const { store, writes } = recordingStore();
  const { stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(messages) {
      sent.push(messages);
      yield { type: 'text-delta', text: '新回答' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['新问题']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [
      { role: 'user', content: '旧问题一' },
      { role: 'assistant', content: '旧回答一' },
      { role: 'user', content: '旧问题二' },
      { role: 'assistant', content: '旧回答二' },
    ],
    store,
    showReasoning: false,
    noThinking: false,
    // 小到只够「system + 当前问题」：两轮旧历史都会被裁掉
    maxContext: 1,
  });

  // 发出去的：只剩系统提示与当前问题
  assert.deepEqual(sent[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '新问题' },
  ]);

  // 落盘的：仍是本轮完整的两条记录 —— 裁剪不回写 Session、也不影响落盘（D-M4a-5）
  assert.deepEqual(
    writes.map((w) => w.change),
    [
      { type: 'message', role: 'user', content: '新问题' },
      { type: 'message', role: 'assistant', content: '新回答' },
    ],
  );

  // 裁剪发生了就警告一行，把「模型怎么忘了」变成可归因的行为
  assert.match(errChunks.join(''), /\[上下文\] 已裁剪 4 条最早的消息（约 \d+ token）\n/);
});

test('未裁剪时 stderr 不出现上下文警告', async () => {
  const { store } = recordingStore();
  const { stream, errChunks, errStream } = captureOutput();

  await runRepl(fakeClient(['答']), {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  const err = errChunks.join('');
  assert.ok(!err.includes('已裁剪'), `不该有裁剪警告：${err}`);
});

test('noThinking 为真时，ChatOptions 里带 thinking: false', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { store } = recordingStore();
  const { stream, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(_messages, options) {
      seen.push(options as Record<string, unknown>);
      yield { type: 'text-delta', text: '答' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: true,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.deepEqual(seen[0], { model: 'deepseek-flash', thinking: false });
});

test('noThinking 为假时，ChatOptions 里连 thinking 键都没有', async () => {
  // 契约是「多一个字段」而不是「字段值不同」：不传即服务端默认的开启（D-M4a-10）
  const seen: Array<Record<string, unknown>> = [];
  const { store } = recordingStore();
  const { stream, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream(_messages, options) {
      seen.push(options as Record<string, unknown>);
      yield { type: 'text-delta', text: '答' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: false,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.equal('thinking' in seen[0], false);
  assert.deepEqual(seen[0], { model: 'deepseek-flash' });
});

test('showReasoning 为真时，思考全文出现在 stderr 而 stdout 干净', async () => {
  const { store } = recordingStore();
  const { chunks, stream, errChunks, errStream } = captureOutput();
  const client: LLMClient = {
    async chat() {
      return { content: 'unused' };
    },
    async *chatStream() {
      yield { type: 'reasoning-delta', text: '我先想想' };
      yield { type: 'text-delta', text: '答案' };
      yield { type: 'done', reason: 'stop' };
    },
  };

  await runRepl(client, {
    input: inputFrom(['hi']),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: [],
    store,
    showReasoning: true,
    noThinking: false,
    maxContext: DEFAULT_MAX_CONTEXT,
  });

  assert.equal(errChunks.join(''), '[思考] 我先想想\n');
  // 结尾那个 `You: ` 是 D15 的已知边界：提示符在**每次读取尝试之前**写出，
  // EOF 那次也会写，所以输出以它结尾。这里逐字节钉住，顺带确认
  // stdout 里没有「我先想想」——思考一个字都不能落进答案文件。
  assert.equal(chunks.join(''), 'You: AI: 答案\nYou: ');
});
