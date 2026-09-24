# AI Agent学习路线
## 项目介绍
本项目是个人学习AI Agent 开发的随手笔记

### 个人介绍
已经是一名10年+的程序员

## 阶段目录

路线图与验收标准的事实来源：`docs/00-guides.md`。
目录命名依据其第二十四节「每个阶段都留下工程资产」。

| 阶段目录 | 项目名 | 路线图目标 | 状态 |
| --- | --- | --- | --- |
| `demos/01-llm/` | ai-chat | 阶段 0 · 实践项目 1（AI Chat） | 进行中：M1 对话部分完成，M2–M7 待做 |
| `demos/02-agent/` | ai-chat-agent | 阶段 1 · 实践项目 2（Coding Agent）的起点 | 设计完成，未开始编码 |
| `demos/03-tools/` | — | 项目 4（Developer Agent）：MCP / Git / Shell / Filesystem | 未开始 |
| `demos/04-mcp/` | — | 同上 | 未开始 |
| `demos/05-rag/` | — | 项目 3（Knowledge Agent）：Embedding / RAG / Rerank | 未开始 |
| `demos/06-memory/` | — | 同上（Memory 部分） | 未开始 |
| `demos/07-workflow/` | — | 项目 5（AI Software Factory）：Workflow / State Machine | 未开始 |
| `demos/08-evaluation/` | — | 同上（Evaluation 部分） | 未开始 |
| `demos/09-production/` | — | 项目 6（Production Agent）：Security / Observability / Cost / Deployment | 未开始 |

> `03`–`09` 还没建目录。它们与「项目 N / 阶段 N」的对应关系是按目录名与 `docs/00-guides.md` 的章节标题推定的，
> 实施时以该文件为准。

> **两套编号别混淆**：阶段编号（`01-llm`）与文档编号（`demos/01-llm/docs/01-full-design.md` 里的 `01`）互不相关。

## 每个阶段项目必须维护

```text
README.md        项目是什么、怎么跑
ARCHITECTURE.md  由什么组成、模块怎么依赖
HOW-IT-WORKS.md  一轮请求实际发生了什么
DECISIONS.md     为什么这样设计、放弃了什么
EVALUATION.md    路线图的验收项达没达标、证据是什么
```

依据 `docs/00-guides.md` 第二十四节。

## AI 开发上下文

跨阶段的技术约束、开发命令、Definition of Done 见 [`AGENTS.md`](AGENTS.md)。