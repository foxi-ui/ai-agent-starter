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
 * **已于 2026-09-28 对着上面这份原始通知逐项核对过**：7 个节日的起止日期与
 * 下面 33 个放假日、以及调休表里的 6 天全部吻合。手抄表最怕的就是抄错一位 ——
 * 那会让某一天的金额算反，而且此后没有任何迹象（唯一的自动化保护是
 * `test/usage.test.ts` 里那几条数据自证用例，它们只能查出「形状不对」，
 * 查不出「照着错的通知抄」）。
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
  // ⚠️ **第二个 NaN 出口，别删**：入参合法不代表平移后合法。`t` 若落在
  // Date 的上界附近（`+275760-09-13T00:00:00.000Z` 是最大值），加上 8 小时会
  // 溢出成 Invalid Date，紧接着 `bj.toISOString()` 抛
  // `RangeError: Invalid time value`。只判入参的话，这个错会从一个统计函数里
  // 炸穿 `/usage` 命令、进而崩掉整个 REPL —— 而触发它只需要一行被人手改坏的日志。
  if (Number.isNaN(bj.getTime())) return null;

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

/** 一个模型的单位价（人民币元 / 百万 token） */
export interface ModelPrice {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/**
 * 高峰档单价，人民币元 / 百万 token。
 *
 * 数值来源：`docs/deepseek-api-facts.md`（官方页面 2026-09-28 抓取）。
 * **官方只以人民币计价**，这里不存美元换算值 —— 两个币种并存正是
 * 「混用口径」那个坑的形状。
 *
 * ⚠️ **改动此表必须同步改 `docs/deepseek-api-facts.md`**：
 * `test/pricing.test.ts` 会逐项比对两者，改一处而漏另一处会红。
 */
const PEAK_PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9, output: 27 },
};

/**
 * 退役旧名 → 现名。服务端仍为它们提供服务并按 Flash 计价
 * （见 `docs/deepseek-api-facts.md`「模型」一节）。
 */
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** 空闲档 = 高峰档的一半（官方：「空闲时段价格为高峰时段价格的一半」） */
const OFF_PEAK_RATIO = 0.5;

/**
 * 查一个模型的单位价（**高峰档**）。
 *
 * 无价目返回 `null` —— **绝不猜单价**。`/model <name>` 不校验模型名，
 * 所以账本里完全可能出现一个没有价目的名字；猜出来的数字看起来精确、
 * 实际错误，而用户没有任何线索能看出它是猜的（D-M4b-5）。
 */
export function priceFor(model: string): ModelPrice | null {
  const name = MODEL_ALIASES[model] ?? model;
  return PEAK_PRICES[name] ?? null;
}

/**
 * 算一轮请求的金额（人民币元）；无价目返回 `null`。
 *
 * 三档分开计：命中的输入便宜 50 倍，把它们合并成一个 promptTokens
 * 就再也还原不出金额（D-M4b-6）。
 *
 * `completionTokens` **已含** `reasoningTokens`（官方 usage 里前者是总数、
 * 后者是其中的子集），所以只按 completionTokens 计一次，不重复。
 *
 * @param period 该轮所处的档位，由 `periodAt(entry.at)` 得出
 */
export function costOf(
  usage: TokenUsage,
  model: string,
  period: PricingPeriod,
): number | null {
  const price = priceFor(model);
  if (price === null) return null;

  const ratio = period === 'peak' ? 1 : OFF_PEAK_RATIO;
  return (
    (usage.cachedTokens / 1e6) * price.cacheHit * ratio +
    (usage.cacheMissTokens / 1e6) * price.cacheMiss * ratio +
    (usage.completionTokens / 1e6) * price.output * ratio
  );
}

/**
 * 逐字段相加。
 *
 * 不用 `reduce` 叠对象展开：那样每次迭代都新建一个对象，账本长起来之后
 * 是 O(n) 次分配。这里原地累加一个累加器即可。
 */
export function sumUsage(usages: readonly TokenUsage[]): TokenUsage {
  const total: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
  };

  for (const u of usages) {
    total.promptTokens += u.promptTokens;
    total.completionTokens += u.completionTokens;
    total.totalTokens += u.totalTokens;
    total.cachedTokens += u.cachedTokens;
    total.cacheMissTokens += u.cacheMissTokens;
    total.reasoningTokens += u.reasoningTokens;
  }

  return total;
}

/**
 * 账本里的一条记录：一轮成功请求。
 *
 * 它同时是 JSONL 里 `{ type: 'usage' }` 记录的载荷，所以字段一旦写下
 * 就不能改（旧文件补不回来）。
 */
