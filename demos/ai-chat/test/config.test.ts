import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '@/cli/config.ts';

test('缺少 apiKey 抛错', () => {
  assert.throws(() => resolveConfig({}), /DEEPSEEK_API_KEY/);
});

test('默认值生效', () => {
  const c = resolveConfig({ DEEPSEEK_API_KEY: 'k' });
  assert.equal(c.baseUrl, 'https://api.deepseek.com');
  assert.equal(c.model, 'deepseek-flash');
});

test('环境变量覆盖默认值', () => {
  const c = resolveConfig({
    DEEPSEEK_API_KEY: 'k',
    DEEPSEEK_BASE_URL: 'https://example.com',
    AI_CHAT_MODEL: 'deepseek-v4-pro',
  });
  assert.equal(c.baseUrl, 'https://example.com');
  assert.equal(c.model, 'deepseek-v4-pro');
});
