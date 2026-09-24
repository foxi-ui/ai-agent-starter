import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from '@/llm/sse.ts';

test('一次 chunk 含多个完整事件', () => {
  const { events, rest } = parseSse('data: a\n\ndata: b\n\n');
  assert.deepEqual(events, [
    { event: 'message', data: 'a' },
    { event: 'message', data: 'b' },
  ]);
  assert.equal(rest, '');
});

test('一条事件被切成两次 chunk', () => {
  const first = parseSse('data: he');
  assert.deepEqual(first.events, []);
  assert.equal(first.rest, 'data: he');

  const second = parseSse('llo\n\n', first.rest);
  assert.deepEqual(second.events, [{ event: 'message', data: 'hello' }]);
  assert.equal(second.rest, '');
});

test('尾部半条事件进 rest，不产出事件', () => {
  const { events, rest } = parseSse('data: 完整\n\ndata: 未完');
  assert.deepEqual(events, [{ event: 'message', data: '完整' }]);
  assert.equal(rest, 'data: 未完');
});

test('\\r\\n 换行等价处理，且 \\r\\n 被切在两次 chunk 之间也能拼回', () => {
  assert.deepEqual(parseSse('data: a\r\n\r\n').events, [{ event: 'message', data: 'a' }]);

  // \r 与 \n 分属两个 chunk —— 这是最容易写错的边界
  const first = parseSse('data: a\r');
  // 尾部落单的 \r 必须**留在 rest 里**：若这里就被剥掉，下一块开头的 \n
  // 会被当成一个空行，CRLF 跨块的那条事件再也拼不回来
  assert.equal(first.rest, 'data: a\r');
  const second = parseSse('\n\r\n', first.rest);
  assert.deepEqual(second.events, [{ event: 'message', data: 'a' }]);
});

test('注释行（keep-alive）被忽略', () => {
  const { events, rest } = parseSse(': keep-alive\n\ndata: a\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'a' }]);
  assert.equal(rest, '');
});

test('同一事件的多行 data 用 \\n 拼接', () => {
  const { events } = parseSse('data: 第一行\ndata: 第二行\n\n');
  assert.deepEqual(events, [{ event: 'message', data: '第一行\n第二行' }]);
});

test('data: 后的一个可选空格被剥掉，多余空格保留', () => {
  assert.deepEqual(parseSse('data: a\n\n').events, [{ event: 'message', data: 'a' }]);
  assert.deepEqual(parseSse('data:a\n\n').events, [{ event: 'message', data: 'a' }]);
  assert.deepEqual(parseSse('data:  a\n\n').events, [{ event: 'message', data: ' a' }]);
});

test('event: 字段作为事件名，缺省 message', () => {
  const { events } = parseSse('event: ping\ndata: x\n\n');
  assert.deepEqual(events, [{ event: 'ping', data: 'x' }]);
});

test('id: / retry: 等其他字段被忽略', () => {
  const { events } = parseSse('id: 42\nretry: 100\ndata: x\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'x' }]);
});

test('没有 data 的块不产出事件（只有注释、只有 event:）', () => {
  assert.deepEqual(parseSse(': 只有注释\n\n').events, []);
  assert.deepEqual(parseSse('event: ping\n\n').events, []);
});

test('[DONE] 只是一条普通事件，含义由调用方解释', () => {
  const { events } = parseSse('data: [DONE]\n\n');
  assert.deepEqual(events, [{ event: 'message', data: '[DONE]' }]);
});

test('空输入与连续空行不崩', () => {
  assert.deepEqual(parseSse(''), { events: [], rest: '' });
  const blank = parseSse('\n\n\n\n');
  assert.deepEqual(blank.events, []);
  // 全是空行时没有任何残留 —— 空块不产出事件，也不该攒下 rest
  assert.equal(blank.rest, '');
});
