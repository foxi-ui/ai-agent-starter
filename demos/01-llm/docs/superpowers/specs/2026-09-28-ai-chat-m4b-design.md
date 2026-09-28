# ai-chat M4b · 设计文档（usage 统计 + 成本账本 + `/usage`）

- 日期：2026-09-28
- 状态：待 review
- 范围：M4b —— **usage 解析 + 落盘账本 + 峰谷分档成本估算 + `/usage` 命令 + 估算校准**
- 前置：M1（非流式多轮 + 最小错误处理）、M2（streaming + 命令）、M3（会话持久化）、M4a（上下文预算 + 三个开关）已完成
- 约束来源：`AGENTS.md`（跨阶段技术约束）、`ARCHITECTURE.md`、`DECISIONS.md` D7 / D13 / D26 / D27 / D39 / D43、`docs/deepseek-api-facts.md`

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
- `/usage` 能回答四个问题：这场对话用了多少 token、钱花在哪、**按当时的峰谷时段**各花了多少、**估算器到底准不准**
- 账本**跨进程存活**：`--resume` 回来接着累计，读的就是这个会话文件一直以来的总账
- 金额按**高峰/空闲分档**算，且这件事依赖的**法定节假日**是查表得到的真实数据，不是猜的
- 代码里的价目表与 `docs/deepseek-api-facts.md` 的一致性由**测试**保证，不靠人记

---

## 2. 范围界定

### 本次范围

- `src/core/types.ts`：新增 `TokenUsage`；`StreamEvent` 加 `usage` 变体；`ChatResult` 加 `usage`
- `src/core/usage.ts`【新】：价目表、节假日表、`periodAt` / `priceFor` / `costOf` / `sumUsage`、`UsageLedger`
- `src/core/context.ts`：`FittedContext` 加 `keptTokens`（供校准用）
- `src/core/journal.ts`：`SessionChange` 加 `usage` 变体；`parseRecord` 解析并**逐字段校验**；`replay` 重建账本
- `src/llm/deepseek.ts`：`toTokenUsage` 归一化；流式末 chunk 产出 `usage` 事件；非流式解析 `usage`
- `src/core/commands.ts`：新增 `/usage`；`CommandDeps` 加 `ledger`
- `src/cli/render.ts`：显式处理 `usage` 事件（**不渲染**）；`/usage` 的表格渲染
- `src/cli/repl.ts`：建账本、累积 usage、成功轮次记账并落盘
- `src/index.ts`：把 replay 出的账本传给 `runRepl`
- `test/usage.test.ts`【新】、`test/pricing.test.ts`【新】
- 五份文档同步（见 §13）

### 明确推迟（本次不实现、不设计细节）

- **假日表的自动更新** —— 内置 2026 一份，超出范围的降级行为见 D-M4b-14
- **单价的环境变量覆盖** —— 价目表来自事实文档，见 D-M4b-9
- **每轮自动打印用量** —— 会破坏 stdout 只承载回答与命令结果的契约，见 D-M4b-7
- **`/sessions` 里显示每个会话的成本** —— 要读每个文件的全部 usage 行，YAGNI
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

**相关**：D-M4b-2、D-M4b-11

### D-M4b-2. **usage 事件先于 done 产出**

**决策**：同一个末 chunk 里同时有 `usage` 与 `finish_reason` 时，先 yield `usage`，再 yield `done`。

**理由**：`done` 是终止信号。消费者（现在的 `repl.ts`、将来的任何调用方）见到它可能 `break` 出循环，之后 yield 的事件就永远拿不到了。usage 先出，保证「**收到 done ⇒ 统计已经到手**」这条不变式。

**相关**：D-M4b-1

### D-M4b-3. 账本**落盘到 JSONL**，跨进程累计

**决策**：JSONL 新增一种记录 `{ type: 'usage', entry }`。`replay()` 折叠出账本，`--resume` 时接着累计。

**理由**

- 「账本」这个词本身就意味着**跨进程**：一个每次启动都从零开始的计数器不叫账本，叫本次会话的仪表盘。
- 落盘后 `/usage` 与 `/history` 的**覆盖范围一致**了（都是「这个会话文件里有什么」）。不落盘的话，REPL 里会出现两个命令读同一份文件却给出不同范围的情况 —— 用户敲完 `/history` 看到 20 条消息，再敲 `/usage` 却只看到本进程那 3 轮，没有任何提示告诉他两者口径不同。
- usage 记录天然是**只能追加、不可变**的，这正是 JSONL 擅长的事，不需要任何更新语义。

**放弃了什么**：不落盘时最大的好处是「不碰 `journal.ts` 的格式契约」。现在这个契约要动：解析、逐字段校验、回放折叠、坏行容错、`clear` 的交互，都要一起处理（见 §6）。

**旧的反对理由与它的解**：不落盘时曾担心「`/clear` 之后账本该不该清零」没有好答案。现在答案有了 —— **不清**（D-M4b-15），理由是账本记的是「这个文件累计花了多少」，与消息内容无关。

**相关**：D-M4b-13、D-M4b-15、D-M4b-16

### D-M4b-4. 按**高峰 / 空闲**分档计价，节假日查**内置表**

**决策**：`periodAt(at)` 判断一条记录落在哪一档；高峰档用官方高峰价，空闲档用其一半。判断依据是**北京时间**的：工作日 9:00–12:00 与 14:00–18:00，且这一天不是法定节假日。

**理由**

- 两档差**整整一倍**。不分档就等于把一半的对话按双倍计价，或者反过来 —— 而真实账单只认一种。
- 时段窗口按官方口径定义在**北京时间**上，用北京时间判断最直观、也最容易与官方页面逐字对照（`docs/deepseek-api-facts.md`）。实现上把时刻平移 +8h 后用 `getUTC*` 读，得到的就是北京时间分量。

**节假日**：官方口径写明「不含中国法定节假日」，所以照顾到这一条才算完整。表是**真实数据**（国办发明电〔2025〕7号，2025-11-04 公布），不是估的 —— 完整日期见 §8。

**必须一并处理的调休**：2026 年有 **6 个调休上班的周末**（如 2/14、2/28、5/9、9/20、10/10、1/4）。如果只认「周六周日 = 空闲」，这 6 天会被算成空闲，而那几天按官方口径是**工作日**（该判高峰）。所以表要两张：**放假日**与**调休上班日**。

**被放弃的选项**：

