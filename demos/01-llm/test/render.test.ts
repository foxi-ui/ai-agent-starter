import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createStreamRenderer } from '@/cli/render.ts';

function collector(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { chunks, stream };
}

function setup() {
  const out = collector();
  const err = collector();
  const renderer = createStreamRenderer({
    output: out.stream,
    errorOutput: err.stream,
  });
  return { out, err, renderer };
}

test('text-delta 逐字写 stdout，不加换行', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '你好' });
  renderer.onEvent({ type: 'text-delta', text: '，世界' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 你好，世界\n');
  assert.deepEqual(err.chunks, []);
});

test('首个 reasoning-delta 在 stderr 写一行指示，且只写一次', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'reasoning-delta', text: '想' });
  renderer.onEvent({ type: 'reasoning-delta', text: '继续想' });
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.finish();

  assert.equal(err.chunks.join(''), '[思考中…]\n');
  // 思考内容本身不出现
  assert.ok(!err.chunks.join('').includes('想'));
  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('没有 reasoning 时 stderr 完全安静', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.deepEqual(err.chunks, []);
  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('finish 调两次只补一个换行', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.finish();
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('整轮没有任何事件时，finish 不写任何东西（一上来就抛错的情形）', () => {
  const { out, renderer } = setup();
  renderer.finish();

  assert.deepEqual(out.chunks, []);
});

test('done 但整轮没有正文时，仍然写出 AI: 前缀', () => {
  // 与 M1 的非流式路径保持一致：那边对空回答写的是 `write(\`AI: ${content}\`)`，
  // content 为空串时同样会输出 `AI: `。两条路径的形状不能不一样。
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: \n');
});

test('前缀只写一次（多个 text-delta 不会重复前缀）', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '一' });
  renderer.onEvent({ type: 'text-delta', text: '二' });
  renderer.onEvent({ type: 'text-delta', text: '三' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 一二三\n');
});

test('finish_reason 为 length 时 stderr 警告截断', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '半句' });
  renderer.onEvent({ type: 'done', reason: 'length' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 半句\n');
  assert.equal(err.chunks.join(''), '[警告] 回答被截断（finish_reason=length）\n');
});

test('finish_reason 为 stop 时不警告', () => {
  const { err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.deepEqual(err.chunks, []);
});

test('已输出正文但流中途失败：finish 仍补换行', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '半截' });
  // 模拟 repl 的 catch 分支之后调用 finish
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 半截\n');
});
