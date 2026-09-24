# ai-chat 完整功能设计

> 本文是 `ai-chat` 的**完整功能蓝图**，记录脑暴阶段确认的全部能力、架构与技术决策。
> 它不按「本次增量」裁剪——覆盖基础能力、命令、进阶能力的全貌，作为后续增量（streaming、结构化输出、token 统计等）的参考依据。
>
> 当前执行范围只有「对话部分」，其 spec 见 `docs/superpowers/specs/2026-09-23-ai-chat-design.md`；本文其余章节对应后续增量。

---

## 1. 目标与背景

在 CLI 模式下实现一个 AI 对话工具，**不使用 LangChain，直接调用 DeepSeek 模型 API**。

它对应学习路线（`docs/00-guides.md` 阶段 0 · 实践项目 1）的第一站，目标是亲手走通这条链路：

```text
LLM API → 消息结构 → 上下文管理 → Streaming → 错误处理 → Token 统计
```

成功标准（阶段 0 验收）：独立调用 LLM API、实现 Streaming、管理上下文、使用 Structured Output、处理 API 错误、统计 Token / Cost。

---

## 2. 完整能力清单（分阶段）

### 基础能力（本次范围）

```text
$ ai-chat

You: 什么是 React Server Components？
AI: ...

You: 总结刚才内容
AI: ...
```

- 非流式多轮对话
- 多轮上下文在内存中累积

### 命令（逐步增加）

| 命令 | 作用 |
|---|---|
| `/clear` | 清空当前会话上下文 |
| `/history` | 查看会话历史 |
| `/model` | 切换 / 查看当前模型 |
| `/usage` | 查看 Token / 成本统计 |

### 进阶能力（然后增加）

| 能力 | 说明 | 落点 |
|---|---|---|
| streaming | SSE 流式输出 | M2 |
| structured output | `response_format` JSON 结构化输出 | M5 |
| conversation history | 会话持久化（JSONL 落盘 + `--resume`） | M3 |
| error handling | 错误分类 + 超时 + 中断回滚 | M6 |
| token statistics | 跨会话 Token 账本与成本估算 | M4 |

### 开关 / 参数

| 参数 | 作用 |
|---|---|
| `--resume <id>` | 恢复指定会话 |
| `-p, --prompt` | 一次性模式，输出后退出 |
| `--model <name>` | 指定模型（默认 `deepseek-flash`） |
| `--no-thinking` | 关闭 thinking，对比延迟与 token 消耗 |
| `--show-reasoning` | 展开显示思考过程全文 |
| `--timeout <sec>` | 首字节 / 流空闲超时（默认 30） |

---

## 3. 完整架构

三层内核，依赖方向严格单向：`cli → core → llm`。

```text
cli/     readline REPL、参数解析、流式渲染、Ctrl+C 处理
  ↓ 只依赖 core 的公开接口
core/    会话状态、上下文组装与预算、Token 账本、命令解析、持久化
  ↓ 只依赖 llm 的公开接口
llm/     DeepSeek adapter、SSE 解析、StreamEvent 归一化、HTTP 错误映射
```

- `llm/` 与 `core/` 不 import `node:readline`、不写 `process.stdout`，只吐事件和返回值。
- 流式输出用 `AsyncIterable<StreamEvent>`（而非回调或 EventEmitter），REPL 侧 `for await` 消费。
- 测试时用 fake `LLMClient` 替换，整个 CLI 行为可在无网络下断言。

### 完整目录结构