- **不做时段判断，一律高峰价**（早先的版本）。代价是空闲时段的金额偏高最多一倍，且 `/usage` 永远显示不出「换个时间聊便宜一半」这个真实事实。
- **节假日用环境变量填**。仓库不携带会过期的数据，但把准确性推给了用户，而绝大多数人不会去填。
- **精确到分钟的时段边界**。官方口径是整点窗口，没有更细的规则。

**代价**：仓库里多一份**会过期**的数据（只覆盖 2026），所以必须有 D-M4b-14 的降级行为。

**相关**：D-M4b-14、D-M4b-9

### D-M4b-5. 未知模型**返回 `null`，绝不猜单价**

**决策**：`costOf` 对有价目的模型返回金额，否则返回 `null`。`cost()` 只累加**有价**部分，并单独返回未定价的模型名列表。

**理由**：`/model <name>` 不校验模型名（沿用下来的既有行为，写错的名字交给 API 报错）。所以账本里完全可能出现一个没有价目的模型名。此时**猜一个单价**会造出一个**看起来精确、实际错误**的数字 —— 而用户没有任何线索能看出它是猜的。`—` 与一行「2 轮未计价」是诚实的，且**可行动**（用户知道该去查价目表了）。

**绝不把 `null` 当 0 混进合计**：那会让总额偏低，却仍然显示成一个完整的数字。

**相关**：D-M4b-6

### D-M4b-6. 命中 / 未命中的输入**分开存**

**决策**：`TokenUsage` 里 `cachedTokens` 与 `cacheMissTokens` 是**两个字段**，不是合并成一个 `promptTokens`。

**理由**：两者单价差 **50 倍**（高峰 `¥0.04` vs `¥2`）。合并后 `promptTokens` 就再也无法还原出金额。

拿 §9 的示例算一遍：那 `1,559` 个**未命中**的输入 token 花了 `¥0.00228`，而同样数量的 token 若全部命中只需 `¥0.000046` —— 差 49 倍。合并成一个字段之后，这个差额就再也还原不出来，`/usage` 报出的钱会与真实账单相差数倍且**方向不定**（取决于那次对话的缓存命中率，而那恰恰是每轮都不同的）。

**相关**：D-M4b-4

### D-M4b-7. `/usage` 走 **stdout**，且**不自动打印**每轮用量

**决策**：用量是用户**主动敲命令**才看到的，输出走 stdout（与 `/history`、`/sessions` 同档）。每轮回答结束后**不**自动追加一行 token 数。

**理由**：stdout 的契约是「只有模型回答与命令结果」（D13 / D26），`pnpm start > answers.txt` 必须拿到一份干净的答案文件。每轮自动打印会让这个文件混进 N 行统计，且用户无法关掉它（除非再加一个 `--no-usage` 开关 —— 那是为了一个本可以不做的东西再造一个开关）。

**相关**：D13、D26、D-M4b-8

### D-M4b-8. `/usage` 输出里**必须**写明口径与范围

**决策**：只要有金额显示，就在最后带上这两行：

```text
口径：按 docs/deepseek-api-facts.md 的价目表分高峰/空闲两档估算（含 2026 年法定节假日表），未经账单核对。
范围：本会话的全部记录，含 --resume 恢复的历史。
```

**理由**：金额与真实账单之间隔着三件事 —— 估算器不精确、中断轮次不计入（§10）、**估算毕竟是估算**。这些不写出来，用户就会把 `¥0.01328` 当成账单。写出来，用户才知道这个数字能用来做什么。

这也正是本仓库既有原则的延续：**不让用户对着静默的差异猜**（D7「屏幕上看到的 ≠ 模型记得的」、D43「裁剪不回写会话」、`troubleshooting` T13「不静默开新会话」都是同一形状）。

**相关**：D-M4b-3、D-M4b-14

### D-M4b-9. 价目表是**代码里的常量**，与事实文档的一致性由**测试**钉住

**决策**：`core/usage.ts` 里写死 `PRICES` 常量（含退役名别名）。同时新增 `test/pricing.test.ts`，读 `docs/deepseek-api-facts.md`、解析价格表、逐项断言与 `PRICES` 相等。

**理由**：core 层零运行时依赖（`AGENTS.md` 硬约束），**读不了 md 文件**，所以代码里那张表必然是文档的副本 —— 两份事实源，官方一调价就会静默漂移。漂移的后果尤其阴险：`/usage` 会报出一个**格式正确、数值错误**的金额，没有任何迹象表明它过时了。

把「价格更新时两处一起改」从 `AGENTS.md` 的一行人工纪律，变成一条**会红的测试**。

**相关的取舍：节假日表没有同款测试。** 它的来源是国务院通知，仓库里没有第二份可以比对的副本，所以测试只能自证（断言表里有那 31 个放假日与 6 个调休日）。**这份表会过期**，见 D-M4b-14。

**代价**：测试依赖 md 表格的格式。表格由我们自己维护，改动时测试会跟着报错 —— 这恰好是想要的行为。

**相关**：D-M4b-4、D-M4b-14

### D-M4b-10. 非流式 `chat()` 也解析 usage，尽管 REPL 不消费它

**决策**：`ChatResult` 加 `usage?: TokenUsage`，`chat()` 解析它并有单测。

**理由**：`core/types.ts:35` 早就写明 `ChatResult` 包一层而不是直接返回 `string`，**就是为了给 token 用量留扩展位**。现在把它填上。另外，解析逻辑与流式路径**共用同一个 `toTokenUsage`**（见 §6），所以「有消费者」这件事对解析代码不成立 —— 它本来就要为流式写。`chat()` 侧只多一行赋值和几条测试。

**被放弃的选项**：不解析，理由是「REPL 走流式，没人用」。放弃它的原因：`chat()` 是**非流式的参照实现**（M2a 保留它与 `chatStream` 并存的理由就是「两者对照着看正是本阶段要学的东西」），让它少解析一个字段，正是把这个对照弄残缺。

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

**改动**：把 usage 分支写出来并 `return`。TS 的联合窄化仍提供守卫 —— 将来若加第五个变体，末尾那行访问 `event.reason` 会编译报错（TS2339），不会静默掉进 done 分支。

**相关**：D-M4b-1

### D-M4b-12. 校准只在 `/usage` 里**显示偏差**，**不回写**估算公式

