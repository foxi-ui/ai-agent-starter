# AGENTS.md

> 回答：AI 在本仓库工作时要遵守什么？
> 本仓库的 **AI 开发上下文**。只放**跨阶段**的约束与指针。
> 各阶段的具体知识在它自己的 `README.md` / `ARCHITECTURE.md` 里，**不要在这里重复**。

## 这是什么

个人 AI Agent 学习路线的实践仓库。每个阶段一个目录，产出一个可运行的项目 + 一套工程资产。

```text
docs/ROADMAP.md        路线图、阶段验收标准 —— 一切的事实来源
README.md              阶段目录与实时状态（谁在哪个目录、做到哪了）
demos/<阶段>/          各阶段项目
```

## 文档怎么写

> **每份文档必须回答一个唯一问题。**

AI 与人都靠「这个问题该去哪份文档找」来导航。一份文档回答两个问题，就会出现两个入口，
两边迟早写出不一致的版本 —— 2026-09-24 的瘦身做的就是把这类重叠拆掉。

当前每份文档负责的问题：

| 文档 | 回答的唯一问题 | 不负责 |
| --- | --- | --- |
| 根 `README.md` | 这个仓库是什么，每个阶段做到哪了？ | 路线正文、验收细则 |
| 本文件 | AI 在本仓库工作时要遵守什么？ | 任何单阶段的知识 |
| `docs/ROADMAP.md` | 这条学习路线怎么走，每个阶段怎么算过关？ | 阶段的实时状态 |
| `demos/NN/README.md` | 这个项目怎么跑起来？ | 架构原理、决策理由 |
| `ARCHITECTURE.md` | 这个系统由什么组成，一轮请求实际跑过了哪些步骤？ | 为什么这么选 |
| `DECISIONS.md` | 为什么是这样设计的，放弃了什么？ | 日期流水、改了哪个文件 |
| `EVALUATION.md` | 验收标准现在达标到什么程度，证据是什么？ | 未来增量的设计 |
| `docs/troubleshooting.md` | 遇到这个报错怎么定位和修？ | 架构说明 |
| `docs/deepseek-api-facts.md` | 模型、价目、错误码分别是什么？ | 任何设计叙述 |

写新文档前先问：**这个问题现有文档里有没有答案？** 有就改那一份，不要新建平行文档。
拆出新文档的唯一正当理由是「现有文档开始回答两个问题了」。

文档头部的 `> 回答：…` 一行必须与上表一致，**且只写一个问号**。

## 先读什么

| 你要做的事 | 先读 |
| --- | --- |
| 知道现在做到哪了、下一步是什么 | 根 `README.md` 的「阶段目录」表 |
| 知道这个阶段的验收标准 | `docs/ROADMAP.md` 的「阶段验收标准」+ 该项目 `EVALUATION.md` |
| 改某个阶段的代码 | 该项目的 `README.md` + `ARCHITECTURE.md` + `DECISIONS.md` |
| 遇到报错 | 该项目 `docs/troubleshooting.md` |
| 新起一个阶段 | 本文件 + 上一个阶段的 `DECISIONS.md`（看哪些决策该继承） |

## 跨阶段技术约束

新阶段项目**继承**这些约束，不要重新发明。当前有代码的阶段是 `demos/01-llm/`（M1–M3 完成）
与 `demos/02-agent/`（6 步计划里的 L1–L5 完成：类型契约、工具层、LLM 层、Agent 循环、
HTTP 服务端都已就位，只剩 L6 的前端与文档）；
`demos/01-llm/README.md` 与 `ARCHITECTURE.md` 是这些约束的详细出处，
`demos/02-agent/` 的对应文档要等它的 L6 才建。

