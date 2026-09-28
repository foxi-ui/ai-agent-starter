# 验收评估

> 回答：`docs/ROADMAP.md` 阶段 0 的 6 条验收标准，现在达标到什么程度？
> 事实来源：`src/` 源码与 `test/` 测试。
> **状态必须附证据，不接受「已完成」这类无证据的断言。**

## 质量门

```text
TypeCheck: PASS  (tsc --noEmit 退出码 0)
Lint:      N/A   (本仓库未配置 linter)
Test:      PASS  (node --test 302/302，退出码 0)
Build:     N/A   (noEmit，Node 直接运行 .ts，无构建产物)
```

## 验收项

- [x] **独立调用 LLM API** —— M1
- [x] **管理上下文** —— M1
- [ ] **处理 API 错误** —— 部分达标：M1 最小实现，M6 补全
- [x] **实现 Streaming** —— M2
- [ ] **使用 Structured Output** —— 未做，落点 M5。**它原本没有任何落点**，见第 5 项
- [x] **统计 Token / Cost** —— M4b

**整体：4 项达标 / 1 项部分 / 1 项未做。**

M1 自身的交付目标 —— **非流式多轮对话 + 最小错误处理** —— 已全部达成并验证。
上表的未做项属于后续增量，不是 M1 的欠账。

## 证据

### 1. 独立调用 LLM API（M1，达标）

- `src/llm/deepseek.ts` 用原生 `fetch` 直接 `POST {baseUrl}/chat/completions`，**无 SDK、零运行时依赖**；
  请求体只带 `model` + `messages`（流式多一个 `stream: true`）；鉴权走 `Authorization: Bearer`
- 离线：`test/deepseek.test.ts`「请求体包含 model 和 messages」校验了 URL、请求体、鉴权头
- 真实网络：用 `.env.local` 的真实 key 跑通两轮对话

### 2. 管理上下文（M1，达标）

- `src/core/session.ts`：`append(role, content)` 累积；`toMessages(systemPrompt)` 组装 `[system, ...历史]`
- 离线：`test/session.test.ts`（6 例）断言按序保存与 `system` 在最前；
  `test/repl.test.ts`「多轮对话上下文按序累积」断言第二轮**实际发出的 messages 数组形状**
- 真实网络：第二轮问「用一句话总结刚才的内容」，回答正确复述了第一轮的 React Server Components 主题
- **上下文预算裁剪（M4a）**：`src/core/context.ts` 的 `fitToBudget` 在超预算时从最老的
  **整轮**开始丢，`system` 与当前问题永不裁；裁剪**只影响本次请求**，会话与磁盘仍是完整历史
  （D43）。离线：`test/context.test.ts`（估算公式、分组的两处边界、永不裁的两条规则、
  单条超预算不裁），以及 `test/repl.test.ts`「maxContext 生效：发给模型的是裁过的，
  落盘的仍是完整历史」——后者才测得到接线有没有接错。
- **真实网络（2026-09-28）**：`--max-context 30` 跑六轮「只回答数字」的问答，
  stderr 从第二轮起逐轮出现 `[上下文] 已裁剪 2 / 4 / 6 / 8 / 10 条最早的消息`；
  会话文件仍是 **meta + 12 条 message = 13 行**的完整历史；最后一问答对（6+6 → 12），
  说明当前问题确实没被裁掉。这一次同时验证了裁剪生效、警告只一行、以及**不回写会话**。

### 3. 处理 API 错误（M1 最小实现，部分达标）

| 场景 | 行为 |
| --- | --- |
| 非 2xx（如 401） | 抛 `DeepSeek API error {status}: {detail}`；防御式取 `error.message`（字段名官方未文档化），取不到则回落原始 body 文本 |
| 错误体不是 JSON（如 502 HTML） | 回落为原始文本，不把 `SyntaxError` 抛出去 |
| `fetch` 抛错（DNS / 连接拒绝） | 原样冒泡，**不被吞成假的空回答** |
| 失败的轮次 | **不追加 assistant 消息**，不伪造回答 |
| 错误输出去向 | **stderr**；stdout 只承载模型回答**与命令结果**（见 D26） |
| 缺 `DEEPSEEK_API_KEY` | stderr 提示 + **退出码 1** |

- 离线：`test/deepseek.test.ts`（23 例）、`test/repl.test.ts`（15 例）、`test/index.test.ts`（1 例）