**决策**：`/usage` 在表格后附一行「合计估算 X / 真实 Y（±Z%，估算偏保守 / 偏激进）」。M4a 的 `CHARS_PER_TOKEN = 1.5` **一个字不动**。

**理由**：M4a 的除数 1.5 是**刻意保守的猜**（D-M4a-1），而 M4b 是它唯一一次能被真实数据检验的机会 —— 不显示就永远只是个猜。但**不回写公式**：真正的 `prompt_tokens` 里含 API 侧的 chat template 开销（role 标签、消息分隔符），即使估算器完美，这个偏差也会系统性地偏向「估算偏小」。拿它去拟合除数，等于把 template 的固定开销摊进了一个应该只描述「文本 → token」的比值里。

**措辞带方向**是刻意的：「偏保守」＝估算 > 真实（安全侧，早裁一轮），「偏激进」＝估算 < 真实（危险侧，可能发出必然被拒的请求）。

**相关**：D-M4a-1、D39

### D-M4b-13. 每条记录带**时间戳**，金额按**记录当时**的时段算

**决策**：`UsageEntry` 带 `at: string`（ISO 8601，`new Date().toISOString()`）。计价时逐条调 `periodAt(new Date(entry.at))`，而不是用「现在」。

**理由**：这是峰谷落盘后**必须**有的字段，否则整个设计不成立 —— 账本里可能同时存在昨天高峰和今天空闲的记录，用同一个时刻统一计价会把其中一半算错。时间戳必须在**写记录的那一刻**确定并持久化，事后补不回来。

取的是**记账时刻**（收到响应、准备写盘时），不是请求发起时刻。两者相差一次响应的时间（秒级），而时段窗口是 3–4 小时，边界误差可以忽略。

**代价**：JSONL 里每条 usage 记录多一个字段；记录格式一旦写下就不能改（旧文件的 `at` 无法回溯补全）。

**相关**：D-M4b-1、D-M4b-4、D-M4b-14

### D-M4b-14. 节假日表只覆盖 **2026**，超出范围的记录按「无假日」算**并提示**

**决策**：表里只有 2026 年的日期。`periodAt` 遇到表中没有的年份，就退回「只按星期判断」的规则（不判假日）。`/usage` 若发现账本里有**超出表覆盖范围**的记录，在口径行之前加一行提示。

**理由**：内置表必然过期（D-M4b-4 的代价），而**静默地用一张过期表**正是本次要防的那类错误 —— 2027 年春节会被当成普通工作日，按高峰计价，金额偏高，且没有任何迹象。所以过期必须**可见**：

```text
注意：节假日表只覆盖 2026 年，2027 年的记录未按法定节假日扣除。
```

**被放弃的选项**：

- **超出范围就报错**。为了一个会自然发生的日期（跨年）让 `/usage` 失败，代价高于收益。
- **表里预填未来年份**。那些日期还没公布，填进去就是编造 —— 比不填糟糕得多。
- **表带一个「有效期」并在过期后整体拒绝计价**。会让一整年的记录都变成 `—`，比偏高更没用。

**相关**：D-M4b-4、D-M4b-9

### D-M4b-15. `/clear` **不**清账本

**决策**：`replay()` 遇到 `clear` 记录时清空 `messages`，但**保留**已折叠出的 usage 记录。

**理由**：账本记的是「**这个会话文件**累计花了多少」。钱已经花掉了，`/clear` 清的是对话内容（它的语义本就不含会话配置，见 D-? 「只清消息、不清模型」），再加一条「顺带清理历史成本」会让账本与账单对不上。

**一并解决的语义问题**：如果 `clear` 也清账本，`replay` 就要在 `clear` 处把 `usageEntries.length = 0` —— 这会让「同一个文件里两段对话的成本」无法相加，而它们确实是同一个账单。保留则天然可加。

**代价**：`/clear` 之后 `/usage` 的数字**不会**归零，可能让第一次用的人疑惑。这个疑惑由「范围：本会话的全部记录」那行（D-M4b-8）兜住。

**相关**：D-M4b-3、D-M4b-8

### D-M4b-16. usage 记录并入 `SessionChange`，但**不经 Session 广播**

**决策**：`SessionChange` 加 `{ type: 'usage'; entry: UsageEntry }`；由 `repl.ts` 在成功轮次**直接调** `store.append()`，不经过 `Session`。

**理由**

- **并入 `SessionChange`**：那个联合的定义本来就是「日志里除 meta 外的全部内容」，`store.append` 的签名接的也是它。usage 放进去，`store` 接口一行不用改。副作用是 `SessionChange` 这个名字变得不那么贴切，所以要在类型注释里点明 `usage` 是例外。
- **不经 Session 广播**：`Session` 的 `onChange` 机制解决的是「**看不见的写入点**」—— `/clear` 与 `/model` 是 `executeCommand` 内部改的状态，`repl` 看不见它们，所以必须让 `Session` 自己喊。而 `ledger.record()` **只有一个调用点**，就在 `repl` 的循环里、紧挨着落盘那几行。为它再加一套广播，是给一个不存在的问题上保险。

**代价**：`repl.ts` 里多一段手写的 `try { store.append(...) } catch { reportWriteFailure(e) }`。它与 `Session` 那条落盘路径**共用** `reportWriteFailure`，所以「写盘失败只警告一次」的既有行为自动覆盖 usage 记录。

**相关**：D-M4b-3、D-M4b-15

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
         ├─ session.append('user', q)                    ──→ 落盘（message）
         │
         ├─ toMessages → fitToBudget                     ──→ ★ 取 keptTokens（估算值）
         │   (core/context.ts)
         │
         ├─ client.chatStream(messages, opts)            ──→ llm/deepseek.ts
         │       │
         │       ├─ reasoning-delta ──→ renderer ──→ stderr
         │       ├─ text-delta ──────→ renderer ──→ stdout
         │       ├─ ★ usage ─────────→ 累积到局部变量   ← 渲染器显式忽略
         │       └─ done ────────────→ renderer
         │
         ├─ session.append('assistant', text)             ──→ 落盘（message）
         │
         └─ ★ 成功且拿到 usage 时：
              ledger.record(entry)                        （内存）
              store.append(sessionId, { type:'usage', entry })  ──→ ★ 落盘（usage）
