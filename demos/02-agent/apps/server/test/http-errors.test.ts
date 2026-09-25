import test from 'node:test';
import assert from 'node:assert/strict';

import { mapErrorToStatus } from '@/http/errors.ts';

test('上游返回错误响应 → 502', () => {
  const mapped = mapErrorToStatus(new Error('DeepSeek API error 401: invalid api key'));
  assert.strictEqual(mapped.status, 502);
  assert.strictEqual(mapped.code, 'upstream_error');
});

test('上游 401 绝不透出成 401（那是我们的 key 错了，不是用户没登录）', () => {
  // Review Focus 第 2 条
  for (const status of [401, 403, 429]) {
    const mapped = mapErrorToStatus(new Error(`DeepSeek API error ${status}: x`));
    assert.notStrictEqual(mapped.status, status);
    assert.strictEqual(mapped.status, 502);
  }
});

test('连不上上游 → 504', () => {
  assert.strictEqual(mapErrorToStatus(new TypeError('fetch failed')).status, 504);
  assert.strictEqual(mapErrorToStatus(new Error('ECONNREFUSED')).status, 504);
  assert.strictEqual(mapErrorToStatus(new Error('socket hang up')).status, 504);
});

test('未知错误 → 500', () => {
  const mapped = mapErrorToStatus(new Error('别的东西炸了'));
  assert.strictEqual(mapped.status, 500);
  assert.strictEqual(mapped.code, 'internal');
});

test('非 Error 的抛出物也能映射', () => {
  assert.strictEqual(mapErrorToStatus('字符串错误').status, 500);
  assert.strictEqual(mapErrorToStatus(null).status, 500);
});

test('返回值只可能是 500 / 502 / 504', () => {
  const samples: unknown[] = [
    new Error('DeepSeek API error 500: x'),
    new Error('fetch failed'),
    new Error('whatever'),
    'string',
    null,
    undefined,
    { weird: true },
  ];
  for (const sample of samples) {
    assert.ok([500, 502, 504].includes(mapErrorToStatus(sample).status));
  }
});
