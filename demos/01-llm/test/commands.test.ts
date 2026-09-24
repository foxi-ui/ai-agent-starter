import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, executeCommand, COMMAND_NAMES } from '@/core/commands.ts';
import { Session } from '@/core/session.ts';
import type { SessionStore } from '@/core/journal.ts';

// 假 store：/sessions 命令唯一需要的外部依赖。
// 本次不给它加断言 —— 只为了让现有的 executeCommand 调用点能编译通过。
function fakeStore(): SessionStore {
  return {
    create() {},
    append() {},
    load() {
      return null;
    },
    list() {
      return [];
    },
  };
}

const deps = { store: fakeStore(), currentSessionId: '20260924-143022-a3f1' };

test('不以 / 开头不是命令', () => {
  assert.deepEqual(parseCommand('今天天气怎么样'), { kind: 'none' });
  // 「/」不在行首也不算命令
  assert.deepEqual(parseCommand('路径是 a/b'), { kind: 'none' });
  assert.deepEqual(parseCommand('  '), { kind: 'none' });
});

test('已知命令解析出名字与参数', () => {
  assert.deepEqual(parseCommand('/clear'), { kind: 'known', name: 'clear', argument: '' });
  assert.deepEqual(parseCommand('/history'), { kind: 'known', name: 'history', argument: '' });
  assert.deepEqual(parseCommand('/model'), { kind: 'known', name: 'model', argument: '' });
  assert.deepEqual(parseCommand('/model deepseek-v4-pro'), {
    kind: 'known',
    name: 'model',
    argument: 'deepseek-v4-pro',
  });
});

test('前后空白被忽略，参数内部空白保留', () => {
  assert.deepEqual(parseCommand('  /clear  '), { kind: 'known', name: 'clear', argument: '' });
  assert.deepEqual(parseCommand('/model   deepseek-v4-pro   '), {
    kind: 'known',
    name: 'model',
    argument: 'deepseek-v4-pro',
  });
});

test('只有 /model 的参数允许含空格（原样保留，不校验）', () => {
  assert.deepEqual(parseCommand('/model a b'), {
    kind: 'known',
    name: 'model',
    argument: 'a b',
  });
});

test('未知命令与空命令报 unknown，原样保留输入', () => {
  assert.deepEqual(parseCommand('/foo'), { kind: 'unknown', input: '/foo' });
  assert.deepEqual(parseCommand('/'), { kind: 'unknown', input: '/' });
  assert.deepEqual(parseCommand('  /foo bar  '), { kind: 'unknown', input: '/foo bar' });
});

test('COMMAND_NAMES 与识别结果一致', () => {
  for (const name of COMMAND_NAMES) {
    assert.deepEqual(parseCommand(`/${name}`), { kind: 'known', name, argument: '' });
  }
});

test('executeCommand /clear 清空并返回条数', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');
  s.append('assistant', 'b');

  assert.deepEqual(executeCommand('clear', '', s, deps), { kind: 'cleared', removed: 2 });
  assert.deepEqual(s.toMessages(''), []);
});

test('executeCommand /history 返回当前消息', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  assert.deepEqual(executeCommand('history', '', s, deps), {
    kind: 'history',
    messages: [{ role: 'user', content: 'a' }],
  });
});

test('executeCommand /history 空会话返回空数组', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('history', '', s, deps), { kind: 'history', messages: [] });
});

test('executeCommand /model 无参数是查询', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '', s, deps), {
    kind: 'model-current',
    model: 'deepseek-flash',
  });
});

test('executeCommand /model 带参数是切换，且真的改到 Session', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', 'deepseek-v4-pro', s, deps), {
    kind: 'model-changed',
    model: 'deepseek-v4-pro',
  });
  assert.equal(s.model, 'deepseek-v4-pro');
});

test('/model 不校验名字（有意为之）', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '随便写的名字', s, deps), {
    kind: 'model-changed',
    model: '随便写的名字',
  });
});

test('/model 只有尾随空白视为空参数（trim 后等价于查询）', () => {
  // tab 补全常常回填成 `/model `（带一个尾随空格），用户可见的后果是：
  // 它走的是**查询**而不是切换。这里把这条边界钉成有意行为，不是漏判。
  assert.deepEqual(parseCommand('/model '), { kind: 'known', name: 'model', argument: '' });
  assert.deepEqual(parseCommand('/model\t'), { kind: 'known', name: 'model', argument: '' });

  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '', s, deps), {
    kind: 'model-current',
    model: 'deepseek-flash',
  });
  assert.equal(s.model, 'deepseek-flash');
});

test('executeCommand /model 查询分支一次都不写 session.model', () => {
  const s = new Session('deepseek-flash');

  // 用 setter 探针替换实例上的 model 访问器。
  //
  // 为什么非要探针：契约是「查询分支**不得写**」，这是对**副作用**的约束，
  // 而断言返回值只能观察到「值」有没有变。写回同值（比如把赋值上移到分支之前、
  // 参数恰好等于当前模型名）在值上完全不可观测，只有「写入次数」会暴露它。
  //
  // 探针是**透明**的：读写都转发给原型上的原访问器，
  // 所以它既是写入计数器，又不改变 Session 的真实行为。
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(s), 'model');
  const originalGet = descriptor?.get;
  const originalSet = descriptor?.set;
  assert.ok(
    originalGet && originalSet,
    'Session 的 model 应该是原型上的 get/set 访问器，否则这个探针的假设不成立',
  );

  let writes = 0;
  Object.defineProperty(s, 'model', {
    get: () => originalGet.call(s),
    set: (value: string) => {
      writes += 1;
      originalSet.call(s, value);
    },
  });

  assert.deepEqual(executeCommand('model', '', s, deps), {
    kind: 'model-current',
    model: 'deepseek-flash',
  });
  assert.equal(writes, 0, '查询分支不得写 session.model');
  assert.equal(s.model, 'deepseek-flash');
});
