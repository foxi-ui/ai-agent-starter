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
