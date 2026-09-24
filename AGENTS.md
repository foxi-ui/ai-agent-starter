# AGENTS.md

> 本仓库的 **AI 开发上下文**。只放**跨阶段**的约束与指针。
> 各阶段的具体知识在它自己的 `README.md` / `ARCHITECTURE.md` 里，**不要在这里重复**。

## 这是什么

个人 AI Agent 学习路线的实践仓库。每个阶段一个目录，产出一个可运行的项目 + 一套工程资产。

```text
docs/00-guides.md      路线图、阶段验收标准 —— 一切的事实来源
README.md              阶段目录映射表（哪个阶段在哪个目录、什么状态）
demos/<阶段>/          各阶段项目
```

## 先读什么

| 你要做的事 | 先读 |
| --- | --- |
| 知道现在做到哪了、下一步是什么 | 根 `README.md` 的「阶段目录」表 |
| 知道这个阶段的验收标准 | `docs/00-guides.md` 第二十六节 + 该项目 `EVALUATION.md` |
| 改某个阶段的代码 | 该项目的 `README.md` + `ARCHITECTURE.md` + `DECISIONS.md` |
| 遇到报错 | 该项目 `docs/troubleshooting.md` |
| 新起一个阶段 | 本文件 + 上一个阶段的 `DECISIONS.md`（看哪些决策该继承） |

## 跨阶段技术约束

新阶段项目**继承**这些约束，不要重新发明。当前唯一有代码的阶段是 `demos/01-llm/`，它的 `README.md` 与 `ARCHITECTURE.md` 是这些约束的详细出处。

- **Node ≥ 22**，依赖原生类型擦除直接运行 `.ts`，**不引入构建步骤**
- **ESM**（`package.json` 的 `"type": "module"`）；包管理器 **pnpm**
- **零运行时依赖**；devDependency 仅 `typescript` + `@types/node`
- **分层单向依赖** `cli → core → llm`；`llm` / `core` 不 import `node:readline`、不写 `process.stdout` / `process.stderr`
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**（原因见 troubleshooting 的 T4）
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`

## 开发命令

在**具体阶段目录下**执行（各阶段是独立项目，根目录没有 `package.json`）：

```bash
pnpm install
pnpm start          # 跑起来
pnpm test           # node --test
pnpm run typecheck  # tsc --noEmit
```

单文件跑测试**必须带 loader**（否则整文件失败，不是某条用例失败）：

```bash
node --import ./loader.mjs --test test/<name>.test.ts
```

## 阶段之间的关系

各阶段是**复制**关系，不是共享依赖 —— 见
`demos/02-agent/docs/superpowers/specs/2026-09-23-ai-chat-agent-design.md` 的 D1「复制底座而非修改 ai-chat」。

由此推出一条硬规则：

> **旧阶段只读不改。** 如果发现某个改动需要同时改多个阶段，说明该抽共享包了 ——
> 先把这个判断写进对应阶段的 `DECISIONS.md`，再动手，不要就地改旧阶段。

## 修改代码时的注意事项

- 改 `package.json` 的 `start` / `test` 脚本时，**两个都要带 `--import ./loader.mjs`**，漏一个会出现「测试过但 `pnpm start` 挂」
- **文档跟代码同一次改动一起更新**。碰到下面任一项，就要检查对应文档：
  `目录结构` → README / ARCHITECTURE；`命令` → README；`配置/环境变量` → README / DECISIONS；`依赖` → README / DECISIONS；`架构` → ARCHITECTURE / DECISIONS
- 遇到新坑并解决后，**随手追加**一条到该阶段的 `docs/troubleshooting.md`，不要攒着

## Definition of Done

逐项报告**实际结果**，不用「应该没问题」「看起来没问题」代替验证：

```text
TypeCheck: PASS / FAIL / N/A
Lint:      N/A（本仓库未配置 linter）
Test:      PASS / FAIL / N/A
Build:     N/A（noEmit，Node 直接运行 .ts，无构建产物）
```

另外，验证命令要**贴着改动范围**跑：先单文件 `node --import ./loader.mjs --test <file>`，再全量 `pnpm test`。

## 已知坑

- 跨阶段通用的坑 → 本文件上面各节
- `demos/01-llm/` 的具体坑 → `demos/01-llm/docs/troubleshooting.md`
