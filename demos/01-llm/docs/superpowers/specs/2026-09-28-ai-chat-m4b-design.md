# ai-chat M4b · 设计文档（usage 统计 + 成本估算 + `/usage`）

- 日期：2026-09-28
- 状态：待 review
- 范围：M4b —— **usage 解析 + 进程内账本 + 成本估算 + `/usage` 命令 + 估算校准**
- 前置：M1（非流式多轮 + 最小错误处理）、M2（streaming + 命令）、M3（会话持久化）、M4a（上下文预算 + 三个开关）已完成
- 约束来源：`AGENTS.md`（跨阶段技术约束）、`ARCHITECTURE.md`、`DECISIONS.md` D7 / D13 / D26 / D39 / D43、`docs/deepseek-api-facts.md`

---

## 1. 背景与目标

`EVALUATION.md` 第 6 项「统计 Token / Cost」是阶段 0 六条验收标准里**最后一条未做**的。归档蓝图 `archive/01-llm/01-full-design.md` 的 M4 把它和上下文预算捆在一起，M4a 已经拆走前半（见 M4a spec §1 的拆分表），本次做完后半。

现状（`EVALUATION.md` 第 6 项原文）：

> - **现状**：不读 `usage` 字段，不累计、不落盘、无 `/usage` 命令
> - **顺序依赖**：`usage` 在流式下只出现在末 chunk，所以这一项与第 4 项耦合 —— 先做 Streaming 更顺（已完成）

那个顺序依赖已经解开（M2a 完成了流式归一化），`core/types.ts:61` 也早就留了话：

> 注意：**没有 `usage` 事件**。Token 统计属于 M4b，现在解析了也没有消费者，与其定义一个没人用的 `TokenUsage` 并连带写测试，不如等 M4b 一起做。

成功标准：

- 流式与非流式两条路径都能从 API 响应里**防御式**解析出 usage，任何字段缺失都不抛错、不让一轮对话失败
- `/usage` 能回答三个问题：这场对话用了多少 token、钱花在哪、**估算器到底准不准**
- 金额口径**只有一个**（人民币、高峰价），且这个口径在输出里自己说出来
- 账本只覆盖本次进程这件事，**在输出里明说**，不让用户对着一个偏小的数字猜
- 代码里的价目表与 `docs/deepseek-api-facts.md` 的一致性由**测试**保证，不靠人记

---

## 2. 范围界定

### 本次范围

- `src/core/types.ts`：新增 `TokenUsage`；`StreamEvent` 加 `usage` 变体；`ChatResult` 加 `usage`
- `src/core/usage.ts`【新】：价目表常量、`priceFor` / `costOf` / `sumUsage`、`UsageLedger`
- `src/core/context.ts`：`FittedContext` 加 `keptTokens`（供校准用）
- `src/llm/deepseek.ts`：`toTokenUsage` 归一化；流式末 chunk 产出 `usage` 事件；非流式解析 `usage`
- `src/core/commands.ts`：新增 `/usage`；`CommandDeps` 加 `ledger`
- `src/cli/render.ts`：显式处理 `usage` 事件（**不渲染**）；`/usage` 的表格渲染
- `src/cli/repl.ts`：建账本、累积 usage、成功轮次记账
- `test/usage.test.ts`【新】、`test/pricing.test.ts`【新】
- 五份文档同步（见 §13）

### 明确推迟（本次不实现、不设计细节）

- **峰谷时段定价**（空闲 = 高峰一半）与**中国法定节假日表** —— 一律按高峰价，见 D-M4b-4
- **单价的环境变量覆盖** —— 选了「按文档价目表」这一档，见 D-M4b-9
- **用量落盘 / 跨会话账本** —— 本次只存内存，见 D-M4b-3
- **每轮自动打印用量** —— 会破坏 stdout 只承载回答与命令结果的契约，见 D-M4b-7
- **`--max-tokens` / `reasoning_effort`** —— API 支持，但蓝图未列，YAGNI
- **精确 tokenizer（tiktoken 等）** —— 零运行时依赖是硬约束，见 D-M4a-1
- **预算告警**（接近 `--max-context` 时提前提示）—— 蓝图未列，YAGNI
- **`/usage` 的参数**（如 `/usage --json`）—— 无参数，与 `/history` 一致

---

## 3. 设计决策汇总

每条都记了**被放弃的选项**，因为决策过程不在代码里。

### D-M4b-1. usage 走 **`StreamEvent` 的第四个变体**，不开第二条通道

**决策**：`StreamEvent` 加 `{ type: 'usage'; usage: TokenUsage }`。`llm/` 层把末 chunk 的 `usage` 归一化成事件，`cli/` 层在既有的 `for await` 循环里多接一个分支。

**被放弃的选项**：`chatStream` 改成返回 `{ events: AsyncIterable<StreamEvent>; usage: Promise<TokenUsage> }`。它看起来分层更漂亮（正文与元数据分开），但有个真实陷阱：两者**共享同一个 `reader`**，而 usage 要到流读完才有 —— 调用方若先 `await usage` 再消费 events，会直接死锁。要写对就必须知道「必须先读完 events」这条不成文约定，而约定正是错误的来源。方案 A 用 **yield 顺序**就把同一件事表达完了，不需要注释守着。

**代价**：`StreamEvent` 从「正文事件」变成了「正文事件 + 一个元数据事件」。这个纯度损失换来的是调用方永远不可能用错。

**相关**：D-M4b-2、D-M4b-10

### D-M4b-2. **usage 事件先于 done 产出**

**决策**：同一个末 chunk 里同时有 `usage` 与 `finish_reason` 时，先 yield `usage`，再 yield `done`。

