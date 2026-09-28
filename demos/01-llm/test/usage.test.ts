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

// ⚠️ **把本测试进程锚到 UTC，别删**。
//
// `core/usage.ts` 内部先平移到北京时间再取分量，注释里声称「不受运行机器时区影响」。
// 但开发机通常就在 Asia/Shanghai，本地时间**恰好等于**北京时间 —— 那种情况下
// 把实现里的 `getUTC*` 换成 `getHours()/getDay()`，下面所有断言照样全绿，
// 于是这条契约实际上没有任何测试保护。
//
// 锚成 UTC 之后，本地时间与北京时间差 8 小时，任何一处误用本地时间方法
// 都会立刻把断言打红。下面那条守卫用例负责证明锚定真的生效了
// （与 test/journal.test.ts 锚 Asia/Shanghai 是同一个套路）。
process.env.TZ = 'UTC';
import {
  periodAt,
  isOutsideHolidayTable,
  HOLIDAYS,
  MAKEUP_WORKDAYS,
  HOLIDAY_TABLE_YEAR,
  priceFor,
  costOf,
  sumUsage,
  UsageLedger,
  type UsageEntry,
} from '@/core/usage.ts';
import type { TokenUsage } from '@/core/types.ts';

test('测试进程的时区确实是 UTC —— 否则下面那些断言证明不了什么', () => {
  // 没有这条守卫，`process.env.TZ = 'UTC'` 哪天被删掉或失效了，
  // 整套「不受机器时区影响」的断言会**悄悄退化成同义反复**
  assert.equal(new Date('2026-09-28T01:00:00Z').getHours(), 1);
  assert.notEqual(new Date('2026-09-28T01:00:00Z').getHours(), 9); // 北京时间才 9 点
});

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

