# ai-chat M4b（usage 统计 + 成本账本）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/usage` 能回答「这场对话用了多少 token、钱花在哪、按当时峰谷各花了多少」，且账本跨 `--resume` 存活。

**Architecture:** `llm/` 层把末 chunk 的 `usage` 归一化成 `StreamEvent` 的第四个变体（顺序在 `done` 之前）；`repl` 成功轮次把它连同**记账时刻**记进 `UsageLedger` 并追加一行 JSONL；`core/usage.ts` 按「北京时间工作日高峰窗口 + 2026 法定节假日表」判定每条记录该用高峰价还是其一半。`Session` 一行不改 —— 账本不走它的广播（D-M4b-16）。

**Tech Stack:** Node 22（原生 TS 类型擦除，无构建步骤）、pnpm、`node --test`。零运行时依赖，本增量不新增任何 `node:` 之外的 import。

**Spec:** `demos/01-llm/docs/superpowers/specs/2026-09-28-ai-chat-m4b-design.md`（本计划实现其全部内容）

## Global Constraints

- Node ≥ 22（本项目在 **v22.23.2** 验证）；**不引入构建步骤**
- ESM（`"type": "module"`）；包管理器 pnpm；**零运行时依赖**
- 分层单向：`cli → core → llm`；`llm` / `core` **不 import `node:readline` / `node:fs` / `express`**，也不写 `process.stdout` / `process.stderr`
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。判断标准：删掉所有类型标注后仍是合法 JS 的，才能用。`tsc --noEmit` 对它们**放行**，只有运行时才炸
- **只当类型用的导入必须写 `import type`**，否则擦除阶段识别不出来，运行时抛「does not provide an export named …」
- 源码用 `@/` 指向 `src/`；单文件跑测试必须带 loader：`node --import ./loader.mjs --test test/<name>.test.ts`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（会被 `node --test` 当测试跑并计入用例数）
- 所有命令在 `demos/01-llm/` 下执行
- 起点基线：`pnpm test` **206/206 通过**、`pnpm run typecheck` 退出码 0
- 密钥只经环境变量；任何贴出来的输出先做泄漏扫描
- 金额一律**人民币元**，峰值价写死在 `core/usage.ts`；空闲档 = 高峰档 × 0.5

## Review Focus

spec 说了软件**必须**做什么，但没说它遇到下面这些时会怎样 —— 而「spec 没写」不等于「允许崩」。这 5 条是最可能被写错、且写错了不容易被察觉的，每条都在对应任务里钉了测试：

1. **`--resume` 一个含 usage 行的文件，账本必须接上** —— 只看新会话的数字对不算数。旧对话的用量若在恢复时丢失，`/usage` 会给出一个偏小却看不出问题的总数（Task 11）
2. **账本里混进一个没有价目表的模型名** —— 合计绝不能把它当 0 悄悄吞掉，否则总额偏低却显示成一个完整的数字（Task 3）
3. **usage 记录写盘失败（只读目录、磁盘满）** —— 对话必须继续，且与 message 落盘失败**共用**那条「只警告一次」的降级路径（Task 10）
4. **`entry.at` 是个坏字符串**（文件被人手改过）—— `new Date(nan).toISOString()` **会抛 RangeError**，不能让它从一个统计函数里炸出来（Task 1 / Task 3）
5. **`usage` 事件掉进渲染器的 `done` 分支** —— 每轮会多写一个 `AI: `，编译不报、只在输出形状上现形（Task 6）

---

### Task 1: `core/types.ts` 的三个类型 + `core/usage.ts` 的时段判断

`types.ts` 本身没有可测行为（纯类型），所以它与第一个用它的模块合成一个任务。节假日表是**手抄的真实数据**，本任务一并钉住。

**Files:**
- Modify: `demos/01-llm/src/core/types.ts`
- Create: `demos/01-llm/src/core/usage.ts`
- Test: `demos/01-llm/test/usage.test.ts`

**Interfaces:**
- Consumes: `@/core/types.ts` 既有的 `FinishReason`（已存在，不改）
- Produces: `TokenUsage`（6 个 number 字段）；`StreamEvent` 的 `usage` 变体；`ChatResult.usage?: TokenUsage`；`PricingPeriod = 'peak' | 'offpeak'`；`periodAt(at: Date): PricingPeriod`；`isOutsideHolidayTable(at: Date): boolean`；`HOLIDAY_TABLE_YEAR`；`HOLIDAYS` / `MAKEUP_WORKDAYS`（只读 Set）

- [ ] **Step 1: 在 `types.ts` 里加 `TokenUsage`**

在 `FinishReason` 定义**之后**、`StreamEvent` 定义**之前**插入：

```ts
/**
 * 一次请求的 token 用量，来自 API 响应的 `usage` 字段。
 *
 * **命中与未命中的输入刻意分成两个字段**：单价差 50 倍（高峰 ¥0.04 vs ¥2
 * per 1M，见 docs/deepseek-api-facts.md），合并成一个 promptTokens 就再也
 * 还原不出金额 —— 而缓存命中率每轮都不一样，误差方向因此不确定。
 *
 * 所有字段都是**归一化后**的结果：上游缺哪个字段就填 0，不会是 undefined。
 * 归一化的责任在 `llm/deepseek.ts` 的 `toTokenUsage`，不在这里。
 */
export interface TokenUsage {
  /** 输入 token 总数 */
  promptTokens: number;
  /** 输出 token 总数（含思考） */
  completionTokens: number;
  /** 输入 + 输出 */
  totalTokens: number;
  /** 输入中命中 prompt cache 的部分（便宜 50 倍） */
  cachedTokens: number;
  /** 输入中未命中 cache 的部分 */
  cacheMissTokens: number;
  /** completion 中属于 thinking 的部分 */
  reasoningTokens: number;
}
```

- [ ] **Step 2: 在 `StreamEvent` 里加 `usage` 变体，并给 `ChatResult` 加 `usage`**

把 `StreamEvent` 换成（注意注释里替换掉了原先那句「没有 usage 事件…」）：

```ts
/**
 * 流式响应归一化后的事件。
 *
 * llm 层把「DeepSeek/OpenAI 的 SSE chunk」翻译成这四种事件，
 * cli 层只认这四种，不知道 SSE 的存在。
 *
 * **顺序契约**：`usage` 永远**先于** `done` 产出（D-M4b-2）。
 * `done` 是终止信号，消费者见到它可能 break 出循环，之后 yield 的事件
 * 就永远拿不到了 —— usage 先出，保证「收到 done ⇒ 统计已经到手」。
 * 真实响应里两者常常在**同一个**末 chunk 上（usage 不是独立 chunk）。
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; reason: FinishReason };
```

`ChatResult` 加一个字段：

```ts
export interface ChatResult {
  content: string;
  /**
   * 本次请求的用量。API 未返回 `usage` 字段时为 `undefined`
   * （而不是全 0 —— 「没拿到」与「真的是 0」是两回事）。
   */
  usage?: TokenUsage;
}
```

- [ ] **Step 3: 写失败测试**

创建 `demos/01-llm/test/usage.test.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/usage.test.ts
```

Expected: FAIL —— `Cannot find module '@/core/usage.ts'`（文件还没建）

- [ ] **Step 5: 写 `core/usage.ts`（本任务只写时段部分）**

创建 `demos/01-llm/src/core/usage.ts`：

```ts
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
```

> `TokenUsage` 这个 import 在本任务里暂时没用到（计价函数在 Task 2 才写）。**保留它**，TypeScript 的 `verbatimModuleSyntax` 未开启时不会报未使用；Task 2 会立刻用上。

- [ ] **Step 6: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/usage.test.ts
```

Expected: PASS（14 个用例）

- [ ] **Step 7: 全量 typecheck 与测试**

```bash
pnpm run typecheck && pnpm test
```

Expected: typecheck 退出码 0；测试 **220 通过**（206 + 新增 14）

- [ ] **Step 8: 提交**

```bash
git add src/core/types.ts src/core/usage.ts test/usage.test.ts
git commit -m "feat(01-llm): M4b 时段判断 + TokenUsage 类型（含 2026 法定节假日表）"
```

---

### Task 2: `core/usage.ts` —— 单价与计价

**Files:**
- Modify: `demos/01-llm/src/core/usage.ts`（追加）
- Test: `demos/01-llm/test/usage.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `PricingPeriod`、`TokenUsage`
- Produces: `ModelPrice`（`cacheHit` / `cacheMiss` / `output`）；`priceFor(model: string): ModelPrice | null`；`costOf(usage: TokenUsage, model: string, period: PricingPeriod): number | null`；`sumUsage(usages: readonly TokenUsage[]): TokenUsage`

- [ ] **Step 1: 写失败测试**

追加到 `test/usage.test.ts`。先改 import 行：

