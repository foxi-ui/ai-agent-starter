# ai-chat 对话部分 · 设计文档

- 日期：2026-09-23
- 状态：待 review
- 范围：仅「对话部分」（多轮非流式对话）。其余能力后续循序渐进实现，本文件不展开。

---

## 1. 背景与目标

`ai-chat` 是学习路线（`docs/00-guides.md` 阶段 0 · 实践项目 1）的第一个项目。

目标：在 CLI 模式下实现一个 AI 对话工具，**不使用 LangChain，直接调用 DeepSeek 模型 API**，亲手走通「LLM API → 消息结构 → 上下文管理」这条链路的起点。

本次只设计并实现**对话部分**：

```text
$ ai-chat

You: 什么是 React Server Components？

AI: ...

You: 总结刚才内容

AI: ...
```

成功标准（本次范围）：

- 能直接调用 DeepSeek API 完成一问一答
- 多轮上下文在内存中累积，「总结刚才内容」能引用上一轮
- 消息结构正确（`system` / `user` / `assistant` 三种 role 与 `content`）
- API 报错不崩溃，打印错误后继续对话

---

## 2. 范围界定

### 本次范围（对话部分）

- CLI REPL：读一行 → 调 API → 打印回答 → 循环
- 多轮上下文：消息在进程内存中累积
- 非流式调用：一次 fetch 拿完整回答
- 最小错误处理：报错打印、不崩溃

### 明确推迟（后续循序渐进实现，本次不实现、不设计细节）

- streaming（SSE 解析、`StreamEvent` 归一化）
- 命令：`/clear` `/history` `/model` `/usage`
- structured output（`response_format`）
- token 统计 / 成本账本（`usage`）
- 会话持久化（JSONL 落盘、`--resume`）
- 上下文预算裁剪
- 正式的 error handling 分类与重试
- 开关：`--no-thinking` `--show-reasoning` `--timeout` 等
- 一次性模式 `-p`

---

## 3. 架构

三层内核，依赖方向严格单向：`cli → core → llm`。

```text
cli/     readline 主循环、打印
  ↓ 只依赖 core 的公开接口
core/    会话状态、消息组装
  ↓ 只依赖 llm 的公开接口
llm/     DeepSeek adapter、请求构造、响应解析
```

- `llm/` 与 `core/` 不 import `node:readline`、不写 `process.stdout`。
- 边界是接口 `LLMClient`，测试时用替身替换，使整个 CLI 行为可在无网络下断言。
- 该骨架为后续增量（streaming / 命令 / 落盘）预留了挂载点，无需返工。

## 4. 目录结构

```text
demos/01-llm/
  package.json          # type: module；scripts: start / test / typecheck
  tsconfig.json         # strict；noEmit；module: nodenext
  src/
    index.ts            # 入口：无参数 → 进 REPL
    cli/repl.ts         # readline 主循环 + 打印
    core/types.ts       # Message 类型
    core/session.ts     # 会话：消息数组、append、toMessages
    llm/client.ts       # LLMClient 接口（测试替身接这里）
    llm/deepseek.ts     # DeepSeek adapter：非流式调用 + 解析
  test/
    session.test.ts
    deepseek.test.ts
  README.md
  ARCHITECTURE.md
  HOW-IT-WORKS.md
  DECISIONS.md
```

## 5. 核心数据流

一轮对话的生命周期：

```text
readline 读一行
  → session.append(user)
  → messages = [system, ...session 历史]
  → deepseek.chat({ model, messages })      # POST /chat/completions，非流式
  → 取 choices[0].message.content 打印
  → session.append(assistant)
  → 回到读下一行
```

- `session` 保存消息数组，`toMessages(systemPrompt)` 组装 `[system, ...历史]`。
- 上下文只在进程内存中，进程退出即清空（持久化属于后续增量）。

## 6. 消息结构（核心学习点）

直接对接 OpenAI-compatible 消息数组：

```ts
type Role = 'system' | 'user' | 'assistant';
interface Message { role: Role; content: string; }
```

- `system`：一条固定提示，简短说明「这是 CLI AI 助手」，作为稳定前缀。
- `user` / `assistant`：按对话顺序交替追加。

DeepSeek 特有知识点（文档中写清，本次只抑制不展开）：

- 响应里 `message.content` 是最终回答，`message.reasoning_content` 是思考过程（thinking 默认开启）。
- 本次只打印 `content`，`reasoning_content` 存在但被抑制不显示。

## 7. DeepSeek API 契约（非流式）

- 端点：`POST {base_url}/chat/completions`，`base_url` 默认 `https://api.deepseek.com`。
- 请求体：`{ model, messages }`（本次不传 `stream`、`thinking`、`temperature` 等）。
- 响应（200）：`choices[0].message.content`（字符串）。
- 模型：固定 `deepseek-flash`（最便宜，适合反复调试），作为常量 + 可被环境变量 `AI_CHAT_MODEL` 覆盖。

## 8. 错误处理（最小）

正式分类与重试推迟；本次只做不崩溃：

- 启动时缺 `DEEPSEEK_API_KEY` → 明确提示后退出（退出码 1）。
- fetch 抛错 / 非 2xx → 打印错误到 stderr，**不追加失败的 assistant 消息**，继续 REPL 循环。

## 9. 配置与环境变量

- `DEEPSEEK_API_KEY`（必需）
- `DEEPSEEK_BASE_URL`（可选，默认 `https://api.deepseek.com`）
- `AI_CHAT_MODEL`（可选，默认 `deepseek-flash`）

## 10. 测试策略

无网络，用 fake `LLMClient` / mock fetch：

- `session.test.ts`：append 顺序正确；`toMessages` 组装出 `[system, ...历史]`。
- `deepseek.test.ts`：请求体正确（`model` + `messages`）；成功解析出 `content`；`reasoning_content` 被抑制；非 2xx 抛错。

## 11. 工具链

- Node 22 原生类型擦除直接运行：`node src/index.ts`。
- TypeCheck：`tsc --noEmit`。
- 测试：`node --test`。
- 零运行时依赖；devDependency 仅 `typescript` + `@types/node`。

## 12. 后续增量路线（简述，仅参考）

增量路线的**唯一事实来源**是 `EVALUATION.md` 的「增量路线」一节，此处不再复制一份 ——
曾因 spec / 计划 / 蓝图各存一份 M 列表，补入 structured output 时出现编号漂移。

本次（M1）的范围是**非流式多轮对话 + 最小错误处理**；其余能力各自的落点见该文件。

## 13. 验收

- TypeCheck：`tsc --noEmit` 通过
- Test：`node --test` 全绿
- 手动冒烟：真实 `DEEPSEEK_API_KEY` 下端到端跑通多轮对话（「总结刚才内容」能引用上一轮）
