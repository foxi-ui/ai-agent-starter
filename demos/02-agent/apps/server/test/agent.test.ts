import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn, runSessionTurn } from '@/core/agent.ts';
import { Session } from '@/core/session.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import type { ChatOptions, ChatResult, Message, ToolResult } from '@/core/types.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';

/** 按顺序吐出预设响应，并记录每次收到的 messages 与 options */
function fakeClient(results: ChatResult[]): {
  client: LLMClient;
  seen: Message[][];
  seenOptions: Array<ChatOptions | undefined>;
} {
  const seen: Message[][] = [];
  const seenOptions: Array<ChatOptions | undefined> = [];
  let index = 0;
  return {
    seen,
    seenOptions,
    client: {
      async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
        seen.push(messages.map((message) => ({ ...message })));
        seenOptions.push(options);
        const result = results[index];
        index += 1;
        if (!result) throw new Error('fakeClient 的预设响应用完了');
        return result;
      },
    },
  };
}

/** 一张工具声明（内容不重要，只为占位） */
const anyTool = {
  name: 'weather',
  description: 'x',
  parameters: { type: 'object' as const, properties: {} },
};

function fakeRegistry(handlers: Record<string, () => ToolResult | Promise<ToolResult>>): ToolRegistry {
  return {
    list: () => [anyTool],
    async execute(name: string): Promise<ToolResult> {
      const handler = handlers[name];
      if (!handler) return { ok: false, error: `未知工具：${name}` };
      return await handler();
    },
  };
}

function toolCallResult(id: string, name: string, args: string): ChatResult {
  return {
    content: null,
    finish_reason: 'tool_calls',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  };
}

const answer = (text: string): ChatResult => ({ content: text, finish_reason: 'stop' });

test('没有 tool_calls 时直接返回答案', async () => {
  const { client, seen } = fakeClient([answer('你好')]);
  const turn = await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(turn.final.content, '你好');
  assert.strictEqual(turn.stopReason, 'answered');
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(turn.added, [{ role: 'assistant', content: '你好' }]);
});

test('一轮工具后收敛：added 里是 assistant{tool_calls} + tool + 最终 assistant', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'weather', '{"city":"Beijing"}'),
    answer('北京今天 25°C，晴天。'),
  ]);
  const registry = fakeRegistry({
    weather: () => ({ ok: true, value: { temperature: '25°C', condition: 'Sunny' } }),
  });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '北京天气' }]);

  assert.strictEqual(turn.stopReason, 'answered');
  assert.strictEqual(turn.final.content, '北京今天 25°C，晴天。');
  assert.deepStrictEqual(turn.added, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"temperature":"25°C","condition":"Sunny"}',
    },
    { role: 'assistant', content: '北京今天 25°C，晴天。' },
  ]);
});

test('多步循环：连续两次工具调用后才收敛', async () => {
  const { client, seen } = fakeClient([
    toolCallResult('c1', 'weather', '{"city":"Beijing"}'),
    toolCallResult('c2', 'weather', '{"city":"Shanghai"}'),
    answer('两地都晴。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '两地天气' }]);

  assert.strictEqual(seen.length, 3);
  assert.strictEqual(turn.added.length, 5);
  assert.strictEqual(turn.final.content, '两地都晴。');
});

test('同一轮里多个 tool_calls：每个各回一条 tool 消息', async () => {
  const { client } = fakeClient([
    {
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
        { id: 'c2', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } },
      ],
    },
    answer('都晴。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  const toolMessages = turn.added.filter((message) => message.role === 'tool');
  assert.deepStrictEqual(
    toolMessages.map((message) => (message.role === 'tool' ? message.tool_call_id : '')),
    ['c1', 'c2'],
  );
});

test('arguments 不是合法 JSON：错误文本回喂，且不执行工具', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'weather', '{city: Beijing'),
    answer('我换个写法。'),
  ]);
  let called = false;
  const registry = fakeRegistry({
    weather: () => {
      called = true;
      return { ok: true, value: '不应被执行' };
    },
  });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(called, false, '参数解析失败时不该执行工具');
  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('JSON'));
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('{city: Beijing'));
  assert.strictEqual(turn.final.content, '我换个写法。');
});

test('工具抛异常：兜底成 {ok:false} 回喂，不崩', async () => {
  const { client } = fakeClient([
    toolCallResult('c1', 'weather', '{"city":"Beijing"}'),
    answer('工具挂了，我直接答。'),
  ]);
  const registry = fakeRegistry({
    weather: () => {
      throw new Error('上游超时');
    },
  });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  assert.strictEqual(toolMessage.content, '上游超时');
  assert.strictEqual(turn.final.content, '工具挂了，我直接答。');
});

test('未知名工具：错误文本回喂', async () => {
  const { client } = fakeClient([toolCallResult('c1', 'nope', '{}'), answer('好，我不用工具了。')]);

  const turn = await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }]);

  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool' && toolMessage.content.includes('nope'));
});