```ts
import {
  periodAt,
  isOutsideHolidayTable,
  HOLIDAYS,
  MAKEUP_WORKDAYS,
  HOLIDAY_TABLE_YEAR,
  priceFor,
  costOf,
  sumUsage,
} from '@/core/usage.ts';
import type { TokenUsage } from '@/core/types.ts';
```

再追加用例：

```ts
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
  // 同样 100 万输入 token，全命中 vs 全未命中
  const hit = costOf(usage({ cachedTokens: 1_000_000 }), 'deepseek-flash', 'peak') as number;
  const miss = costOf(usage({ cacheMissTokens: 1_000_000 }), 'deepseek-flash', 'peak') as number;
  // 0.04 vs 2 —— 正是 D-M4b-6 选择「分开存」的那个 50 倍
  assertMoney(hit, 0.04);
  assertMoney(miss, 2);
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
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/usage.test.ts
```

Expected: FAIL —— `priceFor is not a function`（或 import 报错）

- [ ] **Step 3: 实现**

追加到 `src/core/usage.ts` 末尾：

```ts
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
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/usage.test.ts
```

Expected: PASS（26 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/usage.ts test/usage.test.ts
git commit -m "feat(01-llm): M4b 计价（高峰/空闲分档 + 未知模型返回 null）"
```

---

### Task 3: `core/usage.ts` —— `UsageLedger`

**Files:**
- Modify: `demos/01-llm/src/core/usage.ts`（追加）
- Test: `demos/01-llm/test/usage.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `periodAt`、Task 2 的 `costOf` / `sumUsage` / `priceFor`、`TokenUsage`
- Produces: `UsageEntry`（`at` / `model` / `usage` / `estimatedPromptTokens`）；`CostBreakdown`（`cny` / `peakCny` / `offPeakCny` / `unpricedModels` / `pricedRounds`）；`class UsageLedger`（`constructor(initial?: UsageEntry[])` / `record` / `list` / `total` / `cost` / `rounds`）

- [ ] **Step 1: 写失败测试**

追加到 `test/usage.test.ts`。import 行加 `UsageLedger`，类型 import 加 `UsageEntry`：

```ts
import {
  // …既有的
  UsageLedger,
} from '@/core/usage.ts';
import type { UsageEntry } from '@/core/usage.ts';
```

追加用例：

```ts
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
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/usage.test.ts
```

Expected: FAIL —— `UsageLedger is not a constructor`

- [ ] **Step 3: 实现**

追加到 `src/core/usage.ts` 末尾：

```ts
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
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/usage.test.ts
```

Expected: PASS（37 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/usage.ts test/usage.test.ts
git commit -m "feat(01-llm): M4b UsageLedger（深拷贝、峰谷拆分、未定价模型单列）"
```

---

### Task 4: `core/context.ts` 的 `keptTokens`

**Files:**
- Modify: `demos/01-llm/src/core/context.ts`
- Test: `demos/01-llm/test/context.test.ts`（追加）

**Interfaces:**
- Produces: `FittedContext.keptTokens: number`（= `total - droppedTokens`，三条返回路径都要填）。Task 10 的 `repl.ts` 用它填 `UsageEntry.estimatedPromptTokens`

- [ ] **Step 1: 写失败测试**

追加到 `test/context.test.ts` 末尾：

```ts
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
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/context.test.ts
```

Expected: FAIL —— `fitted.keptTokens` 是 `undefined`

- [ ] **Step 3: 实现**

`FittedContext` 加字段：

```ts
export interface FittedContext {
  /** 实际要发给模型的消息数组 */
  messages: Message[];
  /** 被丢掉的消息**条数**（不是组数）；未裁剪时为 0 */
  dropped: number;
  /** 被丢掉的那些消息的估算 token 数；未裁剪时为 0 */
  droppedTokens: number;
  /**
   * 保留下来的消息的估算 token 数。
   *
   * 供 M4b 的校准用：它要和 API 返回的真实 `prompt_tokens` 比，而后者
   * 描述的是「这一次实际发出去的东西」—— 所以这里也必须是**裁剪后**的估算。
   */
  keptTokens: number;
}
```

`fitToBudget` 的三条返回路径补上字段：

```ts
  // 快路径：没超预算就原样返回。调用方靠 dropped === 0 判断「要不要警告」，
  // 所以这条路径必须一个字节都不动。
  if (total <= budget) return { messages, dropped: 0, droppedTokens: 0, keptTokens: total };
```

```ts
  // 一组都没丢掉：要么本来就只剩一轮（没有什么可裁），要么超预算的是最后一组
  if (dropped === 0) return { messages, dropped: 0, droppedTokens: 0, keptTokens: total };

  // 丢掉的必然是 index 1 起、连续的一段 —— 分组从 index 1 开始且首尾相接
  return {
    messages: [messages[0], ...messages.slice(1 + dropped)],
    dropped,
    droppedTokens,
    keptTokens: total - droppedTokens,
  };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/context.test.ts && pnpm test
```

Expected: 两条命令都全绿（含既有 206）

- [ ] **Step 5: 提交**

```bash
git add src/core/context.ts test/context.test.ts
git commit -m "feat(01-llm): M4b FittedContext 加 keptTokens（供估算校准）"
```

---

### Task 5: `llm/deepseek.ts` 解析 usage

**Files:**
- Modify: `demos/01-llm/src/llm/deepseek.ts`
- Test: `demos/01-llm/test/deepseek.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `TokenUsage`
- Produces: 流式路径产出 `{ type: 'usage', usage }` 事件（**在 `done` 之前**）；非流式 `chat()` 返回的 `ChatResult` 带 `usage`

- [ ] **Step 1: 写失败测试**

追加到 `test/deepseek.test.ts` 末尾。需要一个新的 helper —— 因为 usage 在 chunk 的**顶层**（不在 `choices[0]` 里），现有的 `deltaChunk` 表达不了：

```ts
/** 末 chunk：同时带 finish_reason 与 usage（真实响应就是这么长的） */
function finalChunkWithUsage(usage: Record<string, unknown>) {
  return {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage,
  };
}

/** 一份完整的官方 usage 形状 */
const fullUsage = {
  prompt_tokens: 1203,
  completion_tokens: 456,
  total_tokens: 1659,
  prompt_tokens_details: {
    prompt_cache_hit_tokens: 1024,
    prompt_cache_miss_tokens: 179,
  },
  completion_tokens_details: { reasoning_tokens: 120 },
};
```