**理由**：`done` 是终止信号。消费者（现在的 `repl.ts`、将来的任何调用方）见到它可能 `break` 出循环，之后 yield 的事件就永远拿不到了。usage 先出，保证「**收到 done ⇒ 统计已经到手**」这条不变式。

**代价**：`done` 在事实上的确是最后一个事件这一点被打破了吗？没有 —— 它仍是**最后一个** yield 的（`doneEmitted` 守卫保证只出一次），只是 usage 插在它前面。

**相关**：D-M4b-1

### D-M4b-3. 账本**只存内存**，不写进 JSONL

**决策**：`UsageLedger` 是 `runRepl` 内的一个局部对象，进程退出即消失。JSONL 一行不加。

**理由**

- JSONL 的契约是「**会话内容**的事件流」，回放它重建的是「这场对话说过什么」。usage 是**进程级**的事实（它包含网络重试、模型切换、失败轮次的中间态），混进去会让 `replay()` 多出一类与对话无关的状态。
- 落盘会立刻带出一个没有好答案的语义问题：**`/clear` 之后账本该不该清零？** 清了消息却留着用量，与 `/clear`「清空当前会话」的直觉不符；一起清掉，那 `/usage` 报出的就不再是「本次进程花了多少」，而变成「当前消息列表花了多少」—— 那是另一个指标，且会随裁剪、`/clear` 漂移。
- 跨会话累计还要处理 `--resume` 时把历史 usage 重新读入，而 `clear` 记录会打断可加性（清零之前和之后的记录无法简单相加）。

**代价**：`--resume` 回来 `/usage` 从零，而 `/history` 是完整可见的 —— **同一个 REPL 里两个命令的覆盖范围不一致**。这个代价用输出里的一行明文说明来补偿（D-M4b-8），而不是靠用户自己发现。

**相关**：D-M4b-8

### D-M4b-4. 一律按**高峰价**估算，不实现时段判断

**决策**：`core/usage.ts` 的价目表只用高峰档（flash `¥0.04 / ¥2 / ¥8`，pro `¥0.30 / ¥9 / ¥27` per 1M），不做任何时间判断。

**理由**

- 高峰价是**上界**（空闲是其一半），估高比估低安全 —— 与 D-M4a-1「宁可早裁一轮」是同一个取向。
- 时段判断本身不难，难的是它依赖的那张**中国法定节假日表**：官方口径是「不含中国法定节假日」，而节假日每年由国务院公告，需要人肉更新并塞进仓库。一个会过期的数据文件，是比「金额偏高最多 2 倍」糟得多的负担。
- 它还会引入**不可测的时区行为**：测试里若出现「现在几点」，用例就只能在特定时刻通过。要可测就得把 `now` 注进来，为一个 YAGNI 的功能多一条贯穿调用链的参数。

**代价**：在空闲时段真实花掉的钱**最多是显示金额的一半**。输出里的口径行明说这一点，不让人以为 `¥0.01661` 就是账单。

**相关**：D-M4b-5、D-M4a-1

### D-M4b-5. 未知模型**返回 `null`，绝不猜单价**

**决策**：`costOf(usage, model)` 对有价目的模型返回金额，否则返回 `null`。`estimateCost` 只累加**有价**部分，并单独返回未定价的模型名列表。

**理由**：`/model <name>` 不校验模型名（D-M4a 沿用下来的既有行为，写错的名字交给 API 报错）。所以账本里完全可能出现一个没有价目的模型名。此时**猜一个单价**会造出一个**看起来精确、实际错误**的数字 —— 而用户没有任何线索能看出它是猜的。`—` 与一行「2 轮未计价」是诚实的，且**可行动**（用户知道该去查价目表了）。

**绝不把 `null` 当 0 混进合计**：那会让总额偏低，却仍然显示成一个完整的数字。宁可合计只覆盖有价的部分，并说明它覆盖了多少。

**代价**：`cost()` 的返回类型多一层分支（`cny` + `unpricedModels`），渲染多一条分支。

**相关**：D-M4b-6

### D-M4b-6. 命中 / 未命中的输入**分开存**

**决策**：`TokenUsage` 里 `cachedTokens` 与 `cacheMissTokens` 是**两个字段**，不是合并成一个 `promptTokens`。

**理由**：两者单价差 **50 倍**（高峰 `¥0.04` vs `¥2`）。合并后 `promptTokens` 就再也无法还原出金额 —— 而这是成本的主导项。§9 的示例里 `7,703` 个输入 token 中只有 `6,144` 命中缓存，剩 `1,559` 按贵 50 倍的价计，这一项占了该轮金额的绝大部分。把它抹平，`/usage` 报出的钱会与真实账单相差数倍且**方向不定**。

**代价**：`TokenUsage` 有 6 个字段而非 3 个；解析时要处理两个来源字段（见 §6 的防御式解析）。

**相关**：D-M4b-4

### D-M4b-7. `/usage` 走 **stdout**，且**不自动打印**每轮用量

**决策**：用量是用户**主动敲命令**才看到的，输出走 stdout（与 `/history`、`/sessions` 同档）。每轮回答结束后**不**自动追加一行 token 数。

**理由**：stdout 的契约是「只有模型回答与命令结果」（D13 / D26），`pnpm start > answers.txt` 必须拿到一份干净的答案文件。每轮自动打印会让这个文件混进 N 行统计，且用户无法关掉它（除非再加一个 `--no-usage` 开关 —— 那是为了一个本可以不做的东西再造一个开关）。