**未做（属 M6）**：错误分类（统一成带 `code` 的 `LLMError`）；非流式的首字节超时与 `--timeout` 开关
（**不能用单一总时长包住整个流** —— 长回答会被误杀；流侧的空闲超时已随 M2a 落地，见 D21）；
超时/中断时的会话回滚。**自动重试明确不做**（D5）。

### 4. 实现 Streaming（M2，达标）

- `src/llm/sse.ts` 手写 SSE 分帧（纯函数），覆盖一次多事件、事件跨两次 read、注释行、
  多行 data、`\r\n` 跨块、`[DONE]`、半条事件残留 —— `test/sse.test.ts`
- `chatStream()` 把 chunk 归一化成 `StreamEvent`，覆盖事件序列、末 chunk 的 `finish_reason`、
  `[DONE]` 兜底、非 2xx、空闲超时、坏 JSON 跳过、**多字节字符被切在两次 read 之间不乱码**
  —— `test/deepseek.test.ts`
- `src/cli/render.ts` 把事件渲染到 stdout/stderr；`test/render.test.ts` 覆盖分流规则
- **真实网络**：
  `printf '用一句话说明什么是闭包\n' | pnpm --silent start 1>out.txt 2>err.txt`（`exit=0`）——
  stdout 为 `You: AI: 闭包是函数与其定义时所处词法作用域的组合——…外部变量。`，
  后接一个**无换行**的 `You: ` 提示符；stderr **恰好**一行 `[思考中…]`；stdout 不出现思考文字。
  这一次同时验证了分流、`AI: ` 前缀与 D15 的输出形状

**已做（M4a）**：`--show-reasoning` 展开思考全文、`--no-thinking` 关闭 thinking。
两者都只改**渲染策略与请求体**，不动 `llm/` 层的事件归一化 ——
`reasoning-delta` 从 M2a 起就一直在吐（D18 / D22）。
- 离线：`test/render.test.ts`（展开全文、无 reasoning 时不写前缀、stdout 绝不含思考文字）、
  `test/deepseek.test.ts`（`thinking:false` 才带 `disabled` 字段，两个方法都覆盖）、
  `test/repl.test.ts`（开关透传进 `ChatOptions`）
- **真实网络（2026-09-28）**：`--show-reasoning` 下 stderr 出现 `[思考] The user asks in
  Chinese: …` 全文，而 stdout 只有 `You: AI: <回答>`；`--no-thinking` 下 stderr
  **连 `[思考中…]` 都没有**（只有 `[session]` 一行），确认 thinking 真的被关掉了。
  冲突组合 `--no-thinking --show-reasoning` 与非法 `--max-context` 都是 stderr 一行
  错误 + 一行用法，退出码 1

### 5. 使用 Structured Output（未做，落点 M5）

**现状**：完全未实现。

**API 侧已核实**：`response_format: { type: 'text' | 'json_object' }`（见 `docs/deepseek-api-facts.md`）。

> **路线缺口（已处理）**
>
> 本项原本**没有落点**：Structured Output 只被列在「进阶能力」里，而原增量路线 M1–M6
> **没有任何一个 M 包含它** —— 走完全部增量，阶段 0 的这条验收项依然不会达标。
>
> **已处理**：在增量路线中插入新的 **M5**，原 M5 / M6 顺延为 M6 / M7
> （插在「上下文预算」与「错误分类」之间，使「文档补全 + 全量验证」保持在最后）。
>
> **M5 达标必须覆盖这几条**（即本项未来的验收边界）：
>
> - 请求侧传 `response_format`
> - 解析 JSON 响应
> - **JSON 解析失败的降级行为** —— 最容易漏的边界：模型可能返回被 markdown 代码块
>   包住的 JSON（```` ```json ... ``` ````），直接 `JSON.parse` 会炸
> - **`finish_reason: 'length'` 导致 JSON 截断**时的处理 —— 拿到半个对象应该报错还是
>   尽力解析，需要明确决定

### 6. 统计 Token / Cost（**达标**，M4b）

- **实现**：`usage` 从末 chunk 解析成 `StreamEvent` 的第 4 个变体（先于 `done`），
  成功轮次连同**记账时刻**与**裁剪后的上下文估算**记进 `core/usage.ts` 的账本，
  并向 `.sessions/*.jsonl` 追加一行 `{ type: 'usage' }`；`/usage` 按
  **高峰/空闲**两档（含 2026 法定节假日表与调休表）估算人民币金额