```

### 启动（`--resume` 时账本怎么回来）

```text
  store.load(id) → records
    → replay(records) → { messages, model, ★ usageEntries }
        ├─ messages      → ReplOptions.history      → new Session(...)
        └─ ★ usageEntries → ReplOptions.usageEntries → new UsageLedger(entries)
```

### 关键点

- **账本不参与 `Session` 的 `onChange` 广播**，`session.ts` 一行不改（D-M4b-16）。
- **usage 只在成功轮次记账**：记账点在 `for await` 循环**正常结束之后**。流中途失败（空闲超时、连接断）走 `catch` 分支，不记账、不落盘（§10 有理由）。
- **`estimatedPromptTokens` 取的是裁剪后数组的估算**，不是完整历史的估算。这样它才和真实的 `prompt_tokens` 对得上。

---

## 5. 目录结构

```text
01-llm/
  src/
    core/
      types.ts         # ★ 加 TokenUsage / StreamEvent.usage / ChatResult.usage
      usage.ts         # ★【新】价目表 + 节假日表 + 计价 + UsageLedger + sumUsage
      context.ts       # ★ FittedContext 加 keptTokens
      journal.ts       # ★ SessionChange 加 usage 变体 + parseRecord 校验 + replay 折叠
      commands.ts      # ★ 加 /usage 命令 + CommandDeps.ledger
      session.ts       # 不改
    llm/
      deepseek.ts      # ★ toTokenUsage + 两条路径解析 usage
      client.ts        # 不改（接口签名不变）
      sse.ts           # 不改
    cli/
      render.ts        # ★ usage 事件显式忽略 + /usage 表格渲染
      repl.ts          # ★ 建账本、累积 usage、成功轮次记账 + 落盘
      store.ts         # 不改（append 接的就是 SessionChange）
      args.ts          # 不改（本次无新开关）
      config.ts        # 不改（本次无新环境变量）
    index.ts           # ★ 把 replay 的 usageEntries 传进 runRepl
  test/
    usage.test.ts      # ★【新】时段判断、节假日表、计价、账本
    pricing.test.ts    # ★【新】代码价目表 ↔ docs/deepseek-api-facts.md 一致性
    context.test.ts    # ★ 补 keptTokens 的断言
    journal.test.ts    # ★ 补 usage 记录的序列化/解析/校验/回放
    deepseek.test.ts   # ★ 补 usage 解析与事件顺序
    commands.test.ts   # ★ 补 /usage
    render.test.ts     # ★ 补 usage 事件不变形 + /usage 表格
    repl.test.ts       # ★ 补账本接线与落盘
    index.test.ts      # ★ 补 --resume 后账本重建（子进程 + 真临时目录）
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
  promptTokens: number;     // 输入总数
  completionTokens: number; // 输出总数（含思考）
  totalTokens: number;      // 输入 + 输出
  cachedTokens: number;     // 输入中命中 prompt cache 的部分（便宜 50 倍）
  cacheMissTokens: number;  // 输入中未命中 cache 的部分
  reasoningTokens: number;  // completion 中属于 thinking 的部分
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
/** 计价档位 */
export type PricingPeriod = 'peak' | 'offpeak';

