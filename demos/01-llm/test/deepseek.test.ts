import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekClient } from '@/llm/deepseek.ts';

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
