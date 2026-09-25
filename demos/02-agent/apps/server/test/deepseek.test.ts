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
  // 整对象断言：既证明正文取到，也证明 reasoning_content 没被带出来
  assert.deepEqual(result, { content: '最终回答', finish_reason: 'stop' });
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

test('content 缺失或为 null 时返回 null，而不是空串', async () => {
  mockFetch(async () => jsonResponse({ choices: [{ message: {}, finish_reason: 'stop' }] }));
  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(result.content, null, '兜底成空串会让「说了空话」与「没说话」无法区分');
});

test('fetch 抛错时向上冒泡，不被吞掉', async () => {
  // 模拟网络层失败（DNS 解析失败 / 连接被拒）：fetch 本身 reject。
  // 这一层刻意不 catch——吞掉异常会让上层看到一个假的空回答，
  // 反而掩盖故障。交给上层的 try/catch 决定怎么显示。
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
  // 官方未给出错误响应体的字段名（见 docs/deepseek-api-facts.md），
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

test('options.model 覆盖构造时的默认模型', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4-pro' });

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.model, 'deepseek-v4-pro');
});

test('不传 options.model 时回落构造时的默认模型', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }]);

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.model, 'deepseek-flash');
});

test('带 tools 时请求体按线上的包装层级发送（type/function 两层）', async () => {
  let body: Record<string, unknown> = {};
  mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], {
    tools: [
      {
        name: 'weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
  });

  // 少包一层上游会 400 说 tools 结构不对，而报错不会提到「少包了一层」。
  // 这条断言依赖 Step 1 的核实结论 —— 它是**假设的固化**，不是独立验证。
  assert.deepStrictEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ]);
});

test('tools 为空数组时不发送该字段', async () => {
  let body: Record<string, unknown> = {};
  mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] });
  });

  const client = createDeepSeekClient(config);
  await client.chat([{ role: 'user', content: 'hi' }], { tools: [] });

  assert.ok(!('tools' in body), '空数组在部分 OpenAI 兼容实现上会 400，必须不发');
});

test('解析 tool_calls 与 finish_reason', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Beijing"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: '北京天气' }]);

  assert.strictEqual(result.content, null);
  assert.strictEqual(result.finish_reason, 'tool_calls');
  assert.deepStrictEqual(result.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
  ]);
});

test('finish_reason 缺失时回落 stop', async () => {
  mockFetch(async () => jsonResponse({ choices: [{ message: { content: '好' } }] }));

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.finish_reason, 'stop');
});

test('tool_calls 里混入一条坏的：丢掉坏的、保留好的', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'broken' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.tool_calls?.length, 1);
  assert.strictEqual(result.tool_calls?.[0]?.id, 'c1');
});

test('tool_calls 全是坏的：当作没有 tool_calls', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [{ message: { content: '好', tool_calls: [{ id: 1 }] }, finish_reason: 'stop' }],
    }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.strictEqual(result.tool_calls, undefined);
});

test('没有 tool_calls 时不带该字段', async () => {
  mockFetch(async () =>
    jsonResponse({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] }),
  );

  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.ok(!('tool_calls' in result));
});
