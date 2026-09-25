import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '@/tools/registry.ts';

test('list() 返回三份工具声明', () => {
  const names = createToolRegistry()
    .list()
    .map((tool) => tool.name)
    .sort();
  assert.deepStrictEqual(names, ['calculator', 'get_time', 'weather']);
});

test('每份声明都有非空 description 与 object 类型的 parameters', () => {
  for (const tool of createToolRegistry().list()) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺 description`);
    assert.strictEqual(tool.parameters.type, 'object');
  }
});

test('按名派发到对应工具', async () => {
  const result = await createToolRegistry().execute('weather', { city: 'Beijing' });
  assert.strictEqual(result.ok, true);
});

test('未知名返回 {ok:false} 而不是抛错', async () => {
  const result = await createToolRegistry().execute('no_such_tool', {});
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('no_such_tool'));
});

test('list() 每次返回新数组，外部改不动注册表', () => {
  const registry = createToolRegistry();
  registry.list().push({
    name: 'injected',
    description: 'x',
    parameters: { type: 'object', properties: {} },
  });
  assert.strictEqual(registry.list().length, 3);
});
