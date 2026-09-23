import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runRepl, SYSTEM_PROMPT } from '@/cli/repl.ts';
import type { LLMClient } from '@/llm/client.ts';

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