**被放弃的选项**：默认打印 + `--quiet` 关闭。理由同上：为一个 YAGNI 的功能增加一个永久开关。

**相关**：D13、D26、D-M4b-8

### D-M4b-8. `/usage` 输出里**必须**有「仅统计本次进程」这一行

**决策**：**「仅统计本次进程」这一行在任何情况下都输出**（含账本为空时——那正是用户最容易误会「我明明聊了很多」的时刻）。

口径行（高峰价、未经账单核对）只在**实际显示了金额**时才出现：账本为空时没有任何金额要解释。

```text
口径：按 docs/deepseek-api-facts.md 的**高峰价**估算，未经账单核对（空闲时段实际约为一半）。
仅统计本次进程；--resume 恢复的历史对话不计入。
```

**理由**：这是 D-M4b-3 与 D-M4b-4 两个取舍的**唯一补偿**。两个取舍都会让数字偏离真实值，且方向相反（内存账本 → 偏低；高峰价 → 偏高），用户单看金额无法察觉。把它们写出来，用户才知道这个数字能用来做什么、不能用来做什么。

这条也是本仓库既有原则的延续：**不让用户对着静默的差异猜**（D7「屏幕上看到的 ≠ 模型记得的」、D43「裁剪不回写会话」、`troubleshooting` T13「不静默开新会话」都是同一形状）。

**代价**：每次 `/usage` 都重复两行固定文字。这是刻意的冗余。

**相关**：D-M4b-3、D-M4b-4、D-M4b-9

### D-M4b-9. 价目表是**代码里的常量**，与事实文档的一致性由**测试**钉住

**决策**：`core/usage.ts` 里写死 `PRICES` 常量（含退役名别名）。同时新增 `test/pricing.test.ts`，读 `docs/deepseek-api-facts.md`、解析价格表、逐项断言与 `PRICES` 相等。

**理由**：core 层零运行时依赖（`AGENTS.md` 硬约束），**读不了 md 文件**，所以代码里那张表必然是文档的副本 —— 两份事实源，官方一调价就会静默漂移。漂移的后果尤其阴险：`/usage` 会报出一个**格式正确、数值错误**的金额，没有任何迹象表明它过时了。

把「价格更新时两处一起改」从 `AGENTS.md` 的一行人工纪律，变成一条**会红的测试**。

**代价**：测试依赖 md 表格的格式。表格由我们自己维护，改动时测试会跟着报错 —— 这恰好是想要的行为（改表格就是要惊动它）。

**相关**：D-M4b-5

### D-M4b-10. 非流式 `chat()` 也解析 usage，尽管 REPL 不消费它

**决策**：`ChatResult` 加 `usage?: TokenUsage`，`chat()` 解析它并有单测。

**理由**：`core/types.ts:35` 早就写明 `ChatResult` 包一层而不是直接返回 `string`，**就是为了给 token 用量留扩展位**。现在 M4b 到了，把它填上。

另外两条：解析逻辑与流式路径**共用同一个 `toTokenUsage`**（见 §6），所以「有消费者」这件事对解析代码不成立 —— 它本来就要为流式写。`chat()` 侧只多一行赋值和几条测试。

**被放弃的选项**：不解析，理由是「REPL 走流式，没人用」。放弃它的原因：`chat()` 是**非流式的参照实现**（M2a 保留它与 `chatStream` 并存的理由就是「两者对照着看正是本阶段要学的东西」），让它少解析一个字段，正是把这个对照弄残缺。

**代价**：`ChatResult` 的 usage 在两个方法的返回里都存在，但只有 `chatStream` 的会被 REPL 消费。

**相关**：D-M4b-6

### D-M4b-11. `render.ts` 的 `onEvent` 必须**显式**处理 usage，不能靠 fallthrough

**决策**：`createStreamRenderer` 的 `onEvent` 里加一个显式的 `usage` 分支（什么都不渲染，直接 `return`）。

**理由**：现有实现的最后一个分支是**隐式的 done**：

```ts
if (event.type === 'reasoning-delta') { ...; return; }
if (event.type === 'text-delta') { ...; return; }
// done —— 走到这里的一定是 done
```

加了 `usage` 变体之后，「走到这里的一定是 done」**不再成立**：usage 事件会掉进 done 分支，于是每轮都会**多写一个 `AI: ` 前缀**（`writePrefixOnce`），且 `finish_reason === 'length'` 的判断会读到 `undefined`。屏幕上表现为回答前多一个空的 `AI: `，重定向到文件里也会多出来 —— 一个安静的、只在终端形状上可见的错误。

这是**加联合变体时最容易漏的一处**，所以单列一条决策。

**改动**：把 usage 分支写出来并 `return`。TS 的联合窄化仍提供守卫 —— 将来若加第五个变体，末尾那行访问 `event.reason` 会编译报错（TS2339），不会静默掉进 done 分支。

**相关**：D-M4b-1

### D-M4b-12. 校准只在 `/usage` 里**显示偏差**，**不回写**估算公式

**决策**：`/usage` 在表格后附一行「合计估算 X / 真实 Y（±Z%，估算偏保守 / 偏激进）」。M4a 的 `CHARS_PER_TOKEN = 1.5` **一个字不动**。

**理由**：M4a 的除数 1.5 是**刻意保守的猜**（D-M4a-1），而 M4b 是它唯一一次能被真实数据检验的机会 —— 不显示就永远只是个猜。但**不回写公式**：真正的 `prompt_tokens` 里含 API 侧的 chat template 开销（role 标签、消息分隔符），即使估算器完美，这个偏差也会系统性地偏向「估算偏小」。拿它去拟合除数，等于把 template 的固定开销摊进了一个应该只描述「文本 → token」的比值里。