- **证据（自动化）**：`test/usage.test.ts`（时段判断 15 条 + 计价与账本 22 条）、
  `test/deepseek.test.ts`（usage 解析 11 条，含「先于 done」的顺序断言）、
  `test/journal.test.ts`（usage 记录的格式契约与回放）、
  `test/render.test.ts`（`/usage` 表格与口径行）、
  `test/repl.test.ts`（成功才记账、落盘失败共用降级）、
  `test/index.test.ts`（`--resume` 后账本接得上）
- **证据（2026-09-28 实测，真实网络）**：
  - **设计前提成立**：请求体**不传** `stream_options` 也能在末 chunk 拿到非零
    `usage`（单轮：输入 44 / 输出 139）
  - `--resume` 一个含 3 行 usage 的会话，`/usage` 报 3 轮、合计与原落盘一致；
    续一轮后变 4 轮（`¥0.00319` → `¥0.00427`）
  - `--no-thinking` 下 `reasoningTokens` 为 0
  - **偏差实测**：`--no-thinking` 单轮「估算 19 / 真实 19（+0.0%，与真实一致）」；
    thinking 模式下同一输入是「估算 19 / 真实 44（**-56.8%，估算偏激进**）」
    —— 估算器只数可见文本，**thinking 模式会在提示词里加一段固定开销**
    （实测约 25 token），短上下文下这段开销主导，于是估算反而偏小。
    这正是本项要**暴露**而不是**掩盖**的东西：`/usage` 只显示偏差，不回写估算公式（D61）
  - `命中缓存` 在短提示词下恒为 0：系统提示只有约 19 token，远低于服务端的
    缓存粒度。**这不是统计出错**，而且已用一次长前缀实验排除掉「字段名没认出来」
    这个同样会表现为 0 的原因 —— 把首条消息填到约 460 token 后，第 1 轮命中 0、
    **第 2 轮命中 256**。字段名是对的，缓存也确实会生效，只是需要足够的长度
  - 同一批长上下文实验里，偏差变成「估算 1,058 / 真实 946（**+11.8%，估算偏保守**）」
    —— 固定开销被摊薄之后，M4a 的除数 1.5 确实偏保守。这条**支持** D61
    （只显示偏差、不回头拟合公式）：两个方向都出现过，说明偏差由上下文长度决定，
    不是公式本身的常数偏差
- **已知边界**：中断的轮次不计入（拿不到 usage，宁缺毋滥）；节假日表只覆盖 2026 年，
  超出范围会打印提示；金额是估算，未经账单核对
- 所需的模型与价目事实见 [`docs/deepseek-api-facts.md`](docs/deepseek-api-facts.md)

## 测试 ↔ 行为映射

上表每一行都有对应测试，且全部不需要网络：

