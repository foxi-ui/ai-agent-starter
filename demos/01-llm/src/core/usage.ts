// 用量与成本：时段判断、单价、账本。
//
// **纯逻辑** —— 不 import 任何 node: 模块、不碰文件系统、不写 stdout/stderr。
// 落盘由 cli 层负责（见 cli/repl.ts），本模块只管「怎么算」。
//
// 与 core/context.ts 一样是纯函数优先；UsageLedger 是个薄类（它持有累积状态，
// 没有别的办法），但它的每一个方法都只碰内存。

import type { TokenUsage } from '@/core/types.ts';

/** 计价档位。高峰 = 官方的高峰时段；空闲 = 其余时间，单价是高峰的一半 */
export type PricingPeriod = 'peak' | 'offpeak';

/**
 * 北京时间相对 UTC 的偏移。
 *
 * 官方口径把高峰窗口定义在**北京时间**上（周一至周五 9:00–12:00 与 14:00–18:00），
 * 所以判断时必须先平移到北京时间。**不用 `getHours()` 之类的本地时间方法** ——
 * 那会读运行机器的时区，同一份账本在 CI（UTC）和开发机（Asia/Shanghai）上
 * 会算出不同的金额。平移后用 `getUTC*` 读，结果与机器时区无关。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 2026 年法定节假日（放假，全天按空闲计价）。
 *
 * 来源：国务院办公厅《关于2026年部分节假日安排的通知》
 * （国办发明电〔2025〕7号，2025-11-04 公布）
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * **这份表会过期**：只有 2026 年。超出范围的时刻退回「只按星期判断」，
 * 并由 /usage 给出提示（见 isOutsideHolidayTable 与 D-M4b-14）。
 * 静默用一张过期表比不用表更糟 —— 2027 年春节会被当成普通工作日按高峰计价，
 * 金额偏高且没有任何迹象。
 */
export const HOLIDAYS: ReadonlySet<string> = new Set([
  // 元旦（3 天）
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节（9 天）
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节（3 天）
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节（5 天）
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节（3 天）
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节（3 天）
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节（7 天）
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]);

/**
 * 2026 年调休上班的周末（按**工作日**计价）。
 *
 * 同一份来源通知。**这张表不能省**：只按「周末即空闲」判断的话，
 * 这 6 天会被算成空闲，而官方口径下它们是工作日 —— 9:00–12:00 与 14:00–18:00
 * 该判高峰。漏掉它，金额会偏低；漏掉 HOLIDAYS，金额会偏高。两张表缺一不可。
 */
export const MAKEUP_WORKDAYS: ReadonlySet<string> = new Set([
  '2026-01-04', // 元旦调休（周日）
  '2026-02-14', // 春节调休（周六）
  '2026-02-28', // 春节调休（周六）
  '2026-05-09', // 劳动节调休（周六）
  '2026-09-20', // 国庆调休（周日）
  '2026-10-10', // 国庆调休（周六）
]);

/** 节假日表覆盖的年份。超出它的记录不按法定节假日扣除（D-M4b-14） */
export const HOLIDAY_TABLE_YEAR = 2026;

/** 一个时刻的北京时间分量：日期键、星期、小时 */
interface BeijingParts {
  /** `YYYY-MM-DD`（北京时间） */
  key: string;
  /** 0 = 周日 … 6 = 周六 */
  day: number;
  /** 0–23 */
  hour: number;
}

/**
 * 把 UTC 时刻折算成北京时间分量。
 *
 * ⚠️ **无效 Date 会在这里被拦住**：`new Date(NaN).toISOString()` 抛
 * `RangeError: Invalid time value`。调用方（periodAt）对无效时刻有明确
 * 约定（按高峰计），所以这里必须先判 NaN 再往下走，不能让它炸出去 ——
 * 一个统计函数不该因为一行被人手改坏的日志而抛错。
 */
function beijingParts(at: Date): BeijingParts | null {
  const t = at.getTime();
  if (Number.isNaN(t)) return null;

  // 平移之后一律用 getUTC* / toISOString 读 —— 得到的就是北京时间分量，
  // 且不受运行机器时区影响
  const bj = new Date(t + BEIJING_OFFSET_MS);
  return {
    key: bj.toISOString().slice(0, 10),
    day: bj.getUTCDay(),
    hour: bj.getUTCHours(),
  };
}

/**
 * 判断一个时刻落在高峰还是空闲档。
 *
 * 官方口径：高峰 = 北京时间周一至周五 9:00–12:00 与 14:00–18:00，
 * 且**不含中国法定节假日**；其余时间（含周末与节假日全天）为空闲。
 *
 * 无效时刻返回 `'peak'` —— 偏高是安全侧（与 M4a 的估算除数取 1.5 同一个
 * 取向：宁可高估）。落盘的 `at` 是我们自己写的，走到这条路径说明文件
 * 被人手改过。
 */
export function periodAt(at: Date): PricingPeriod {
  const parts = beijingParts(at);
  if (parts === null) return 'peak';

  // 节假日优先于星期：国庆可能落在周三，调休的周六要当工作日
  if (HOLIDAYS.has(parts.key)) return 'offpeak';

  const isWorkday =
    (parts.day >= 1 && parts.day <= 5) || MAKEUP_WORKDAYS.has(parts.key);
  if (!isWorkday) return 'offpeak';

  return (parts.hour >= 9 && parts.hour < 12) || (parts.hour >= 14 && parts.hour < 18)
    ? 'peak'
    : 'offpeak';
}

/**
 * 这个时刻是否超出了节假日表的覆盖范围。
 *
 * 用于让「表过期」这件事**可见**：/usage 发现有超范围的记录时会加一行提示。
 * 不这么做的话，2027 年的春节会被静默当成普通工作日按高峰计价。
 *
 * 无效时刻返回 `false` —— 一行坏日志不该顺带触发「表过期」的提示。
 */
export function isOutsideHolidayTable(at: Date): boolean {
  const parts = beijingParts(at);
  if (parts === null) return false;
  return Number(parts.key.slice(0, 4)) !== HOLIDAY_TABLE_YEAR;
}