```ts
// ── usage 解析（M4b） ─────────────────────────────────────────────────

test('流式：末 chunk 的 usage 产出 usage 事件，且排在 done 之前', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(sseChunk(deltaChunk({ content: '你好' }))),
      enc.encode(sseChunk(finalChunkWithUsage(fullUsage))),
    ]),
  );

  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));

  // **断言整个序列**，不是分别断言「有 usage」「有 done」——
  // 后者在顺序反了的时候照样通过，而顺序正是契约（D-M4b-2）：
  // 消费者见到 done 可能 break，usage 必须在它之前到手
  assert.deepEqual(
    events.map((e) => e.type),
    ['text-delta', 'usage', 'done'],
  );
  assert.deepEqual(events[1], {
    type: 'usage',
    usage: {
      promptTokens: 1203,
      completionTokens: 456,
      totalTokens: 1659,
      cachedTokens: 1024,
      cacheMissTokens: 179,
      reasoningTokens: 120,
    },
  });
});

test('流式：usage 与 done 在同一个 chunk 上也保持 usage 在前', async () => {
  // 真实响应里两者就长在一起 —— 这个用例才是常态
  mockFetch(async () =>
    sseResponse([enc.encode(sseChunk(finalChunkWithUsage(fullUsage)))]),
  );
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  assert.deepEqual(events.map((e) => e.type), ['usage', 'done']);
});

test('流式：响应没有 usage 时不产出 usage 事件', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(sseChunk(deltaChunk({ content: '你好' }))),
      enc.encode(sseChunk(deltaChunk({}, 'stop'))),
    ]),
  );
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  assert.deepEqual(events.map((e) => e.type), ['text-delta', 'done']);
});

test('流式：usage 字段缺失时全部填 0，不抛错', async () => {
  mockFetch(async () => sseResponse([enc.encode(sseChunk(finalChunkWithUsage({})))]));
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  const usageEvent = events.find((e) => e.type === 'usage');
  assert.ok(usageEvent);
  assert.deepEqual(usageEvent.usage, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
  });
});

test('流式：只有 cached_tokens（没有 prompt_cache_hit_tokens）时回落', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(
          finalChunkWithUsage({
            prompt_tokens: 1000,
            completion_tokens: 10,
            total_tokens: 1010,
            prompt_tokens_details: { cached_tokens: 800 },
          }),
        ),
      ),
    ]),
  );
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  const usageEvent = events.find((e) => e.type === 'usage');
  assert.ok(usageEvent);
  assert.equal(usageEvent.usage.cachedTokens, 800);
  // 未命中由 prompt_tokens - 命中 推出
  assert.equal(usageEvent.usage.cacheMissTokens, 200);
});

test('流式：命中数大于输入总数时，未命中不为负', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(
          finalChunkWithUsage({
            prompt_tokens: 100,
            prompt_tokens_details: { prompt_cache_hit_tokens: 500 },
          }),
        ),
      ),
    ]),
  );
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  const usageEvent = events.find((e) => e.type === 'usage');
  assert.ok(usageEvent);
  // 负金额比金额偏差难查得多
  assert.equal(usageEvent.usage.cacheMissTokens, 0);
});

test('流式：total_tokens 缺失时由输入 + 输出补齐', async () => {
  mockFetch(async () =>
    sseResponse([
      enc.encode(
        sseChunk(
          finalChunkWithUsage({ prompt_tokens: 100, completion_tokens: 20 }),
        ),
      ),
    ]),
  );
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  const usageEvent = events.find((e) => e.type === 'usage');
  assert.ok(usageEvent);
  assert.equal(usageEvent.usage.totalTokens, 120);
});

test('流式：usage 字段类型不对（字符串）时全部填 0，不抛错', async () => {
  mockFetch(async () => sseResponse([enc.encode(sseChunk(finalChunkWithUsage('nope' as never)))]));
  const client = createDeepSeekClient(config);
  const events = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  const usageEvent = events.find((e) => e.type === 'usage');
  assert.ok(usageEvent);
  assert.equal(usageEvent.usage.promptTokens, 0);
});

test('流式：请求体不带 stream_options', async () => {
  // 官方口径：不传它时 usage 也出现在最后一个 chunk 上。
  // 这条钉住「最小请求体」原则，也是本设计唯一待实测验证的前提
  let capturedInit: Parameters<typeof fetch>[1] | undefined;
  mockFetch(async (_url, init) => {
    capturedInit = init;
    return sseResponse([enc.encode(sseChunk(finalChunkWithUsage(fullUsage)))]);
  });
  const client = createDeepSeekClient(config);
  await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
  const body = JSON.parse(String(capturedInit!.body));
  assert.equal(body.stream_options, undefined);
});

// ── 非流式路径的 usage ────────────────────────────────────────────────

test('chat()：解析 usage', async () => {
  mockFetch(async () =>
    jsonResponse({
      choices: [{ message: { role: 'assistant', content: '你好' } }],
      usage: fullUsage,
    }),
  );
  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);

  assert.equal(result.content, '你好');
  assert.deepEqual(result.usage, {
    promptTokens: 1203,
    completionTokens: 456,
    totalTokens: 1659,
    cachedTokens: 1024,
    cacheMissTokens: 179,
    reasoningTokens: 120,
  });
});

test('chat()：响应没有 usage 时是 undefined（不是全 0）', async () => {
  // 「没拿到」与「真的是 0」是两回事，契约里写的是 undefined
  mockFetch(async () =>
    jsonResponse({ choices: [{ message: { role: 'assistant', content: '你好' } }] }),
  );
  const client = createDeepSeekClient(config);
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(result.usage, undefined);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/deepseek.test.ts
```

Expected: FAIL —— 找不到 `usage` 事件 / `result.usage` 是 undefined

- [ ] **Step 3: 实现**

在 `thinkingField` 之后加归一化函数：

```ts
/** 数字字段的防御式读取：不是有限数就取 0 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 把 API 的 usage 对象归一化成 TokenUsage。
 *
 * **永不抛错**：任何字段缺失、类型不对、整个对象不存在，都退回 0 ——
 * 统计拿不到不该毁掉一轮对话。
 *
 * 字段名取**防御式策略**：官方未文档化 `prompt_tokens_details` 的确切形状
 * （见 `docs/deepseek-api-facts.md` 末尾「官方未给出错误响应体的字段名，
 * 解析须防御式处理」），所以两个候选名都试：
 *
 * - 命中：`prompt_cache_hit_tokens` → `cached_tokens` → 0
 * - 未命中：`prompt_cache_miss_tokens` → `promptTokens - 命中` → 0
 * - 总数：`total_tokens` → `promptTokens + completionTokens`
 *
 * 未命中那一档要取 `Math.max(0, …)`：上游若给出「命中数 > 输入总数」，
 * 相减会得到负数，而负金额比金额偏差难查得多。
 */
function toTokenUsage(raw: unknown): TokenUsage {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const promptTokens = num(source.prompt_tokens);
  const completionTokens = num(source.completion_tokens);

  const promptDetails = (
    typeof source.prompt_tokens_details === 'object' && source.prompt_tokens_details !== null
      ? source.prompt_tokens_details
      : {}
  ) as Record<string, unknown>;

  const cachedTokens =
    promptDetails.prompt_cache_hit_tokens !== undefined
      ? num(promptDetails.prompt_cache_hit_tokens)
      : num(promptDetails.cached_tokens);

  const cacheMissTokens =
    promptDetails.prompt_cache_miss_tokens !== undefined
      ? num(promptDetails.prompt_cache_miss_tokens)
      : Math.max(0, promptTokens - cachedTokens);

  const completionDetails = (
    typeof source.completion_tokens_details === 'object' &&
    source.completion_tokens_details !== null
      ? source.completion_tokens_details
      : {}
  ) as Record<string, unknown>;

  return {
    promptTokens,
    completionTokens,
    totalTokens:
      source.total_tokens !== undefined
        ? num(source.total_tokens)
        : promptTokens + completionTokens,
    cachedTokens,
    cacheMissTokens,
    reasoningTokens: num(completionDetails.reasoning_tokens),
  };
}
```

流式路径：把 payload 的类型声明加 `usage`，并在 `done` **之前** yield。改这两处：

```ts
            let payload: {
              choices?: Array<{
                delta?: { content?: string | null; reasoning_content?: string | null };
                finish_reason?: string | null;
              }>;
              usage?: unknown;
            };
```

```ts
            // 同一个 chunk 可能同时带内容和 finish_reason，所以逐个字段判定，
            // 不是 switch 整个 chunk。顺序也要紧：正文 → **usage** → done。
            //
            // usage 必须在 done 之前：done 是终止信号，消费者见到它可能 break，
            // 之后 yield 的就永远拿不到了。真实响应里两者在同一个末 chunk 上，
            // 所以这个顺序不是理论问题（D-M4b-2）。
            if (delta?.reasoning_content) {
              yield { type: 'reasoning-delta', text: delta.reasoning_content };
            }
            if (delta?.content) {
              yield { type: 'text-delta', text: delta.content };
            }
            if (payload.usage !== undefined) {
              yield { type: 'usage', usage: toTokenUsage(payload.usage) };
            }
            if (choice?.finish_reason && !doneEmitted) {
              doneEmitted = true;
              // 宽松处理：服务端新增取值时原样传出，不做白名单校验
              yield { type: 'done', reason: choice.finish_reason as FinishReason };
            }
```

非流式路径：类型声明加 `usage?: unknown`，返回值带上它：

```ts
      const data = (await response.json()) as {
        choices: Array<{ message?: { content?: string } }>;
        usage?: unknown;
      };
```

```ts
      const content = data.choices[0]?.message?.content ?? '';
      // 「没拿到」与「真的是 0」是两回事：API 没给 usage 时保持 undefined，
      // 由调用方决定怎么显示（见 core/types.ts 的 ChatResult）
      const usage = data.usage === undefined ? undefined : toTokenUsage(data.usage);
      return { content, usage };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/deepseek.test.ts && pnpm test
```

Expected: 两条命令都全绿

- [ ] **Step 5: 提交**

```bash
git add src/llm/deepseek.ts test/deepseek.test.ts
git commit -m "feat(01-llm): M4b 解析 usage（防御式归一化，事件先于 done）"
```

---

### Task 6: `cli/render.ts` 显式忽略 usage 事件 ⚠️ 必须紧跟 Task 5

**从 Task 5 起，usage 事件会掉进渲染器那个隐式的 `done` 分支，每轮多写一个 `AI: `。** 编译不报、只在输出形状上现形，所以这一步不能拖。

**Files:**
- Modify: `demos/01-llm/src/cli/render.ts`
- Test: `demos/01-llm/test/render.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `StreamEvent` 的 `usage` 变体
- Produces: `createStreamRenderer(...).onEvent` 对 usage 事件**无任何输出**

- [ ] **Step 1: 写失败测试**

先看 `test/render.test.ts` 现有的注入两条流的写法，照它加。追加：

```ts
// ── usage 事件（M4b） ─────────────────────────────────────────────────

