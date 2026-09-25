import test from 'node:test';
import assert from 'node:assert/strict';

import { timeTool } from '@/tools/time.ts';

test('返回可解析的 ISO 时间字符串', async () => {
  const result = await timeTool.run({});
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { now?: unknown };
  assert.strictEqual(typeof value.now, 'string');
  assert.ok(!Number.isNaN(Date.parse(value.now as string)));
});

test('忽略任何多余参数', async () => {
  assert.strictEqual((await timeTool.run({ unexpected: 'ignored' })).ok, true);
});

test('声明没有 required 参数', () => {
  assert.strictEqual(timeTool.declaration.name, 'get_time');
  assert.strictEqual(timeTool.declaration.parameters.required, undefined);
});
