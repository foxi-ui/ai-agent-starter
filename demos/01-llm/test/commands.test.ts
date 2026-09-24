import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, executeCommand, COMMAND_NAMES } from '@/core/commands.ts';
import { Session } from '@/core/session.ts';

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

  assert.deepEqual(executeCommand('clear', '', s), { kind: 'cleared', removed: 2 });
  assert.deepEqual(s.toMessages(''), []);
});

test('executeCommand /history 返回当前消息', () => {
  const s = new Session('deepseek-flash');
  s.append('user', 'a');

  assert.deepEqual(executeCommand('history', '', s), {
    kind: 'history',
    messages: [{ role: 'user', content: 'a' }],
  });
});

test('executeCommand /history 空会话返回空数组', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('history', '', s), { kind: 'history', messages: [] });
});

test('executeCommand /model 无参数是查询', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '', s), {
    kind: 'model-current',
    model: 'deepseek-flash',
  });
});

test('executeCommand /model 带参数是切换，且真的改到 Session', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', 'deepseek-v4-pro', s), {
    kind: 'model-changed',
    model: 'deepseek-v4-pro',
  });
  assert.equal(s.model, 'deepseek-v4-pro');
});

test('/model 不校验名字（有意为之）', () => {
  const s = new Session('deepseek-flash');
  assert.deepEqual(executeCommand('model', '随便写的名字', s), {
    kind: 'model-changed',
    model: '随便写的名字',
  });
});
