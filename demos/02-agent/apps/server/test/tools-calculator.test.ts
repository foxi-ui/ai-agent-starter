import test from 'node:test';
import assert from 'node:assert/strict';

import { calculatorTool } from '@/tools/calculator.ts';

async function calculate(expression: string) {
  return calculatorTool.run({ expression });
}

function valueOf(result: Awaited<ReturnType<typeof calculate>>): number {
  assert.strictEqual(result.ok, true);
  return result.ok ? (result.value as { result: number }).result : NaN;
}

test('四则运算与优先级', async () => {
  assert.deepStrictEqual(await calculate('1 + 2 * 3'), {
    ok: true,
    value: { expression: '1 + 2 * 3', result: 7 },
  });
});

test('括号改变优先级', async () => {
  assert.strictEqual(valueOf(await calculate('(1 + 2) * 3')), 9);
});

test('小数与一元负号', async () => {
  assert.strictEqual(valueOf(await calculate('1.5 * 2')), 3);
  assert.strictEqual(valueOf(await calculate('-4 + 1')), -3);
});

test('除零返回 {ok:false}，且错误文本包含表达式原文', async () => {
  const result = await calculate('1 / 0');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 / 0'));
});

test('字母被白名单拦下', async () => {
  assert.strictEqual((await calculate('alert(1)')).ok, false);
});

test('分号、反引号与属性访问被白名单拦下', async () => {
  for (const expression of ['1; process.exit(1)', '`1`', '1 .toString()']) {
    assert.strictEqual((await calculate(expression)).ok, false, `应被拒绝：${expression}`);
  }
});

test('括号不配对返回 {ok:false}', async () => {
  assert.strictEqual((await calculate('(1 + 2')).ok, false);
});

test('尾部有多余内容返回 {ok:false}', async () => {
  assert.strictEqual((await calculate('1 2')).ok, false);
});

test('缺 expression 参数返回 {ok:false}', async () => {
  assert.strictEqual((await calculatorTool.run({})).ok, false);
});

test('错误文本里带着表达式原文（模型据此才能改）', async () => {
  // 这里写 `1 +` 而不是 `1 + `（尾随空格）：实现里 original 取的是 trim 后的值，
  // 成功路径返回的 expression 也是同一个值 —— 两条路径对「表达式原文」的定义必须一致。
  const result = await calculate('1 +');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 +'));
});