test('平移到北京时间后溢出的时刻，按高峰计且不抛错', () => {
  // 入参是**合法** Date，但它是 Date 的上界，+8h 会溢出成 Invalid Date ——
  // 只判入参 NaN 的话，`bj.toISOString()` 会抛 RangeError 从这里炸穿 /usage。
  // 触发它只需要一行被人手改坏的日志（`at` 字段校验只要求是 string）。
  const maxDate = new Date('+275760-09-13T00:00:00.000Z');
  assert.equal(Number.isNaN(maxDate.getTime()), false, '前提：入参本身是合法的');

  assert.equal(periodAt(maxDate), 'peak');
  assert.equal(isOutsideHolidayTable(maxDate), false);
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

// ── 单价与计价 ────────────────────────────────────────────────────────

/** 造一份用量。默认全 0，避免每个用例都写全 6 个字段 */
function usage(fields: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    ...fields,
  };
}

/**
 * 金额比较。
 *
 * 不用 assert.equal：costOf 内部是三个浮点数相加（10⁻³ 量级 ÷ 10⁶），
 * 直接比会有 10⁻¹⁸ 级的表示误差。容差取 1e-9 —— 对 0.004 这个量级来说
 * 足够宽松（能容忍浮点误差），又足够严格（任何真实的计价错误都远大于它）。
 */
function assertMoney(actual: number | null, expected: number): void {
  assert.notEqual(actual, null, '期望有价目，实际得到 null');
  assert.ok(
    Math.abs((actual as number) - expected) < 1e-9,
    `金额不符：实际 ${actual}，期望 ${expected}`,
  );
}

test('priceFor 认两个正式模型', () => {
  assert.deepEqual(priceFor('deepseek-flash'), {
    cacheHit: 0.04,
    cacheMiss: 2,
    output: 8,
  });
  assert.deepEqual(priceFor('deepseek-v4-pro'), {
    cacheHit: 0.30,
    cacheMiss: 9,
    output: 27,
  });
});

test('priceFor 把退役旧名映射到 flash', () => {
  // 服务端仍为这两个名字提供服务并按 Flash 计价
  assert.deepEqual(priceFor('deepseek-v4-flash'), priceFor('deepseek-flash'));
  assert.deepEqual(
    priceFor('deepseek-v4-flash-vision-exp'),
    priceFor('deepseek-flash'),
  );
});

test('priceFor 对未知模型返回 null，不猜单价', () => {
  // 猜一个单价会造出「看起来精确、实际错误」的数字，
  // 而用户没有任何线索能看出它是猜的
  assert.equal(priceFor('gpt-4'), null);
  assert.equal(priceFor(''), null);
});

test('costOf：三档单价各自独立计入', () => {
  // 走 flash 高峰价：cacheHit 0.04 / cacheMiss 2 / output 8（per 1M）
  const cachedOnly = costOf(usage({ cachedTokens: 1_000_000 }), 'deepseek-flash', 'peak');
  assertMoney(cachedOnly, 0.04);

  const missOnly = costOf(usage({ cacheMissTokens: 1_000_000 }), 'deepseek-flash', 'peak');
  assertMoney(missOnly, 2);

  const outputOnly = costOf(usage({ completionTokens: 1_000_000 }), 'deepseek-flash', 'peak');
  assertMoney(outputOnly, 8);
});

test('costOf：空闲档恰好是高峰档的一半', () => {
  const u = usage({
    cachedTokens: 500_000,
    cacheMissTokens: 300_000,
    completionTokens: 200_000,
  });
  const peak = costOf(u, 'deepseek-flash', 'peak') as number;
  const off = costOf(u, 'deepseek-flash', 'offpeak') as number;
  assertMoney(off, peak / 2);
});

test('costOf：命中缓存让输入便宜 50 倍', () => {
  // 同样 100 万输入 token，全命中 vs 全未命中。
  // 断言**比值**而不是两个绝对值 —— 后者与「三档单价各自独立计入」完全重复，
  // 真正要钉的是这个倍数本身（D-M4b-6 选择「分开存」的理由就是它）
  const hit = costOf(usage({ cachedTokens: 1_000_000 }), 'deepseek-flash', 'peak') as number;
  const miss = costOf(usage({ cacheMissTokens: 1_000_000 }), 'deepseek-flash', 'peak') as number;
  assert.ok(
    Math.abs(miss / hit - 50) < 1e-9,
    `未命中/命中 应为 50 倍，实际 ${miss / hit}`,
  );
});

test('costOf：思考 token 已含在 completion 里，不重复计', () => {
  // reasoningTokens 只是 completionTokens 的一个子集标记，不是额外的一档
  const withReasoning = costOf(
    usage({ completionTokens: 1_000_000, reasoningTokens: 800_000 }),
    'deepseek-flash',
    'peak',
  );
  const withoutReasoning = costOf(
    usage({ completionTokens: 1_000_000 }),
    'deepseek-flash',
    'peak',
  );
  assertMoney(withReasoning, withoutReasoning as number);
});

test('costOf：全 0 用量得 0（不是 null）', () => {
  // 「API 没给 usage」与「真的用了 0」是两回事：前者 llm 层会产出全 0，
  // 那是一个真实可能的用量，照常计价
  assertMoney(costOf(usage(), 'deepseek-flash', 'peak'), 0);
});

test('costOf：未知模型返回 null', () => {
  assert.equal(costOf(usage({ completionTokens: 100 }), 'gpt-4', 'peak'), null);
});

test('sumUsage：逐字段相加', () => {
  const a = usage({
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cachedTokens: 60,
    cacheMissTokens: 40,
    reasoningTokens: 3,
  });
  const b = usage({
    promptTokens: 200,
    completionTokens: 20,
    totalTokens: 220,
    cachedTokens: 150,
    cacheMissTokens: 50,
    reasoningTokens: 7,
  });
  assert.deepEqual(sumUsage([a, b]), {
    promptTokens: 300,
    completionTokens: 30,
    totalTokens: 330,
    cachedTokens: 210,
    cacheMissTokens: 90,
    reasoningTokens: 10,
  });
});

test('sumUsage：空数组返回全 0', () => {
  assert.deepEqual(sumUsage([]), usage());
});

test('sumUsage：不修改入参', () => {
  const a = usage({ promptTokens: 100 });
  sumUsage([a]);
  assert.equal(a.promptTokens, 100);
});

// ── UsageLedger ───────────────────────────────────────────────────────

/** 造一条账本记录。默认走 flash + 周一北京 10:00（高峰） */
function entry(fields: Partial<UsageEntry> = {}): UsageEntry {
  return {
    at: '2026-09-28T02:00:00.000Z', // 北京 10:00，周一 → 高峰
    model: 'deepseek-flash',
    usage: usage({ cachedTokens: 1_000_000 }),
    estimatedPromptTokens: 0,
    ...fields,
  };
}

test('空账本：轮次 0、合计全 0、金额全 0', () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.rounds, 0);
  assert.deepEqual(ledger.list(), []);
  assert.deepEqual(ledger.total(), usage());
  assert.deepEqual(ledger.cost(), {
    cny: 0,
    peakCny: 0,
    offPeakCny: 0,
    unpricedModels: [],
    pricedRounds: 0,
  });
});