/** 一个模型的单位价（人民币元 / 百万 token） */
export interface ModelPrice {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/** 账本里的一条记录：一轮成功请求 */
export interface UsageEntry {
  /**
   * 记账时刻（ISO 8601）。**金额按它来分峰谷**（D-M4b-13），
   * 所以它必须落盘 —— 事后无法回溯。
   */
  at: string;
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
  /** 有价目部分里，高峰档的金额 */
  peakCny: number;
  /** 有价目部分里，空闲档的金额 */
  offPeakCny: number;
  /** 账本里出现过的、无价目表的模型名（去重，保持首次出现顺序） */
  unpricedModels: string[];
  /** 有价目的轮次数 */
  pricedRounds: number;
}

/**
 * 判断一个时刻落在高峰还是空闲档。
 *
 * 官方口径（docs/deepseek-api-facts.md）：高峰为**北京时间**周一至周五
 * 9:00–12:00 与 14:00–18:00，不含中国法定节假日。
 *
 * 实现上把时刻平移 +8h 后用 getUTC* 读 —— 得到的就是北京时间分量，
 * 且不受运行机器的本地时区影响（CI 在 UTC 上跑的结果与在 Asia/Shanghai 上一致）。
 *
 * @param at 记账时刻
 */
export function periodAt(at: Date): PricingPeriod;

/** 查一个模型的单价。含退役名别名；无价目返回 null（D-M4b-5） */
export function priceFor(model: string): ModelPrice | null;

/**
 * 单轮的金额；无价目返回 null。空闲档按高峰价减半。
 *
 * @param period 该轮所处的档位，由 periodAt(entry.at) 得出
 */
export function costOf(usage: TokenUsage, model: string, period: PricingPeriod): number | null;

/** 逐字段相加。空数组返回全 0 的 TokenUsage */
export function sumUsage(usages: readonly TokenUsage[]): TokenUsage;

/** 节假日表的覆盖年份。超出它的记录见 D-M4b-14 */
export const HOLIDAY_TABLE_YEAR = 2026;

/** 一个时刻是否超出节假日表的覆盖范围 */
export function isOutsideHolidayTable(at: Date): boolean;

/**
 * 用量账本。**落盘由 repl 负责**（D-M4b-16），本类只管内存状态。
 */
export class UsageLedger {
  /** @param initial 从 JSONL 回放出的历史记录；新会话传空 */
  constructor(initial: UsageEntry[] = []);
  /** 记一轮。只应由 repl 在**成功**轮次调用 */
  record(entry: UsageEntry): void;
  /**
   * 记录列表的**深拷贝**，外部改不动内部状态。
   *
   * 必须是深拷贝而不是 `[...entries]`：`UsageEntry.usage` 是嵌套对象，
   * 浅拷贝下调用方一句 `list[0].usage.promptTokens = 0` 就穿透进来改了账本。
   * 与 `Session.history()` 的处置同理（那里 Message 是扁平的才只需一层展开）。
   */
  list(): UsageEntry[];
  /** 全部记录的字段级合计 */
  total(): TokenUsage;
  /** 金额合计（含峰谷拆分）与未定价模型 */
  cost(): CostBreakdown;
  /** 轮次数 */
  get rounds(): number;
}
```

**价目表常量**（含别名）：

```ts
// 高峰价，人民币元 / 百万 token；空闲档为其一半（见 costOf）。
// 数值来源：docs/deepseek-api-facts.md（官方页面 2026-09-28 抓取）。
// ⚠️ 改动此表必须同步改文档 —— test/pricing.test.ts 会逐项比对（D-M4b-9）。
const PEAK_PRICES: Record<string, ModelPrice> = {
  'deepseek-flash':  { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9, output: 27 },
};

// 退役旧名仍被服务端按 Flash 计价（docs/deepseek-api-facts.md「模型」一节）
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

// 空闲档 = 高峰档的一半（官方："空闲时段价格为高峰时段价格的一半"）
const OFF_PEAK_RATIO = 0.5;

// 节假日：两张私有表，日期键是**北京时间的 YYYY-MM-DD**。
// 完整清单与来源见 §8。`HOLIDAYS` 缺了会让金额偏高，`MAKEUP_WORKDAYS`
// 缺了会让金额偏低 —— 两张都不能省（D-M4b-4）。
const HOLIDAYS: ReadonlySet<string>;
const MAKEUP_WORKDAYS: ReadonlySet<string>;
```

**计价公式**：

```text
unit(price, period) = period === 'peak' ? price : price × OFF_PEAK_RATIO

cost = cachedTokens     / 1e6 × unit(cacheHit,  period)
     + cacheMissTokens  / 1e6 × unit(cacheMiss, period)
     + completionTokens / 1e6 × unit(output,    period)
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

### `core/journal.ts` 改动

```ts
import type { UsageEntry } from '@/core/usage.ts';   // ★ core 内部互相 import，仍在 core 层

export type SessionChange =
  | { type: 'message'; role: Role; content: string }
  | { type: 'clear' }
  | { type: 'model'; model: string }
  /**
   * ★ 账本记录。**唯一一个不由 Session 广播的变体** —— 账本不是会话消息的一部分，
   * 由 repl 在成功轮次直接交给 store（D-M4b-16）。
   * 放进这个联合，是为了让 store.append 的签名不必放宽。
   */
  | { type: 'usage'; entry: UsageEntry };

export type SessionRecord =
  | { type: 'meta'; id: string; createdAt: string; model: string }
  | SessionChange;

/** replay 的返回值 */
export function replay(records: SessionRecord[]): {
  messages: Message[];
  model: string | null;
  usageEntries: UsageEntry[];   // ★ 新增。`clear` **不会**清空它（D-M4b-15）
};
```

`parseRecord` 的 `case 'usage'` 要**逐字段校验**（文件内容不可信，与既有做法一致）：`at` / `model` 是 string，`estimatedPromptTokens` 是 number，`usage` 是对象且 6 个字段都是 number。任何一项不符 → 返回 `null`（当坏行跳过，由调用方计数）。

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
if (delta?.reasoning_content) yield { type: 'reasoning-delta', ... };
if (delta?.content)           yield { type: 'text-delta', ... };
if (payload.usage)            yield { type: 'usage', usage: toTokenUsage(payload.usage) };  // ★
if (choice?.finish_reason && !doneEmitted) yield { type: 'done', ... };
```

payload 的类型声明加 `usage?: unknown`。

**非流式路径**：`data` 的类型声明加 `usage?: unknown`，返回 `{ content, usage }`，其中 `usage` 在 API 未返回时是 `undefined`（保持 `ChatResult.usage?` 的语义）。

**⚠️ 不传 `stream_options.include_usage`**：`docs/deepseek-api-facts.md` 写明不传它时 usage 也出现在最后一个 chunk 上，符合既有的「最小请求体」原则。**这是本次唯一一个待实测验证的前提** —— 冒烟若发现不传就拿不到 usage，再补上并写进 troubleshooting。

### `core/commands.ts` 改动

```ts
export type CommandName = 'clear' | 'history' | 'model' | 'sessions' | 'usage';  // ★

export const COMMAND_NAMES: readonly CommandName[] =
  ['clear', 'history', 'model', 'sessions', 'usage'];  // ★ 顺序即未知命令提示里的顺序

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

两处（D-M4b-11 与 §9）：`onEvent` 显式忽略 usage；`renderCommandResult` 加 `case 'usage'`。

### `cli/repl.ts` 改动

```ts
/** ReplOptions 新增 */
export interface ReplOptions {
  // ...既有字段
  /** 从 JSONL 回放出的账本记录；新会话传空数组 */
  usageEntries: UsageEntry[];   // ★
}
```

```ts
const ledger = new UsageLedger(options.usageEntries);   // ★ 起点是历史累计
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

  // ★ 只在成功路径记账 + 落盘。中断的轮次拿不到 usage，记不了（§10）
  if (usage) {
    const entry: UsageEntry = {
      at: new Date().toISOString(),   // ★ 时刻在这里定格，之后不再变
      model: session.model,
      usage,
      estimatedPromptTokens: fitted.keptTokens,
    };
    ledger.record(entry);
    try {
      // 与 Session 那条落盘路径共用 reportWriteFailure：写盘失败只警告一次
      options.store.append(options.sessionId, { type: 'usage', entry });
    } catch (error) {
      reportWriteFailure(error);
    }
  }
} catch (error) { ... }
```

**注意 `session.model` 的取值时机**：用 `session.model` 而不是 `chatOptions.model` 的旧值 —— 两者此时相同，但用 `session.model` 少一次变量搬运。真正要守住的是「记账时的模型 = 发请求时的模型」，而这一轮内 `session.model` 不会被改（`/model` 在另一条分支上、下一轮才生效）。

### `index.ts` 改动

```ts
const { messages, model, usageEntries } = replay(records);
await runRepl(client, { /* ... */ history: messages, usageEntries });
```

新建会话时 `usageEntries: []`。

### `test/pricing.test.ts`【新】

读 `docs/deepseek-api-facts.md`，解析「## 价格（人民币元 / 百万 tokens）」下的表格，断言每一行的**高峰列**与 `PEAK_PRICES` 逐项相等。

匹配三行（每个模型）：`输入 cache hit` / `输入 cache miss` / `输出`，取表格**第 4 列**。失败信息要指明**是哪一项对不上**（模型 + 类别 + 文档值 + 代码值），否则这条测试红了之后还得人去比对。

---

## 7. `/usage` 命令契约

| 输入 | 行为 |
| --- | --- |
| `/usage` | 渲染账本 |
| `/usage ` （尾随空白） | 同上（`parseCommand` 已 trim） |
| `/usage foo` | **忽略参数**，同上 —— 与 `/history` 的处置一致 |
| 账本为空 | 两行提示（见 §9），仍走 stdout |

**只读**：不写 `session`、不广播、不动账本、不落盘。用与 `/model` 查询分支同样的「setter 探针」手法在 `test/commands.test.ts` 里钉住。

---

## 8. 时段与计价算法

### 时段判断

```text
输入：at（记账时刻）

1. 平移到北京时间：bj = at + 8h（之后一律用 bj 的 UTC 分量读，即北京时间的年月日时分）
2. 取日期键 key = bj 的 YYYY-MM-DD
3. key 在放假日表里            → 空闲
4. 否则判断是否工作日：
     bj 的星期 ∈ 周一~周五      → 是
     key 在调休上班表里          → 是（覆盖周末）
     其余                        → 否 → 空闲
5. 工作日再看小时：
     bj 的 hour ∈ [9,12) 或 [14,18)  → 高峰
     其余                            → 空闲
```

### 2026 年法定节假日表（真实数据）

来源：[国务院办公厅关于2026年部分节假日安排的通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)（国办发明电〔2025〕7号，2025-11-04 公布）。

**放假日（全天按空闲计价）—— 33 天**

| 节日 | 日期 |
| --- | --- |
| 元旦 | 01-01 ~ 01-03 |
| 春节 | 02-15 ~ 02-23（9 天） |
| 清明节 | 04-04 ~ 04-06 |
| 劳动节 | 05-01 ~ 05-05 |
| 端午节 | 06-19 ~ 06-21 |
| 中秋节 | 09-25 ~ 09-27 |
| 国庆节 | 10-01 ~ 10-07 |

**调休上班日（按工作日，该判高峰）—— 6 天**

| 日期 | 说明 |
| --- | --- |
| 01-04（周日） | 元旦调休 |
| 02-14（周六）、02-28（周六） | 春节调休 |
| 05-09（周六） | 劳动节调休 |
| 09-20（周日）、10-10（周六） | 国庆调休 |

> **为什么必须带调休表**：只按「周末即空闲」判断的话，这 6 天会被算成空闲，而官方口径下它们是工作日（9:00–12:00 / 14:00–18:00 该判高峰）。反过来，若只加放假日表而不加调休表，这 6 天的金额会**偏低**。

### 计价

```text
total = Σ entries
cny   = Σ (有价目的 entry 的 costOf(usage, model, periodAt(new Date(entry.at))))
peakCny / offPeakCny = 按档位分别累加（用于输出里的拆分说明）
unpricedModels = entries 中 priceFor(model) === null 的 model 去重（保持首次出现顺序）
pricedRounds   = 有价目的 entry 数
```

边界：

| 场景 | 行为 |
| --- | --- |
| 账本为空 | `total()` 全 0；`cost()` 返回 `{ cny: 0, peakCny: 0, offPeakCny: 0, unpricedModels: [], pricedRounds: 0 }` |
| 全部模型无价目 | `cny: 0` 且 `unpricedModels` 非空 → 渲染显示合计 `—`，**不是** `¥0.00000` |
| 混合有价/无价 | 合计只含前者，另起一行「N 轮未计价（model-a, model-b）」 |
| usage 全 0（API 没给） | 正常记账，金额 `¥0.00000`。**不特殊处理** —— 0 是一个真实可能的用量 |
| `entry.at` 无法解析成日期 | 按**高峰**计（偏高是安全侧），不抛错。落盘的 `at` 是我们自己写的，走到这里说明文件被手改过 |

---

## 9. 输出形状

### `/usage`（stdout）

**有记录时**：

```text
本会话用量（3 轮）
  #  模型             时段   输入     命中缓存   输出     思考     费用
  1  deepseek-flash   高峰   1,203    1,024      456      120      ¥0.00405
  2  deepseek-flash   空闲   2,890    2,048      612      240      ¥0.00333
  3  deepseek-flash   高峰   3,610    3,072      588      180      ¥0.00590
  ─────────────────────────────────────────────────────────────────────
  合计                      7,703    6,144      1,656    540      ¥0.01328

上下文估算：合计估算 7,450 / 真实 7,703（-3.3%，估算偏激进）
时段拆分：高峰 2 轮 ¥0.00995 / 空闲 1 轮 ¥0.00333
口径：按 docs/deepseek-api-facts.md 的价目表分高峰/空闲两档估算（含 2026 年法定节假日表），未经账单核对。
范围：本会话的全部记录，含 --resume 恢复的历史。
```

**账本为空时**：

```text
本会话还没有用量记录。
范围：本会话的全部记录，含 --resume 恢复的历史。
```

**有未定价模型时**，在 `上下文估算` 行之前插入：

```text
注意：2 轮使用未定价模型（my-model），未计入合计。
```

**账本里有超出节假日表范围的记录时**，在 `口径` 行之前插入（D-M4b-14）：

```text
注意：节假日表只覆盖 2026 年，2027 年的记录未按法定节假日扣除。
```

**关于示例里那个负号**：偏差为负（估算偏小）是**符合预期**的，不是估算器坏了。真实 `prompt_tokens` 里还含 API 侧的 chat template 开销（role 标签、消息分隔符），而估算只看正文；中文正文下 `chars / 1.5` 本身相当准（3 个汉字约合 2 token），所以剩下的差额基本就是 template 开销。这正是 D-M4b-12 说的「不能拿这个偏差率去拟合除数」。

### 渲染规则

| 规则 | 说明 |
| --- | --- |
| 中文表头对齐 | 汉字在终端占 **2 列**，`padEnd` 按 UTF-16 码元算会错位。需要一个 `displayWidth` 辅助函数（见下） |
| 千分位 | 手写正则 `\B(?=(\d{3})+(?!\d))`，**不用 `toLocaleString`** —— 后者依赖 ICU 构建，测试结果会随 Node 构建漂移 |
| 金额 | `¥` + `toFixed(5)`。单轮约 `¥0.004`，2 位小数会全是 `¥0.00` |
| 无价目 | 显示 `—`（不是 `¥0.00000`） |
| 时段列 | `高峰` / `空闲` |
| 偏差率 | `(估算 - 真实) / 真实 × 100`，保留 1 位小数带符号。真实为 0 时省略整行（无意义） |
| 偏差措辞 | 估算 > 真实 → `估算偏保守`；< → `估算偏激进`；相等 → `一致` |
| 时段拆分行 | 只在有价目轮次 ≥ 2 且两档都出现过时才显示（只有一档时它只是重复合计） |
| 列宽 | 按该列内容的最大显示宽度算，表头参与计算 |

`displayWidth` 的取法：逐码点判断是否落在东亚宽字符区间（CJK 统一表意文字、假名、谚文、全角标点等），是则 +2，否则 +1。**只用于这一处对齐**，不追求 Unicode 完整性 —— 表头只有「模型 / 时段 / 输入 / 命中缓存 / 输出 / 思考 / 费用」这几个固定词。这一点要写在注释里，免得将来被当成通用工具误用。

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
| 流中途失败（超时、连接断） | **不记账、不落盘**。走 `catch` 分支，记账在它之外的正常路径上 |
| 一轮成功但 usage 为 null | 不记账（`if (usage)` 守卫） |
| usage 记录**写盘失败** | 内存账本照常记；走共用的 `reportWriteFailure`，**只警告一次**、对话继续（与 message 落盘失败的降级一致） |
| JSONL 里的 usage 行**损坏**（缺字段、类型不对） | `parseRecord` 返回 null → 当坏行跳过并计数，其余记录照常回放 |
| 旧版本文件（无 usage 行）| `replay` 得到空账本 → `/usage` 显示「本会话还没有用量记录」 |
| 旧版本程序读新文件 | `parseRecord` 的 `default` 分支跳过未知 type（既有行为），stderr 提示跳过行数 |
| `/usage` 在账本为空时调用 | 走空账本文案，**不是**错误、不进 stderr |
| `entry.at` 解析不出日期 | 按高峰计（偏高是安全侧），不抛错 |
| 账本里有超出 2026 的记录 | 正常计价（按无假日的工作日规则），另加一行提示 |

**已知偏差**（写在这里，也写进 `/usage` 的输出）：

1. **中断的轮次不计入**：API 侧可能已经为已生成的部分计费，但我们拿不到那个 usage。账本因此**偏低**。
2. **节假日表只到 2026**：2027 年起节假日按普通工作日算，金额**偏高**（D-M4b-14）。
3. **偏差率的系统性偏移**：真实 `prompt_tokens` 含 API 侧的 chat template 开销，所以偏差率天然偏向「估算偏小」，它**不是**估算器精度的纯净度量（D-M4b-12）。
4. **文档价目 ≠ 账单**：2026-09-24 实测过本地记账与文档价目表差 38 倍，本次的金额同样**未经账单核对**。

---

## 11. 注释要求（本次特别强调）

- `TokenUsage` 的**每个字段**都要有注释，特别是 `cachedTokens` / `cacheMissTokens` 为什么要分开（D-M4b-6）—— 这是最容易被后人「顺手合并」的一处
- `PEAK_PRICES` 上方必须有：单位、来源文档、「改动必须同步文档，测试会比对」
- 节假日表上方必须有：**来源通知的文号与 URL**、覆盖年份、「这份表会过期」、以及**调休表为什么必须存在**
- `periodAt` 的注释要写明「平移 +8h 后用 getUTC* 读」这个手法，以及它为什么不受本机时区影响
- `UsageEntry.at` 的注释要写明**金额按它分档、事后无法回溯**
- `toTokenUsage` 的注释要列出**字段名候选顺序**与「永不抛错」的承诺
- `StreamEvent` 的 `usage` 变体旁写明**顺序契约**（先于 done）与理由
- `SessionChange` 的 `usage` 变体旁写明**为什么它是唯一不由 Session 广播的变体**（D-M4b-16）
- `journal.ts` 的 `replay` 里注明 **`clear` 不清账本**（D-M4b-15）—— 这是最容易被后人「顺手一起清掉」的一处
- `repl.ts` 记账处写明「只在成功路径」以及为什么
- `render.ts` 的 usage 分支写明「为什么必须显式写出来」（D-M4b-11 的 fallthrough 陷阱）
- `displayWidth` 的注释写明它的**适用范围有限**，不是通用工具

---

## 12. 验证策略

### 新增 `test/usage.test.ts`

- `periodAt`：高峰窗口的**两个起点与两个终点**各自的内外边界（9:00 高峰 / 8:59 空闲 / 12:00 空闲 / 14:00 高峰 / 18:00 空闲）；周六周日全天空闲；**平移正确**（喂一个 UTC 时刻，验证它按北京时间判断 —— 例如 `01:00Z` 是北京 09:00，属高峰）
- `periodAt` 的节假日：放假日即使落在周三也判空闲；**调休上班的周六照样判高峰**（两条都要有，否则漏掉任一张表都不报错）
- `periodAt` 超出表年份：2027 年的工作日按普通规则判，不报错
- `isOutsideHolidayTable`：2026 年末与 2027 年初的分界
- 节假日表自证：放假日 33 天、调休日 6 天，且日期与 §8 的清单一致
- `priceFor`：两个正式模型、两个退役别名、未知模型 → `null`
- `costOf`：三档单价在**两个档位**下的独立贡献；**缓存命中主导金额**（构造命中多的 usage，验证金额显著低于全 miss）；空闲档恰好是高峰档的一半
- `costOf` 边界：全 0 usage → 0；未知模型 → `null`
- `sumUsage`：逐字段相加；空数组 → 全 0
- `UsageLedger`：`new UsageLedger()` 为空、`new UsageLedger(entries)` 铺入历史；记两条后累计正确；`list()` 返回**深**拷贝（改它的 `usage.promptTokens` 影响不到内部）；`cost()` 的峰谷拆分正确；`unpricedModels` 去重且保持首次出现顺序；`pricedRounds` 正确

### 新增 `test/pricing.test.ts`

读 `docs/deepseek-api-facts.md`，逐项断言 `PEAK_PRICES` 与高峰列相等（D-M4b-9）。

### 扩既有测试

| 文件 | 补什么 |
| --- | --- |
| `context.test.ts` | `keptTokens` 在三条返回路径上分别正确，且等于 `total - droppedTokens` |
| `journal.test.ts` | usage 记录的序列化↔解析两向契约；**逐字段校验**（缺 `at` / 缺 `usage` 子字段 / 类型不对 各返回 null）；`replay` 折叠出 `usageEntries`；**`clear` 之后 usageEntries 仍在**（D-M4b-15，这条最容易被漏）；旧文件（无 usage 行）回放出空数组 |
| `deepseek.test.ts` | 末 chunk 带 usage → 产出 `usage` 事件**且它在 `done` 之前**（断言事件序列，不是分别断言存在）；无 usage 的流 → 不产出；字段缺失 → 全 0；字段类型错 → 全 0；`prompt_cache_hit_tokens` 缺失时回落 `cached_tokens`；命中 > 输入时未命中不为负；非流式 `chat()` 解析 usage；非流式无 usage → `undefined` |
| `commands.test.ts` | `/usage` 空账本 / 有记录 / 含未定价模型；**只读探针**（会话写入计数为 0）；`parseCommand('/usage')` 为 known |
| `render.test.ts` | `/usage` 表格（含中文表头的对齐：断言表头行与数据行的**显示宽度**一致）；空账本文案；**必须含「范围：本会话的全部记录」**；未定价模型行；超表年份的提示行；金额 5 位小数；无价目显示 `—`；时段列；**usage 事件不产生任何输出**（stdout / stderr 都空） |
| `repl.test.ts` | 一轮成功后账本恰 1 条**且 store 收到一条 usage 记录**；`entry.at` 是合法 ISO 串；**`estimatedPromptTokens` 等于裁剪后的估算**（配一个会触发裁剪的 `maxContext`，断言它小于完整历史的估算）—— 这条才测得到 M4a 与 M4b 有没有接对；失败轮次不记账不落盘；`usage` 为 null 的轮次不记账；usage 落盘失败时对话继续且只警告一次 |
| `index.test.ts` | 新会话启动 → 文件里只有 meta 一行（**不**多写 usage）；`--resume` 一个含 usage 行的文件 → `/usage` 的累计包含历史（子进程 + 真临时目录，与既有用例同一套路） |

### 手动冒烟（真实网络，不进 CI）

```bash
# 把 /usage 当作最后一行一起喂进去 —— 管道输入下 REPL 读完就退出，没法再交互敲命令
# 1) ⚠️ 验证本次唯一的设计前提：不传 stream_options 也能拿到 usage
printf '说三个字\n/usage\n' | pnpm --silent start > out1.txt 2>/dev/null
#    out1.txt 的「合计」行应是**非零**的输入/输出，而不是全 0
#    若全 0：说明必须传 stream_options.include_usage，改 deepseek.ts 并写进 troubleshooting

# 2) 多轮：命中缓存列是否真的非零（系统提示是稳定前缀，应产生 cache hit）
printf '问题一\n问题二\n问题三\n/usage\n' | pnpm --silent start > out2.txt

# 3) 账本真的落盘了：文件里应有 usage 行，且 --resume 后 /usage 数字接得上
cat .sessions/<id>.jsonl | tail -3
printf '/usage\n' | pnpm --silent start --resume <id> > out3.txt

# 4) --no-thinking 下 reasoningTokens 应为 0
printf '说三个字\n/usage\n' | pnpm --silent start --no-thinking > out4.txt
```

**密钥不得进会话**：真实 key 只从 `.env.local` 读，任何贴出来的输出前先做泄漏扫描。

---

## 13. 文档同步

跟代码同一次改动一起更新：

| 文档 | 改什么 |
| --- | --- |
| `README.md` | 「常用命令」表格加 `/usage`；「REPL 命令」表格加 `/usage`；「当前能力边界」把「命令：`/usage`（属 M4b）」「token 统计 / 成本账本（属 M4b）」两条从「尚未实现」移出，写进「已实现」并点明**跨 --resume 累计**；「项目结构」补 `core/usage.ts`、`test/usage.test.ts`、`test/pricing.test.ts`；**说明节假日表只覆盖 2026** |
| `ARCHITECTURE.md` | 「模块职责」补 `usage.ts`；「运行时数据流」补 usage 事件的产出与记账/落盘；「落盘路径」一节补 usage 记录这一种；「接口边界」补 `UsageLedger` |
| `DECISIONS.md` | 追加 D-M4b-1 ~ D-M4b-16（编号延续，**不重排**既有编号） |
| `EVALUATION.md` | 第 6 项「统计 Token / Cost」翻成**达标**并附证据（含冒烟得到的真实偏差率数字）；质量门里的用例数更新；「测试 ↔ 行为映射」表补四行 |
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
1.  core/types.ts：TokenUsage + StreamEvent.usage + ChatResult.usage
                    —— 纯类型，不影响任何现有代码的编译
2.  core/usage.ts + test/usage.test.ts
                    —— 纯逻辑，不依赖任何现有文件。两张节假日表在这一步落地
3.  core/context.ts 的 keptTokens + test/context.test.ts
4.  llm/deepseek.ts：toTokenUsage + 两条路径 + test/deepseek.test.ts
                    —— 这一步之后 usage 已经开始流动
5.  cli/render.ts（**只做一半**）：usage 事件的显式忽略 + test/render.test.ts
                    —— ⚠️ 必须紧跟第 4 步，理由见下
6.  core/journal.ts：usage 变体 + 校验 + replay + test/journal.test.ts
7.  core/commands.ts：/usage + CommandDeps.ledger + test/commands.test.ts
8.  cli/render.ts（另一半）：/usage 的表格渲染 + 补 test/render.test.ts
9.  cli/repl.ts + index.ts 接线 + test/repl.test.ts + test/index.test.ts
10. test/pricing.test.ts                    —— 独立，可随时做
11. README / ARCHITECTURE / DECISIONS / EVALUATION
12. 手动冒烟 §12 的 4 项
```

**两个顺序陷阱**：

- **第 5 步必须紧跟第 4 步。** 第 1 步给 `StreamEvent` 加了变体，而 `render.ts` 的最后一个分支是**隐式的 done**（D-M4b-11）—— 从第 4 步起 usage 会真的掉进那个分支，每轮多写一个 `AI: `。这个错误编译不报、只在运行时的输出形状上现形，所以不能带着它往下走。第 5 步之所以「只做一半」（先不碰 `/usage` 表格），是因为表格要等第 7 步的 `CommandResult` 新变体。
- **第 6 步会让 `store.append` 接受新记录类型，但 `repl.ts` 要到第 9 步才真正写它。** 中间几步里这个能力是「已实现但没有调用方」的 —— 这是正常的，不要为了「先用上」而提前接线（那会把落盘逻辑塞到一个还没验证过的位置）。