test('usage 事件不产生任何输出', () => {
  // 这条测的是一个**安静的**错误：渲染器的最后一个分支是隐式的 done，
  // 加了 usage 变体之后它会掉进去，写出一个空的 `AI: ` 前缀 ——
  // 屏幕上多一行、重定向到文件里也多一行，而没有任何报错。
  //
  // 用量是用户敲 /usage 才看的东西，不该混进 stdout（D-M4b-7）。
  const { out, err, renderer } = setup();

  renderer.onEvent({
    type: 'usage',
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cachedTokens: 5,
      cacheMissTokens: 5,
      reasoningTokens: 2,
    },
  });
  renderer.finish();

  // out.chunks / err.chunks 是本文件既有 collector() 的形状
  assert.deepEqual(out.chunks, []);
  assert.deepEqual(err.chunks, []);
});

test('usage 夹在正文与 done 之间时，正文与前缀不受影响', () => {
  const { out, err, renderer } = setup();

  const u = {
    promptTokens: 1, completionTokens: 1, totalTokens: 2,
    cachedTokens: 0, cacheMissTokens: 1, reasoningTokens: 0,
  };
  renderer.onEvent({ type: 'text-delta', text: '你好' });
  renderer.onEvent({ type: 'usage', usage: u });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  // `AI: ` 前缀只写一次；usage 事件不额外产生前缀
  assert.equal(out.chunks.join(''), 'AI: 你好\n');
  assert.deepEqual(err.chunks, []);
});
```

> `setup()` 与 `collector()` 是本文件既有的辅助：`collector()` 返回 `{ chunks, stream }`，`setup(showReasoning?)` 返回 `{ out, err, renderer }`。上面用的就是它们。

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/render.test.ts
```

Expected: FAIL —— `out` 是 `['AI: ', '\n']`（usage 掉进了 done 分支）

- [ ] **Step 3: 实现**

在 `onEvent` 里，`text-delta` 分支之后、`done` 之前插入：

```ts
      if (event.type === 'usage') {
        // **必须显式写出来，不能靠 fallthrough。**
        //
        // 这个 if 链的最后一个分支是隐式的 done（「走到这里的一定是 done」），
        // 加了 usage 变体之后那句话不再成立 —— 不拦它的话每个末 chunk 都会
        // 掉进 done 分支，多写一个 `AI: ` 前缀，且 finish_reason 的截断判断
        // 会读到 undefined。这个错误编译不报、只在输出形状上现形。
        //
        // 用量由 /usage 按需展示，不往 stdout 里插（D-M4b-7）。
        return;
      }
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/render.test.ts && pnpm test
```

Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/cli/render.ts test/render.test.ts
git commit -m "fix(01-llm): M4b 渲染器显式忽略 usage 事件（原本会掉进 done 分支）"
```

---

### Task 7: `core/journal.ts` —— usage 记录的落盘契约

**Files:**
- Modify: `demos/01-llm/src/core/journal.ts`
- Test: `demos/01-llm/test/journal.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的 `UsageEntry`
- Produces: `SessionChange` 的 `usage` 变体；`parseRecord` 对该变体的逐字段校验；`replay` 返回值新增 `usageEntries: UsageEntry[]`

- [ ] **Step 1: 写失败测试**

追加到 `test/journal.test.ts`：

```ts
// ── usage 记录（M4b） ─────────────────────────────────────────────────

/** 一份合法的 usage 记录载荷 */
const usageEntry = {
  at: '2026-09-28T02:00:00.000Z',
  model: 'deepseek-flash',
  usage: {
    promptTokens: 1203,
    completionTokens: 456,
    totalTokens: 1659,
    cachedTokens: 1024,
    cacheMissTokens: 179,
    reasoningTokens: 120,
  },
  estimatedPromptTokens: 1180,
};

test('usage 记录的两向格式契约', () => {
  const record = { type: 'usage' as const, entry: usageEntry };
  const line = serializeRecord(record);
  assert.deepEqual(parseRecord(line), record);
});

test('usage 记录缺字段时当坏行跳过', () => {
  // 文件内容不可信（可能被手改），每个字段都要校验
  const bad = [
    { type: 'usage' },                                        // 缺 entry
    { type: 'usage', entry: { ...usageEntry, at: 1 } },       // at 不是 string
    { type: 'usage', entry: { ...usageEntry, model: null } }, // model 不是 string
    { type: 'usage', entry: { ...usageEntry, estimatedPromptTokens: 'x' } },
    { type: 'usage', entry: { ...usageEntry, usage: 'nope' } },
    {
      type: 'usage',
      entry: { ...usageEntry, usage: { ...usageEntry.usage, promptTokens: 'x' } },
    },
    {
      type: 'usage',
      entry: { ...usageEntry, usage: { ...usageEntry.usage, reasoningTokens: undefined } },
    },
  ];
  for (const record of bad) {
    assert.equal(parseRecord(JSON.stringify(record)), null, `${JSON.stringify(record)} 应被拒`);
  }
});

test('replay 折叠出 usageEntries', () => {
  const records: SessionRecord[] = [
    { type: 'meta', id: '20260928-100000-abcd', createdAt: 'x', model: 'deepseek-flash' },
    { type: 'message', role: 'user', content: '你好' },
    { type: 'usage', entry: usageEntry },
    { type: 'message', role: 'assistant', content: '你也好' },
  ];
  const replayed = replay(records);
  assert.equal(replayed.messages.length, 2);
  assert.deepEqual(replayed.usageEntries, [usageEntry]);
});

test('clear 清消息但**不清**账本', () => {
  // 这条最容易被后人「顺手一起清掉」。账本记的是「这个会话文件累计花了多少」，
  // 钱已经花掉了，/clear 清的是对话内容（D-M4b-15）
  const records: SessionRecord[] = [
    { type: 'meta', id: 'id', createdAt: 'x', model: 'm' },
    { type: 'message', role: 'user', content: 'a' },
    { type: 'usage', entry: usageEntry },
    { type: 'clear' },
    { type: 'message', role: 'user', content: 'b' },
  ];
  const replayed = replay(records);
  assert.equal(replayed.messages.length, 1);       // 只剩 clear 之后那条
  assert.deepEqual(replayed.usageEntries, [usageEntry]); // 账本原封不动
});

test('旧文件（没有 usage 行）回放出空账本', () => {
  const replayed = replay([
    { type: 'meta', id: 'id', createdAt: 'x', model: 'm' },
    { type: 'message', role: 'user', content: 'a' },
  ]);
  assert.deepEqual(replayed.usageEntries, []);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/journal.test.ts
```

Expected: FAIL —— `usageEntries` 是 undefined / `parseRecord` 对 usage 返回 null

- [ ] **Step 3: 实现**

顶部 import 加：

```ts
import type { UsageEntry } from '@/core/usage.ts';
```

`SessionChange` 加变体：

```ts
export type SessionChange =
  | { type: 'message'; role: Role; content: string }
  | { type: 'clear' }
  | { type: 'model'; model: string }
  /**
   * 账本记录。
   *
   * **唯一一个不由 `Session` 广播的变体** —— 账本不是会话消息的一部分，
   * 由 `repl` 在成功轮次直接交给 store（D-M4b-16）。放进这个联合是为了让
   * `store.append` 的签名不必放宽，不是因为它真的属于「会话状态」。
   */
  | { type: 'usage'; entry: UsageEntry };
```

同时更新 `SessionChange` 上方那段注释的最后一句，点明这个例外。

`parseRecord` 的 switch 里、`case 'model'` 之后加：

```ts
    case 'usage': {
      const entry = record.entry;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
      const e = entry as Record<string, unknown>;

      if (typeof e.at !== 'string' || typeof e.model !== 'string') return null;
      if (typeof e.estimatedPromptTokens !== 'number') return null;
      if (typeof e.usage !== 'object' || e.usage === null || Array.isArray(e.usage)) return null;

      const u = e.usage as Record<string, unknown>;
      const numbers = [
        'promptTokens',
        'completionTokens',
        'totalTokens',
        'cachedTokens',
        'cacheMissTokens',
        'reasoningTokens',
      ];
      // 六个字段一个都不能少、都必须是数字 —— 缺一个就让整条记录当坏行跳过，
      // 而不是补 0 混过去：补 0 会让金额静默偏低，而坏行至少会被计数报出来
      for (const key of numbers) {
        if (typeof u[key] !== 'number') return null;
      }

      return {
        type: 'usage',
        entry: {
          at: e.at,
          model: e.model,
          usage: {
            promptTokens: u.promptTokens as number,
            completionTokens: u.completionTokens as number,
            totalTokens: u.totalTokens as number,
            cachedTokens: u.cachedTokens as number,
            cacheMissTokens: u.cacheMissTokens as number,
            reasoningTokens: u.reasoningTokens as number,
          },
          estimatedPromptTokens: e.estimatedPromptTokens,
        },
      };
    }
```

`replay` 加累加：