| 行为 | 测试 |
| --- | --- |
| 消息按序累积、`system` 在最前 | `test/session.test.ts` |
| SSE 分帧：一次多事件、事件跨两次 read、注释行、多行 data、`\r\n` 跨块、半条事件残留 | `test/sse.test.ts`（纯函数，喂字符串） |
| 请求体 / 响应解析 / 401 抛错 / 空 content / fetch 抛错 / 非 JSON 错误体 / 流式事件序列、末 chunk 的 `finish_reason`、空闲超时、多字节切分 | `test/deepseek.test.ts`（mock `globalThis.fetch`） |
| 正文走 stdout、思考指示与截断警告走 stderr、`finish` 只补一个换行 | `test/render.test.ts`（注入两条流） |
| 一问一答、错误写 stderr 不污染 stdout、报错后继续、多轮上下文形状 | `test/repl.test.ts`（fake `LLMClient`） |
| 命令解析三态（none / known / unknown）、`/clear` `/history` `/model` 的执行结果、`/model` 查询分支不写 `session.model` | `test/commands.test.ts`（纯函数，直接调 `parseCommand` / `executeCommand`） |
| 缺 key 抛错、默认值、环境变量覆盖 | `test/config.test.ts` |
| 缺 key 时 stderr 提示 + 退出码 1 | `test/index.test.ts`（子进程集成测试） |
| JSONL 记录的两向格式契约、坏行/未知 type 跳过、回放（`clear` 清消息不清模型、meta 定初始、model 覆盖）、id 生成与白名单 | `test/journal.test.ts`（纯函数，喂字符串） |
| 会话文件读写：meta 独占创建不覆盖、append 追加、load 的坏行计数与 ENOENT/EISDIR 之分、list 的倒序与条数、路径穿越被拒 | `test/store.test.ts`（**真临时目录，不 mock `node:fs`**） |
| `--resume` 参数解析：缺值 / 非法 id / 多余参数 / 未知参数各自抛错并附用法 | `test/args.test.ts`（纯函数） |
| 变更广播：三个变更点各广播一次、只读操作零广播、构造时铺入 history **不**广播 | `test/session.test.ts` |
| 落盘接线与降级：一轮两条记录、`/clear` `/model` 也落盘、写盘失败只警告一次且对话继续 | `test/repl.test.ts`（记录型假 store） |
| `/sessions` 列表渲染：`*` 标记、时间列就地切片、空表提示 | `test/render.test.ts` |
| 启动分支：退出码 1 的四种情况、新会话落盘恰一行 meta、resume **不改动日志长度**、坏行警告、模型回落 | `test/index.test.ts`（子进程集成测试） |
| 上下文估算与裁剪：除数方向、按整轮分组、`system`/最后一组永不裁、单条超预算不裁、失败轮次与开头残余的分组 | `test/context.test.ts`（纯函数） |
| 三个开关的参数解析：互斥、`--max-context` 的八种非法输入、顺序无关、布尔幂等、`--resume` 重复给报错 | `test/args.test.ts`（纯函数） |
| 思考的两种渲染模式与流向（stdout 绝不含思考文字）；请求体的 `thinking` 只在关闭时出现 | `test/render.test.ts`、`test/deepseek.test.ts` |
| 裁剪接线：发给 client 的被裁、落盘的是完整历史、警告恰一行；三个开关透传 | `test/repl.test.ts`（记录型假 client / 假 store） |
| 时段判断：工作日两个高峰窗口的左右边界、午休与深夜、周末、法定节假日、调休上班日、超出 2026 的范围、无效时刻不抛错；两张表的数据自证（33 天 / 6 天 / 全在周末 / 不重叠） | `test/usage.test.ts`（纯函数，喂 UTC 时刻断言档位） |
| 计价与账本：三档单价独立计入、空闲恰为高峰一半、命中便宜 50 倍、思考不重复计、未知模型返回 `null`、未定价模型不与合计混、按每条记录**当时**的时段计价、`at` 是坏字符串时不抛错、`list()` 深拷贝 | `test/usage.test.ts`（纯函数） |
| usage 解析：末 chunk 的 usage 产出事件且**先于 done**、与 done 同 chunk 的顺序、无 usage 时不产事件、字段缺失/类型不对全填 0、命中数大于输入时未命中不为负、`total_tokens` 缺失时补齐、请求体不带 `stream_options`；非流式 `chat()` 的 `usage` 与「没拿到用 `undefined`」 | `test/deepseek.test.ts`（mock `globalThis.fetch`） |
| `/usage` 渲染：空账本的提示、表头与数据行显示宽度一致（中文占 2 列）、金额 5 位小数、未定价显示 `—`、口径行、节假日表过期提示 | `test/render.test.ts`（注入 stdout） |

```bash
pnpm test
```

**为什么退出码要用子进程测**：退出码是**进程级**行为。`resolveConfig` 的单元测试只能断言
「会抛错」，断言不了「进程最终以 1 退出」—— 把 `process.exit(1)` 改成 `throw`，
单元测试依然全绿，而脚本与 CI 的判断依据已经坏了。这些用例都不触网：退出码为 1 的那几种
情况都发生在发起任何网络请求之前，其余用例则让 stdin 立刻结束（不产生对话）或只跑
`/model` 这类纯查询命令，因此不会让测试变慢或不稳定。**它们也全部把 `AI_CHAT_HOME`
指向各自的临时目录**，不会碰仓库里的 `.sessions/`。

## 相关决策

`DECISIONS.md` D1（手写 fetch 而非 SDK）、D5（不做自动重试）、D7（失败轮次不写 assistant）、
D13（错误走 stderr）、D21（流空闲超时）、D26（命令结果走 stdout）、
D39（估算除数取 1.5）、D43（裁剪不回写会话）、D44（思考走 stderr）、D49（`thinking` 是 boolean）、
D50–D65（M4b 的 16 条：usage 事件与顺序、账本落盘与峰谷计价、未知模型不猜单价、
`/usage` 的口径行、价目表一致性测试、`/clear` 不清账本、不经 Session 广播等）

## 维护方式

- **每完成一个 M，或改动任何与验收相关的能力时，更新本文件**
- 状态**必须附证据**（命令 + 实测输出，或指向具体测试用例名），不写无证据的「已完成」
- 若某条验收项**在路线里找不到落点**，像第 5 项那样显式标出来 —— 这是本文件最有价值的用途