**措辞带方向**是刻意的：「偏保守」＝估算 > 真实（安全侧，早裁一轮），「偏激进」＝估算 < 真实（危险侧，可能发出必然被拒的请求）。用户看一眼就知道这个除数有没有在帮倒忙。

**代价**：`FittedContext` 多一个 `keptTokens` 字段，账本每条多一个 `estimatedPromptTokens` 字段。

**相关**：D-M4a-1、D39

---

## 4. 架构与数据流

### 一轮对话（本次改动处标 ★）

```text
  用户输入
    │
    ├─ 命令分支 ──→ executeCommand ──→ ★ /usage 读账本 ──→ renderCommandResult ──→ stdout
    │                (core/commands.ts)     (core/usage.ts)
    │
    └─ 对话分支
         │
         ├─ session.append('user', q)                    ──→ 落盘
         │
         ├─ toMessages → fitToBudget                     ──→ ★ 取 keptTokens（估算值）
         │   (core/context.ts)
         │
         ├─ client.chatStream(messages, opts)            ──→ llm/deepseek.ts
         │       │
         │       ├─ reasoning-delta ──→ renderer ──→ stderr
         │       ├─ text-delta ──────→ renderer ──→ stdout
         │       ├─ ★ usage ─────────→ 累积到局部变量   ← 本次新增（渲染器显式忽略）
         │       └─ done ────────────→ renderer
         │
         ├─ session.append('assistant', text)             ──→ 落盘
         │
         └─ ★ ledger.record({ model, usage, estimatedPromptTokens })
```

### 关键点

- **账本不与 Session 耦合**：它不参与 `onChange` 广播、不落盘、`/clear` 不影响它（D-M4b-3）。`Session` 一行不改。
- **usage 只在成功轮次记账**：记账点在 `for await` 循环**正常结束之后**。流中途失败（空闲超时、连接断）走 `catch` 分支，不记账 —— 理由见 §10。
- **`estimatedPromptTokens` 取的是裁剪后数组的估算**，不是完整历史的估算。这样它才和真实的 `prompt_tokens` 对得上（两者描述的都是「这一次实际发出去的东西」）。

---

## 5. 目录结构

```text
01-llm/
  src/
    core/
      types.ts         # ★ 加 TokenUsage / StreamEvent.usage / ChatResult.usage
      usage.ts         # ★【新】价目表 + 计价 + UsageLedger + sumUsage
      context.ts       # ★ FittedContext 加 keptTokens
      commands.ts      # ★ 加 /usage 命令 + CommandDeps.ledger
      session.ts       # 不改
      journal.ts       # 不改（账本不落盘）
    llm/
      deepseek.ts      # ★ toTokenUsage + 两条路径解析 usage
      client.ts        # 不改（接口签名不变）
      sse.ts           # 不改
    cli/
      render.ts        # ★ usage 事件显式忽略 + /usage 表格渲染
      repl.ts          # ★ 建账本、累积 usage、成功轮次记账
      args.ts          # 不改（本次无新开关）
      config.ts        # 不改（本次无新环境变量）
      store.ts         # 不改
    index.ts           # 不改
  test/
    usage.test.ts      # ★【新】计价、账本、sumUsage
    pricing.test.ts    # ★【新】代码价目表 ↔ docs/deepseek-api-facts.md 一致性
    context.test.ts    # ★ 补 keptTokens 的断言
    deepseek.test.ts   # ★ 补 usage 解析与事件顺序
    commands.test.ts   # ★ 补 /usage
    render.test.ts     # ★ 补 usage 事件不变形 + /usage 表格
    repl.test.ts       # ★ 补账本接线
```

---

## 6. 类型与函数契约

### `core/types.ts` 改动

```ts
/**
 * 一次请求的 token 用量，来自 API 响应的 `usage` 字段。
 *
 * **命中与未命中的输入刻意分成两个字段**：单价差 50 倍（高峰 ¥0.04 vs ¥2
 * per 1M，见 docs/deepseek-api-facts.md），合并成一个 promptTokens 就再也
 * 还原不出金额（D-M4b-6）。
 *
 * 所有字段都是**归一化后**的结果：上游缺哪个字段就填 0，不会出现 undefined。
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

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  // ★ 新增。顺序契约：**永远先于 done**（D-M4b-2）
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; reason: FinishReason };

export interface ChatResult {
  content: string;
  /** 本次请求的用量。API 未返回 usage 时为 undefined */
  usage?: TokenUsage;   // ★ 新增
}
```

### `core/usage.ts`【新】