```ts
export function replay(records: SessionRecord[]): {
  messages: Message[];
  model: string | null;
  usageEntries: UsageEntry[];
} {
  const messages: Message[] = [];
  let model: string | null = null;
  // 账本独立于 messages —— `clear` 清前者不清它（D-M4b-15）
  const usageEntries: UsageEntry[] = [];

  for (const record of records) {
    switch (record.type) {
      // …既有三个 case 不变

      case 'usage':
        usageEntries.push(record.entry);
        break;
    }
  }

  return { messages, model, usageEntries };
}
```

并在 `case 'clear'` 的处理里补一句注释：

```ts
      case 'clear':
        // **只清消息、不清模型、也不清账本**。
        //
        // 模型：`/clear` 清的是对话内容，不是会话配置（与 Session.clear() 对齐）。
        // 账本：记的是「这个会话文件累计花了多少」，钱已经花掉了，与消息内容无关
        //   （D-M4b-15）。顺手清掉会让 /usage 与账单对不上，而且这个改动
        //   看起来非常「对称」、非常容易被后人做出来 —— 所以测试专门钉了它。
        messages.length = 0;
        break;
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/journal.test.ts && pnpm test
```

Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/core/journal.ts test/journal.test.ts
git commit -m "feat(01-llm): M4b 日志新增 usage 记录（逐字段校验 + 回放；clear 不清账本）"
```

---

### Task 8: `core/commands.ts` 的 `/usage`

**Files:**
- Modify: `demos/01-llm/src/core/commands.ts`
- Test: `demos/01-llm/test/commands.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的 `UsageLedger` / `UsageEntry` / `CostBreakdown`、Task 1 的 `TokenUsage`
- Produces: `CommandName` 加 `'usage'`；`CommandDeps.ledger`；`CommandResult` 加 `{ kind: 'usage'; entries; total; cost }`

- [ ] **Step 1: 写失败测试**

追加到 `test/commands.test.ts`。注意 `CommandDeps` 现在需要 `ledger`，**既有用例的 deps 构造处要一并补上**（用一个空的 `new UsageLedger()`）：

```ts
// ── /usage（M4b） ─────────────────────────────────────────────────────

test('parseCommand 认识 /usage', () => {
  assert.deepEqual(parseCommand('/usage'), {
    kind: 'known',
    name: 'usage',
    argument: '',
  });
});

test('/usage 空账本返回空结果', () => {
  const ledger = new UsageLedger();
  const result = executeCommand('usage', '', session, {
    store,
    currentSessionId: 'id',
    ledger,
  });

  assert.equal(result.kind, 'usage');
  if (result.kind !== 'usage') return;
  assert.deepEqual(result.entries, []);
  assert.equal(result.total.promptTokens, 0);
  assert.equal(result.cost.cny, 0);
});

test('/usage 返回账本内容', () => {
  const entry = {
    at: '2026-09-28T02:00:00.000Z',
    model: 'deepseek-flash',
    usage: {
      promptTokens: 100, completionTokens: 20, totalTokens: 120,
      cachedTokens: 60, cacheMissTokens: 40, reasoningTokens: 5,
    },
    estimatedPromptTokens: 95,
  };
  const ledger = new UsageLedger([entry]);
  const result = executeCommand('usage', '', session, {
    store, currentSessionId: 'id', ledger,
  });

  assert.equal(result.kind, 'usage');
  if (result.kind !== 'usage') return;
  assert.deepEqual(result.entries, [entry]);
  assert.equal(result.total.promptTokens, 100);
});

test('/usage 是只读的：不写会话', () => {
  // 与 /model 的查询分支同一处置 —— 查询不该有副作用
  const writes: unknown[] = [];
  const probe = new Session('deepseek-flash', {
    onChange: (change) => writes.push(change),
  });
  const ledger = new UsageLedger();

  executeCommand('usage', '', probe, { store, currentSessionId: 'id', ledger });

  assert.equal(writes.length, 0);
});

test('/usage 忽略多余参数', () => {
  const result = executeCommand('usage', 'foo bar', session, {
    store, currentSessionId: 'id', ledger: new UsageLedger(),
  });
  assert.equal(result.kind, 'usage');
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/commands.test.ts
```

Expected: FAIL —— `parseCommand('/usage')` 返回 `{ kind: 'unknown' }`

- [ ] **Step 3: 实现**

import 加：

```ts
import type { UsageEntry, UsageLedger, CostBreakdown } from '@/core/usage.ts';
import type { TokenUsage } from '@/core/types.ts';
```

命令名与列表：

```ts
export type CommandName = 'clear' | 'history' | 'model' | 'sessions' | 'usage';

export const COMMAND_NAMES: readonly CommandName[] = [
  'clear',
  'history',
  'model',
  'sessions',
  'usage',
];
```

`CommandDeps` 加字段：

```ts
export interface CommandDeps {
  store: SessionStore;
  /** 当前会话的 id，用于在 /sessions 列表里打 * 标记 */
  currentSessionId: string;
  /** 用量账本。core 不落盘、不读文件，所以由调用方注入（与 store 同一套路） */
  ledger: UsageLedger;
}
```

`CommandResult` 加变体：

```ts
  | {
      kind: 'usage';
      /** 账本内容（已按 /usage 需要的顺序排好） */
      entries: UsageEntry[];
      /** 字段级合计 */
      total: TokenUsage;
      /** 金额合计、峰谷拆分与未定价模型 */
      cost: CostBreakdown;
    };
```

`executeCommand` 加 case（放在 `case 'sessions'` 之后）：

```ts
    case 'usage':
      // 纯查询：不写 session、不广播、不动账本。
      // 参数被忽略 —— 与 /history 的处置一致
      return {
        kind: 'usage',
        entries: deps.ledger.list(),
        total: deps.ledger.total(),
        cost: deps.ledger.cost(),
      };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/commands.test.ts && pnpm test
```

Expected: 全绿（`repl.ts` 里那个 `executeCommand` 调用点暂时会因为缺 `ledger` 而类型报错 —— 若 `pnpm run typecheck` 报出来，先补一个 `ledger: new UsageLedger()` 并在 Task 10 换成真实的那个）

- [ ] **Step 5: 提交**

```bash
git add src/core/commands.ts test/commands.test.ts
git commit -m "feat(01-llm): M4b /usage 命令（只读查询）"
```

---

### Task 9: `cli/render.ts` 渲染 `/usage` 表格

**Files:**
- Modify: `demos/01-llm/src/cli/render.ts`
- Test: `demos/01-llm/test/render.test.ts`（追加）

**Interfaces:**
- Consumes: Task 8 的 `CommandResult` 的 `usage` 变体、Task 1 的 `periodAt`、Task 2 的 `costOf`
- Produces: `renderCommandResult` 对 `usage` 的渲染；模块内私有 `displayWidth` / `group` / `formatAmount`

- [ ] **Step 1: 写失败测试**

追加到 `test/render.test.ts`：

```ts
// ── /usage 渲染（M4b） ────────────────────────────────────────────────

/** 渲染一个 /usage 结果，把 stdout 拼成整串 */
function renderUsage(entries: UsageEntry[]): string {
  const ledger = new UsageLedger(entries);
  const out = collector();
  renderCommandResult(
    { kind: 'usage', entries: ledger.list(), total: ledger.total(), cost: ledger.cost() },
    { output: out.stream },
  );
  return out.chunks.join('');
}

const sampleEntry = (fields: Partial<UsageEntry> = {}): UsageEntry => ({
  at: '2026-09-28T02:00:00.000Z', // 周一北京 10:00 → 高峰
  model: 'deepseek-flash',
  usage: {
    promptTokens: 1203, completionTokens: 456, totalTokens: 1659,
    cachedTokens: 1024, cacheMissTokens: 179, reasoningTokens: 120,
  },
  estimatedPromptTokens: 1180,
  ...fields,
});

test('/usage 空账本给出提示，且包含「范围」那行', () => {
  const text = renderUsage([]);
  assert.match(text, /本会话还没有用量记录/);
  // 这行是 D-M4b-8 的硬要求：让「账本覆盖哪些记录」这件事自己说出来
  assert.match(text, /范围：本会话的全部记录/);
});

test('/usage 表格含表头、数据行与合计行', () => {
  const text = renderUsage([sampleEntry()]);
  assert.match(text, /模型/);
  assert.match(text, /命中缓存/);
  assert.match(text, /合计/);
  assert.match(text, /deepseek-flash/);
  assert.match(text, /1,203/); // 千分位
  assert.match(text, /高峰/);
});

test('/usage 表头与数据行的显示宽度一致（中文占 2 列）', () => {
  // padEnd 按 UTF-16 码元算的话，含中文的表头会比数据行短一截，
  // 终端里看就是错位的
  const lines = renderUsage([sampleEntry()]).split('\n');
  const headerLine = lines.find((l) => l.includes('模型'))!;
  const dataLine = lines.find((l) => l.includes('deepseek-flash'))!;

  const width = (s: string): number => {
    let w = 0;
    // 与实现同一个近似：CJK 统一表意文字算 2 列
    for (const ch of s) w += /[一-鿿]/.test(ch) ? 2 : 1;
    return w;
  };
  assert.equal(width(headerLine), width(dataLine));
});

test('/usage 金额保留 5 位小数', () => {
  // 1024/1e6*0.04 + 179/1e6*2 + 456/1e6*8 = 0.00404696
  assert.match(renderUsage([sampleEntry()]), /¥0\.00405/);
});

test('/usage 未定价模型的费用显示为 —，并单列一行', () => {
  const text = renderUsage([sampleEntry({ model: 'gpt-4' })]);
  assert.match(text, /—/);
  assert.match(text, /未定价模型/);
  assert.doesNotMatch(text, /¥0\.00000/); // 绝不能把 null 当 0
});

test('/usage 输出含口径行', () => {
  assert.match(renderUsage([sampleEntry()]), /口径：.*高峰.*空闲/);
});

test('/usage 有超出节假日表范围的记录时给出提示', () => {
  assert.match(
    renderUsage([sampleEntry({ at: '2027-01-04T02:00:00.000Z' })]),
    /节假日表只覆盖 2026/,
  );
});

test('/usage 全是 2026 的记录时不出现过期提示', () => {
  assert.doesNotMatch(renderUsage([sampleEntry()]), /节假日表只覆盖/);
});
```

