// 上下文预算：估算与裁剪。
//
// 对应 spec §6 / §8。`fitToBudget` 刻意是纯函数，所以这里不需要网络、不需要 IO，
// 也不需要 repl —— 喂数组、断言数组。
//
// 测试里的 token 数全部是**手算出来的具体数字**（长度 3 → 2 token、长度 6 → 4 token、
// 长度 15 → 10 token），而不是调 estimateTokens 现算 —— 后者会让「估算公式被改坏」
// 这一类偏差在裁剪用例里完全看不出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, fitToBudget } from '@/core/context.ts';
import type { Message, Role } from '@/core/types.ts';

/** 造一条消息：内容长度决定估算值。长度 n → ceil(n / 1.5) token */
function msg(role: Role, chars: number): Message {
  return { role, content: 'x'.repeat(chars) };
}

/** 15 字符 → 10 token，用作 system */
const system = (): Message => msg('system', 15);
/** 6 字符 → 4 token，用作一轮问答里的每条消息 */
const turn = (role: 'user' | 'assistant'): Message => msg(role, 6);

// ── estimateTokens ────────────────────────────────────────────────────

test('estimateTokens 空串是 0', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens 对中文取保守上界（除数 1.5，不是 4）', () => {
  // 两个汉字：2 / 1.5 = 1.33 → 上取整 2。
  // 若除数被改回蓝图里的 4，这里会得到 1 —— 正是「低估」那个隐患。
  assert.equal(estimateTokens('闭包'), 2);
  // 五个汉字：5 / 1.5 = 3.33 → 4。除数改成 4 的话这里是 2，同样会低估。
  assert.equal(estimateTokens('什么是闭包'), 4);
});

test('estimateTokens 对上取整边界的方向', () => {
  // 恰好整除时不多算一个
  assert.equal(estimateTokens('xxx'), 2); // 3 / 1.5 = 2
  assert.equal(estimateTokens('xxxxxx'), 4); // 6 / 1.5 = 4
  // 差一点就进位
  assert.equal(estimateTokens('x'), 1); // 1 / 1.5 = 0.67 → 1
  assert.equal(estimateTokens('xxxx'), 3); // 4 / 1.5 = 2.67 → 3
});

test('estimateTokens 按 UTF-16 码元计数（代理对算 2）', () => {
  // emoji 是代理对，length 为 2（不是 1）。这是已知且有意接受的近似，
  // 钉住它是为了让这个行为成为「记录在案」而不是某天被当成 bug 改掉。
  assert.equal(estimateTokens('😀'), 2);
});

// ── fitToBudget：快路径 ───────────────────────────────────────────────

test('未超预算时原样返回，且返回的就是入参那个数组', () => {
  const messages = [system(), turn('user')]; // 10 + 4 = 14
  const fitted = fitToBudget(messages, 100);

  assert.equal(fitted.dropped, 0);
  assert.equal(fitted.droppedTokens, 0);
  // 同一个引用：未裁剪时不做任何拷贝
  assert.strictEqual(fitted.messages, messages);
});

test('恰好等于预算时不算超，不裁剪', () => {
  const messages = [system(), turn('user')]; // 14
  const fitted = fitToBudget(messages, 14);

  assert.equal(fitted.dropped, 0);
  assert.strictEqual(fitted.messages, messages);
});

// ── fitToBudget：按整轮裁 ─────────────────────────────────────────────

/** 一轮问答 8 token；system 10 token */
function threeTurns(): Message[] {
  return [
    system(), // index 0，永不裁
    turn('user'), // ┐ 第一轮（最老）
    turn('assistant'), // ┘
    turn('user'), // ┐ 第二轮
    turn('assistant'), // ┘
    turn('user'), // 第三轮 = 当前问题
  ];
  // 总计 10 + 4 + 4 + 4 + 4 + 4 = 30
}

test('超预算时从最老的一轮开始丢，丢到够为止', () => {
  const fitted = fitToBudget(threeTurns(), 25);

  // 30 > 25 → 丢掉第一轮（8 token）→ 22 ≤ 25 → 停
  assert.equal(fitted.dropped, 2);
  assert.equal(fitted.droppedTokens, 8);
  assert.equal(fitted.messages.length, 4);
  // 留下的是 [system, 第二轮 user, 第二轮 assistant, 当前 user]
  assert.equal(fitted.messages[0].role, 'system');
  assert.equal(fitted.messages[1].content, turn('user').content);
});

test('裁剪不拆半条消息 —— 丢的是整轮，不会留下没有问题的答案', () => {
  const fitted = fitToBudget(threeTurns(), 25);
  const roles = fitted.messages.map((m) => m.role);

  // 留下 user 之后必然跟着它的 assistant（或它就是最后那条当前问题）。
  // 若实现按「条数」而不是按「轮」裁，这里会出现一个孤立的 assistant。
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
});

test('裁剪后返回的是新数组，不再是入参那个', () => {
  const messages = threeTurns();
  const fitted = fitToBudget(messages, 25);

  assert.notStrictEqual(fitted.messages, messages);
  // 入参没有被就地改动 —— 这是「不回写会话状态」在纯函数层的体现
  assert.equal(messages.length, 6);
});