```ts
/** 一个模型的单价（人民币元 / 百万 token）。只用高峰档，见 D-M4b-4 */
export interface ModelPrice {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/** 账本里的一条记录：一轮成功请求 */
export interface UsageEntry {
  /** 该轮实际使用的模型（可能是 /model 切换后的） */
  model: string;
  usage: TokenUsage;
  /**
   * 该轮**实际发出去的消息数组**的估算 token 数（M4a 的 estimateTokens 之和，
   * 即 fitToBudget 之后的 keptTokens）。用于与真实 promptTokens 对比，
   * 检验 D-M4a-1 的除数 1.5 是否真的偏保守。
   */
  estimatedPromptTokens: number;
}

/** 账本的合计结果 */
export interface CostBreakdown {
  /** 有价目部分的金额合计（人民币元）。全部无价目时为 0 */
  cny: number;
  /** 账本里出现过的、无价目表的模型名（去重，保持首次出现顺序） */
  unpricedModels: string[];
  /** 有价目的轮次数 */
  pricedRounds: number;
}

/** 查一个模型的单价。含退役名别名；无价目返回 null（D-M4b-5） */
export function priceFor(model: string): ModelPrice | null;

/** 单轮的金额；无价目返回 null */
export function costOf(usage: TokenUsage, model: string): number | null;

/** 逐字段相加。空数组返回全 0 的 TokenUsage */
export function sumUsage(usages: readonly TokenUsage[]): TokenUsage;

/** 进程内的用量账本。**不落盘、不广播、/clear 不影响它**（D-M4b-3） */
export class UsageLedger {
  private entries: UsageEntry[] = [];   // 构造即空账本，没有需要注入的依赖
  /** 记一轮。只应由 repl 在**成功**轮次调用 */
  record(entry: UsageEntry): void;
  /**
   * 记录列表的**深拷贝**，外部改不动内部状态。
   *
   * 必须是深拷贝而不是 `[...entries]`：`UsageEntry.usage` 是嵌套对象，
   * 浅拷贝下调用方一句 `list[0].usage.promptTokens = 0` 就穿透进来改了账本。
   * 与 `Session.history()` 的处置同理（那里因为 Message 是扁平的才只需一层展开，
   * 这里要多展开一层）。
   */
  list(): UsageEntry[];
  /** 全部记录的字段级合计 */
  total(): TokenUsage;
  /** 金额合计与未定价模型 */
  cost(): CostBreakdown;
  /** 轮次数 */
  get rounds(): number;
}
```

**价目表常量**（含别名）：

```ts
// 高峰价，人民币元 / 百万 token。空闲时段为其一半；
// 一律按高峰计 —— 与 M4a 的估算除数取 1.5 同一个取向：宁可高估（D-M4b-4）。
// 数值来源：docs/deepseek-api-facts.md（官方页面 2026-09-28 抓取）。
// ⚠️ 改动此表必须同步改文档 —— test/pricing.test.ts 会逐项比对（D-M4b-9）。
const PRICES: Record<string, ModelPrice> = {
  'deepseek-flash':  { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9, output: 27 },
};

// 退役旧名仍被服务端按 Flash 计价（docs/deepseek-api-facts.md「模型」一节）
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};
```

**计价公式**：

```text
cost = cachedTokens   / 1e6 × cacheHit
     + cacheMissTokens / 1e6 × cacheMiss
     + completionTokens / 1e6 × output
```

注意 `completionTokens` 已含 `reasoningTokens`，**不重复计**。

### `core/context.ts` 改动

`FittedContext` 加一个字段：

```ts
export interface FittedContext {
  messages: Message[];
  dropped: number;
  droppedTokens: number;
  /** 保留下来的消息的估算 token 数 = total - droppedTokens。供 M4b 校准用 */
  keptTokens: number;   // ★ 新增
}
```

三条返回路径都要填：未超预算（`keptTokens: total`）、一组都没丢（同上）、真裁了（`total - droppedTokens`）。

### `llm/deepseek.ts` 改动

新增一个内部函数，**两条路径共用**（行为只此一处，理由同 D-M4a-11 对 `thinkingField` 的处置）：

```ts
/**
 * 把 API 的 usage 对象归一化成 TokenUsage。**永不抛错**：任何字段缺失、
 * 类型不对、整个对象不存在，都退回 0（统计拿不到不该毁掉一轮对话）。
 *
 * 字段名取防御式策略 —— 官方未文档化 prompt_tokens_details 的确切形状
 * （docs/deepseek-api-facts.md 末尾），所以两个候选名都试：
 * - 命中：prompt_cache_hit_tokens → cached_tokens → 0
 * - 未命中：prompt_cache_miss_tokens → (promptTokens - 命中) → 0
 *
 * 最后一档要取 `Math.max(0, …)`：上游数据若给出「命中数 > 输入总数」，
 * 相减会得到负数，而负金额比金额偏差难查得多（§10）。
 */
function toTokenUsage(raw: unknown): TokenUsage;
```

**流式路径**：在既有的逐个字段判定之后，加 usage 判定，且在 `done` 之前：

```ts
// 顺序要紧：usage 必须在 done 之前 yield（D-M4b-2）
if (delta?.reasoning_content) yield { type: 'reasoning-delta', ... };
if (delta?.content)           yield { type: 'text-delta', ... };
if (payload.usage)            yield { type: 'usage', usage: toTokenUsage(payload.usage) };  // ★
if (choice?.finish_reason && !doneEmitted) yield { type: 'done', ... };
```

payload 的类型声明加 `usage?: unknown`。

**非流式路径**：`data` 的类型声明加 `usage?: unknown`，返回 `{ content, usage: ... }`。为保持 `ChatResult.usage?: TokenUsage` 的语义（「API 未返回时为 undefined」），这里要先判存在：

```ts
const usage = data.usage === undefined ? undefined : toTokenUsage(data.usage);
return { content, usage };
```

**⚠️ 不传 `stream_options.include_usage`**：`docs/deepseek-api-facts.md` 写明不传它时 usage 也出现在最后一个 chunk 上，符合既有的「最小请求体」原则。**这是本次唯一一个待实测验证的前提** —— 冒烟若发现不传就拿不到 usage，再补上并写进 troubleshooting。

### `core/commands.ts` 改动

```ts
export type CommandName = 'clear' | 'history' | 'model' | 'sessions' | 'usage';  // ★

export const COMMAND_NAMES: readonly CommandName[] =
  ['clear', 'history', 'model', 'sessions', 'usage'];  // ★ 顺序即提示里的顺序

export interface CommandDeps {
  store: SessionStore;
  currentSessionId: string;
  ledger: UsageLedger;   // ★ 新增
}

export type CommandResult =
  | ...
  | { kind: 'usage'; entries: UsageEntry[]; total: TokenUsage; cost: CostBreakdown };  // ★
```