> import 处补 `UsageLedger`、`type UsageEntry`。

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/render.test.ts
```

Expected: FAIL —— `renderCommandResult` 的 `default` 分支把 `usage` 当成 never 报错（编译期），或输出为空

- [ ] **Step 3: 实现**

import 加：

```ts
import { periodAt, costOf, isOutsideHolidayTable, HOLIDAY_TABLE_YEAR } from '@/core/usage.ts';
```

在 `formatSessionTime` 之后加三个私有辅助：

```ts
/**
 * 一个字符在终端里占几列。
 *
 * 汉字、全角标点在等宽终端里占 **2 列**，而 `String.length` 把它们算作 1 ——
 * 所以用 `padEnd` 对齐中文表头一定会错位。
 *
 * ⚠️ **这不是一个通用的 Unicode 宽度实现**，只覆盖本项目表头用到的那几个词
 * （模型 / 时段 / 输入 / 命中缓存 / 输出 / 思考 / 费用）。别拿它去处理 emoji、
 * 组合字形或其它东亚文字。
 */
const WIDE_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿＀-｠￠-￦]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

/** 按**显示宽度**右侧补空格 */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 千分位。
 *
 * **不用 `toLocaleString`** —— 它依赖 ICU 构建，同一份输入在不同 Node
 * 构建上可能得到不同结果，测试会跟着飘。这个三行实现结果恒定。
 */
function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金额 → `¥0.00405`；无价目 → `—`（不是 ¥0.00000） */
function formatAmount(cny: number | null): string {
  return cny === null ? '—' : `¥${cny.toFixed(5)}`;
}
```

`renderCommandResult` 的 switch 里加一个 case（放在 `case 'sessions'` 之后、`default` 之前）：

```ts
    case 'usage': {
      write(`本会话用量（${result.entries.length} 轮）`);

      if (result.entries.length === 0) {
        write('本会话还没有用量记录。');
        write('范围：本会话的全部记录，含 --resume 恢复的历史。');
        return;
      }

      // 逐行算好，再统一算列宽 —— 表头也要参与，否则中文表头会窄一截
      const rows = result.entries.map((entry, index) => {
        const period = periodAt(new Date(entry.at));
        return [
          String(index + 1),
          entry.model,
          period === 'peak' ? '高峰' : '空闲',
          group(entry.usage.promptTokens),
          group(entry.usage.cachedTokens),
          group(entry.usage.completionTokens),
          group(entry.usage.reasoningTokens),
          formatAmount(costOf(entry.usage, entry.model, period)),
        ];
      });

      const headers = ['#', '模型', '时段', '输入', '命中缓存', '输出', '思考', '费用'];

      // 合计行：前两列留空（不填模型与时段 —— 它们是「每条」的属性）
      const totalAmount =
        result.cost.pricedRounds === 0 && result.cost.unpricedModels.length > 0
          ? null
          : result.cost.cny;
      const totalRow = [
        '合计', '', '',
        group(result.total.promptTokens),
        group(result.total.cachedTokens),
        group(result.total.completionTokens),
        group(result.total.reasoningTokens),
        formatAmount(totalAmount),
      ];

      const widths = headers.map((header, i) =>
        Math.max(displayWidth(header), ...rows.map((r) => displayWidth(r[i]))),
      );
      const renderRow = (cells: string[]): string =>
        cells.map((cell, i) => padDisplay(cell, widths[i])).join('  ').trimEnd();

      write(renderRow(headers));
      for (const row of rows) write(`  ${renderRow(row)}`.trimEnd());
      write(`  ${'─'.repeat(widths.reduce((a, b) => a + b + 2, -2))}`);
      write(`  ${renderRow(totalRow)}`.trimEnd());
      write('');

      // 未定价模型：单独一行，且**不与合计混在一起**
      if (result.cost.unpricedModels.length > 0) {
        const count = result.entries.length - result.cost.pricedRounds;
        write(
          `注意：${count} 轮使用未定价模型（${result.cost.unpricedModels.join(', ')}），未计入合计。`,
        );
      }

      // 估算校准：只有拿到过真实用量才有意义
      if (result.total.promptTokens > 0) {
        const estimated = result.entries.reduce((sum, e) => sum + e.estimatedPromptTokens, 0);
        const actual = result.total.promptTokens;
        const delta = ((estimated - actual) / actual) * 100;
        const direction = estimated > actual ? '估算偏保守' : estimated < actual ? '估算偏激进' : '与真实一致';
        write(
          `上下文估算：合计估算 ${group(estimated)} / 真实 ${group(actual)}（${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%，${direction}）`,
        );
      }

      // 峰谷拆分：只在两档都出现过时才有信息量
      if (result.cost.pricedRounds >= 2 && result.cost.peakCny > 0 && result.cost.offPeakCny > 0) {
        write(
          `时段拆分：高峰部分 ${formatAmount(result.cost.peakCny)} / 空闲部分 ${formatAmount(result.cost.offPeakCny)}`,
        );
      }

      // 表过期是**必须可见**的：静默用一张过期表会让 2027 年春节
      // 被当成普通工作日按高峰计价（D-M4b-14）
      if (result.entries.some((e) => isOutsideHolidayTable(new Date(e.at)))) {
        write(
          `注意：节假日表只覆盖 ${HOLIDAY_TABLE_YEAR} 年，${HOLIDAY_TABLE_YEAR + 1} 年及以后的记录未按法定节假日扣除。`,
        );
      }

      // 口径与范围这两行**始终**输出（D-M4b-8）：金额与真实账单之间隔着
      // 估算器的误差、中断的轮次、节假日表的覆盖范围三件事，
      // 不写出来用户就会把 ¥0.01328 当成账单
      write(
        `口径：按 docs/deepseek-api-facts.md 的价目表分高峰/空闲两档估算（含 ${HOLIDAY_TABLE_YEAR} 年法定节假日表），未经账单核对。`,
      );
      write('范围：本会话的全部记录，含 --resume 恢复的历史。');
      return;
    }
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/render.test.ts && pnpm test
```

Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/cli/render.ts test/render.test.ts
git commit -m "feat(01-llm): M4b /usage 表格渲染（显示宽度对齐 + 口径与范围说明）"
```

---

### Task 10: `cli/repl.ts` + `index.ts` 接线

**Files:**
- Modify: `demos/01-llm/src/cli/repl.ts`
- Modify: `demos/01-llm/src/index.ts`
- Test: `demos/01-llm/test/repl.test.ts`、`demos/01-llm/test/index.test.ts`（追加）

**Interfaces:**
- Consumes: 前面全部；`ReplOptions` 新增 `usageEntries: UsageEntry[]`
- Produces: 成功轮次写一行 usage 记录到 store；`/usage` 能读到累计

- [ ] **Step 1: 写失败测试**

追加到 `test/repl.test.ts`（用文件里既有的记录型假 store / 假 client）：

