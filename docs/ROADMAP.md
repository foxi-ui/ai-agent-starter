# ROADMAP

> 回答：这条学习路线怎么走，每个阶段怎么算过关？
> 唯一事实来源。各阶段项目的实时状态见根 `README.md`；跨阶段技术约束见 `AGENTS.md`。

## 一、整体学习路线

建议按 6 个阶段推进，整体约 4～6 个月，每天投入 1～2 小时。

```text
阶段 0：LLM 基础
       ↓
阶段 1：第一个 Agent
       ↓
阶段 2：Tools + MCP
       ↓
阶段 3：RAG + Memory
       ↓
阶段 4：Workflow + Multi-Agent
       ↓
阶段 5：Evaluation + Production
       ↓
最终项目：AI Software Factory
```

核心原则：

> 概念 → 最小实验 → 工程能力 → 完整项目 → 生产化 → 反向补理论

### 按产出项目看同一路线

```text
第 1 阶段   LLM API                              → AI Chat
第 2 阶段   Agent Loop / Tool Calling            → Coding Agent
第 3 阶段   MCP / Tools                          → Developer Agent
第 4 阶段   RAG / Memory                         → Knowledge Agent
第 5 阶段   Workflow / 状态机 / Human-in-the-loop → AI Software Factory
第 6 阶段   Evaluation / Security / 可观测性 / 生产化 → Production AI Agent
第 7 阶段   Multi-Agent                          → 复杂 AI 系统
```

> 这两套视角的阶段编号**对不齐**（6 阶段 vs 7 阶段）。详见「五、已知缺口」。

## 二、项目驱动学习顺序

不要采用「先学完所有概念，最后做项目」：

```text
学 LLM → 学 RAG → 学 Agent → 学 MCP → 学 Multi-Agent → 最后做项目
```

推荐：

```text
项目 → 遇到问题 → 学习对应知识 → 解决问题 → 总结 → 进入下一阶段
```

对应 6 个项目，各自的考察点：

| 项目 | 学习内容 |
| --- | --- |
| 1：AI Chat | LLM API、Prompt、Context、Streaming |
| 2：Coding Agent | Tool Calling、Agent Loop、State |
| 3：Knowledge Agent | Embedding、RAG、Rerank、Memory |
| 4：Developer Agent | MCP、Git、Shell、Filesystem |
| 5：AI Software Factory | Workflow、State Machine、Human Approval、Evaluation |
| 6：Production Agent | Security、Observability、Cost、Latency、Deployment |

## 三、阶段目录与工程资产

不要做完 Demo 就删除。每个阶段一个目录：

```text
01-llm/         02-agent/      03-tools/
04-mcp/         05-rag/        06-memory/
07-workflow/    08-evaluation/ 09-production/
```

每个项目**至少维护**这些文件：

```text
README.md        项目是什么、怎么跑
ARCHITECTURE.md  由什么组成、模块怎么依赖、一轮请求实际发生了什么
DECISIONS.md     为什么这样设计、放弃了什么
EVALUATION.md    路线图的验收项达没达标、证据是什么
docs/troubleshooting.md   踩过的坑与解法
```

这是**建议**不是硬性要求 —— 阶段还没成形时允许缺项。缺哪份、为什么缺，写在该阶段目录的
`README.md` 里说明。

同时记录每个坑的完整链条：

```text
问题 → 尝试 → 失败 → 原因 → 解决 → 经验
```

半年后得到的不是「我看过很多 Agent 教程」，而是「我有一套自己的 Agent Engineering 方法论」。

## 四、阶段验收标准

每个阶段都必须「验收」，不要只看教程完成度。

### 阶段 0

- 独立调用 LLM API
- 实现 Streaming
- 管理上下文
- 使用 Structured Output
- 处理 API 错误
- 统计 Token / Cost

### 阶段 1

- 自己实现 Agent Loop
- 自己定义 Tool
- 处理 Tool Result
- 实现基本任务循环
- 防止无限循环

### 阶段 2

- 理解 Function Calling
- 编写 MCP Server
- 接入 MCP Tool
- 实现权限控制
- 将外部服务接入 Agent

### 阶段 3

- 构建完整 RAG
- 理解 Embedding
- 实现 Chunking
- 实现 Retrieval
- 使用 Rerank
- 分析 RAG 失败原因

### 阶段 4

- 设计 Workflow
- 使用状态机
- 实现失败重试
- 实现 Human-in-the-loop
- 判断何时应该使用 Workflow 而不是 Agent

### 阶段 5

- 建立 Agent Evaluation Dataset
- 定义指标
- 建立回归测试
- 分析 Agent Trace
- 统计 Token / Cost / Latency
- 处理 Prompt Injection
- 实现权限控制
- 完成基本生产部署

## 五、已知缺口

这份路线自身的不完整之处，如实记录，不代笔补全：

- **阶段 6（Security + Production）没有验收标准** —— 第四节只覆盖到阶段 5，而第一节的路线里阶段 5 是「Evaluation + Production」。补验收标准时需要同时理清阶段编号。
- **两套阶段编号对不齐** —— 第一节的「6 阶段」与「7 阶段」两个视角编号不一致，项目 N 与阶段 N 也不是一一对应。
- **`03`–`09` 目录与阶段/项目的对应关系是推定的** —— 按目录名与原始规划的章节标题推断，实施到该阶段时以实际情况为准。
