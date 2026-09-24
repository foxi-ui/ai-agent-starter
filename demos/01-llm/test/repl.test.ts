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
