# 02-agent 实施步骤

> 回答：这六份计划按什么顺序做，每一步做完能亲眼看见什么？

本目录把「阶段二的实施」拆成 **6 个渐进步骤**。每一步结束时都有一个**能跑、能看**的东西，
下一步在它基础上加一层。计划正文在各自的文件里，本文件只负责「顺序」与「判据」。

设计文档（要做什么、为什么这么设计）在
`../specs/2026-09-25-ai-chat-agent-web-design.md`，本目录是实现它的步骤。

---

## 一、六步

| 步 | 计划文件 | 做什么 | **做完你能亲眼看见** |
| --- | --- | --- | --- |
| L1 | [`l1-skeleton-and-types.md`](./2026-09-25-l1-skeleton-and-types.md) | 建 monorepo 骨架；`Message` 改成可辨识联合、`Session` 退回纯类 | `session.test.ts` 9 条绿；一条 assistant 消息**没法**丢掉 `tool_calls`（类型检查拦住） |
| L2 | [`l2-tools-and-slice.md`](./2026-09-25-l2-tools-and-slice.md) | 工具层（接口 + 三个工具 + 注册表）；**垂直切片**：手工造一张调用单，跑完「声明 → 派发 → 执行 → 拼回消息」 | 不接模型，也能把 weather 从「声明」走到「结果」；`registry.execute('weather', {city:'Beijing'})` 真的回 `25°C, Sunny` |
| L3 | [`l3-llm-client.md`](./2026-09-25-l3-llm-client.md) | LLM 层：按线上的包装层级发 `tools`、解析并校验 `tool_calls` | **那张调用单改由模型开出**（不再是你手写的），`arguments` 是模型给的 JSON 字符串 |
| L4 | [`l4-agent-loop.md`](./2026-09-25-l4-agent-loop.md) | Agent 循环（`maxSteps` / 回喂 / 失败不崩）+ 展示投影 | 一次完整的多步循环在离线断言里跑通：调 → 执行 → 回喂 → 收敛；`foldTranscript` 把它折成展示项 |
| L5 | [`l5-http-server.md`](./2026-09-25-l5-http-server.md) | 会话注册表（FIFO + 串行锁）、错误映射、express 路由、进程入口 | `pnpm start` + `curl`，响应 JSON 里躺着工具轨迹；换掉 key 会得到 502 而不是 401 |
| L6 | [`l6-web-and-docs.md`](./2026-09-25-l6-web-and-docs.md) | React 前端（对话框 + 工具轨迹 + 会话恢复）、四件套文档、端到端冒烟 | 浏览器里先冒出 `⚙ weather` 轨迹块，再冒出回答 |

各步新增的服务端自动化用例数：

```text
L1  9 条   （session）
L2 35 条   （工具层 26 + 垂直切片 9）
L3 15 条   （deepseek）
L4 25 条   （agent 16 + transcript 9）
L5 37 条   （会话注册表 12 + 错误映射 6 + http-app 13 + 入口 6）
   ─────
   121 条

L6  0 条   —— 前端与文档，**没有自动化用例**（spec D14 的已知欠账）
```

> **L2 为什么是 35 而不是计划里写的 34**：L2 的收尾评审发现 calculator 的
> 「args 不是对象」分支没有任何用例打到（weather 有对应用例），补了第 11 条。
> 上表的 121 是补完之后重新数的。

**顺序不可调换**，每一步消费上一步定义的签名：

```text
L1  Message / Session / LLMClient 接口
     ↓
L2  ToolRegistry / ToolDefinition        ← 只依赖 L1（tools → core，不碰 LLM 层）
     ↓
L3  LLMClient 的真实现（发 tools、解析 tool_calls）
     ↓
L4  AgentTurn / runAgentTurn             ← 同时消费 L2 的注册表与 L3 的 client
     ↓
L5  AppDeps / createApp                  ← 消费 L4 的 runSessionTurn
     ↓
L6  apps/web 的线上契约                  ← 消费 L5 的响应形状
```

### 为什么 L2 在 L3 前面（这一步与直觉相反）

按依赖的「自然」顺序是「先有 LLM 层，再有工具层」—— 毕竟工具是模型提出要调的。
但**代码依赖是单向的**：`tools → core`，工具层一个字都不碰 LLM 层。

把它前置换来的是一个**垂直切片**：L2 结束时，你可以在**完全没有模型**的情况下，
手工写一张 `ToolCall`，把它走完「解析参数 → 按名派发 → 执行 → 序列化成 `tool` 消息」。
L3 再把「这张单子从哪来」换成模型给的，L4 才把整件事包进循环。

这样每一步只引入**一个新概念**：L2 引入「工具」，L3 引入「模型开单」，L4 引入「循环」。
反过来做的话，L2 就要同时引入「模型」和「工具」两个概念，而工具那部分会被模型的噪音盖住。

---

## 二、每一步怎么算过关

**每一步**都必须同时满足三条：

1. **计划里点名的测试文件全绿**（命令见每份文档的 Step，`node --import ./loader.mjs --test <file>`）
2. **`pnpm run typecheck` 退出码 0**
3. **那个「能亲眼看见」的东西真的看见了** —— 照着该份文档末尾的验证步骤跑一遍，别跳

> **例外：L1 与 L2 的 typecheck 是红的。** `apps/server/src/llm/deepseek.ts` 是从 01-llm
> 原样复制过来的，它 `import { parseSse } from '@/llm/sse.ts'`（**值导入**，不是 type-only），
> 而 `sse.ts` 按设计不复制过来 —— 于是它直到 **L3** 才被重写。
> 在此之前：
> - **各步自己的单文件测试是绿的**（`node --test test/<name>.test.ts`）
> - **全量 `pnpm test` 与 `pnpm run typecheck` 是红的**，红的就是 deepseek 这一条链
>
> 这不是疏忽，是「复制起点后逐步改造」的必然中间态。**L3 一结束就该全绿**，
> 如果那时还红，说明 L3 没做完。

---

## 三、各步共同的约定

这几条每份文档都会完整重复一遍（实施者只读自己那份就够），这里列出是为了让你知道它们是全局的：

- **Node ≥ 22**，靠原生类型擦除直接跑 `.ts`，服务端**不引入构建步骤**
- 只用**擦除得掉**的 TS 特性；**只当类型用的导入必须写 `import type`**
- `core/` / `llm/` / `tools/` / `presentation/` **零第三方依赖**；`http/` 允许，但必须登记
- 依赖方向单向：`http → presentation → core → llm`、`tools → core`、`http → tools`、`http → llm`
- **只有 `src/main.ts` 碰 `process`；只有 `http/` 碰 express**
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑
- 每个 Task 末尾提交一次，**提交信息用中文**，写清这一步引入的概念

---

## 四、做完之后

全部六步走完 → 回到 `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 **§17 验收** 逐条对照。
其中「前端没有自动化测试」与「会话只在服务端内存里」是**有意接受的两笔欠账**（spec D14 / D3），
报告时必须如实写出，不能用「测试全绿」掩盖。