```ts
// ── 账本接线（M4b） ───────────────────────────────────────────────────

/**
 * 带 usage 的假 client。
 *
 * 既有的 `fakeClient` 不吐 usage 事件，所以那些用例天然走「不记账」分支；
 * 这里要的是相反的情况。事件顺序照抄真实契约：正文 → usage → done。
 */
function fakeClientWithUsage(answers: string[], usage: TokenUsage): LLMClient {
  let i = 0;
  return {
    async chat() {
      return { content: answers[i++] ?? '', usage };
    },
    async *chatStream() {
      const content = answers[i++] ?? '';
      yield { type: 'text-delta', text: content };
      yield { type: 'usage', usage };
      yield { type: 'done', reason: 'stop' };
    },
  };
}

const USAGE: TokenUsage = {
  promptTokens: 1203,
  completionTokens: 456,
  totalTokens: 1659,
  cachedTokens: 1024,
  cacheMissTokens: 179,
  reasoningTokens: 120,
};

/** 跑一次 REPL，省掉每个用例都抄一遍 options */
async function runWith(
  client: LLMClient,
  options: {
    lines: string[];
    store: SessionStore;
    history?: Message[];
    usageEntries?: UsageEntry[];
    maxContext?: number;
  },
): Promise<{ out: string; err: string }> {
  const { chunks, stream, errChunks, errStream } = captureOutput();
  await runRepl(client, {
    input: inputFrom(options.lines),
    output: stream,
    errorOutput: errStream,
    prompt: 'You: ',
    model: 'deepseek-flash',
    sessionId: SESSION_ID,
    history: options.history ?? [],
    usageEntries: options.usageEntries ?? [],
    store: options.store,
    showReasoning: false,
    noThinking: false,
    maxContext: options.maxContext ?? DEFAULT_MAX_CONTEXT,
  });
  return { out: chunks.join(''), err: errChunks.join('') };
}

/** 从落盘记录里挑出 usage 那些 */
function usageWrites(writes: Array<{ id: string; change: SessionChange }>) {
  return writes
    .map((w) => w.change)
    .filter((c): c is Extract<SessionChange, { type: 'usage' }> => c.type === 'usage');
}

test('一轮成功后落盘一行 usage 记录，带合法 ISO 时刻', async () => {
  const { store, writes } = recordingStore();

  await runWith(fakeClientWithUsage(['你好'], USAGE), { lines: ['hi'], store });

  const recorded = usageWrites(writes);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].entry.model, 'deepseek-flash');
  assert.deepEqual(recorded[0].entry.usage, USAGE);
  // 时刻必须能被 Date 解析 —— 金额按它分峰谷（D-M4b-13）
  assert.equal(Number.isNaN(Date.parse(recorded[0].entry.at)), false);
});

test('estimatedPromptTokens 取的是**裁剪后**的估算', async () => {
  // 这条才测得到 M4a 的裁剪与 M4b 的估算有没有接对：
  // 用完整历史的估算会得到一个虚高的偏差，而偏差率正是 /usage 要给人看的
  const { store, writes } = recordingStore();
  const history: Message[] = [
    { role: 'user', content: 'u'.repeat(300) },
    { role: 'assistant', content: 'a'.repeat(300) },
  ];

  await runWith(fakeClientWithUsage(['你好'], USAGE), {
    lines: ['hi'],
    store,
    history,
    maxContext: 50, // 极小：system + 两轮历史必然超预算
  });

  const recorded = usageWrites(writes);
  assert.equal(recorded.length, 1);

  const fullEstimate =
    estimateTokens(SYSTEM_PROMPT) +
    estimateTokens('u'.repeat(300)) +
    estimateTokens('a'.repeat(300)) +
    estimateTokens('hi');

  assert.ok(
    recorded[0].entry.estimatedPromptTokens < fullEstimate,
    `裁剪后 ${recorded[0].entry.estimatedPromptTokens} 应小于完整历史 ${fullEstimate}`,
  );
});

test('失败的轮次不记账、不落盘 usage', async () => {
  const { store, writes } = recordingStore();

  await runWith(fakeClient([new Error('boom')]), { lines: ['hi'], store });

  // 中断的轮次拿不到 usage，记一笔残缺的会让账本看起来完整、实则错
  assert.equal(usageWrites(writes).length, 0);
});

test('响应没有 usage 时不记账（既有 fakeClient 就是这种情况）', async () => {
  const { store, writes } = recordingStore();

  await runWith(fakeClient(['你好']), { lines: ['hi'], store });

  assert.equal(usageWrites(writes).length, 0);
});

test('usage 落盘失败时对话继续，且只警告一次', async () => {
  const { store, attempts } = failingStore('磁盘满了');

  const { out, err } = await runWith(fakeClientWithUsage(['你好', '再见'], USAGE), {
    lines: ['hi', 'bye'],
    store,
  });

  assert.ok(attempts() > 0);
  // 与 message 落盘失败**共用**同一条降级路径（reportWriteFailure），
  // 所以警告仍然恰好一行，而不是每轮刷一句
  assert.equal(err.match(/\[警告\]/g)?.length, 1, `stderr：${err}`);
  // 对话继续：两轮回答都出来了
  assert.match(out, /你好/);
  assert.match(out, /再见/);
});
```

import 处补：

```ts
import { estimateTokens } from '@/core/context.ts';
import type { UsageEntry } from '@/core/usage.ts';
import type { Message, TokenUsage } from '@/core/types.ts';
```

追加到 `test/index.test.ts`（子进程 + 真临时目录，复用既有的 `runCli` / `runEnv` / `tempHome` / `writeSessionFile` / `META_LINE`）：

```ts
// ── usage 记录的回放（M4b） ───────────────────────────────────────────

const USAGE_LINE = JSON.stringify({
  type: 'usage',
  entry: {
    at: '2026-09-28T02:00:00.000Z', // 周一北京 10:00 → 高峰
    model: 'deepseek-flash',
    usage: {
      promptTokens: 1203,
      completionTokens: 456,
      totalTokens: 1659,
      cachedTokens: 1024,
      cacheMissTokens: 179,
      reasoningTokens: 120,
    },
    estimatedPromptTokens: 1180,
  },
});

test('--resume 一个含 usage 行的文件：/usage 的累计包含历史', async (t) => {
  // 覆盖的是**接线**：usage 记录要从 JSONL 回放出来，经 index.ts 一路传进
  // runRepl，再由 /usage 读出来。分段测试看不出中间哪一环丢了 ——
  // 而丢了的表现是一个偏小却看不出问题的总数。
  const home = tempHome(t);
  writeSessionFile(home, SESSION_ID, [META_LINE, USER_LINE, ASSISTANT_LINE, USAGE_LINE]);

  const result = await runCli(runEnv(home), {
    args: ['--resume', SESSION_ID],
    stdin: ['/usage'],
  });

  assert.equal(result.code, 0);
  // 空账本会打印「还没有用量记录」—— 出现它就说明历史没接上
  assert.ok(
    !result.stdout.includes('还没有用量记录'),
    `历史 usage 没被回放：${result.stdout}`,
  );
  assert.match(result.stdout, /1 轮/);
  assert.match(result.stdout, /deepseek-flash/);
  // 数字确实来自那一行
  assert.match(result.stdout, /1,203/);
  assert.match(result.stdout, /1,024/);
});

test('损坏的 usage 行当坏行跳过，账本为空但会话照常恢复', async (t) => {
  const home = tempHome(t);
  // 缺 usage 子字段的记录 —— 校验应当拒掉它，而不是补 0 混过去
  writeSessionFile(home, SESSION_ID, [
    META_LINE,
    USER_LINE,
    '{"type":"usage","entry":{"at":"2026-09-28T02:00:00.000Z"}}',
  ]);

  const result = await runCli(runEnv(home), {
    args: ['--resume', SESSION_ID],
    stdin: ['/usage'],
  });

  assert.equal(result.code, 0);
  assert.match(result.stderr, /\[警告\] 已跳过 1 行无法解析的记录/);
  assert.match(result.stdout, /还没有用量记录/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --import ./loader.mjs --test test/repl.test.ts
```

Expected: FAIL —— `usageEntries` 不是合法选项 / 没有 usage 落盘

- [ ] **Step 3: 实现 `repl.ts`**

import 加：

```ts
import { UsageLedger } from '@/core/usage.ts';
import type { UsageEntry } from '@/core/usage.ts';
import type { ChatOptions, Message, TokenUsage } from '@/core/types.ts';
```

`ReplOptions` 加字段：

```ts
  /**
   * 从 JSONL 回放出的账本记录；新会话传空数组。
   *
   * 与 `history` 同一个处置：账本是**会话文件级**的累计，
   * 所以 --resume 时接着算，而不是从零开始（D-M4b-3）。
   */
  usageEntries: UsageEntry[];
```

`runRepl` 里建账本（放在 `session` 构造之后）：

```ts
  // 账本只覆盖本会话文件 —— 起点是回放出来的历史记录。
  // 它**不**参与 Session 的 onChange 广播（D-M4b-16）：账本不是会话消息，
  // 落盘由下面那段显式调用完成。
  const ledger = new UsageLedger(options.usageEntries);
```