`executeCommand` 的 `case 'usage'` 是**纯查询**，不写 `session` —— 与 `/model` 的查询分支同一处置。

### `cli/render.ts` 改动

两处（见 D-M4b-11 与 §9）：`onEvent` 显式忽略 usage；`renderCommandResult` 加 `case 'usage'`。

### `cli/repl.ts` 改动

```ts
const ledger = new UsageLedger();   // 每次启动一个新的 —— 「仅本次进程」的实现点
```

循环内：

```ts
let usage: TokenUsage | null = null;
try {
  for await (const event of stream) {
    renderer.onEvent(event);
    if (event.type === 'text-delta') text += event.text;
    else if (event.type === 'usage') usage = event.usage;   // ★
  }
  session.append('assistant', text);
  // ★ 只在成功路径记账
  if (usage) {
    ledger.record({ model: session.model, usage, estimatedPromptTokens: fitted.keptTokens });
  }
} catch (error) { ... }
```

`executeCommand` 调用处补 `ledger`。

**注意 `session.model` 的取值时机**：用 `session.model` 而不是 `chatOptions.model` 的旧值 —— 两者此时相同，但用 `session.model` 少一次变量搬运。真正要守住的是「记账时的模型 = 发请求时的模型」，而这一轮内 `session.model` 不会被改（`/model` 命令在另一条分支上、且下一轮才生效）。

`runRepl` 的 `ReplOptions` **不加字段**：账本是 REPL 内部实现细节，不是外部配置。

### `test/pricing.test.ts`【新】

```ts
// 读 docs/deepseek-api-facts.md，解析「## 价格（人民币元 / 百万 tokens）」下的表格，
// 断言每一行的高峰列与 core/usage.ts 的 PRICES 逐项相等。
```

匹配三行（每个模型）：`输入 cache hit` / `输入 cache miss` / `输出`，取表格**第 4 列**（高峰）。

失败信息要指明**是哪一项对不上**（模型 + 类别 + 文档值 + 代码值），否则这条测试红了之后还得人去比对。

---

## 7. `/usage` 命令契约

| 输入 | 行为 |
| --- | --- |
| `/usage` | 渲染账本 |
| `/usage ` （尾随空白） | 同上（`parseCommand` 已 trim） |
| `/usage foo` | **忽略参数**，同上 —— 与 `/history` 的处置一致 |
| 账本为空 | 两行提示（见 §9），仍走 stdout |

**只读**：不写 `session`、不广播、不动账本。用与 `/model` 查询分支同样的「setter 探针」手法在 `test/commands.test.ts` 里钉住。

---

## 8. 计价算法与边界

```text
total = Σ entries
cny   = Σ (有价目的 entry 的 costOf(usage, model))
unpricedModels = entries 中 priceFor(model) === null 的 model 去重（保持首次出现顺序）
pricedRounds   = 有价目的 entry 数
```

边界：

| 场景 | 行为 |
| --- | --- |
| 账本为空 | `total()` 全 0；`cost()` 返回 `{ cny: 0, unpricedModels: [], pricedRounds: 0 }` |
| 全部模型无价目 | `cny: 0` 且 `unpricedModels` 非空 → 渲染显示合计 `—`，**不是** `¥0.00000` |
| 混合有价/无价 | 合计只含前者，另起一行「N 轮未计价（model-a, model-b）」 |
| usage 全 0（API 没给） | 正常记账，金额 `¥0.00000`。**不特殊处理** —— 0 是一个真实可能的用量 |
| 单价为 0 的模型 | 当前价目表里没有，但公式天然支持 |

---

## 9. 输出形状

### `/usage`（stdout）

**有记录时**：

```text
本次进程用量（3 轮）
  #  模型             输入     命中缓存   输出     思考     费用
  1  deepseek-flash   1,203    1,024      456      120      ¥0.00405
  2  deepseek-flash   2,890    2,048      612      240      ¥0.00666
  3  deepseek-flash   3,610    3,072      588      180      ¥0.00590
  ──────────────────────────────────────────────────────────────
  合计               7,703    6,144      1,656    540      ¥0.01661

上下文估算：合计估算 7,450 / 真实 7,703（-3.3%，估算偏激进）
口径：按 docs/deepseek-api-facts.md 的高峰价估算，未经账单核对（空闲时段实际约为一半）。
仅统计本次进程；--resume 恢复的历史对话不计入。
```

**关于示例里那个负号**：偏差为负（估算偏小）是**符合预期**的，不是估算器坏了。真实 `prompt_tokens` 里还含 API 侧的 chat template 开销（role 标签、消息分隔符），而估算只看正文；中文正文下 `chars / 1.5` 本身相当准（3 个汉字约合 2 token），所以剩下的差额基本就是 template 开销。这正是 D-M4b-12 说的「不能拿这个偏差率去拟合除数」。

**账本为空时**：

```text
本次进程还没有用量记录。
仅统计本次进程；--resume 恢复的历史对话不计入。
```

**有未定价模型时**，在 `上下文估算` 行之前插入：

```text
注意：2 轮使用未定价模型（my-model），未计入合计。
```

### 渲染规则

