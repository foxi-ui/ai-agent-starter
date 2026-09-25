# 验收评估

> 回答：`docs/ROADMAP.md` 阶段 1 的 5 条验收标准，现在达标到什么程度？

本仓库的规矩是**状态必须附证据**，不接受「已完成」这类无证据的断言。
所以下表每一行的「证据」列写的都是**具体的测试落点**（文件 + 用例名），而不是一句结论。

**自动化质量门（已执行，实测输出）**

```text
$ pnpm run typecheck     # 两个 app 都跑 tsc --noEmit
apps/server typecheck: Done
apps/web typecheck: Done                 → 退出码 0

$ pnpm test              # 服务端 node --test，全程离线
# tests 121   # pass 121   # fail 0      → 退出码 0

$ pnpm -F web build
dist/index.html                 0.40 kB │ gzip:  0.27 kB
dist/assets/index-*.css         3.06 kB │ gzip:  1.14 kB
dist/assets/index-*.js        225.04 kB │ gzip: 70.82 kB
✓ built in 463ms
```

**尚未执行**：`plans/2026-09-25-l6-web-and-docs.md` Task 16 的 Step 2（密钥泄漏扫描）、
Step 3（真实 API 的 curl 冒烟）、Step 4（浏览器端到端 8 条）。
也就是说，**下面这些验收项的证据目前是「自动化测试通过」，不是「真实模型跑通」** ——
真实链路（真的开出一张调用单、真的执行工具、浏览器里真的看见轨迹）还没验证过。

## ROADMAP 阶段 1

| 验收项 | 状态 | 证据（测试落点） |
|---|---|---|
| 自己实现 Agent Loop | ✅ 达标 | `test/agent.test.ts`：`一轮工具后收敛`、`多步循环：连续两次工具调用后才收敛`、`同一轮里多个 tool_calls` |
| 自己定义 Tool | ✅ 达标 | `test/tools-registry.test.ts`：`list() 返回三份工具声明`、`每份声明都有非空 description 与 object 类型的 parameters`；三个工具的 schema 另见 `test/tools-{weather,time,calculator}.test.ts` |
| 处理 Tool Result | ✅ 达标 | `test/agent.test.ts`：`一轮工具后收敛`（断言 tool 消息的 content 就是 `JSON.stringify(value)`）、`arguments 不是合法 JSON：错误文本回喂`、`工具抛异常：兜底成 {ok:false} 回喂，不崩`、`未知名工具：错误文本回喂` |
| 实现基本任务循环 | ✅ 达标 | `test/http-app.test.ts`：`POST 消息返回本轮的展示项（工具轨迹 + 回答，不含用户那条）` —— 一次假的天气轮从 HTTP 进、带着工具轨迹从 HTTP 出 |
| 防止无限循环 | ✅ 达标 | `test/agent.test.ts`：`跑满 maxSteps：调用次数恰好等于 maxSteps，且最后一条是带 content 的 assistant`、`maxSteps 默认为 6` |

**另外三条不来自 ROADMAP、但本项目自己立的验收点**（spec §11 的 Review Focus）：

| 验收项 | 状态 | 证据 |
|---|---|---|
| 同一会话的并发请求串行 | ✅ 达标 | `test/http-session-registry.test.ts`：`同一 id 上的两个 run 串行执行，不交错`；`test/http-app.test.ts`：`同一会话并发两个请求：第二个能看到第一个的结果` |
| 上游状态码绝不透出 | ✅ 达标 | `test/http-errors.test.ts`：`上游 401 绝不透出成 401`；`test/http-app.test.ts`：`上游 401 → 502` |
| 失败的一轮不写进会话 | ✅ 达标 | `test/agent.test.ts`：`runSessionTurn：本轮失败时只留下 user 那一条`；`test/http-app.test.ts`：`失败的一轮不写进会话（历史里只有 user）` |

## 未做项与落点

逐条对应 spec §2 的「明确推迟」表。**这一节最有价值的用途是：若某条在本项目里找不到落点，
就在这里显式标出来。** 本次没有找不到落点的条目 —— 每一条都能指到一份决策或一个计划的下一步。

| 项 | 落点 |
|---|---|
| CLI 入口与 readline 交互 | D2，**整个不做**。若将来要做，`core/` 是干净的，加一个 `cli/` 即可 |
| 会话持久化（JSONL / 落盘 / 恢复） | D3。见下面第 ① 条 |
| SSE 流式（含 `chatStream` / `sse.ts`） | D5 / D19。阶段一的流式代码已在 L3 删除 |
| MCP Client / Server | 只留了挂载点：`tools/registry.ts` 的 `createToolRegistry()` 加一个 `mount()` 即可，`core/tool-registry.ts` 的接口不用动 |
| token 统计 / 成本账本 | 阶段一 M4 的欠账，本项目未接手 |
| 错误类型体系（带 `code` 的 `LLMError`）、自动重试、上游取消与首字节超时 | 阶段一推给 M6 的欠账；本项目只在 HTTP 边界做 502 / 504 二分（`http/errors.ts`），**不引入错误类型体系** |
| 上下文预算裁剪 | 同上 |
| HTTP 侧的斜杠命令（`/clear` `/history`） | 前端没有命令输入口 |
| 前端测试框架（vitest / RTL） | D14。见下面第 ② 条 |
| `express.static` 托管 `web/dist`（同源部署） | 本次只跑 Vite dev + proxy。因为前端一律用相对路径，同源部署时前端一行都不用改 |
| HTTP 鉴权 / CORS 白名单 | D17，只监听 `127.0.0.1` |
| 会话淘汰用 LRU | D16，本次 FIFO、上限 100 |
| 浏览器断开后取消服务端在途请求 | 未做。服务端会继续跑完那一轮 |
| 多会话（前端同时开多个对话） | 未做。前端一次只跟一个会话说话（`localStorage` 里只存一个 id） |

### 两件必须记住的事

**① 会话只在服务端内存里，重启即丢。**
`http/session-registry.ts` 持有的是一个 `Map`，没有任何落盘。服务端一重启，
浏览器里那个 `sessionId` 就失效了，下一次请求会拿到 404。前端的处置是
**静默清掉本地 id 并给一条可关闭的提示**，而不是白屏；下一次发送会自动新建会话。

**② 前端没有自动化测试。**
`apps/web` 里没有任何测试文件，这是 D14 里写明的一笔**已知欠账**。
之所以把 `chatReducer` 拆成不 import React 的纯函数，就是为了将来补测试时不必重构。
**在补上之前，不要以为前端有测试覆盖。** 目前唯一守着前后端契约的是服务端的
`test/http-app.test.ts`（它逐字断言响应 JSON 的键与形状）。
