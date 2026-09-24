import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@/core/session.ts';

test('append 按序保存消息', () => {
  const s = new Session('deepseek-flash');
  s.append('user', '什么是 React Server Components？');
  s.append('assistant', '它是……');
  assert.deepEqual(s.toMessages(''), [
    { role: 'user', content: '什么是 React Server Components？' },
    { role: 'assistant', content: '它是……' },
  ]);
});

test('toMessages 把 system 放在最前', () => {
  const s = new Session('deepseek-flash');
  s.append('user', '总结刚才内容');
  assert.deepEqual(s.toMessages('你是 CLI AI 助手'), [
    { role: 'system', content: '你是 CLI AI 助手' },
    { role: 'user', content: '总结刚才内容' },
  ]);
});

test('构造时带上当前模型，可读可改', () => {
  const s = new Session('deepseek-flash');
  assert.equal(s.model, 'deepseek-flash');
  // 先攒一条消息再切模型：`set model` 注释声称「只影响后续请求，不改动已有消息」，
  // 这里把它变成可证伪的断言 —— 模型是 per-call 参数，历史消息不该被它碰到
  s.append('user', '什么是 React Server Components？');
  const before = s.toMessages('你是 CLI AI 助手');
  s.model = 'deepseek-v4-pro';
  assert.equal(s.model, 'deepseek-v4-pro');
  assert.deepEqual(s.toMessages('你是 CLI AI 助手'), before);
});

test('clear 清空消息并返回条数，不影响当前模型', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');
  s.append('assistant', 'b');

  assert.equal(s.clear(), 2);
  assert.deepEqual(s.toMessages(''), []);
  // 清的是对话，不是会话配置
  assert.equal(s.model, 'deepseek-flash');
  // 再清一次返回 0，不报错
  assert.equal(s.clear(), 0);
});

test('history 返回副本，改它不影响会话内部', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  const snapshot = s.history();
  assert.deepEqual(snapshot, [{ role: 'user', content: 'a' }]);

  snapshot.push({ role: 'user', content: '偷偷加的' });
  assert.equal(s.history().length, 1);
});
