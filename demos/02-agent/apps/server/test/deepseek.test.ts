import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import type { StreamEvent } from '@/core/types.ts';

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

// 造一个 SSE 响应：把若干**原始字节**依次推入流。
// 用字节而不是字符串，是为了能精确构造「多字节字符/一条事件被切成两次 read」的场景。
function sseResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// 按固定间隔逐个推 chunk 的 SSE 响应，用于区分「空闲超时」与「总时长上限」。
//
// 时间点一次性排好（第 i 个 chunk 在 (i+1) × intervalMs 到达），而不是用 pull()
// 在「读取方来要数据时」再排。原因：pull 会被提前调用 —— read() 本身会触发一次 pull，
// 每次 pull 又各自排一个定时器，于是下标会跑到队尾、提前 close()，
// 落在后面的定时器再 enqueue 就抛 ERR_INVALID_STATE。
// 这里要测的是时间，不是背压，所以用不依赖 demand 的固定时间线。
function pacedSseResponse(payloads: string[], intervalMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      payloads.forEach((payload, i) => {
        setTimeout(() => {
          controller.enqueue(enc.encode(payload));
          // 最后一个 chunk 之后立刻关流
          if (i === payloads.length - 1) controller.close();
        }, intervalMs * (i + 1));
      });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const enc = new TextEncoder();

/** 把一个上游 chunk 的 JSON 包成一条 SSE 事件 */
function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ delta, finish_reason: finishReason }] };
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

test('chatStream 请求体含 model/messages/stream，且不含 stream_options', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return sseResponse([enc.encode('data: [DONE]\n\n')]);
  });

  const client = createDeepSeekClient(config);
  await collect(client.chatStream([{ role: 'user', content: 'hi' }]));

  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.stream, true);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  // 官方文档没有要求流式必须带 stream_options；M2 也不消费 usage，所以不发
  assert.equal('stream_options' in body, false);
});

test('chatStream 的 options.model 覆盖默认模型', async () => {
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return sseResponse([enc.encode('data: [DONE]\n\n')]);
  });

  const client = createDeepSeekClient(config);
  await collect(
    client.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4-pro' }),
  );

  assert.equal(JSON.parse(String(capturedInit!.body)).model, 'deepseek-v4-pro');
});

test('chatStream 把 delta 归一化成事件序列', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(deltaChunk({ role: 'assistant', content: '' })) +
          sseChunk(deltaChunk({ reasoning_content: '想一下' })) +
          sseChunk(deltaChunk({ content: '你好' })) +
          sseChunk(deltaChunk({ content: '，世界' })) +
          sseChunk(deltaChunk({}, 'stop')) +
          'data: [DONE]\n\n',
      ),
    ]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'reasoning-delta', text: '想一下' },
    { type: 'text-delta', text: '你好' },
    { type: 'text-delta', text: '，世界' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('末 chunk 的 usage 被忽略，不产生事件也不报错', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(deltaChunk({ content: '答' })) +
          sseChunk({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }) +
          'data: [DONE]\n\n',
      ),
    ]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '答' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('finish_reason 为 length 时 done 带上 length', async () => {
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(deltaChunk({}, 'length')) + 'data: [DONE]\n\n')]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'done', reason: 'length' },
  ]);
});

test('未见过 finish_reason 时 [DONE] 兜底成 stop', async () => {
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(deltaChunk({ content: '答' })) + 'data: [DONE]\n\n')]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '答' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('一条事件被切成两次 read 也能拼回', async () => {
  const whole = sseChunk(deltaChunk({ content: '完整' })) + 'data: [DONE]\n\n';
  const bytes = enc.encode(whole);
  const cut = Math.floor(bytes.length / 2);

  mockFetch(async () => sseResponse([bytes.slice(0, cut), bytes.slice(cut)]));

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '完整' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('多字节字符被切在两次 read 之间也不乱码', async () => {
  const bytes = enc.encode(sseChunk(deltaChunk({ content: '你好' })) + 'data: [DONE]\n\n');

  // 从「你」的 UTF-8 首字节之后一个字节处切开 —— 正好切在多字节字符内部。
  // 用 indexOf 定位而不是写死偏移量：写死的数字会随 JSON 形状变化而失效，
  // 而且很容易不小心落在纯 ASCII 前缀里，那样这个用例就白测了。
  const cut = bytes.indexOf(enc.encode('你')[0]);

  mockFetch(async () => sseResponse([bytes.slice(0, cut + 1), bytes.slice(cut + 1)]));

  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  assert.deepEqual(events[0], { type: 'text-delta', text: '你好' });
});

test('坏 JSON 的事件被跳过，其余照常', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        'data: {这不是 JSON\n\n' +
          sseChunk(deltaChunk({ content: '好的' })) +
          'data: [DONE]\n\n',
      ),
    ]),
  );

  const client = createDeepSeekClient(config);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '好的' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('chatStream 非 2xx 抛错', async () => {
  mockFetch(async () => jsonResponse({ error: { message: 'Invalid API key' } }, 401));

  const client = createDeepSeekClient(config);
  await assert.rejects(
    () => collect(client.chatStream([{ role: 'user', content: 'hi' }])),
    /Invalid API key/,
  );
});

