import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@/core/session.ts';

test('append 按序保存消息', () => {
  const s = new Session();
  s.append('user', '什么是 React Server Components？');
  s.append('assistant', '它是……');
  assert.deepEqual(s.toMessages(''), [
    { role: 'user', content: '什么是 React Server Components？' },
    { role: 'assistant', content: '它是……' },
  ]);
});

test('toMessages 把 system 放在最前', () => {
  const s = new Session();
  s.append('user', '总结刚才内容');
  assert.deepEqual(s.toMessages('你是 CLI AI 助手'), [
    { role: 'system', content: '你是 CLI AI 助手' },
    { role: 'user', content: '总结刚才内容' },
  ]);
});
