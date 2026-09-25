import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@/core/session.ts';

test('append 按序保存消息', () => {
  const s = new Session('deepseek-flash');
  s.append('user', '什么是 React Server Components？');
  // assistant 走 appendMessage：append 的 role 已收窄成 'system' | 'user'，
  // 用 append 写出这条消息**无法通过类型检查**（见下面那条守卫用例）。
  s.appendMessage({ role: 'assistant', content: '它是……' });
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

test('history 返回副本，改它不影响会话内部', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  const snapshot = s.history();
  assert.deepEqual(snapshot, [{ role: 'user', content: 'a' }]);

  snapshot.push({ role: 'user', content: '偷偷加的' });
  assert.equal(s.history().length, 1);

  // 每次调用都要拿到**新的**数组。上面的 push 断言挡不住「缓存一个数组复用」
  // 这种优化 —— 那种实现下 push 会污染缓存，但长度断言仍可能侥幸成立。
  assert.notEqual(s.history(), s.history());
});

test('history 的元素也是新的，改元素碰不到会话内部', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  // 只换掉数组是不够的：数组新、元素共享时，改元素照样穿透到会话状态。
  // spec 对 history() 的契约是「外部改不动内部状态」，所以这里钉元素隔离。
  const snapshot = s.history();
  snapshot[0].content = '改过的';

  assert.equal(s.history()[0].content, 'a');
});

// ── 收窄后的 append：类型层面的防线 ──────────────────────────────────
//
// 下面这几条测的是「收窄 append 之后，原来那些写法还在不在」。

test('append 只接受 user 与 system，assistant 必须走 appendMessage', () => {
  // 这条不是运行时断言，而是**类型检查**的守卫：
  // 下一行若写成 session.append('assistant', 'x')，tsc 会报错。
  // 用注释钉住它，是为了让删掉 @ts-expect-error 的人先看见这条用例。
  const session = new Session('m');
  // @ts-expect-error append 的 role 已收窄，不接受 assistant
  session.append('assistant', '你好');
});

test('appendMessage 记录 tool 角色与 tool_call_id', () => {
  const session = new Session('m');
  session.appendMessage({ role: 'tool', content: '25°C, Sunny', tool_call_id: 'c1' });

  assert.deepStrictEqual(session.history(), [
    { role: 'tool', content: '25°C, Sunny', tool_call_id: 'c1' },
  ]);
});

test('appendAll 按顺序追加多条', () => {
  const session = new Session('m');
  session.appendAll([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } },
    ] },
    { role: 'tool', content: '"晴"', tool_call_id: 'c1' },
    { role: 'assistant', content: '晴天。' },
  ]);

  assert.strictEqual(session.history().length, 3);
});

test('改 history() 返回值里的 tool_calls 不影响会话状态', () => {
  // 深拷贝若退化成 {...m}，这一条会红
  const session = new Session('m');
  session.appendMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
  });

  const snapshot = session.history();
  const first = snapshot[0]!;
  if (first.role === 'assistant' && first.tool_calls) {
    first.tool_calls[0]!.function.name = 'tampered';
  }

  const again = session.history()[0]!;
  assert.strictEqual(again.role, 'assistant');
  assert.strictEqual(
    again.role === 'assistant' ? again.tool_calls![0]!.function.name : null,
    'weather',
  );
});

test('model 是构造时定的、只读', () => {
  const session = new Session('deepseek-v4-pro');
  assert.strictEqual(session.model, 'deepseek-v4-pro');
  // 只读是类型层面的：下一行若去掉注释，tsc 会报 Cannot assign to 'model'
  // session.model = 'other';
});