test('空闲超时抛错', async () => {
  // 一个永远不推数据、也不关闭的流
  mockFetch(async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  // 注入极短超时，避免测试真的等 30 秒
  const client = createDeepSeekClient(config, 20);
  await assert.rejects(
    () => collect(client.chatStream([{ role: 'user', content: 'hi' }])),
    /空闲超时/,
  );
});

test('无 finish_reason 也无 [DONE] 就关流时，兜底补一个 stop', async () => {
  // 只有正文，流随即关闭：两个结束信号都没有。
  // 这条兜底是「调用方总能收到一个 done」的最后保障。
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(deltaChunk({ content: '半句话' })))]),
  );

  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  assert.deepEqual(events, [
    { type: 'text-delta', text: '半句话' },
    // 必须是 'stop'：'aborted' 的语义是「客户端主动中断生成」，属于 M6，
    // 服务端只是没给结束标记而已
    { type: 'done', reason: 'stop' },
  ]);
});

test('同一 chunk 同时带 content 与 finish_reason 时，先 text-delta 后 done', async () => {
  // 服务端常把最后一段正文和 finish_reason 放进同一个 chunk。
  // 若两处 yield 顺序颠倒，这段正文会排在 done 之后 —— 调用方
  // 一旦在 done 时收尾，就会吞掉回答的最后一句话。
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(deltaChunk({ content: '最后一段' }, 'stop')))]),
  );

  const client = createDeepSeekClient(config);
  // deepEqual 对数组是顺序敏感的，颠倒顺序即失败
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '最后一段' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('空闲超时按 chunk 间隔重置，不因总时长超过超时而误杀', async () => {
  // 区分「空闲超时」与「整个流的总时长上限」：
  // 总时长 4 × 40ms = 160ms 故意超过超时值 100ms，
  // 但每个 chunk 的间隔（40ms）都远小于它。
  // 只有「每次 read 都重置计时器」的实现能读完；
  // 换成包住整个流的单一计时器会在第 3 个 chunk 之前就中断。
  //
  // 数值为什么放大到 100/40 而不是 30/20：「总时长 > 超时」这条判别本身是稳的
  // （setTimeout 只会晚不会早，总时长不可能变短），真正需要留余量的是
  // 「单个间隔别逼近超时」—— 机器有负载时 10ms 的余量会偶发失败。
  const payloads = [
    sseChunk(deltaChunk({ content: '一' })),
    sseChunk(deltaChunk({ content: '二' })),
    sseChunk(deltaChunk({ content: '三' })),
    'data: [DONE]\n\n',
  ];

  mockFetch(async () => pacedSseResponse(payloads, 40));

  const client = createDeepSeekClient(config, 100);
  assert.deepEqual(await collect(client.chatStream([{ role: 'user', content: 'hi' }])), [
    { type: 'text-delta', text: '一' },
    { type: 'text-delta', text: '二' },
    { type: 'text-delta', text: '三' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('调用方提前退出消费时，底层流被 cancel', async () => {
  // Task 6 的 REPL 会在「中途停止打印」时 break 出 for await。
  // 那一刻生成器的 finally 是唯一的清理点：只 releaseLock() 的话底层流仍然活着，
  // 真实 fetch 下 undici 的连接会悬着直到 GC 才回收。
  let canceled = false;
  mockFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(sseChunk(deltaChunk({ content: '一' }))));
        controller.enqueue(enc.encode(sseChunk(deltaChunk({ content: '二' }))));
      },
      cancel() {
        canceled = true;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  const client = createDeepSeekClient(config);
  for await (const event of client.chatStream([{ role: 'user', content: 'hi' }])) {
    if (event.type === 'text-delta') break;
  }

  // for await 的 break 会 await 生成器的 return()，也就是 await 过 finally，
  // 所以这里不需要再等一个 tick
  assert.equal(canceled, true);
});