test('system 永不裁 —— 哪怕预算小到只剩它和当前问题', () => {
  const fitted = fitToBudget(threeTurns(), 1);

  assert.equal(fitted.messages[0].role, 'system');
  assert.equal(fitted.messages[0].content, system().content);
});

test('最后一组永不裁 —— 当前问题必须活下来', () => {
  const fitted = fitToBudget(threeTurns(), 1);
  const last = fitted.messages[fitted.messages.length - 1];

  assert.equal(last.role, 'user');
  assert.equal(last.content, turn('user').content);
});

test('裁到只剩最后一组就停，不会把当前轮也丢掉', () => {
  const fitted = fitToBudget(threeTurns(), 1);

  // [system, 当前 user]：丢掉了第一、二轮共 4 条
  assert.equal(fitted.messages.length, 2);
  assert.equal(fitted.dropped, 4);
  assert.equal(fitted.droppedTokens, 16);
});

test('预算为 0 或负数不需要特例：走到「只剩最后一组」为止', () => {
  for (const budget of [0, -5]) {
    const fitted = fitToBudget(threeTurns(), budget);
    assert.equal(fitted.messages.length, 2, `budget=${budget}`);
    assert.equal(fitted.dropped, 4, `budget=${budget}`);
  }
});

// ── fitToBudget：不可裁的情形 ─────────────────────────────────────────

test('单条消息自己就超预算时不裁，原样发出去让 API 报错', () => {
  // 静默丢掉用户的问题，比拿到一个 400 难查得多
  const messages = [system(), msg('user', 300)]; // 10 + 200 = 210
  const fitted = fitToBudget(messages, 5);

  assert.equal(fitted.dropped, 0);
  assert.strictEqual(fitted.messages, messages);
});

test('历史为空时（只有 system 与当前问题）永不裁', () => {
  const messages = [system(), turn('user')];
  const fitted = fitToBudget(messages, 1);

  assert.equal(fitted.dropped, 0);
  assert.strictEqual(fitted.messages, messages);
});

test('空数组与单元素数组都原样返回', () => {
  const empty = fitToBudget([], 100);
  assert.equal(empty.dropped, 0);
  assert.deepEqual(empty.messages, []);

  const only = fitToBudget([system()], 1);
  assert.equal(only.dropped, 0);
  assert.equal(only.messages.length, 1);
});

// ── fitToBudget：分组的两种边界 ───────────────────────────────────────

test('失败的轮次（只有 user 没有 assistant）能自成一组建整轮丢掉', () => {
  // D7：失败的轮次不追加 assistant 消息，历史里于是出现两个相邻的 user。
  // 按 role 交替推轮边界会在 `uFail, uB` 之间切错，把一次失败的提问
  // 和下一次的提问绑成一组 —— 这条用例专门钉住这个反例。
  const uFail = msg('user', 6); // 4 token，失败的那次
  const messages = [system(), uFail, turn('user'), turn('assistant'), turn('user')];
  // 10 + 4 + 4 + 4 + 4 = 26

  const fitted = fitToBudget(messages, 22);

  // 26 > 22 → 只丢掉 uFail 那一组（4 token）→ 22 ≤ 22 → 停
  assert.equal(fitted.dropped, 1);
  assert.equal(fitted.droppedTokens, 4);
  // 紧接着的 uB 完好无损 —— 它没有被绑上一起丢
  assert.equal(fitted.messages[1].content, turn('user').content);
  assert.equal(fitted.messages.length, 4);
});

test('开头不以 user 起始的残余单独成一组，最先被丢', () => {
  // 日志的第一条记录是 assistant 时会出现这种历史
  const residue = msg('assistant', 6); // 4 token
  const messages = [system(), residue, turn('user'), turn('assistant'), turn('user')];
  // 10 + 4 + 4 + 4 + 4 = 26

  const fitted = fitToBudget(messages, 22);

  // 只丢掉那条残余，后面的一整轮不动
  assert.equal(fitted.dropped, 1);
  assert.equal(fitted.droppedTokens, 4);
  assert.equal(fitted.messages[1].role, 'user');
  assert.equal(fitted.messages.length, 4);
});

// ── keptTokens（M4b 校准用） ──────────────────────────────────────────

test('未超预算时 keptTokens 等于全部估算', () => {
  const messages = [system(), turn('user')]; // 10 + 4 = 14
  const fitted = fitToBudget(messages, 100);
  assert.equal(fitted.keptTokens, 14);
});

test('裁剪后 keptTokens 等于 total 减 droppedTokens', () => {
  // 三个完整轮：10 + (4+4) × 3 = 34。预算 20 → 丢掉最老的两轮（16）
  const messages = [
    system(),
    turn('user'), turn('assistant'),
    turn('user'), turn('assistant'),
    turn('user'), turn('assistant'),
  ];
  const fitted = fitToBudget(messages, 20);

  assert.equal(fitted.droppedTokens, 16);
  assert.equal(fitted.keptTokens, 34 - 16);
});

test('单条消息自超预算、一组都没丢时，keptTokens 仍是全部估算', () => {
  // 预算再小也裁不动最后一组，此时 dropped 为 0、keptTokens 应是 14
  const messages = [system(), turn('user')];
  const fitted = fitToBudget(messages, 1);
  assert.equal(fitted.dropped, 0);
  assert.equal(fitted.keptTokens, 14);
});
