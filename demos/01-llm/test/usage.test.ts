// 用量与计价：时段判断、单价、账本。
//
// 对应 spec §6 / §8 / §9。`core/usage.ts` 是纯函数 + 一个薄类，所以这里
// 不需要网络、不需要 IO、不需要临时目录 —— 喂值、断言值。
//
// 时间的构造一律用 **UTC 串**，因为函数内部按北京时间判断（+8h）。
// 每个用例的注释里都写出了「这个 UTC 时刻对应北京时间几点」，
// 否则读的人要自己心算，而算错一次就会把断言写反。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodAt,
  isOutsideHolidayTable,
  HOLIDAYS,
  MAKEUP_WORKDAYS,
  HOLIDAY_TABLE_YEAR,
} from '@/core/usage.ts';

// ── periodAt：工作日的高峰窗口 ─────────────────────────────────────────
//
// 2026-09-28 是**周一**，且不在节假日表里（中秋假期是 9/25–9/27）。

test('工作日高峰窗口的左边界：北京 9:00 是高峰、8:59 是空闲', () => {
  // UTC 01:00 = 北京 09:00
  assert.equal(periodAt(new Date('2026-09-28T01:00:00Z')), 'peak');
  // UTC 00:59 = 北京 08:59
  assert.equal(periodAt(new Date('2026-09-28T00:59:00Z')), 'offpeak');
});

test('工作日高峰窗口的右边界：北京 12:00 起是午休（空闲）', () => {
  // UTC 03:59 = 北京 11:59
  assert.equal(periodAt(new Date('2026-09-28T03:59:00Z')), 'peak');
  // UTC 04:00 = 北京 12:00
  assert.equal(periodAt(new Date('2026-09-28T04:00:00Z')), 'offpeak');
});

test('工作日第二个高峰窗口：北京 14:00 到 18:00', () => {
  assert.equal(periodAt(new Date('2026-09-28T06:00:00Z')), 'peak');    // 北京 14:00
  assert.equal(periodAt(new Date('2026-09-28T09:59:00Z')), 'peak');    // 北京 17:59
  assert.equal(periodAt(new Date('2026-09-28T10:00:00Z')), 'offpeak'); // 北京 18:00
});

test('午休与深夜都是空闲', () => {
  assert.equal(periodAt(new Date('2026-09-28T04:30:00Z')), 'offpeak'); // 北京 12:30
  assert.equal(periodAt(new Date('2026-09-28T18:00:00Z')), 'offpeak'); // 北京次日 02:00
});

test('普通周末全天空闲', () => {
  // 2026-09-05 是周六、09-06 是周日，且都不在节假日表里
  // （9/19-9/20 那个周末不行：9/20 是调休上班日）
  assert.equal(periodAt(new Date('2026-09-05T02:00:00Z')), 'offpeak'); // 周六 10:00
  assert.equal(periodAt(new Date('2026-09-06T02:00:00Z')), 'offpeak'); // 周日 10:00
});

// ── periodAt：节假日与调休 ────────────────────────────────────────────

test('法定节假日即使落在工作日也判空闲', () => {
  // 2026-10-01 是**周四**（国庆），北京 10:00 —— 正常工作日的高峰时段
  assert.equal(periodAt(new Date('2026-10-01T02:00:00Z')), 'offpeak');
  // 春节也是一样：2026-02-17 是周二，北京 15:00
  assert.equal(periodAt(new Date('2026-02-17T07:00:00Z')), 'offpeak');
});

test('调休上班的周末照样判高峰', () => {
  // 2026-09-20 是**周日**，但它是国庆调休上班日；北京 10:00
  assert.equal(periodAt(new Date('2026-09-20T02:00:00Z')), 'peak');
  // 2026-02-14 是**周六**，春节调休；北京 15:00
  assert.equal(periodAt(new Date('2026-02-14T07:00:00Z')), 'peak');
});

test('调休上班日只在高峰窗口内算高峰，其余时间仍是空闲', () => {
  // 同一天（2026-09-20 调休），北京 12:30 是午休
  assert.equal(periodAt(new Date('2026-09-20T04:30:00Z')), 'offpeak');
});

// ── 表的覆盖范围 ──────────────────────────────────────────────────────

test('超出节假日表年份：不判节假日，但会报告超出范围', () => {
  // 2027-01-01 是周五，表里没有它 → 按普通工作日判，北京 10:00 是高峰
  assert.equal(periodAt(new Date('2027-01-01T02:00:00Z')), 'peak');
  assert.equal(isOutsideHolidayTable(new Date('2027-01-01T02:00:00Z')), true);
});

test('表覆盖范围内的时刻不算超出', () => {
  assert.equal(isOutsideHolidayTable(new Date('2026-09-28T02:00:00Z')), false);
  assert.equal(HOLIDAY_TABLE_YEAR, 2026);
});

// ── 无效输入 ──────────────────────────────────────────────────────────

test('无效时刻按高峰计，且不抛错', () => {
  // 落盘的 at 是我们自己写的，走到这里说明文件被人手改过。
  // 关键：new Date(NaN).toISOString() 会抛 RangeError，
  // 所以实现里必须先判 NaN 再取北京时间分量。
  const invalid = new Date('不是日期');
  assert.equal(Number.isNaN(invalid.getTime()), true);
  assert.equal(periodAt(invalid), 'peak');
});

test('无效时刻不触发「超出表范围」的提示', () => {
  assert.equal(isOutsideHolidayTable(new Date('不是日期')), false);
});

// ── 数据自证 ──────────────────────────────────────────────────────────
//
// 下面两条测的不是逻辑而是**数据**。表是从国务院通知手抄的，
// 抄错一位就会让某一天的金额算错，而那种错没有任何其它迹象。

test('放假日表：33 天，且每个节日的首尾都在', () => {
  assert.equal(HOLIDAYS.size, 33);
  for (const key of [
    '2026-01-01', '2026-01-03',        // 元旦
    '2026-02-15', '2026-02-23',        // 春节（9 天）
    '2026-04-04', '2026-04-06',        // 清明
    '2026-05-01', '2026-05-05',        // 劳动节
    '2026-06-19', '2026-06-21',        // 端午
    '2026-09-25', '2026-09-27',        // 中秋
    '2026-10-01', '2026-10-07',        // 国庆
  ]) {
    assert.equal(HOLIDAYS.has(key), true, `${key} 应在放假日表里`);
  }
});

test('调休上班表：6 天，且全是周六或周日', () => {
  assert.equal(MAKEUP_WORKDAYS.size, 6);
  for (const key of MAKEUP_WORKDAYS) {
    // 这些是「本该休息却要上班」的日子，所以必然落在周末 ——
    // 若抄进一个工作日，那天的 9:00–12:00 会从「空闲」变成「高峰」，
    // 金额凭空多一倍
    const day = new Date(`${key}T04:00:00Z`).getUTCDay(); // 北京 12:00，避开日界
    assert.ok(day === 0 || day === 6, `${key} 应该是周末，实际是星期 ${day}`);
  }
});

test('两张表不重叠', () => {
  // 同一天既放假又上班是抄写错误的典型形状
  for (const key of MAKEUP_WORKDAYS) {
    assert.equal(HOLIDAYS.has(key), false, `${key} 同时出现在两张表里`);
  }
});
