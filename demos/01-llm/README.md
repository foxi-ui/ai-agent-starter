# ai-chat

> 回答：这个项目怎么跑起来？

CLI 模式下的 AI 对话工具，**不使用 LangChain，直接调用 DeepSeek 模型 API**。

对应学习路线的第一站，目标是亲手走通这条链路的起点：

```text
LLM API → 消息结构 → 上下文管理 → Streaming → 错误处理 → Token 统计
```

> **当前范围：仅「对话部分」**——多轮对话（非流式 + **流式 SSE**）+ 最小错误处理
> + **会话持久化**（JSONL 落盘、`--resume`、`/sessions`）。
> 蓝图中尚未落地的项（token 统计、structured output、上下文裁剪等）见 [`EVALUATION.md`](EVALUATION.md)。

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
| `AI_CHAT_HOME` | ❌ | `.sessions`（相对 cwd） | 会话日志目录。设成绝对路径可把会话集中到一处 |

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
| `pnpm start` | 启动 REPL（新会话） |
| `pnpm start --resume <id>` | 恢复指定会话，接着上次聊 |
| `pnpm test` | 运行全部测试（`node --test`，当前 167 个用例） |
| `pnpm run typecheck` | 类型检查（`tsc --noEmit`） |

命令的事实来源是 `package.json` 的 `scripts` 字段。

### 会话：id、`--resume` 与会话目录

每次启动都会把这场对话记到 `.sessions/<id>.jsonl`（一行一条 JSON），启动时在
**stderr** 打印会话 id：

```text
[session] 20260924-224330-a3f1        # 新会话
[resumed] 20260924-224330-a3f1（2 条消息）  # 恢复已有会话
```

拿这个 id 就能续聊：

```bash
pnpm start --resume 20260924-224330-a3f1
```

> **⚠️ 不要写成 `pnpm start -- --resume <id>`。** 这里与 npm 的惯例相反：
> 实测 pnpm 10.34.5 会把 `--` 原样转发给脚本、成为第一个参数，程序报
> `未知参数：--` 并以退出码 1 退出。也用不着 `--` 来防 pnpm 吃掉参数
> （`--resume` 不会被它吃掉）。详见 `docs/troubleshooting.md` T13。

行为约定：

- **会话不存在**、**id 格式不合法**（例如 `--resume ../../etc/passwd`）、
  **多给了参数**，都在 stderr 报错并以退出码 1 退出 —— 绝不静默开一个新会话，
  那会把用户以为还留着的上下文悄悄丢掉。
- 会话文件里**坏掉的行会被跳过**并在 stderr 提示跳过了几行，其余内容照常恢复。
- 写盘失败（只读目录、磁盘满）不会中断对话：内存照常走，stderr 给**一行**警告。
- 会话目录默认是**当前工作目录**下的 `.sessions/`，可用 `AI_CHAT_HOME` 覆盖。

## REPL 命令

| 命令 | 作用 |
| --- | --- |
| `/clear` | 清空当前会话的消息（不影响当前模型） |
| `/history` | 列出当前会话的消息，每条截断到 200 字符 |
| `/model` | 显示当前模型 |
| `/model <name>` | 切换模型，立即对后续请求生效 |
| `/sessions` | 列出历史会话，当前会话带 `*` 标记 |

命令**不进入对话上下文**，也不会被发给模型。`/model` 不校验模型名 ——
写错的名字会在下一次请求时由 API 报错（走 stderr）。

命令结果走 **stdout** —— 与模型回答一样落在重定向文件里（`pnpm start > answers.txt`
能看到 `/clear` 的清空提示与 `/history` 的列表）；**未知命令提示与错误**走 **stderr**。

## 项目结构

