# AI Agent学习路线

> 回答：这个仓库是什么，每个阶段做到哪了？

## 项目介绍

本项目是个人学习AI Agent 开发的随手笔记

### 个人介绍

已经是一名10年+的程序员

## 阶段目录

路线、阶段划分、目录命名与验收标准的**唯一事实来源**是 [`docs/ROADMAP.md`](docs/ROADMAP.md)。
下表只记**谁在哪个目录、做到哪了**。

| 阶段目录 | 项目名 | 状态 |
| --- | --- | --- |
| `demos/01-llm/` | ai-chat | 进行中：M1、M2、M3（会话持久化）完成，M4–M7 待做 |
| `demos/02-agent/` | ai-chat-agent | 进行中：monorepo 骨架、`Message` 可辨识联合与 `Session` 纯类已就位（6 步计划里的 L1），L2–L6 待做 |
| `demos/03-tools/` | — | 未开始 |
| `demos/04-mcp/` | — | 未开始 |
| `demos/05-rag/` | — | 未开始 |
| `demos/06-memory/` | — | 未开始 |
| `demos/07-workflow/` | — | 未开始 |
| `demos/08-evaluation/` | — | 未开始 |
| `demos/09-production/` | — | 未开始 |

> `03`–`09` 还没建目录，它们与「阶段 N / 项目 N」的对应关系是**推定**的 ——
> 详见 [`docs/ROADMAP.md`](docs/ROADMAP.md) 的「已知缺口」。

> **两套编号别混淆**：阶段编号（`01-llm`）与阶段内部文档的序号互不相关 —— 前者是学习顺序，后者只是文件名前缀。

## AI 开发上下文

跨阶段的技术约束、开发命令、Definition of Done 见 [`AGENTS.md`](AGENTS.md)。
各阶段该维护哪些工程资产、怎么算验收通过，见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。
