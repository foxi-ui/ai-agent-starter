# ai-chat-agent

> 回答：这个项目怎么跑起来？

阶段二 · **Tool Calling / Agent Loop**。前后端分离：`apps/server` 是一个 express 服务端
（Agent 循环在里面），`apps/web` 是一个 React 对话框，两者只通过 HTTP 说话。

与前一个阶段（`demos/01-llm`）的关系是**复制**而不是共享依赖 —— 见 `DECISIONS.md` 的 D1。

## 环境要求

- **Node ≥ 22**（本项目在 v22.23.2 验证）—— 服务端靠原生类型擦除直接跑 `.ts`，无构建步骤
- **pnpm**（`packageManager` 锁在 `pnpm@10.34.5`）
- 一个 DeepSeek API key（只做真实冒烟时需要；`pnpm test` 全程离线）

## 目录结构

**阶段根只有编排脚本与文档，没有源码。** 两个可运行的应用平级放在 `apps/` 下：

```text
demos/02-agent/
  package.json          # 只放编排脚本，无源码
  pnpm-workspace.yaml   # packages: ['apps/*']
  README.md  ARCHITECTURE.md  DECISIONS.md  EVALUATION.md
  docs/
    troubleshooting.md
    how-agent-works.html      # Agent 循环讲解页
    superpowers/specs/  plans/
  apps/
    server/             # express 服务端 + Agent 循环
    web/                # React 前端（自带 Vite 工具链）
```

为什么不是「阶段根即服务端」见 `DECISIONS.md` 的 D21。

## 环境变量

放在 `apps/server/.env.local`（真实值，已 gitignore）；`.env` 是入库的占位符模板。

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | — | 缺失时服务端**启动即退出**（退出码 1），不是等到第一次请求才 401 |
| `DEEPSEEK_BASE_URL` | | `https://api.deepseek.com` | |
| `AI_CHAT_MODEL` | | `deepseek-flash` | 建会话时写进 `Session.model` |
| `AI_AGENT_PORT` | | `3000` | `0` 表示由内核分配一个空闲端口（子进程测试靠它避免端口冲突） |
| `AI_AGENT_HOST` | | `127.0.0.1` | 只监听回环地址，不做鉴权与 CORS（见 D17） |

## 命令

**全部在阶段根（`demos/02-agent/`）执行。**

```bash
pnpm install         # 一次装完两个应用
pnpm start           # 起服务端（:3000）
pnpm -F web dev      # 起前端 dev server（:5173，/api 反代到 :3000）
pnpm dev             # 并行起两个
pnpm test            # 服务端测试（node --test，全程离线）
pnpm run typecheck   # 两个应用都跑 tsc --noEmit
pnpm -F web build    # 前端构建产物 → apps/web/dist
```

单独跑某个服务端测试文件时**必须带 loader**（否则整个文件失败，不是某条用例失败）：

```bash
cd apps/server
node --import ./loader.mjs --test test/<name>.test.ts
```

## 手动冒烟（真实 API，单独跑，不进 `pnpm test`）

```bash
pnpm dev &
id=$(curl -sX POST localhost:3000/api/sessions | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"北京今天天气怎么样？"}'
```

然后在浏览器打开 `http://localhost:5173`，应当先看到 `⚙ weather` 轨迹块，再看到回答。

## 当前范围 / 尚未实现

`EVALUATION.md` 的「未做项与落点」一节逐条列了本次**明确推迟**的东西
（CLI 入口、会话持久化、流式、MCP、token 统计、前端测试框架……），
以及两条最需要记住的边界：**会话只在服务端内存里，重启即丢**；**前端没有自动化测试**。
那份文档是这些事实的唯一出处，这里不另抄一份。

服务端接口只有三个：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/sessions` | 建会话 → `{ sessionId, model }` |
| `POST` | `/api/sessions/:id/messages` | 发一句话 → `{ items, stopReason }`（`items` 是**本轮新增**的展示项，不含用户那条） |
| `GET` | `/api/sessions/:id/messages` | 取整段历史 → `{ items }` |

其余细节：`ARCHITECTURE.md`（一轮请求跑过哪些步骤）、`DECISIONS.md`（为什么这样设计）、
`docs/troubleshooting.md`（报错怎么查）。
