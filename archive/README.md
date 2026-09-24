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
| `01-llm/llm-architecture-diagram/` | 架构图与数据流图（HTML + 视觉校验截图/JSON），约 3.3 MB | 与 `ARCHITECTURE.md` 同一内容的可视化形态；截图是验证快照，不是文档 |
| `01-llm/how-conversation-works.html` | 一轮对话可视化 | 内容已并入 `ARCHITECTURE.md` 的「运行时数据流」 |
| `01-llm/how-sse-works.html` | SSE 解码可视化 | 内容已在 `ARCHITECTURE.md` 步骤 4 与 spec m2 §7 |
| `01-llm/archify/` | 上述两张图的 archify 源数据（JSON） | 图表已归档，源数据随之归档 |
