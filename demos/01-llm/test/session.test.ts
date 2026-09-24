import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@/core/session.ts';
import type { SessionChange } from '@/core/journal.ts';

/** 收集 onChange 广播出来的变更，供断言完整序列 */
function collector(): { changes: SessionChange[]; onChange: (change: SessionChange) => void } {
  const changes: SessionChange[] = [];
  return { changes, onChange: (change) => changes.push(change) };
}

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

// ── 变更广播（onChange）───────────────────────────────────────────────
//
// M3 让 Session 在三个变更点广播，cli 收到就落盘。这是「会话活得比进程久」
// 的全部机制，也是「回放到的事件与落盘事件是同一组」的唯一保证。

test('三个变更点各广播一次，载荷就是日志里那一行', () => {
  const { changes, onChange } = collector();
  const s = new Session('deepseek-flash', { onChange });

  s.append('user', '什么是闭包');
  s.append('assistant', '函数与词法作用域的组合');
  s.clear();
  s.model = 'deepseek-v4-pro';

  // 断言**完整序列**而不只是条数：漏一个变更点、顺序颠倒、
  // 或载荷里的字段名/值写错，都会在这里现形。
  assert.deepEqual(changes, [
    { type: 'message', role: 'user', content: '什么是闭包' },
    { type: 'message', role: 'assistant', content: '函数与词法作用域的组合' },
    { type: 'clear' },
    { type: 'model', model: 'deepseek-v4-pro' },
  ]);
});

test('只读操作一次都不广播', () => {
  const { changes, onChange } = collector();
  const s = new Session('deepseek-flash', { onChange });
  s.append('user', 'a');
  changes.length = 0; // 只看下面这些只读操作

  s.toMessages('你是 CLI AI 助手');
  s.history();
  void s.model; // 读 getter

  // 只读操作若也广播，每轮请求都会往日志里多写一行 —— 日志会以请求数增长。
  assert.deepEqual(changes, []);
});

test('构造时铺入的 history 不广播（打开一次会话，日志不该变长）', () => {
  // 这条钉住 session.ts 构造函数里那句「回放结果直接铺成初始状态，不经过 append」。
  // 若改成构造时逐条 append，每恢复一条历史就多写一行日志 ——
  // 打开一次会话，文件就翻一倍，而且 `--resume` 两次就翻两番。
  // 这是实施计划里点名的第 2 号人工审查项。
  const { changes, onChange } = collector();
  const s = new Session('deepseek-flash', {
    history: [
      { role: 'user', content: '上次问的' },
      { role: 'assistant', content: '上次答的' },
    ],
    onChange,
  });

  assert.deepEqual(changes, []);
  // 历史确实铺进去了（否则「零广播」可能只是因为什么都没做）
  assert.deepEqual(s.history(), [
    { role: 'user', content: '上次问的' },
    { role: 'assistant', content: '上次答的' },
  ]);

  // 证明探针是有效的：同一实例上真的发生变更时，它必须记到。
  // 没有这一句，onChange 根本没被接上时「零广播」断言照样成立 —— 一条空转的假绿。
  s.append('user', '这次问的');
  assert.deepEqual(changes, [{ type: 'message', role: 'user', content: '这次问的' }]);
});

test('构造时复制 history 数组，外部 push 碰不到会话内部', () => {
  const history = [{ role: 'user' as const, content: '原来的' }];
  const s = new Session('deepseek-flash', { history });

  history.push({ role: 'user', content: '偷偷加的' });

  assert.deepEqual(s.history(), [{ role: 'user', content: '原来的' }]);
});

test('【已知边界】构造时传入的 history，其**元素对象是共享的**（只做了浅拷贝）', () => {
  // 构造函数里是 `[...options.history]` —— 换掉了外层数组，但里面的 Message
  // 仍是调用方那些对象。所以调用方改元素字段会穿透进会话状态。
  //
  // 与 history() 不对称：那边刻意做了元素级深拷贝（注释写明「元素也必须是新的」，
  // 因为 spec 对它的契约是「外部改不动内部状态」）。这里没有同样的保证。
  //
  // 当前不可达：全项目唯一的调用方是 src/index.ts，它传的是 replay() 现造的
  // `{role, content}` 新对象，且之后把数组丢掉，没有任何人还持有这些元素。
  // 所以这是一条**潜在**的不一致，不是正在发生的缺陷 —— 已作为观察项报告，未改代码。
  //
  // 若将来有调用方要复用传入的数组或元素，这里必须升级成元素级拷贝。
  const history = [{ role: 'user' as const, content: '原来的' }];
  const s = new Session('deepseek-flash', { history });

  history[0].content = '改过的';

  assert.equal(s.history()[0].content, '改过的', '当前行为：元素共享');
});

test('onChange 抛错时，内存状态**已经**更新了（先改内存、再广播）', () => {
  // 这条钉住 append / clear / set model 里「先改内存、再广播」的顺序。
  // 顺序反过来的话，广播（写文件）抛错时内存还没改 —— 用户会看到
  // 「报错了但下一轮模型又记得」，状态自相矛盾。
  // cli/repl.ts 正是靠这个顺序才敢把写盘失败降级成「警告一次、对话继续」。
  const s = new Session('deepseek-flash', {
    onChange: () => {
      throw new Error('磁盘满了');
    },
  });

  assert.throws(() => s.append('user', 'a'), /磁盘满了/);
  assert.deepEqual(s.history(), [{ role: 'user', content: 'a' }]);

  assert.throws(() => s.clear(), /磁盘满了/);
  assert.deepEqual(s.history(), []);

  assert.throws(() => {
    s.model = 'deepseek-v4-pro';
  }, /磁盘满了/);
  assert.equal(s.model, 'deepseek-v4-pro');
});
