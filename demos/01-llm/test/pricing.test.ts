// 代码里的价目表 ↔ docs/deepseek-api-facts.md 的一致性。
//
// 为什么需要这条测试：core 层零运行时依赖，读不了 md 文件，所以
// `core/usage.ts` 的 PEAK_PRICES 必然是事实文档的**副本** —— 两份事实源，
// 官方一调价就会静默漂移。漂移的后果尤其阴险：/usage 会报出一个
// **格式正确、数值错误**的金额，没有任何迹象表明它过时了。
//
// 这条测试把「价格更新时两处一起改」从一行人工纪律变成一条会红的测试（D-M4b-9）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { priceFor } from '@/core/usage.ts';

const docPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'deepseek-api-facts.md');

/** 文档表格里的行：`| deepseek-flash | 输入 cache hit | ¥0.02 | ¥0.04 |` */
function parseRow(line: string): { model: string; kind: string; peak: number } | null {
  const cells = line.split('|').map((c) => c.trim());
  // 首尾各有一个空串（行以 | 开头结尾）
  if (cells.length < 6) return null;

  const [, model, kind, , peak] = cells;
  const match = /^¥([\d.]+)$/.exec(peak);
  if (!/^deepseek-/.test(model) || match === null) return null;

  return { model, kind, peak: Number(match[1]) };
}

const doc = readFileSync(docPath, 'utf8');

const expected: Array<{ model: string; kind: string; field: 'cacheHit' | 'cacheMiss' | 'output' }> = [
  { model: 'deepseek-flash', kind: '输入 cache hit', field: 'cacheHit' },
  { model: 'deepseek-flash', kind: '输入 cache miss', field: 'cacheMiss' },
  { model: 'deepseek-flash', kind: '输出', field: 'output' },
  { model: 'deepseek-v4-pro', kind: '输入 cache hit', field: 'cacheHit' },
  { model: 'deepseek-v4-pro', kind: '输入 cache miss', field: 'cacheMiss' },
  { model: 'deepseek-v4-pro', kind: '输出', field: 'output' },
];

const rows = doc.split('\n').map(parseRow).filter((r) => r !== null);

for (const { model, kind, field } of expected) {
  test(`文档的高峰价与代码一致：${model} / ${kind}`, () => {
    const row = rows.find((r) => r.model === model && r.kind === kind);
    assert.ok(row, `文档里找不到「${model} / ${kind}」这一行 —— 表格格式变了？`);

    const price = priceFor(model);
    assert.ok(price, `代码里没有 ${model} 的价目`);
    // 失败信息必须指明**是哪一项**对不上，否则红了之后还得人去逐行比对
    assert.equal(
      price[field],
      row.peak,
      `${model} 的 ${kind}：文档写 ¥${row.peak}，代码写 ${price[field]}`,
    );
  });
}

test('文档表格能被解析出 6 行价目', () => {
  // 防止正则失效后上面那些用例「找不到行」却因为别的原因通过
  assert.equal(rows.length, 6);
});
