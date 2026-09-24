# ai-chat

CLI 模式下的 AI 对话工具，**不使用 LangChain，直接调用 DeepSeek 模型 API**。

对应学习路线的第一站，目标是亲手走通这条链路的起点：

```text
LLM API → 消息结构 → 上下文管理 → Streaming → 错误处理 → Token 统计
```

> **当前范围：仅「对话部分」**——非流式多轮对话 + 最小错误处理。
> 完整功能蓝图（streaming、命令、落盘、token 统计等）见 [`docs/01-full-design.md`](docs/01-full-design.md)。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node | ≥ 22（依赖原生类型擦除直接运行 `.ts`；本项目在 **v22.23.2** 验证） |
| 包管理器 | pnpm（本仓库使用 pnpm@10.34.5） |
| 运行时依赖 | 无 |
| devDependency | `typescript`、`@types/node` |

> 若运行 `.ts` 时报 `ERR_UNKNOWN_FILE_EXTENSION`，说明 Node 版本过低或未开启类型擦除，
> 可临时加 `--experimental-strip-types` 验证。

## 快速开始

### 1. 安装

```bash
pnpm install
```

### 2. 配置环境变量

| 环境变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | ✅ | — | DeepSeek API 密钥。缺失时启动即提示并退出（退出码 1） |
| `DEEPSEEK_BASE_URL` | ❌ | `https://api.deepseek.com` | API 基地址 |
| `AI_CHAT_MODEL` | ❌ | `deepseek-flash` | 模型名 |

密钥只经环境变量注入，**不写入代码**（见 `src/cli/config.ts`）。

有三种注入方式，任选其一：

**方式 1：env 文件（推荐）**

`pnpm start` / `pnpm test` 已内置以下加载顺序：

```text
--env-file-if-exists=.env          # 模板，仅占位符，随仓库提交
--env-file-if-exists=.env.local    # 本地真实值，已被 .gitignore 忽略
```

复制模板并填入真实密钥：

```bash
cp .env .env.local
# 编辑 .env.local，把 <your_deepseek_api_key> 换成真实密钥
```

规则：

- **靠后的文件优先**，所以 `.env.local` 覆盖 `.env`（Node 的多 `--env-file` 行为）。
- **显式环境变量优先级最高**：`DEEPSEEK_API_KEY=你的key pnpm start` 会覆盖两个文件。
- `.env.local` 不存在时**静默跳过**，不会报错。
- **`.env.local` 已被 `.gitignore` 忽略**，真实密钥不会被提交。

**方式 2：直接导出**

```bash
export DEEPSEEK_API_KEY=你的key
```

**方式 3：单次内联**

```bash
DEEPSEEK_API_KEY=你的key pnpm start
```

### 3. 运行

```bash
pnpm start
```

```text
You: 什么是 React Server Components？
AI: ...

You: 总结刚才内容
AI: ...
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm start` | 启动 REPL |
| `pnpm test` | 运行全部测试（`node --test`，当前 61 个用例） |
| `pnpm run typecheck` | 类型检查（`tsc --noEmit`） |

命令的事实来源是 `package.json` 的 `scripts` 字段。

## 项目结构

```text
01-llm/                 # 目录名 = 阶段槽位；项目名 ai-chat
  package.json          # type: module；scripts: start / test / typecheck
  tsconfig.json         # strict；noEmit；module: nodenext；@/ 路径别名
  .env                  # 环境变量模板（仅占位符，随仓库提交）
  .env.local            # 本地真实值（被 .gitignore 忽略，不入库）
  loader.mjs            # 注册 @/ 别名钩子（Node 运行时用）
  loader-hooks.mjs      # @/ → src/ 的 resolve 实现
  src/
    index.ts            # 入口：解析配置 → 启动 REPL
    cli/config.ts       # 环境变量 → Config
    cli/repl.ts         # readline 主循环 + 打印
    cli/render.ts       # StreamEvent → stdout/stderr
    core/types.ts       # Message / Role / ChatResult / StreamEvent / ChatOptions 类型
    core/session.ts     # 会话：消息数组、append、toMessages
    llm/client.ts       # LLMClient 接口（测试替身的接缝）
    llm/deepseek.ts     # DeepSeek adapter：非流式调用 + 响应解析
    llm/sse.ts          # SSE 分帧（纯函数）
  test/
    session.test.ts
    deepseek.test.ts
    repl.test.ts
    config.test.ts
    index.test.ts       # 入口集成测试（子进程，验证退出码）
```

## 当前能力边界

**已实现**

- 非流式多轮对话 + **流式（SSE）逐字输出**，上下文在进程内存中累积
- 思考过程默认不展开，仅在 stderr 给一行 `[思考中…]` 指示
- `system` / `user` / `assistant` 三种 role 的消息组装
- 最小错误处理：API 报错打印到 **stderr** 后继续循环，不崩溃、不污染上下文；
  模型回答走 stdout，两条流互不干扰（`pnpm start > answers.txt` 只拿到回答）

**尚未实现（后续增量）**

- 命令：`/clear` `/history` `/model` `/usage`
- 会话持久化（JSONL 落盘、`--resume`）
- token 统计 / 成本账本、上下文预算裁剪
- 错误分类与自动重试、`--timeout`、`-p` 一次性模式

## 文档

| 文档 | 回答什么问题 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 项目由什么组成？模块如何依赖？ |
| [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) | 一轮对话实际发生了什么？ |
| [`DECISIONS.md`](DECISIONS.md) | 为什么这样设计？ |
| [`EVALUATION.md`](EVALUATION.md) | 路线图的验收项达没达标？证据是什么？ |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | 报这个错怎么办？怎么避免再犯？ |
| [`docs/00-index.md`](docs/00-index.md) | 原始需求 |
| [`docs/01-full-design.md`](docs/01-full-design.md) | 完整功能蓝图 |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | 本次增量的设计 spec |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | 本次增量的实施计划 |