| 规则 | 说明 |
| --- | --- |
| 中文表头对齐 | 汉字在终端占 **2 列**，`padEnd` 按 UTF-16 码元算会错位。需要一个 `displayWidth` 辅助函数（见下） |
| 千分位 | 手写正则 `\B(?=(\d{3})+(?!\d))`，**不用 `toLocaleString`** —— 后者依赖 ICU 构建，测试结果会随 Node 构建漂移 |
| 金额 | `¥` + `toFixed(5)`。单轮约 `¥0.004`，2 位小数会全是 `¥0.00` |
| 无价目 | 显示 `—`（不是 `¥0.00000`） |
| 偏差率 | `(估算 - 真实) / 真实 × 100`，保留 1 位小数带符号。真实为 0 时省略整行（无意义） |
| 偏差措辞 | 估算 > 真实 → `估算偏保守`；< → `估算偏激进`；相等 → `一致` |
| 列宽 | 按该列内容的最大显示宽度算，表头参与计算 |

`displayWidth` 的取法：逐码点判断是否落在东亚宽字符区间（CJK 统一表意文字、假名、谚文、全角标点等），是则 +2，否则 +1。**只用于这一处对齐**，不追求 Unicode 完整性 —— 表头只有「模型 / 输入 / 命中缓存 / 输出 / 思考 / 费用」这几个固定词，且都是常见汉字。这一点要写在注释里，免得将来被当成通用工具误用。

### usage 事件（不渲染）

`createStreamRenderer.onEvent` 收到 `{ type: 'usage' }` 时**什么都不做**，直接返回（D-M4b-7、D-M4b-11）。stdout 与 stderr 都不写。

---

## 10. 错误与边界

| 场景 | 行为 |
| --- | --- |
| 响应没有 `usage` 字段 | 流式：不产出 usage 事件，`done` 照常；非流式：`ChatResult.usage` 为 `undefined` |
| `usage` 字段类型不对（字符串、数组） | `toTokenUsage` 返回全 0，**不抛错** |
| `prompt_tokens_details` 缺失 | `cachedTokens` 0、`cacheMissTokens` = `promptTokens` |
| 只有 `cached_tokens` 没有 `prompt_cache_hit_tokens` | 用 `cached_tokens` |
| 命中数 > 输入总数（上游数据不一致） | 未命中**下限取 0**，不产生负数 —— 负金额比金额偏差更难查 |
| 流中途失败（超时、连接断） | **不记账**。走 `catch` 分支，`ledger.record` 在它之外 |
| 一轮成功但 usage 为 null | 不记账（`if (usage)` 守卫） |
| `/usage` 在账本为空时调用 | 走空账本文案，**不是**错误、不进 stderr |
| JSONL 回放 | **完全不受影响** —— 本次不新增记录类型（D-M4b-3） |

**已知偏差**（写在这里，也写进 `/usage` 的输出）：

1. **中断的轮次不计入**：API 侧可能已经为已生成的部分计费，但我们拿不到那个 usage。账本因此**偏低**。
2. **一律按高峰价**：空闲时段的真实花费最多是显示金额的一半。账本因此**偏高**。
3. **偏差率的系统性偏移**：真实 `prompt_tokens` 含 API 侧的 chat template 开销，所以偏差率天然偏向「估算偏小」，它**不是**估算器精度的纯净度量（D-M4b-12）。
4. **文档价目 ≠ 账单**：2026-09-24 实测过本地记账与文档价目表差 38 倍（见 memory 记录），本次的金额同样**未经账单核对**。

---

## 11. 注释要求（本次特别强调）

- `TokenUsage` 的**每个字段**都要有注释，特别是 `cachedTokens` / `cacheMissTokens` 为什么要分开（D-M4b-6）—— 这是最容易被后人「顺手合并」的一处
- `PRICES` 常量上方必须有：单位、为什么用高峰价、来源文档、「改动必须同步文档，测试会比对」
- `toTokenUsage` 的注释要列出**字段名候选顺序**与「永不抛错」的承诺
- `StreamEvent` 的 `usage` 变体旁写明**顺序契约**（先于 done）与理由
- `repl.ts` 账单记账处写明「只在成功路径」以及为什么（中断轮次拿不到 usage）
- `render.ts` 的 usage 分支写明「为什么必须显式写出来」（D-M4b-11 的 fallthrough 陷阱）
- `displayWidth` 的注释写明它的**适用范围有限**，不是通用工具

---

## 12. 验证策略

### 新增 `test/usage.test.ts`

- `priceFor`：两个正式模型、两个退役别名、未知模型 → `null`
- `costOf`：三档单价的独立贡献；**缓存命中主导金额**（构造一个命中多的 usage，验证金额显著低于全 miss）
- `costOf` 的边界：全 0 usage → 0；未知模型 → `null`
- `sumUsage`：逐字段相加；空数组 → 全 0
- `UsageLedger`：初始为空（`rounds` 0、`total()` 全 0、`cost()` 空）；记两条后累计正确；`list()` 返回副本（**改它不影响内部**）
- `cost()`：全有价 / 混合 / 全无价三种情况；`unpricedModels` **去重且保持首次出现顺序**；`pricedRounds` 正确

### 新增 `test/pricing.test.ts`

读 `docs/deepseek-api-facts.md`，逐项断言 `PRICES` 与高峰列相等（D-M4b-9）。失败信息带模型名、类别、两个数值。

### 扩既有测试