test('构造时可以铺入历史记录（--resume 用）', () => {
  const ledger = new UsageLedger([entry(), entry()]);
  assert.equal(ledger.rounds, 2);
});

test('record 累加，total 逐字段相加', () => {
  const ledger = new UsageLedger();
  ledger.record(entry({ usage: usage({ promptTokens: 100, cachedTokens: 100 }) }));
  ledger.record(entry({ usage: usage({ promptTokens: 200, cachedTokens: 200 }) }));

  assert.equal(ledger.rounds, 2);
  assert.equal(ledger.total().promptTokens, 300);
  assert.equal(ledger.total().cachedTokens, 300);
});

test('list() 返回深拷贝：改里面的 usage 影响不到账本', () => {
  const ledger = new UsageLedger([entry({ usage: usage({ promptTokens: 100 }) })]);
  const snapshot = ledger.list();
  // 浅拷贝（[...entries]）挡不住这一句 —— UsageEntry.usage 是嵌套对象
  snapshot[0].usage.promptTokens = 999;
  snapshot[0].model = '改过了';

  assert.equal(ledger.list()[0].usage.promptTokens, 100);
  assert.equal(ledger.list()[0].model, 'deepseek-flash');
});

test('record 时也隔绝外部引用', () => {
  const ledger = new UsageLedger();
  const e = entry({ usage: usage({ promptTokens: 100 }) });
  ledger.record(e);
  e.usage.promptTokens = 999;
  assert.equal(ledger.total().promptTokens, 100);
});

test('cost() 按每条记录**当时**的时段计价', () => {
  const ledger = new UsageLedger([
    // 周一北京 10:00 → 高峰
    entry({
      at: '2026-09-28T02:00:00.000Z',
      usage: usage({ cacheMissTokens: 1_000_000 }),
    }),
    // 周一北京 13:00 → 午休，空闲
    entry({
      at: '2026-09-28T05:00:00.000Z',
      usage: usage({ cacheMissTokens: 1_000_000 }),
    }),
  ]);

  const cost = ledger.cost();
  assertMoney(cost.peakCny, 2);    // 2 元/1M（高峰）
  assertMoney(cost.offPeakCny, 1); // 1 元/1M（空闲 = 一半）
  assertMoney(cost.cny, 3);
  assert.equal(cost.pricedRounds, 2);
});

test('cost()：未定价模型单独列出，不混进合计', () => {
  const ledger = new UsageLedger([
    entry({ usage: usage({ cacheMissTokens: 1_000_000 }) }), // 2 元
    entry({ model: 'gpt-4', usage: usage({ cacheMissTokens: 1_000_000 }) }),
  ]);

  const cost = ledger.cost();
  // 关键：合计**只**含有价的那一条。把 null 当 0 会得到一个偏低
  // 却仍然显示成完整数字的总额
  assertMoney(cost.cny, 2);
  assert.deepEqual(cost.unpricedModels, ['gpt-4']);
  assert.equal(cost.pricedRounds, 1);
});

test('cost()：未定价模型去重且保持首次出现顺序', () => {
  const ledger = new UsageLedger([
    entry({ model: 'b-model' }),
    entry({ model: 'a-model' }),
    entry({ model: 'b-model' }),
  ]);
  assert.deepEqual(ledger.cost().unpricedModels, ['b-model', 'a-model']);
});

test('cost()：全部未定价时 cny 为 0 且列表非空', () => {
  const ledger = new UsageLedger([entry({ model: 'unknown-1' })]);
  const cost = ledger.cost();
  assert.equal(cost.cny, 0);
  assert.deepEqual(cost.unpricedModels, ['unknown-1']);
  assert.equal(cost.pricedRounds, 0);
});

test('cost()：at 是坏字符串时按高峰计，不抛错', () => {
  // new Date('坏值').toISOString() 会抛 RangeError —— 一个统计函数
  // 不该因为一行被人手改坏的日志而崩
  const ledger = new UsageLedger([
    entry({ at: '不是日期', usage: usage({ cacheMissTokens: 1_000_000 }) }),
  ]);
  assertMoney(ledger.cost().cny, 2); // 高峰价
});