```text
demos/01-llm/
  package.json          # type: module；scripts: start / test / typecheck
  tsconfig.json         # strict；noEmit；module: nodenext
  src/
    index.ts            # 入口：解析参数 → REPL 或一次性模式
    cli/
      args.ts           # parseArgs 封装 + usage 文案
      repl.ts           # readline 主循环
      oneshot.ts        # -p 模式
      render.ts         # StreamEvent → stdout
      signals.ts        # SIGINT / SIGTERM 语义
    core/
      types.ts          # Message / StreamEvent / TokenUsage / Turn 等公共类型
      session.ts        # 会话状态：消息数组、当前模型、会话 id
      context.ts        # 上下文组装：预算与裁剪
      ledger.ts         # Token 账本与成本估算
      commands.ts       # /clear /history /model /usage 解析与执行
    llm/
      client.ts         # LLMClient 接口（测试替身接这里）
      deepseek.ts       # DeepSeek adapter：请求构造 / 流解析 / 错误映射
      sse.ts            # 手写 SSE 解析器（纯函数）
      errors.ts         # 错误分类
      pricing.ts        # 单价表 + 成本计算
    store/
      jsonl.ts          # 追加写 / 读取 / 损坏行处理
      paths.ts          # ~/.ai-chat 路径解析 + 会话 id 校验
  test/                 # 与被测模块一一对应的 *.test.ts
  README.md  ARCHITECTURE.md  HOW-IT-WORKS.md  DECISIONS.md  EVALUATION.md
```

---

## 4. CLI 契约（完整）

```text
ai-chat                          进入 REPL，新建会话
ai-chat --resume <id>            恢复指定会话
ai-chat -p, --prompt "问题"       一次性模式：输出回答后退出
ai-chat --model <name>           默认 deepseek-flash
ai-chat --no-thinking            关闭 thinking
ai-chat --show-reasoning         显示思考过程全文
ai-chat --timeout <sec>          首字节 / 流空闲超时，默认 30
ai-chat --help | --version
```

环境变量：

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 必需 |
| `DEEPSEEK_BASE_URL` | 可选，默认 `https://api.deepseek.com` |
| `AI_CHAT_HOME` | 可选，默认 `~/.ai-chat`（为可测性预留，测试指向临时目录） |

退出码：`0` 正常 / `2` 参数错误 / `1` 运行时错误（认证、网络、余额）。

---

## 5. 消息结构与 StreamEvent

### 消息结构（核心学习点）

直接对接 OpenAI-compatible 消息数组：

```ts
type Role = 'system' | 'user' | 'assistant';
interface Message { role: Role; content: string }
```

- `system`：一条固定提示，作为稳定前缀（也让 prompt cache hit 生效）。
- DeepSeek 特有：响应里 `message.content` 是最终回答，`message.reasoning_content` 是思考过程（thinking 默认开启）。默认折叠不显示，`--show-reasoning` 展开。

### StreamEvent（llm 层吐出的事件）

```ts
type StreamEvent =
  | { type: 'text-delta';      text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'usage';           usage: TokenUsage }
  | { type: 'done';            reason: FinishReason }
```

---

## 6. 流式协议要点（5 条硬约束）

全部来自 DeepSeek 官方文档，是 `deepseek.ts` + `sse.ts` 的验收清单：

1. ~~**`stream: true` 必须同时带 `stream_options`**，否则返回 400。~~
   **（2026-09-24 更正：原文写反了。）** 依赖方向是反的：**`stream_options` 必须先有 `stream: true`**，
   单独传 `stream_options` 才返回 400。官方文档**没有**任何地方要求流式必须带 `stream_options`。
   因此只传 `stream: true` 是合法的，`stream_options` 只在要 `include_usage` 时才需要。
2. **`usage` 只在最后一个 chunk 出现**，且官方明确**不产生单独的 usage-only chunk**；中断生成时拿不到 usage。
3. **SSE 必须按字节流缓冲解析**：一次 `read()` 可能含多条事件，一条事件可能被 TCP 切成两次 `read()`。解析器维护残余缓冲、遇空行 dispatch、忽略 `:` 开头的注释行（keep-alive）。
4. **thinking 默认开启**，`delta.reasoning_content` 与 `delta.content` 是两条独立通道交替到达；`reasoning_tokens` 计入 `completion_tokens`。
5. **thinking 模式下 `temperature` 无效**，`max_tokens` 默认值也不同（非 thinking 8K / thinking 64K / `reasoning_effort=max` 时 128K）。默认不传 `temperature`。

**超时**不能用单一总时长包住整个流（长回答会被误杀），拆成：首字节超时（默认 30s）+ 流空闲超时（两个 chunk 间隔超 30s 判定死亡）。

---

## 7. 上下文管理

