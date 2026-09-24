# 验收评估

> 回答：`docs/00-guides.md` 阶段 0 的 6 条验收标准，哪些真的做到了？证据是什么？没做到的计划怎么补？
> 事实来源：`src/` 源码、`test/` 测试、`docs/01-full-design.md` 的增量路线。
> **状态列必须附证据，不接受「已完成」这类无证据的断言。**

- 评估日期：2026-09-24
- 对应路线图：`docs/00-guides.md` 第二十六节「阶段 0 验收」

---

## 质量门（当前）

```text
TypeCheck: PASS  (tsc --noEmit 退出码 0)
Lint:      N/A   (本仓库未配置 linter)
Test:      PASS  (node --test 16/16，退出码 0)
Build:     N/A   (noEmit，Node 直接运行 .ts，无构建产物)
```

---

## 验收项总表

| # | 验收项 | 状态 | 落点 |
| --- | --- | --- | --- |
| 1 | 独立调用 LLM API | ✅ 达标 | M1 |
| 2 | 管理上下文 | ✅ 达标 | M1 |
| 3 | 处理 API 错误 | ⚠️ 部分达标 | M1 最小实现，M6 补全 |
| 4 | 实现 Streaming | ❌ 未做 | M2 |
| 5 | 使用 Structured Output | ❌ 未做 | M5（2026-09-24 补入） |
| 6 | 统计 Token / Cost | ❌ 未做 | M4 |

**整体：2 项达标 / 1 项部分 / 3 项未做。**

M1（本次增量）自身的交付目标 —— **非流式多轮对话 + 最小错误处理** —— 已全部达成并验证。上表的 ❌ 属于后续增量，不是 M1 的欠账。

---

## 1. 独立调用 LLM API — ✅ 达标

**证据**

- `src/llm/deepseek.ts` 用原生 `fetch` 直接 `POST {baseUrl}/chat/completions`，**无 SDK、无框架、零运行时依赖**
- 请求体只带 `model` + `messages`；鉴权走 `Authorization: Bearer`
- 离线断言：`test/deepseek.test.ts`「请求体包含 model 和 messages」校验了 URL、请求体、鉴权头
- 真实网络：2026-09-24 用 `.env.local` 的真实 key 跑通两轮对话

**相关决策**：`DECISIONS.md` D1（手写 fetch 而非 SDK）

---

## 2. 管理上下文 — ✅ 达标

**证据**

- `src/core/session.ts`：`append(role, content)` 累积；`toMessages(systemPrompt)` 组装 `[system, ...历史]`
- 离线断言：
  - `test/session.test.ts`（2 例）—— 按序保存、`system` 在最前
  - `test/repl.test.ts`「多轮对话上下文按序累积」—— 断言第二轮**实际发出的 messages 数组形状**
- 真实网络：第二轮问「用一句话总结刚才的内容」，回答正确复述了第一轮的 React Server Components 主题

**未做（属 M4）**：上下文预算裁剪（64K 软预算、按「轮」裁剪、永不动 `system` 与当前消息）。设计见 `01-full-design.md` §7。

---

## 3. 处理 API 错误 — ⚠️ 部分达标

**已做**

| 场景 | 行为 |
| --- | --- |
| 非 2xx（如 401） | 抛 `DeepSeek API error {status}: {detail}`；防御式取 `error.message`（字段名官方未文档化），取不到则回落原始 body 文本 |
| 错误体不是 JSON（如 502 HTML） | 回落为原始文本，不把 `SyntaxError` 抛出去 |
| `fetch` 抛错（DNS / 连接拒绝） | 原样冒泡，**不被吞成假的空回答** |
| 失败的轮次 | **不追加 assistant 消息**，不伪造回答 |
| 错误输出去向 | **stderr**；stdout 只承载模型回答 |
| 缺 `DEEPSEEK_API_KEY` | stderr 提示 + **退出码 1** |

**离线证据**：`test/deepseek.test.ts`（6 例）、`test/repl.test.ts`（4 例）、`test/index.test.ts`（1 例，子进程断言退出码）

**未做（属 M6）**

- **错误分类**：统一成带 `code` 的 `LLMError`（`invalid_request` / `unauthorized` / `insufficient_balance` / `retryable` / `timeout` / `network` / `unknown`），REPL 按 code 决定提示
- **超时**：首字节超时 + 流空闲超时（各默认 30s）。**不能用单一总时长包住整个流** —— 长回答会被误杀
- **会话回滚**：超时/网络中断时把会话回滚到本轮之前
- **自动重试：明确不做**。理由见 `01-full-design.md` §9 —— 重试会让 token 统计变脏（一次失败重试算几轮？），且重试/熔断属于阶段 6 生产化内容