`executeCommand` 调用处补 deps：

```ts
        const result = executeCommand(parsed.name, parsed.argument, session, {
          store: options.store,
          currentSessionId: options.sessionId,
          ledger,
        });
```

循环内改成：

```ts
      // 本轮正文与用量。渲染器只呈现，累积是这里的职责
      let text = '';
      let usage: TokenUsage | null = null;

      try {
        const fitted = fitToBudget(session.toMessages(SYSTEM_PROMPT), options.maxContext);
        // 这一段（裁剪警告）原样保留，M4b 不动它
        if (fitted.dropped > 0) {
          writeError(
            `[上下文] 已裁剪 ${fitted.dropped} 条最早的消息（约 ${fitted.droppedTokens} token）`,
          );
        }

        const chatOptions: ChatOptions = { model: session.model };
        if (options.noThinking) chatOptions.thinking = false;

        const stream = client.chatStream(fitted.messages, chatOptions);

        for await (const event of stream) {
          renderer.onEvent(event);
          if (event.type === 'text-delta') text += event.text;
          else if (event.type === 'usage') usage = event.usage;
        }

        session.append('assistant', text);

        // **只在成功路径记账**：中断的轮次（超时、连接断）走 catch 分支，
        // 那时 API 侧可能已经为已生成的部分计费，但我们拿不到那个 usage ——
        // 记一笔残缺的会让账本看起来完整、实则错。宁可偏低且可解释。
        if (usage) {
          const entry: UsageEntry = {
            // 时刻在这里定格：金额按它分峰谷，事后再算就晚了（D-M4b-13）
            at: new Date().toISOString(),
            model: session.model,
            usage,
            // 裁剪**之后**的估算 —— 它要和真实的 prompt_tokens 对得上，
            // 而后者描述的是「这一次实际发出去的东西」
            estimatedPromptTokens: fitted.keptTokens,
          };
          ledger.record(entry);
          try {
            // 与 Session 那条落盘路径共用 reportWriteFailure：
            // 「写盘失败只警告一次」这条降级自动覆盖 usage 记录
            options.store.append(options.sessionId, { type: 'usage', entry });
          } catch (error) {
            reportWriteFailure(error);
          }
        }
      } catch (error) {
        // 这一段原样保留。注意它**不做任何记账** —— 失败轮次走的就是这条路，
        // 而 usage 累积与落盘都在上面那条成功路径上（见上面的注释）
        renderer.finish();
        writeError(`[error] ${(error as Error).message}`);
      } finally {
        renderer.finish();
      }
```

- [ ] **Step 4: 实现 `index.ts`**

```ts
let usageEntries: UsageEntry[] = [];
```

resume 分支：

```ts
  const replayed = replay(loaded.records);
  history = replayed.messages;
  usageEntries = replayed.usageEntries;
```

新会话分支保持 `usageEntries = []`（初值已设）。

`runRepl` 调用补：

```ts
  history,
  usageEntries,
```

- [ ] **Step 5: 跑测试，确认通过**

```bash
pnpm run typecheck && pnpm test
```

Expected: typecheck 退出码 0；测试全绿

- [ ] **Step 6: 提交**

```bash
git add src/cli/repl.ts src/index.ts test/repl.test.ts test/index.test.ts
git commit -m "feat(01-llm): M4b 接线（成功轮次记账 + usage 落盘 + --resume 接着累计）"
```

---

### Task 11: 价目表的一致性测试

**Files:**
- Test: `demos/01-llm/test/pricing.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `priceFor`
- Produces: 无（测试只读文档与代码）

- [ ] **Step 1: 写测试**

创建 `demos/01-llm/test/pricing.test.ts`：

```ts
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

const expected: Array<{ model: string; kind: string; peak: number; field: 'cacheHit' | 'cacheMiss' | 'output' }> = [
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
```

- [ ] **Step 2: 跑测试，确认通过**

```bash
node --import ./loader.mjs --test test/pricing.test.ts
```

Expected: PASS（7 个用例）

- [ ] **Step 3: 故意改坏一次，确认它会红**

把 `core/usage.ts` 里 `'deepseek-flash'` 的 `output` 临时改成 `9`，跑：

```bash
node --import ./loader.mjs --test test/pricing.test.ts
```

Expected: FAIL，且错误信息里同时有 `¥8` 与 `9`。**改回去**。

> 这一步不是形式：一条「永远不会红」的一致性测试等于没有。上面那个 `rows.length === 6` 的用例就是为此加的。

- [ ] **Step 4: 提交**

```bash
git add test/pricing.test.ts
git commit -m "test(01-llm): M4b 价目表与事实文档的一致性测试"
```

---

### Task 12: 文档同步与冒烟

**Files:**
- Modify: `demos/01-llm/README.md`、`ARCHITECTURE.md`、`DECISIONS.md`、`EVALUATION.md`、`docs/troubleshooting.md`（按需）

- [ ] **Step 1: 更新 `README.md`**

四处：

1. 「常用命令」表格加一行 —— `/usage` 不在 `pnpm start` 的参数里，**不加**；真正要加的是「REPL 命令」表
2. 「REPL 命令」表格加：

```markdown
| `/usage` | 显示本会话的 token 用量、按高峰/空闲分档的费用估算与估算偏差 |
```

3. 「当前能力边界」：把「尚未实现」里的两条移出

```markdown
- 命令：`/usage`（Token 统计尚未实现，属 M4b）
- token 统计 / 成本账本（属 M4b）
```

「已实现」里加：

```markdown
- **token 统计与成本账本**：每轮成功请求的 `usage` 记进 `.sessions/*.jsonl`
  （`{ type: 'usage' }` 记录），`--resume` 后接着累计。`/usage` 按
  **高峰/空闲**两档估算金额（人民币元，价目见 `docs/deepseek-api-facts.md`），
  并显示 M4a 的上下文估算与真实用量的偏差。**这不是账单** —— 中断的轮次
  不计入，且节假日表只覆盖 2026 年
```

4. 「项目结构」补三行（`core/usage.ts`、`test/usage.test.ts`、`test/pricing.test.ts`）

- [ ] **Step 2: 更新 `ARCHITECTURE.md`**

- 「模块职责」补 `core/usage.ts` 一行
- 「运行时数据流」在步骤 5/6 后补 usage 事件的产出与记账
- 「落盘路径」一节补 `usage` 记录这一种，并点明它**不经 Session 广播**

- [ ] **Step 3: 追加 `DECISIONS.md`**

D-M4b-1 ~ D-M4b-16，编号延续，**不重排**既有编号。内容照抄 spec §3（每条都要有「被放弃的选项」）。

- [ ] **Step 4: 更新 `EVALUATION.md`**

- 第 6 项「统计 Token / Cost」翻成**达标**，附证据（测试用例名 + 冒烟实测的偏差率数字）
- 顶部质量门里的用例数与 `Test:` 行更新
- 「测试 ↔ 行为映射」表补四行（usage 纯函数 / usage 解析 / `/usage` 渲染 / 账本接线与落盘）

- [ ] **Step 5: 实跑冒烟（真实网络）**

```bash
printf '说三个字\n/usage\n' | pnpm --silent start > out1.txt 2>/dev/null; cat out1.txt
```

⚠️ **先确认第一件事**：`/usage` 的合计**非零**。全 0 说明不传 `stream_options.include_usage` 拿不到 usage —— 那就改 `deepseek.ts` 的请求体补上它，并把这条写进 `docs/troubleshooting.md`。

```bash
printf '问题一\n问题二\n问题三\n/usage\n' | pnpm --silent start > out2.txt; cat out2.txt
printf '说三个字\n/usage\n' | pnpm --silent start --no-thinking > out3.txt; cat out3.txt

# 账本真的落盘了
tail -3 .sessions/<id>.jsonl
printf '/usage\n' | pnpm --silent start --resume <id> > out4.txt; cat out4.txt
```

- [ ] **Step 6: 泄漏扫描后提交**

```bash
grep -i "sk-\|api_key\|authorization" out*.txt && echo "⚠️ 有泄漏，先清理" || echo "干净"
rm -f out1.txt out2.txt out3.txt out4.txt
git add README.md ARCHITECTURE.md DECISIONS.md EVALUATION.md docs/troubleshooting.md
git commit -m "docs(01-llm): M4b 文档同步（/usage、账本落盘、峰谷计价）"
```

---

## 收尾

全部任务完成后跑一遍完整验收：

```bash
pnpm run typecheck && pnpm test
```

```text
TypeCheck: PASS
Lint:      N/A（本仓库未配置 linter）
Test:      PASS（206 + 新增，全绿）
Build:     N/A（noEmit，Node 直接运行 .ts）
```

并确认 `EVALUATION.md` 里阶段 0 的六条验收标准**只剩「使用 Structured Output」一条未做**（落点 M5）。
