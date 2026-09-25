import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionNotFoundError, createSessionRegistry } from '@/http/session-registry.ts';
import { newSessionId } from '@/http/ids.ts';

/** 递增的假 id 生成器，让每个会话都有稳定的名字 */
function counterIds(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `20260101-00000${index}-aaaa`;
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('create 返回会话与 id，get 能取回', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { session, id } = registry.create();

  assert.strictEqual(session.model, 'm');
  assert.strictEqual(registry.get(id), session);
});

test('get 未知 id 返回 null', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  assert.strictEqual(registry.get('nope'), null);
});

test('run 在未知 id 上抛 SessionNotFoundError', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  await assert.rejects(() => registry.run('nope', async () => 'x'), SessionNotFoundError);
});

test('同一 id 上的两个 run 串行执行，不交错', async () => {
  // Review Focus 第 3 条：交错会让 toMessages() 里出现没有 tool 回应的
  // assistant{tool_calls}，上游 400 且错因完全不指向并发
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { id } = registry.create();
  const events: string[] = [];

  const first = registry.run(id, async () => {
    events.push('A:start');
    await delay(30);
    events.push('A:end');
  });
  const second = registry.run(id, async () => {
    events.push('B:start');
    await delay(1);
    events.push('B:end');
  });

  await Promise.all([first, second]);

  assert.deepStrictEqual(events, ['A:start', 'A:end', 'B:start', 'B:end']);
});

test('不同 id 的 run 互不阻塞', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const a = registry.create();
  const b = registry.create();
  const events: string[] = [];

  const first = registry.run(a.id, async () => {
    events.push('A:start');
    await delay(30);
    events.push('A:end');
  });
  const second = registry.run(b.id, async () => {
    events.push('B:start');
    await delay(1);
    events.push('B:end');
  });

  await Promise.all([first, second]);

  assert.deepStrictEqual(events, ['A:start', 'B:start', 'B:end', 'A:end']);
});

test('前一个 run 失败不毒化这条链', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { id } = registry.create();

  const first = registry.run(id, async () => {
    throw new Error('第一段失败');
  });
  const second = registry.run(id, async () => '第二段成功');

  await assert.rejects(() => first, /第一段失败/);
  assert.strictEqual(await second, '第二段成功');
});

test('run 把会话传给回调', async () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm' });
  const { session, id } = registry.create();

  assert.strictEqual(await registry.run(id, async (passed) => passed), session);
});

test('超过 maxSessions 时淘汰最早创建的（FIFO）', () => {
  const registry = createSessionRegistry({ newId: counterIds(), model: 'm', maxSessions: 2 });
  const first = registry.create();
  const second = registry.create();
  assert.strictEqual(registry.size(), 2);

  const third = registry.create();

  assert.strictEqual(registry.size(), 2);
  assert.strictEqual(registry.get(first.id), null, '最早的那个应被淘汰');
  assert.ok(registry.get(second.id));
  assert.ok(registry.get(third.id));
});

test('newSessionId 的形状是 YYYYMMDD-HHMMSS-xxxx', () => {
  const id = newSessionId(new Date(2026, 8, 25, 9, 5, 3));
  // 月份是 0 基的，传 8 表示 9 月；各段都要补零
  assert.match(id, /^20260925-090503-[0-9a-f]{4}$/);
});

test('newSessionId 取的是**本地时间**，不是 UTC', () => {
  // 用 toISOString() 会得到 UTC，东八区会早 8 小时 —— 那是个安静的错误
  const local = new Date(2026, 0, 1, 0, 30, 0);
  assert.match(newSessionId(local), /^20260101-003000-/);
});

test('同一时刻生成的两个 id 不会撞（随机后缀）', () => {
  const now = new Date(2026, 8, 25, 9, 5, 3);
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId(now)));
  assert.ok(ids.size > 1, '50 次里应当出现不同的后缀');
});

test('按字典序排就是时间序', () => {
  const earlier = newSessionId(new Date(2026, 8, 25, 9, 5, 3));
  const later = newSessionId(new Date(2026, 8, 25, 10, 5, 3));
  assert.ok(earlier < later, '字典序必须与时间序一致（spec §11 要点 4）');
});