```text
01-llm/                 # 目录名 = 阶段槽位；项目名 ai-chat
  package.json          # type: module；scripts: start / test / typecheck
  tsconfig.json         # strict；noEmit；module: nodenext；@/ 路径别名
  .env                  # 环境变量模板（仅占位符，随仓库提交）
  .env.local            # 本地真实值（被 .gitignore 忽略，不入库）
  loader.mjs            # 注册 @/ 别名钩子（Node 运行时用）
  loader-hooks.mjs      # @/ → src/ 的 resolve 实现
  .sessions/            # 会话日志（运行时产物，被 .gitignore 忽略）
  src/
    index.ts            # 入口：解析配置与参数 → 新建/恢复会话 → 启动 REPL
    cli/config.ts       # 环境变量 → Config
    cli/args.ts         # 命令行参数解析（--resume），纯函数、非法即抛错
    cli/store.ts        # SessionStore 的文件实现 —— 唯一读写会话日志、唯一碰 node:fs 的地方
    cli/repl.ts         # readline 主循环 + 打印 + 变更落盘（onChange）
    cli/render.ts       # StreamEvent / CommandResult → stdout/stderr
    core/types.ts       # Message / Role / ChatResult / StreamEvent / ChatOptions 类型
    core/journal.ts     # 会话日志：记录类型、序列化/解析、回放、id 生成与校验（纯逻辑，不碰 fs）
    core/session.ts     # 会话：消息数组、append、toMessages、变更广播（onChange）
    core/commands.ts    # 命令解析（parseCommand）与执行（executeCommand → CommandResult）
    llm/client.ts       # LLMClient 接口（测试替身的接缝）
    llm/deepseek.ts     # DeepSeek adapter：非流式 + 流式调用、响应解析
    llm/sse.ts          # SSE 分帧（纯函数）
  test/
    session.test.ts     # 消息累积、history 副本、变更广播（onChange）
    deepseek.test.ts
    sse.test.ts         # SSE 分帧（纯函数）
    render.test.ts      # StreamEvent / CommandResult → stdout/stderr
    repl.test.ts        # REPL 主循环 + 落盘接线与降级
    config.test.ts
    index.test.ts       # 入口集成测试（子进程，验证退出码与会话文件）
    commands.test.ts    # 命令解析与执行（纯函数，无需捕获输出）
    journal.test.ts     # 日志格式、解析、回放、id 生成与校验（纯函数）
    store.test.ts       # 会话存储的文件实现（真临时目录，不 mock fs）
    args.test.ts        # --resume 的参数解析（纯函数）
```

## 当前能力边界

**已实现**

- 非流式多轮对话 + **流式（SSE）逐字输出**，上下文在进程内存中累积
- REPL 命令：`/clear` `/history` `/model` `/sessions`
- 思考过程默认不展开，仅在 stderr 给一行 `[思考中…]` 指示
- `system` / `user` / `assistant` 三种 role 的消息组装
- 最小错误处理：API 报错打印到 **stderr** 后继续循环，不崩溃、不污染上下文；
  模型回答**与命令结果**走 stdout，两条流互不干扰
  （`pnpm start > answers.txt` 里只有回答与命令结果，没有报错）
- 会话持久化：JSONL 事件流落在 `.sessions/`，`--resume <id>` 恢复，`/sessions` 列出。
  自动化测试见 `test/journal.test.ts`（格式与回放）、`test/store.test.ts`（真临时目录上的
  读写与路径安全）、`test/args.test.ts`（参数解析），以及 `test/index.test.ts` 的子进程用例

**尚未实现（后续增量）**

- 命令：`/usage`（Token 统计尚未实现，属 M4）
- token 统计 / 成本账本、上下文预算裁剪
- 错误分类与自动重试、`--timeout`、`-p` 一次性模式

## 文档

| 文档 | 回答什么问题 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 项目由什么组成？模块如何依赖？ |
| [`DECISIONS.md`](DECISIONS.md) | 为什么这样设计？ |
| [`EVALUATION.md`](EVALUATION.md) | 路线图的验收项达没达标？证据是什么？ |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | 报这个错怎么办？怎么避免再犯？ |
| [`docs/deepseek-api-facts.md`](docs/deepseek-api-facts.md) | 模型名 / 价目 / 错误码查表 |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | 本次增量的设计 spec |