- **Node ≥ 22**，依赖原生类型擦除直接运行 `.ts`
- **服务端不引入构建步骤**：无打包、无转译产物，`node --import ./loader.mjs src/**.ts` 直接跑。
  **前端是唯一的例外** —— `apps/web/` 自带 Vite 工具链、独立 `package.json` 与独立构建产物，
  不进服务端的 `pnpm test` / `tsc --noEmit` 口径（见 `demos/02-agent/apps/web/`）
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）——
  原生类型擦除只做擦除不做变换。`tsc --noEmit` 对它们**放行**，只有运行时才炸
  （见 `demos/01-llm/docs/troubleshooting.md` T11）。
  判断标准：删掉所有类型标注后仍是合法 JS 的，才能用。
  **推论**：只当类型用的导入**必须**写 `import type`，否则擦除阶段无法识别它，
  运行时抛「does not provide an export named …」—— 同一个坑的另一个出口
- **ESM**（`package.json` 的 `"type": "module"`）；包管理器 **pnpm**
- **核心层零运行时依赖**：`core/` 与 `llm/` 只用 `node:` 内置模块与全局 `fetch`，禁止引入第三方包
- **`server/` 层允许运行时依赖，且必须登记**：当前唯一一条是 `express`（配套 `@types/express`，
  见 `demos/02-agent/DECISIONS.md`）。新增任何运行时依赖都要在本行列出并说明理由；
  `tools/` 层维持零依赖
- **分层单向依赖** `cli → core → llm`、`server → core → llm`、`tools → core`
  （**`core` 不 import `tools`**）；`server` 与 `cli` **互不导入**。
  `llm` / `core` 不 import `node:readline` / `node:fs` / `express`，也不写 `process.stdout` / `process.stderr`
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**（原因见 troubleshooting 的 T4）
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`

## 开发命令

在**具体阶段目录下**执行（各阶段是独立项目，根目录没有 `package.json`）。
「独立」指的是**阶段之间**互不依赖；一个阶段内部可以有多个应用，
用 pnpm workspace 组织（当前只有 `demos/02-agent/` 这么做）：

```text
demos/NN/            阶段根：没有源码，只有编排脚本与文档
  apps/<app>/        每个应用一个 package.json
```


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

workspace 形式的阶段（当前只有 `demos/02-agent/`）在**阶段根**一条命令跑全部，
依赖也只装一次；要单独操作某个应用时用 `pnpm -F <app>`：

```bash
pnpm install         # 一次装完 apps/ 下所有应用
pnpm start           # 起服务端
pnpm dev             # 并行起服务端 + 前端 dev server
pnpm -F web build    # 只构建前端
```

## 阶段之间的关系

各阶段是**复制**关系，不是共享依赖 —— 见
`demos/02-agent/docs/superpowers/specs/2026-09-25-ai-chat-agent-web-design.md` 的 D1「复制而非共享依赖」。

由此推出一条硬规则：

> **旧阶段只读不改。** 如果发现某个改动需要同时改多个阶段，说明该抽共享包了 ——
> 先把这个判断写进对应阶段的 `DECISIONS.md`，再动手，不要就地改旧阶段。

## 修改代码时的注意事项

- 改 `package.json` 里跑 `.ts` 的脚本时（`start` / `dev` / `test`），**每一个都要带 `--import ./loader.mjs`**，漏一个会出现「测试过但 `pnpm start` 挂」
- **文档跟代码同一次改动一起更新**。碰到下面任一项，就要检查对应文档：
  `目录结构` → README / ARCHITECTURE；`命令` → README；`配置/环境变量` → README / DECISIONS；`依赖` → README / DECISIONS；`架构` → ARCHITECTURE / DECISIONS
- 遇到新坑并解决后，**随手追加**一条到该阶段的 `docs/troubleshooting.md`，不要攒着

## Definition of Done

逐项报告**实际结果**，不用「应该没问题」「看起来没问题」代替验证：

```text
TypeCheck: PASS / FAIL / N/A
Lint:      N/A（本仓库未配置 linter）
Test:      PASS / FAIL / N/A
Build:     N/A（noEmit，Node 直接运行 .ts，无构建产物）／前端另有 vite build
```

另外，验证命令要**贴着改动范围**跑：先单文件 `node --import ./loader.mjs --test <file>`，再全量 `pnpm test`。

## 已知坑

- 跨阶段通用的坑 → 本文件上面各节
- `demos/01-llm/` 的具体坑 → `demos/01-llm/docs/troubleshooting.md`