- 系统提示词固定一条，不随会话变化（稳定前缀，利于 cache hit）。
- 组装上下文 = `[system, ...裁剪后的历史, 当前 user 消息]`。
- 软预算（默认 64K token）：超过时从最老消息开始丢，永不动 `system` 和当前消息；裁剪原子单位是「轮」（user+assistant 一对），绝不拆半条消息。
- 无精确 tokenizer 时用估算：`tokens ≈ chars / 4`（中文约 1.5 字符/token，英文约 4，取 4 作保守上界）。**不引入 tiktoken 依赖**；估算只用于预算决策，最终以 API 返回的 `prompt_tokens` 为准。
- DeepSeek 是 1M 上下文，64K 预算几乎不会命中，但「多轮超出窗口该丢什么」是阶段 0 必须掌握的，故保留此模块并有测试。

---

## 8. Token 账本与成本

### UsageRecord

```ts
{ sessionId, model, timestamp,
  promptTokens, completionTokens, reasoningTokens,
  promptCacheHitTokens, promptCacheMissTokens }
```

### 成本计算

```text
input cost  = miss_tokens × 输入价 + hit_tokens × 输入(cache hit)价
output cost = completion_tokens × 输出价
```

- 输入按 cache hit / miss 拆档，对应 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。
- `reasoning_tokens` 已含在 `completion_tokens` 里，**不做二次计价**。
- 单价存 off-peak / peak 两档，按峰值取上界。
- `/usage` 分「当前会话累计」与「跨会话累计」（后者来自 JSONL 落盘）。
- 落盘与会话消息同一次追加写，保证不丢不错位。
- **中断时**：拿不到 usage，不记成本，`finish_reason` 记为 `aborted`，并在 `/usage` 标注「有 N 轮生成被中断，成本未计」。

---

## 9. 错误处理

统一映射成 `LLMError`，带机器可判的 `code`，REPL 按 code 决定提示：

| 场景 | code | 行为 |
|---|---|---|
| 400 / 422 | `invalid_request` | 打印服务端 hint，不重试 |
| 401 | `unauthorized` | 提示检查 `DEEPSEEK_API_KEY` |
| 402 | `insufficient_balance` | 提示充值 |
| 429 / 500 / 503 | `retryable` | 提示稍后重试，**v1 不自动重试** |
| 首字节/流超时 | `timeout` | 提示超时，会话回滚到本轮之前 |
| 网络中断 | `network` | 同上 |
| 非 2xx 且无 `error` 字段 | `unknown` | 打印原始状态码 + 截断 body |

- **v1 不自动重试**：重试/熔断属于阶段 6 生产化内容；且自动重试会让 token 统计变脏（一次失败重试算几轮？）。先做到忠实分类 + 干净失败。
- **错误响应体防御式解析**：官方未给错误 body 字段名，按 `error.message` / `error.code` / `message` 逐层尝试，都不取到则归 `unknown`。

---

## 10. 测试策略

按「离修改最近的测试优先」分层：

| 层 | 对象 | 关键用例 |
|---|---|---|
| `llm/sse.ts` | SSE 解析纯函数 | 一条多事件、事件跨 read 分片、注释行、`[DONE]`、半条 `data:` 残留 |
| `llm/deepseek.ts` | adapter | mock fetch 验证请求体、thinking 双通道顺序、usage 只在末 chunk、错误映射 |
| `llm/pricing.ts` | 单价/成本 | 峰值/低谷、cache 拆档、reasoning 不重复计价 |
| `core/context.ts` | 预算裁剪 | 未超不裁、按整轮裁、system 与当前消息永不裁 |
| `core/ledger.ts` | 账本 | 累加、跨会话汇总、中断标注 |
| `core/commands.ts` | 命令 | `/clear`、`/model` 非法名、`/usage` 空会话 |
| `store/jsonl.ts` | 持久化 | 追加读回一致、损坏行跳过、非目录路径报错 |

- **集成测试（无网络）**：`oneshot.ts` 注入 fake `LLMClient`，断言标准输出与退出码。
- **验收冒烟（真实网络，手动）**：一条真实 API 端到端（streaming + thinking + 一轮 usage 落盘），不进 CI 自动化。

---

## 11. 增量交付路线

