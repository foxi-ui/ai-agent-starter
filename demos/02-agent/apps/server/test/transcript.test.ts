import test from 'node:test';
import assert from 'node:assert/strict';

import { foldTranscript } from '@/presentation/transcript.ts';

test('user 与有正文的 assistant 各自成项', () => {
  const items = foldTranscript([
    { role: 'system', content: '被跳过' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ]);

  assert.deepStrictEqual(items, [
    { kind: 'user', text: '你好' },
    { kind: 'assistant', text: '你好呀' },
  ]);
});

test('只有 tool_calls 没有正文的 assistant 不产出 assistant 项', () => {
  // 否则对话框里会多出一个空气泡（本文件 Review Focus 第 2 条）
  const items = foldTranscript([
    { role: 'user', content: '北京天气' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"temperature":"25°C"}' },
  ]);

  assert.deepStrictEqual(items, [
    { kind: 'user', text: '北京天气' },
    {
      kind: 'tool',
      name: 'weather',
      argumentsText: '{"city":"Beijing"}',
      ok: true,
      result: '{"temperature":"25°C"}',
    },
  ]);
});

test('失败的工具结果（不是合法 JSON）标记为 ok: false', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '无法计算「1/0」：除数不能为 0' },
  ]);

  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.strictEqual(tool.ok, false);
  assert.strictEqual(tool.result, '无法计算「1/0」：除数不能为 0');
});

test('配不上对的 tool_calls 产出 ok: null（半截历史）', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    },
  ]);

  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.strictEqual(tool.ok, null);
  assert.strictEqual(tool.result, '');
});

test('同一轮多个工具调用按顺序各成一项', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } },
        { id: 'c2', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '"25°C, Sunny"' },
    { role: 'tool', tool_call_id: 'c2', content: '"28°C, Cloudy"' },
  ]);

  const tools = items.filter((item) => item.kind === 'tool');
  assert.strictEqual(tools.length, 2);
  assert.ok(tools[0]!.kind === 'tool' && tools[0]!.argumentsText.includes('Beijing'));
  assert.ok(tools[1]!.kind === 'tool' && tools[1]!.argumentsText.includes('Shanghai'));
  assert.ok(tools[0]!.kind === 'tool' && tools[0]!.ok === true);
  assert.ok(tools[1]!.kind === 'tool' && tools[1]!.ok === true);
});

test('assistant 既有正文又有 tool_calls 时两者都不丢', () => {
  const items = foldTranscript([
    {
      role: 'assistant',
      content: '我查一下',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '"晴"' },
  ]);

  assert.deepStrictEqual(
    items.map((item) => item.kind),
    ['assistant', 'tool'],
  );
});

test('找不到调用单的孤儿 tool 消息被忽略', () => {
  const items = foldTranscript([{ role: 'tool', tool_call_id: 'ghost', content: '"x"' }]);
  assert.deepStrictEqual(items, []);
});

test('空历史折叠成空数组', () => {
  assert.deepStrictEqual(foldTranscript([]), []);
});

test('成功路径的字符串结果也能被认出来（JSON.stringify 出来的都是合法 JSON）', () => {
  // 工具返回一个纯字符串时，成功路径写的是 `"晴"`（带引号），仍是合法 JSON
  const items = foldTranscript([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '"晴"' },
  ]);

  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.strictEqual(tool.ok, true);
});