export interface UsageEntry {
  /**
   * 记账时刻（ISO 8601）。
   *
   * **金额按它来分峰谷**，所以它必须在写记录的那一刻定格并持久化 ——
   * 账本里会同时躺着昨天高峰和今天空闲的记录，用「现在」统一计价
   * 会把其中一半算错，而事后无法回溯补全（D-M4b-13）。
   */
  at: string;
  /** 该轮实际使用的模型（可能是 /model 切换后的） */
  model: string;
  usage: TokenUsage;
  /**
   * 该轮**实际发出去的消息数组**的估算 token 数（M4a 的 estimateTokens 之和，
   * 即 fitToBudget 之后的 keptTokens）。
   *
   * 用于与真实 promptTokens 对比，检验 D-M4a-1 的除数 1.5 是否真的偏保守。
   * 注意它必须是**裁剪后**的估算 —— 用完整历史的估算会得到一个虚高的偏差。
   */
  estimatedPromptTokens: number;
}

/** 账本的合计结果 */
export interface CostBreakdown {
  /** 有价目部分的金额合计（人民币元）。全部无价目时为 0 */
  cny: number;
  /** 有价目部分里，高峰档的金额 */
  peakCny: number;
  /** 有价目部分里，空闲档的金额 */
  offPeakCny: number;
  /** 账本里出现过的、无价目表的模型名（去重，保持首次出现顺序） */
  unpricedModels: string[];
  /** 有价目的轮次数 */
  pricedRounds: number;
}

/** 深拷贝一条记录。`usage` 是嵌套对象，浅展开挡不住穿透写 */
function cloneEntry(entry: UsageEntry): UsageEntry {
  return { ...entry, usage: { ...entry.usage } };
}

/**
 * 进程内的用量账本。
 *
 * **只管内存状态**：落盘由 `cli/repl.ts` 负责（它拿到 entry 后自己调
 * `store.append`）。之所以不给它加 `onChange` 广播（`Session` 是那样做的），
 * 是因为那个机制解决的是「**看不见的写入点**」—— `/clear` 与 `/model` 是
 * `executeCommand` 内部改的状态，`repl` 看不见。而 `record()` 只有一个调用点，
 * 就在 `repl` 的循环里、紧挨着落盘那几行（D-M4b-16）。
 */
export class UsageLedger {
  private entries: UsageEntry[] = [];

  /** @param initial 从 JSONL 回放出的历史记录；新会话传空数组 */
  constructor(initial: UsageEntry[] = []) {
    this.entries = initial.map(cloneEntry);
  }

  /** 记一轮。只应由 repl 在**成功**轮次调用 */
  record(entry: UsageEntry): void {
    this.entries.push(cloneEntry(entry));
  }

  /**
   * 记录列表的**深拷贝**，外部改不动内部状态。
   *
   * 必须是深拷贝而不是 `[...entries]`：`UsageEntry.usage` 是嵌套对象，
   * 浅拷贝下调用方一句 `list[0].usage.promptTokens = 0` 就穿透进来改了账本。
   * 与 `Session.history()` 的处置同理（那里 Message 是扁平的，才只需一层展开）。
   */
  list(): UsageEntry[] {
    return this.entries.map(cloneEntry);
  }

  /** 全部记录的字段级合计 */
  total(): TokenUsage {
    return sumUsage(this.entries.map((e) => e.usage));
  }

  /**
   * 金额合计、峰谷拆分与未定价模型。
   *
   * 逐条用 `entry.at` 判断档位 —— 不是用「现在」。
   */
  cost(): CostBreakdown {
    let cny = 0;
    let peakCny = 0;
    let offPeakCny = 0;
    let pricedRounds = 0;
    const unpricedModels: string[] = [];

    for (const entry of this.entries) {
      const period = periodAt(new Date(entry.at));
      const amount = costOf(entry.usage, entry.model, period);

      if (amount === null) {
        // 不把 null 当 0 混进合计 —— 那会让总额偏低却显示成完整数字
        if (!unpricedModels.includes(entry.model)) {
          unpricedModels.push(entry.model);
        }
        continue;
      }

      pricedRounds += 1;
      cny += amount;
      if (period === 'peak') {
        peakCny += amount;
      } else {
        offPeakCny += amount;
      }
    }

    return { cny, peakCny, offPeakCny, unpricedModels, pricedRounds };
  }

  /** 轮次数 */
  get rounds(): number {
    return this.entries.length;
  }
}
