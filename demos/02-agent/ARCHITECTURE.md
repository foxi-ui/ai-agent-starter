# 架构

> 回答：这个系统由什么组成，一轮请求实际跑过了哪些步骤？

## 分层

```text
apps/web/      React 前端 —— 只通过 HTTP 说话，不 import 服务端任何文件
  ↑  HTTP（相对路径 /api，dev 时由 Vite proxy 反代）
apps/server/src/
  main.ts        进程入口：装配 client + registry + 会话表 → listen（唯一碰 process 的文件）
  http/          路由、请求校验、错误映射、会话注册表、会话 id
  presentation/  展示投影：Message[] → TranscriptItem[]
  core/          Agent 循环、会话状态、工具注册表接口、系统提示、类型契约
  llm/           DeepSeek adapter：请求构造、工具声明序列化、tool_calls 解析
  tools/         具体工具实现（weather / get_time / calculator）
```

依赖方向单向，无环：

```text
http → presentation → core
http → core
http → llm
http → tools
core → llm          （仅 import type）
tools → core        （实现 core 声明的接口）
```

## 依赖规则

| 允许 | 禁止 |
|---|---|
| `tools → core` | `core → tools` |
| `core → llm`（`import type`） | `core` / `llm` / `tools` / `presentation` → `express` |
| `http → 任意下层` | `presentation` → `http` |
| `main.ts` → `process.*` | 其它任何文件 → `process.stdout` / `process.stderr` |
| `apps/web` → HTTP | `apps/web` → 服务端任何文件 |

`core` / `llm` / `tools` / `presentation` 四层另有两条：**零第三方依赖**（只用 `node:` 内置模块
与全局 `fetch`），以及**不碰 `req` / `res`**。`express` 是本仓库唯一的运行时依赖，
只允许出现在 `http/`。

## 三条硬边界，各自的依据

**1. `presentation` 不知道 HTTP 存在。**
`presentation/transcript.ts` 的入参是 `Message[]`，出参是 `TranscriptItem[]`，全文件只
`import type { Message } from '@/core/types.ts'`。钉住它的是一次 grep（见
`plans/2026-09-25-l4-agent-loop.md` Task 7 Step 5）：
`grep -rn "@/http/" src/presentation/ src/core/ src/llm/ src/tools/` 必须无输出。

**2. 只有 `src/main.ts` 碰 `process`。**
依据是 `http/app.ts` 的 `AppDeps.logError` **必填、且由调用方注入** ——
它刻意不给一个写 `process.stderr` 的默认实现。这样 `http/` 里没有任何一处能碰 `process`，
错误日志的真实实现只能落在入口。

**3. agent 层只产出事实，界面的事归投影层。**
`runAgentTurn` 返回的 `AgentTurn = { final, added, stopReason }` 里**没有任何一个字段是为界面
存在的**。判断标准：删掉这个字段，浏览器上的东西会少一块吗？「调了哪个工具、传了什么、
成没成功」全部由 `presentation/transcript.ts` 从 `added` 推导。见 `DECISIONS.md` 的 D4。

## 一轮请求的完整数据流

以 `POST /api/sessions/:id/messages`（问「北京今天天气怎么样？」）为例：

```text
① 浏览器  POST /api/sessions/:id/messages  {message:"北京今天天气怎么样？"}
   apps/web/src/api.ts 用相对路径 → Vite proxy 反代到 :3000

② http/app.ts  校验 message 是非空字符串（express 5 下 req.body 可能是 undefined）

③ http/session-registry.ts  sessions.run(id, fn)
   —— 同一会话串行。不是优化，是正确性：Session.append 同步无锁，而一轮中间有 await，
      并发时两条 user 会先落地，第二条的 toMessages() 里出现没有 tool 回应的
      assistant{tool_calls}，上游直接 400 且错因不指向并发

④ core/agent.ts  runSessionTurn
   append('user', …)  →  toMessages(SYSTEM_PROMPT)  →  runAgentTurn
   （这两行的顺序是语义：反过来的话用户这句话根本没被发出去）

⑤ runAgentTurn 第 1 轮：client.chat(messages, {tools: registry.list(), model})
   llm/deepseek.ts  toWireTools() 把内部扁平声明包成 {type:'function', function:{…}}
   模型返回 content:null + tool_calls:[weather{arguments:'{"city":"Beijing"}'}]

⑥ 判据是 tool_calls 非空，**不看 finish_reason**（D7）
   → 追加 assistant{tool_calls}，再逐个调用：
     JSON.parse(arguments) → registry.execute('weather', {city:'Beijing'})
     → 结果 JSON.stringify 成 tool 消息的 content，靠 tool_call_id 认领那张单
   （参数非法 / 工具抛异常 / 工具名不存在 → 都变成 {ok:false} 的错误文本回喂，不崩）

⑦ 第 2 轮：把 assistant{tool_calls} + tool 一起发回去，模型这次不再开单
   → 追加最终 assistant，stopReason: 'answered'

⑧ appendAll(turn.added)  —— 只在整轮成功后调用一次，失败轮次不留下伪造的回答

⑨ presentation/transcript.ts  foldTranscript(turn.added)
   3 条消息折成 2 个展示项：那条只有 tool_calls、没有正文的 assistant
   **不产出空气泡**，它的信息变成了前面那个 tool 项

⑩ 200 JSON  { items: [...], stopReason: 'answered' }
   apps/web/src/chatReducer.ts 按序接到列表尾部
```

`GET /api/sessions/:id/messages` 走的是同一个 `foldTranscript`，只是范围换成整段历史。

## 两个容易问的问题

**为什么 `presentation` 这一层要存在？**
`Message` 是发给 API 的**线格式**，它按「模型需要什么」组织 —— `assistant{tool_calls}` 与
`tool` 是两条独立消息，而且前者可能没有正文。界面要的是「一次工具调用连它的结果」这样一整块。
两者形状天然不同。实时路径与历史路径共用同一个 `foldTranscript`（D18），
所以前端只需要一套渲染逻辑；否则要写两套，而两套迟早不一致。

**`GET` 为什么不加会话锁？**
`Session.history()` 返回的是**深拷贝**，读不会与在途的一轮打架。加锁反而会让一次刷新页面
等完一个几十秒的回答。

## 三个测试接缝

| 接缝 | 接口位置 | 替身 |
|---|---|---|
| `LLMClient` | `llm/client.ts` | 手写对象字面量（见 `test/agent.test.ts` 的 `fakeClient`） |
| `ToolRegistry` | `core/tool-registry.ts` | 手写对象字面量（见 `test/agent.test.ts` 的 `fakeRegistry`） |
| 端口 | `http/app.ts` 的 `createApp(deps)` | `app.listen(0,'127.0.0.1')` + Node 原生 `fetch`（见 `test/http-app.test.ts`） |

第三个接缝之所以成立，是因为 `createApp` **返回 app 而不 listen** —— 测试才能用临时端口
把它跑起来、跑完就关。
