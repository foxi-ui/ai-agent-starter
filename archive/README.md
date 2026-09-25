# archive

归档区。这里的文件**不再是事实来源**，只为可追溯保留。

## 规则

- 文件从主线移出时用 `git mv` 到这里，不删除
- 归档文件**内部的**交叉引用指向归档时的路径，不逐条修复
- 需要某个事实时，先看主线文档；主线没有再来这里找

## 内容

| 路径 | 是什么 | 为什么移出 |
| --- | --- | --- |
| `00-guides-full.md` | 原 `docs/00-guides.md` 全文 | 精简为 `docs/ROADMAP.md`，其余 24 节学习内容归档 |
| `01-llm/00-index.md` | 01-llm 的原始需求脑暴 | 60/82 行是 `00-guides` 节五/节六的粘贴，双重冗余 |
| `01-llm/01-full-design.md` | 01-llm 完整蓝图 | 目录树列了 8 个不存在的 src 文件；§12 已提为 `docs/deepseek-api-facts.md` |
| `01-llm/HOW-IT-WORKS.md` | 运行时行为说明 | 约 60–65% 内容在别处已有副本；唯一部分已并入 `ARCHITECTURE.md` |
| `01-llm/plans/` | 4 份实施计划（4803 行） | 任务已完成的执行过程产物 |
| `01-llm/llm-architecture-diagram/` | 架构图与数据流图（HTML + 视觉校验脚手架），约 1.8 MB | 与 `ARCHITECTURE.md` 同一内容的可视化形态；8 张 `.visual-check.*.png` 截图已移除 —— 是验证快照、可再生成，不是文档 |
| `01-llm/how-conversation-works.html` | 一轮对话可视化 | 内容已并入 `ARCHITECTURE.md` 的「运行时数据流」 |
| `01-llm/how-sse-works.html` | SSE 解码可视化 | 内容已在 `ARCHITECTURE.md` 步骤 4 与 spec m2 §7 |
| `01-llm/archify/` | 上述两张图的 archify 源数据（JSON） | 图表已归档，源数据随之归档 |
| `02-agent/2026-09-23-ai-chat-agent-design.md` | 02-agent 的**纯 CLI 版**设计 | 与现行的 `2026-09-25-ai-chat-agent-web-design.md` 回答同一个问题（这个阶段怎么设计）。仍然有效的三块 —— `ToolRegistry` 接口、三个工具的行为规格、与 ROADMAP 阶段 1 的对应 —— 已并入现 spec；其余部分被现 spec 取代 |
| `02-agent/2026-09-25-tool-calling-agent.md` | 02-agent 的**单一总计划**（5062 行 / 15 个 Task） | 已拆成 `demos/02-agent/docs/superpowers/plans/` 下的 6 份渐进步骤 + 一份索引。拆分不是纯粹切分：工具层提到了 LLM 层之前、并新增了垂直切片那一步，**顺序与任务编号都已改变**，所以它不再是可照做的计划。任务编号对照：T1–T2 → L1 的 Task 1–2；**T4 → L2 的 Task 3**（工具层被提到了 LLM 层之前）；T3 → L3 的 Task 5；T5–T6 → L4 的 Task 6–7；T7–T10 → L5 的 Task 8–11；T11–T15 → L6 的 Task 12–16。L2 的 Task 4（垂直切片）在本文件里**没有对应物**，是拆分时新增的 |