```text
M1 对话部分（本次）：非流式多轮 + 最小错误处理
M2 streaming + /clear /model /history
M3 会话落盘 + --resume + 跨会话账本
M4 /usage + --no-thinking + --show-reasoning + 上下文预算
M5 structured output：response_format json_object + JSON 解析 + 包裹/截断的降级处理
M6 错误分类 + 超时 + 一次性 -p 模式 + 退出码
M7 文档补全 + 手动冒烟 + 全量验证
```

> **M5 是 2026-09-24 补入的。** 原因：structured output 是 `docs/00-guides.md` 第二十六节
> 阶段 0 验收的六条之一，但原路线 M1–M6 里没有任何一个 M 覆盖它 ——
> 走完全部增量仍然不达标。详见 `EVALUATION.md` 第 5 项。
> 补入时插在 M4 与「错误分类」之间并顺延了后续编号，使「文档补全 + 全量验证」保持在最后。

每个 M 结束后都能 `tsc --noEmit` + `node --test` 全绿。

---

## 12. DeepSeek API 事实汇总

（脑暴阶段已核实，供后续增量直接引用，避免凭记忆。）

### 模型

| 模型 | 版本 | 上下文 | 最大输出 | 并发 |
|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1M | 384K | 2,500 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 384K | 500 |

- 两者均支持 thinking / non-thinking，thinking 默认开启。
- Vision：`deepseek-flash` 支持，`deepseek-v4-pro` 不支持。
- 旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已退役（请求仍被服务，按 Flash 计价）。

### 价格（per 1M tokens）

| 模型 | 分类 | 低谷 | 峰值 |
|---|---|---|---|
| deepseek-flash | 输入 cache hit | $0.003 | $0.006 |
| deepseek-flash | 输入 cache miss | $0.15 | $0.3 |
| deepseek-flash | 输出 | $0.6 | $1.2 |
| deepseek-v4-pro | 输入 cache hit | $0.022 | $0.044 |
| deepseek-v4-pro | 输入 cache miss | $0.66 | $1.32 |
| deepseek-v4-pro | 输出 | $1.98 | $3.96 |

- 低谷 = 峰值的一半；峰值窗口 UTC 周一至周五 01:00–04:00 与 06:00–10:00（不含中国法定节假日）。

### 接口

- Base URL：`https://api.deepseek.com`（OpenAI 格式）；`https://api.deepseek.com/anthropic`（Anthropic 格式）。
- 端点：`POST /chat/completions`。
- 消息角色：`system` / `user` / `assistant` / `tool`；content 可为字符串或数组（`text` / `image_url` / `file`）。
- `thinking`：`{ type: 'enabled' | 'disabled' }`；`reasoning_effort`：`none/low/high/max`。
- `max_tokens`：1–384K；默认非 thinking 8K / thinking 64K / `reasoning_effort=max` 时 128K。
- `temperature`：≤2，默认 1，thinking 模式无效。
- `stream_options.include_usage`：**可选**，不是流式的必填项。为 `true` 时每个 chunk 都带 `usage` 字段，除最后一个外均为 `null`；不传它时 `usage` 只在最后一个 chunk 出现。两种情况下都**不产生单独的 usage-only chunk**，统计搭载在末个内容 chunk 上（该 chunk 的 `choices` 只有一个元素，不带新内容、只带非 null 的 `finish_reason`）。
- `response_format`：`{ type: 'text' | 'json_object' }`。
- `finish_reason`：`stop` / `length` / `content_filter` / `tool_calls` / `insufficient_system_resource` / `aborted`。
- `usage`：`prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details.{cached_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens}`、`completion_tokens_details.reasoning_tokens`。

### 错误码

| 码 | 含义 | 建议 |
|---|---|---|
| 400 | 请求体格式错误 | 按提示修正 |
| 401 | 认证失败 | 检查 API key |
| 402 | 余额不足 | 充值 |
| 422 | 参数无效 | 按提示调整 |
| 429 | 触发限流 | 放慢请求节奏 |
| 500 | 服务端错误 | 稍后重试 |
| 503 | 服务过载 | 稍后重试 |

> 官方未给出错误响应体的字段名，解析须防御式处理。