**相关决策**：`DECISIONS.md` D5（不做自动重试）、D7（失败轮次不写 assistant）、D13（错误走 stderr）

---

## 4. 实现 Streaming — ❌ 未做

**现状**：一次 `fetch` 拿完整回答；`LLMClient.chat()` 返回 `Promise<ChatResult>`。

**目标形态**：在 `chat()` 之外增加 `AsyncIterable<StreamEvent>`，事件为 `text-delta` / `reasoning-delta` / `usage` / `done`；REPL 侧 `for await` 消费。

**实施前必须过的 5 条硬约束**（已核实，见 `01-full-design.md` §6）

1. `stream: true` **必须同时带 `stream_options`**，否则返回 400
2. `usage` **只在最后一个 chunk** 出现，且官方明确**不产生单独的 usage-only chunk** → 中断生成时拿不到 usage
3. SSE 必须**按字节流缓冲解析**：一次 `read()` 可能含多条事件，一条事件可能被 TCP 切成两次 `read()`。解析器要维护残余缓冲、遇空行 dispatch、忽略 `:` 开头的注释行（keep-alive）
4. thinking 默认开启，`delta.reasoning_content` 与 `delta.content` 是**两条独立通道**交替到达
5. thinking 模式下 `temperature` **无效**（默认不传）

**落点**：M2

---

## 5. 使用 Structured Output — ❌ 未做（落点：M5，2026-09-24 补入）

**现状**：完全未实现。

**API 侧已核实**：`response_format: { type: 'text' | 'json_object' }`（`01-full-design.md` §12）。

> ### 路线缺口（已于 2026-09-24 补上）
>
> 本项原本**没有落点**：Structured Output 只被列在 `01-full-design.md` §2 的「进阶能力」，
> 而 §11 的原增量路线 M1–M6 里**没有任何一个 M 包含它** —— 走完全部增量，阶段 0 的这条验收项依然不会达标。
>
> **已处理**：在 `01-full-design.md` §11 中插入新的 **M5**，原 M5 / M6 顺延为 M6 / M7
> （插在「上下文预算」与「错误分类」之间，使「文档补全 + 全量验证」保持在最后）。
> 同时给 §2 的「进阶能力」表补了「落点」列，避免再出现「列了能力但没有增量认领」。
>
> **实施 M5 时至少覆盖**：
>
> - 请求侧传 `response_format`
> - 解析 JSON 响应
> - **JSON 解析失败的降级行为** —— 最容易漏的边界：模型可能返回被 markdown 代码块包住的 JSON（```` ```json ... ``` ````），直接 `JSON.parse` 会炸
> - **`finish_reason: 'length'` 导致 JSON 截断**时的处理 —— 拿到半个对象应该报错还是尽力解析，需要明确决定

---

## 6. 统计 Token / Cost — ❌ 未做

**现状**：不读 `usage` 字段，不累计、不落盘、无 `/usage` 命令。

**设计已就绪**（`01-full-design.md` §8）

- `UsageRecord`：`sessionId / model / timestamp / promptTokens / completionTokens / reasoningTokens / promptCacheHitTokens / promptCacheMissTokens`
- 成本公式：`input cost = miss_tokens × 输入价 + hit_tokens × 输入(cache hit)价`，`output cost = completion_tokens × 输出价`
- `reasoning_tokens` **已含在 `completion_tokens` 里，不做二次计价**
- 单价存低谷/峰值两档，**按峰值取上界**
- **中断时**拿不到 usage → 不记成本，`finish_reason` 记为 `aborted`，并在 `/usage` 标注「有 N 轮生成被中断，成本未计」

**顺序依赖**：`usage` 在流式下只出现在末 chunk，所以这一项与第 4 项（Streaming）耦合 —— 先做 Streaming 更顺。落点 M4。

---

## 维护方式

- **每完成一个 M，或改动任何与验收相关的能力时，更新本文件**，并同步 `docs/01-full-design.md` §11 的路线
- 状态列**必须附证据**（命令 + 实测输出，或指向具体测试用例名），不写无证据的「已完成」
- 若某条验收项**在路线里找不到落点**，像第 5 项那样显式标出来 —— 这是本文件最有价值的用途
