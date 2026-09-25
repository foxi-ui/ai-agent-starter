import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '@/llm/config.ts';

test('缺 DEEPSEEK_API_KEY 时抛错', () => {
  assert.throws(() => resolveConfig({}), /DEEPSEEK_API_KEY/);
});

test('key 是空串也算缺失（用 !apiKey 而不是 ??）', () => {
  assert.throws(() => resolveConfig({ DEEPSEEK_API_KEY: '' }), /DEEPSEEK_API_KEY/);
});

test('baseUrl 与 model 有默认值', () => {
  const config = resolveConfig({ DEEPSEEK_API_KEY: 'k' });
  assert.deepStrictEqual(config, {
    apiKey: 'k',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  });
});

test('环境变量覆盖默认值', () => {
  const config = resolveConfig({
    DEEPSEEK_API_KEY: 'k',
    DEEPSEEK_BASE_URL: 'https://example.test',
    AI_CHAT_MODEL: 'deepseek-v4-pro',
  });
  assert.strictEqual(config.baseUrl, 'https://example.test');
  assert.strictEqual(config.model, 'deepseek-v4-pro');
});