test('finish_reason 是 stop 但带 tool_calls：仍要执行工具', async () => {
  // 有些 OpenAI 兼容实现会这样返回。若循环条件看 finish_reason，
  // 就会漏调工具、把 content: null 当成最终答案回给用户（前端显示一个空气泡）。
  const { client } = fakeClient([
    {
      content: null,
      finish_reason: 'stop',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    answer('北京今天 25°C，晴天。'),
  ]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '25°C, Sunny' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: '北京天气' }]);

  const toolMessages = turn.added.filter((message) => message.role === 'tool');
  assert.strictEqual(toolMessages.length, 1, '必须执行了工具');
  assert.strictEqual(turn.final.content, '北京今天 25°C，晴天。');
});

test('工具返回 undefined 时回喂 "null"（tool 消息的 content 必须是非空字符串）', async () => {
  const { client } = fakeClient([toolCallResult('c1', 'weather', '{}'), answer('好')]);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: undefined }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  const toolMessage = turn.added.find((message) => message.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  assert.strictEqual(toolMessage.content, 'null');
});

test('跑满 maxSteps：调用次数恰好等于 maxSteps，且最后一条是带 content 的 assistant', async () => {
  // 每次都给 tool_calls，永远不收敛
  const results = Array.from({ length: 3 }, (_, index) =>
    toolCallResult(`c${index}`, 'weather', '{}'),
  );
  const { client, seen } = fakeClient(results);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }], { maxSteps: 3 });

  assert.strictEqual(seen.length, 3, 'maxSteps 是「最多调几次模型」，off-by-one 会在这里露出来');
  assert.strictEqual(turn.stopReason, 'max-steps');

  const last = turn.added[turn.added.length - 1]!;
  assert.strictEqual(last.role, 'assistant');
  assert.ok(
    last.role === 'assistant' && typeof last.content === 'string' && last.content !== '',
    '最后一条必须是带正文的 assistant，否则历史对 API 非法',
  );
  assert.strictEqual(last.role === 'assistant' ? last.tool_calls : undefined, undefined);
});

test('maxSteps 默认为 6', async () => {
  const results = Array.from({ length: 6 }, (_, index) =>
    toolCallResult(`c${index}`, 'weather', '{}'),
  );
  const { client, seen } = fakeClient(results);
  const registry = fakeRegistry({ weather: () => ({ ok: true, value: '晴' }) });

  const turn = await runAgentTurn(client, registry, [{ role: 'user', content: 'hi' }]);

  assert.strictEqual(seen.length, 6);
  assert.strictEqual(turn.stopReason, 'max-steps');
});

test('输入 messages 不被修改', async () => {
  const { client } = fakeClient([answer('好')]);
  const input: Message[] = [{ role: 'user', content: 'hi' }];
  const snapshot = JSON.stringify(input);

  await runAgentTurn(client, fakeRegistry({}), input);

  assert.strictEqual(JSON.stringify(input), snapshot);
});

test('每次请求都带上 registry.list() 与 model', async () => {
  const { client, seenOptions } = fakeClient([answer('好')]);
  await runAgentTurn(client, fakeRegistry({}), [{ role: 'user', content: 'hi' }], {
    model: 'deepseek-v4-pro',
  });

  assert.deepStrictEqual(seenOptions[0]?.tools, [anyTool]);
  assert.strictEqual(seenOptions[0]?.model, 'deepseek-v4-pro');
});

test('runSessionTurn：先把 user 写进会话，再组装 messages 发出去', async () => {
  const { client, seen } = fakeClient([answer('好')]);
  const session = new Session('deepseek-flash');
  session.append('user', '上一轮的话');

  await runSessionTurn(session, client, fakeRegistry({}), '本轮的话', { systemPrompt: SYSTEM_PROMPT });

  assert.deepStrictEqual(seen[0], [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '上一轮的话' },
    { role: 'user', content: '本轮的话' },
  ]);
  assert.deepStrictEqual(session.history(), [
    { role: 'user', content: '上一轮的话' },
    { role: 'user', content: '本轮的话' },
    { role: 'assistant', content: '好' },
  ]);
});

test('runSessionTurn：本轮失败时只留下 user 那一条', async () => {
  const client: LLMClient = {
    async chat() {
      throw new Error('DeepSeek API error 500: boom');
    },
  };
  const session = new Session('deepseek-flash');

  await assert.rejects(
    () => runSessionTurn(session, client, fakeRegistry({}), 'hi', { systemPrompt: SYSTEM_PROMPT }),
    /boom/,
  );

  assert.deepStrictEqual(session.history(), [{ role: 'user', content: 'hi' }]);
});

test('runSessionTurn：把 session.model 作为 per-call 参数传下去', async () => {
  const { client, seenOptions } = fakeClient([answer('好')]);
  const session = new Session('deepseek-v4-pro');

  await runSessionTurn(session, client, fakeRegistry({}), 'hi', { systemPrompt: SYSTEM_PROMPT });

  assert.strictEqual(seenOptions[0]?.model, 'deepseek-v4-pro');
});
