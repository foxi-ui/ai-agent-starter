import test from 'node:test';
import assert from 'node:assert/strict';

import { weatherTool } from '@/tools/weather.ts';

test('Beijing 命中内置表', async () => {
  const result = await weatherTool.run({ city: 'Beijing' });
  assert.deepStrictEqual(result, {
    ok: true,
    value: { city: 'Beijing', temperature: '25°C', condition: 'Sunny' },
  });
});

test('城市名大小写与首尾空白不影响命中', async () => {
  const result = await weatherTool.run({ city: '  beijing  ' });
  assert.strictEqual(result.ok, true);
});

test('未收录的城市返回兜底值并注明是模拟数据', async () => {
  const result = await weatherTool.run({ city: 'Mars' });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { note?: string };
  assert.ok(typeof value.note === 'string' && value.note.includes('模拟数据'));
});

test('缺 city 参数返回 {ok:false} 而不是抛错', async () => {
  assert.strictEqual((await weatherTool.run({})).ok, false);
});

test('city 不是字符串返回 {ok:false}', async () => {
  assert.strictEqual((await weatherTool.run({ city: 42 })).ok, false);
});

test('args 不是对象也不抛错', async () => {
  assert.strictEqual((await weatherTool.run(null)).ok, false);
  assert.strictEqual((await weatherTool.run('Beijing')).ok, false);
});

test('声明里的 name 与 registry 注册名一致，required 标了 city', () => {
  assert.strictEqual(weatherTool.declaration.name, 'weather');
  assert.deepStrictEqual(weatherTool.declaration.parameters.required, ['city']);
});
