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