| 文件 | 补什么 |
| --- | --- |
| `context.test.ts` | `keptTokens` 在三条返回路径上分别正确（未超预算 / 一组没丢 / 真裁了），且等于 `total - droppedTokens` |
| `deepseek.test.ts` | 末 chunk 带 usage → 产出 `usage` 事件**且它在 `done` 之前**（断言事件序列，不是分别断言存在）；无 usage 的流 → 不产出；字段缺失 → 全 0；字段类型错 → 全 0；`prompt_cache_hit_tokens` 缺失时回落 `cached_tokens`；命中 > 输入时未命中不为负；非流式 `chat()` 解析 usage；非流式无 usage → `undefined` |
| `commands.test.ts` | `/usage` 空账本 / 有记录 / 含未定价模型；**只读探针**（会话写入计数为 0）；`parseCommand('/usage')` 为 known |
| `render.test.ts` | `/usage` 表格（含中文表头的对齐：断言表头行的**显示宽度**与数据行一致）；空账本文案；**必须含「仅统计本次进程」**；未定价模型行；金额 5 位小数；无价目显示 `—`；**usage 事件不产生任何输出**（stdout / stderr 都空） |
| `repl.test.ts` | 一轮成功后账本恰 1 条；**`estimatedPromptTokens` 等于裁剪后的估算**（配一个会触发裁剪的 `maxContext`，断言它小于完整历史的估算）—— 这条才测得到 M4a 与 M4b 有没有接对；失败轮次不记账；`usage` 为 null 的轮次不记账 |

### 手动冒烟（真实网络，不进 CI）

```bash
# 把 /usage 当作最后一行一起喂进去 —— 管道输入下 REPL 读完就退出，没法再交互敲命令
# 1) ⚠️ 验证本次唯一的设计前提：不传 stream_options 也能拿到 usage
printf '说三个字\n/usage\n' | pnpm --silent start > out1.txt 2>/dev/null
#    out1.txt 的「合计」行应是**非零**的输入/输出，而不是全 0
#    若全 0：说明必须传 stream_options.include_usage，改 deepseek.ts 并写进 troubleshooting

# 2) 多轮：命中缓存列是否真的非零（系统提示是稳定前缀，应产生 cache hit）
printf '问题一\n问题二\n问题三\n/usage\n' | pnpm --silent start > out2.txt

# 3) --no-thinking 下 reasoningTokens 应为 0
printf '说三个字\n/usage\n' | pnpm --silent start --no-thinking > out3.txt

# 4) 估算偏差率：记录实际数字，写进 EVALUATION.md 的证据
```

**密钥不得进会话**：真实 key 只从 `.env.local` 读，任何贴出来的输出前先做泄漏扫描。

---

## 13. 文档同步

跟代码同一次改动一起更新：

| 文档 | 改什么 |
| --- | --- |
| `README.md` | 「常用命令」表格加 `/usage` 一行；「REPL 命令」表格加 `/usage`；「当前能力边界」把「命令：`/usage`（属 M4b）」「token 统计 / 成本账本（属 M4b）」两条从「尚未实现」移出，写进「已实现」并**点明只统计本次进程**；「项目结构」补 `core/usage.ts`、`test/usage.test.ts`、`test/pricing.test.ts` |
| `ARCHITECTURE.md` | 「模块职责」补 `usage.ts`；「一轮请求」数据流在步骤 5/6 之后补 usage 事件的产出与记账；「接口边界」补 `UsageLedger` |
| `DECISIONS.md` | 追加 D-M4b-1 ~ D-M4b-12（编号延续，**不重排**既有编号） |
| `EVALUATION.md` | 第 6 项「统计 Token / Cost」翻成**达标**并附证据（含冒烟得到的真实偏差率数字）；质量门里的用例数更新；「测试 ↔ 行为映射」表补三行 |
| `docs/deepseek-api-facts.md` | **本次已更新**（价格改人民币原值）。若冒烟验证了「不传 stream_options 也有 usage」，把这条从「可选」升级为「实测确认」 |
| `docs/troubleshooting.md` | 实施过程中若踩到新坑，随手追加一条 |

---

## 14. 验收

```text
TypeCheck: pnpm run typecheck → 退出码 0
Lint:      N/A（本仓库未配置 linter）
Test:      pnpm test → 全绿（新增 test/usage.test.ts、test/pricing.test.ts）
Build:     N/A（noEmit，Node 直接运行 .ts）
```

外加 §12 的 4 项手动冒烟全部通过，且 `EVALUATION.md` 第 6 项翻成达标。

**本次的路线意义**：做完之后，`docs/ROADMAP.md` 阶段 0 的六条验收标准里**只剩「使用 Structured Output」（落点 M5）一条未做**。

---

## 15. 实施顺序（供 writing-plans 参考）

按依赖关系，每一步都能独立跑 `typecheck`：

```text
1. core/types.ts：TokenUsage + StreamEvent.usage + ChatResult.usage
                   —— 纯类型，不影响任何现有代码的编译
2. core/usage.ts + test/usage.test.ts        —— 纯逻辑，不依赖任何现有文件
3. core/context.ts 的 keptTokens + test/context.test.ts
4. llm/deepseek.ts：toTokenUsage + 两条路径 + test/deepseek.test.ts
                   —— 这一步之后 usage 已经开始流动，但还没有消费者
5. core/commands.ts：/usage + CommandDeps.ledger + test/commands.test.ts
6. cli/render.ts：usage 事件显式忽略 + /usage 表格 + test/render.test.ts
7. cli/repl.ts 接线 + test/repl.test.ts
8. test/pricing.test.ts                      —— 独立，可随时做
9. README / ARCHITECTURE / DECISIONS / EVALUATION
10. 手动冒烟 §12 的 4 项
```

第 1 步会**暂时**打破 `render.ts` 的隐式 done 分支假设（加了变体却没有分支处理）—— 好在那个 fallthrough 只在运行时会错，编译不受影响，所以第 6 步处理它即可。但**第 4 步之后就该立刻做第 6 步**，不要带着这个已知的错继续往下走。
