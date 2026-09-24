# DeepSeek API 事实汇总

> 查表用。设计叙述见 `ARCHITECTURE.md`，坑与解法见 `troubleshooting.md`。
> 来源：原 01-llm 完整蓝图 §12（现 `archive/01-llm/01-full-design.md`），2026-09-24 迁出。

（脑暴阶段已核实，供后续增量直接引用，避免凭记忆。）

## 模型

| 模型 | 版本 | 上下文 | 最大输出 | 并发 |
|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1M | 384K | 2,500 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 384K | 500 |

- 两者均支持 thinking / non-thinking，thinking 默认开启。
- Vision：`deepseek-flash` 支持，`deepseek-v4-pro` 不支持。
- 旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已退役（请求仍被服务，按 Flash 计价）。

## 价格（per 1M tokens）

| 模型 | 分类 | 低谷 | 峰值 |
|---|---|---|---|
| deepseek-flash | 输入 cache hit | $0.003 | $0.006 |
| deepseek-flash | 输入 cache miss | $0.15 | $0.3 |
| deepseek-flash | 输出 | $0.6 | $1.2 |
| deepseek-v4-pro | 输入 cache hit | $0.022 | $0.044 |
| deepseek-v4-pro | 输入 cache miss | $0.66 | $1.32 |
| deepseek-v4-pro | 输出 | $1.98 | $3.96 |

- 低谷 = 峰值的一半；峰值窗口 UTC 周一至周五 01:00–04:00 与 06:00–10:00（不含中国法定节假日）。

## 接口

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

## 错误码

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
