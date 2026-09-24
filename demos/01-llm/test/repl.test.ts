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

function inputFrom(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n'));
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
    model: 'deepseek-flash',
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
    model: 'deepseek-flash',
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
