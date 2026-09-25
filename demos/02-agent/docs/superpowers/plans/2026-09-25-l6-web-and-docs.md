# L6 · 前端、文档与冒烟 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**这是渐进步骤的第 6 步（共 6 步）。** 顺序与判据见 [`README.md`](./README.md)。
**前置：L1–L5 已完成**（服务端能 `curl` 打通，响应 JSON 里已有工具轨迹）。

**Goal:** 建 `apps/web` —— 一个 React 聊天界面，能看到**工具调用轨迹**；然后把项目文档补上，跑一次端到端冒烟。

**这一步学到什么：**

1. **前端是独立工具链。** `apps/web` 有自己的 `package.json`、`tsconfig.json` 与 Vite 配置，是**本仓库第一个前端构建步骤**（spec D13）—— 它不进服务端的 `pnpm test` / `tsc --noEmit` 口径。
2. **前端只认 HTTP 契约，不 import 服务端任何文件。** `vite.config.ts` 的 proxy 把 `/api` 反代到服务端，所以**不需要 CORS**；前端代码里一律用**相对路径**，将来同源部署时一行都不用改。
3. **`sessionId` 的恢复要分清「没有」与「失效」。** mount 时若本地有 id 就 `GET` 历史；**404（服务端重启 / 会话被淘汰）不报错**，静默清掉本地 id 并给一条可关闭的提示 —— 不能白屏。而**建会话要推迟到首次发送**，否则每刷一次页面服务端就多一个没人用的会话。
4. **状态机的理由不是「状态多」**，而是 `items / status / notice` 三者若各用一个 `useState`，很容易渲染出「错误已设置但 status 还是 sending」的中间态。

**Architecture:** 前端整体是 `useReducer` + 独立纯函数 `chatReducer.ts`（不 import React）。**类型手写一份 `apps/web/src/types.ts`，不跨包 import 服务端的类型**（spec D15）—— 那会把服务端的 `@types/node` 拖进前端 tsconfig，而这份 tsconfig 刻意设了 `"types": []`。真正的守卫是服务端 `test/http-app.test.ts` 里对响应 JSON 键与形状的逐字断言。

**Tech Stack:** React 19 + Vite 8，独立 `package.json`；`pnpm install` 在**阶段根**一次装完两个应用。

**Spec:** `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 §12（前端）、§15（工具链）、§17（验收）；D13、D14、D15

## Global Constraints

以下约束对**每一个** Task 都生效，六份计划里都完整重复一遍。

- **Node ≥ 22**（本项目在 v22.23.2 验证），依赖原生类型擦除直接运行 `.ts`，服务端**不引入构建步骤**。
  **前端是唯一的例外** —— `apps/web/` 自带 Vite 工具链、独立 `package.json` 与独立构建产物，
  不进服务端的 `pnpm test` / `tsc --noEmit` 口径
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。
  判断标准：删掉所有类型标注后仍是合法 JS 的，才能用
- **只当类型用的导入必须写 `import type`**，否则擦除阶段无法识别，运行时抛
  「does not provide an export named …」而 `tsc --noEmit` 放行
  （前端由 `verbatimModuleSyntax` 在类型检查阶段强制）
- **`core/` / `llm/` / `tools/` / `presentation/` 零第三方依赖**，只用 `node:` 内置模块与全局 `fetch`
- **`http/` 层允许运行时依赖且必须登记**：当前唯一一条是 `express`（配套 `@types/express`）
- **依赖方向单向**：`http → presentation → core`、`http → core`、`http → llm`、`http → tools`、
  `core → llm`（仅 `import type`）、`tools → core`。
  **`core` 不 import `tools`**；**`presentation` 不 import `http`**；**`apps/web` 不 import 服务端任何文件**
- `core/` / `llm/` / `tools/` / `presentation/` **不 import express**、不碰 `req` / `res`、
  **不写** `process.stdout` / `process.stderr`；**只有 `src/main.ts` 碰 `process`**
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**；`start` / `dev` / `test` 三个脚本都要带
- ESM（`"type": "module"`）；包管理器 pnpm
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（裸 `node --test` 会匹配到它，静默撑大用例数）
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。
**本步相关的两条：**

1. **刷新页面时不该多建会话** —— 期望行为：只发 `GET .../messages`，
   **没有 `POST /api/sessions`**。测试落点：Task 14 Step 6 与 Task 16 Step 4（手动冒烟，
   因为前端没有自动化测试）。**注意**：不要去「数服务端的会话数」——
   `SessionRegistry.size()` 刻意不暴露给 HTTP，浏览器侧根本观测不到。
2. **`localStorage` 里的 id 是用户可改的** —— 它会被拼进 URL 路径。
   期望行为：`encodeURIComponent` 之后再用。测试落点：Task 13 Step 2 的代码。
3. **服务端重启后刷新页面** —— 期望行为：出现一条**可关闭**的提示，而不是白屏，
   且下一次发送会自动新建会话。测试落点：Task 14 Step 6。

---

### Task 12: 前端骨架

`apps/web` 是 workspace 里的一个包，依赖在**阶段根**一次装完（spec §12）。
本仓库**第一个前端构建步骤**（spec D13）。

**Files:**
- Create: `demos/02-agent/apps/web/{package.json,tsconfig.json,vite.config.ts,index.html}`
- Create: `demos/02-agent/apps/web/src/{main.tsx,App.tsx,styles.css}`

**Interfaces:**
- Consumes: 无
- Produces: 一个 `pnpm -F web build` 能过的空壳

- [ ] **Step 1: 写 `apps/web/package.json`**

```json
{
  "name": "web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.5.0",
    "vite": "^8.3.1"
  }
}
```

- [ ] **Step 2: 写 `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": []
  },
  "include": ["src", "vite.config.ts"]
}
```

`verbatimModuleSyntax` 与服务端那条「只当类型用的导入必须写 `import type`」是同一个教训，
这里直接在类型检查阶段强制它。`types: []` 也是刻意的 —— 前端**不应该**依赖 Node 的类型（spec §12）。

- [ ] **Step 3: 写 `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 前端一律用**相对路径** `/api/...`，dev 时由 Vite 反代到服务端。
      // 因此不需要 CORS 中间件（spec §12）；将来若改成 express.static 同源部署，
      // 前端代码一行都不用改。
      //
      // 这是整个前端里**唯一**允许出现服务端地址的地方。
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
```

- [ ] **Step 4: 写 `apps/web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ai-chat-agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 `apps/web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: 写 `apps/web/src/App.tsx` 空壳**

```tsx
export default function App() {
  return <main className="app">正在加载…</main>;
}
```

- [ ] **Step 7: 写 `apps/web/src/styles.css`**

配色沿用 `../how-agent-works.html` 的色板 —— 讲解页与界面用同一套颜色，
读文档与用界面的心智是一套。

```css
:root {
  --ground: #f4f5f7;
  --surface: #ffffff;
  --ink: #191c22;
  --ink-faint: #8a92a0;
  --line: #dce0e7;
  --user: #40454f;
  --user-bg: #f2f4f7;
  --llm: #3d50b4;
  --llm-bg: #e7eafb;
  --tool: #0e7c66;
  --tool-bg: #dff1ec;
  --warn: #a63b3b;
  --warn-bg: #faebeb;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ground: #11141a;
    --surface: #191d25;
    --ink: #e7eaf0;
    --ink-faint: #737c8c;
    --line: #2b313c;
    --user: #c6ccd6;
    --user-bg: #1b1f27;
    --llm: #93a2f0;
    --llm-bg: #1f2540;
    --tool: #5bc4a8;
    --tool-bg: #12291f;
    --warn: #e89393;
    --warn-bg: #35201f;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 15px;
  line-height: 1.6;
}

.app {
  display: flex;
  flex-direction: column;
  max-width: 760px;
  height: 100dvh;
  margin: 0 auto;
}

.app__header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}

.app__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.app__meta {
  color: var(--ink-faint);
  font-size: 13px;
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 20px 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 14px;
}

.notice button {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  opacity: 0.7;
}

.list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.list__empty {
  margin: auto;
  color: var(--ink-faint);
  text-align: center;
  font-size: 14px;
}

.bubble {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble--user {
  align-self: flex-end;
  background: var(--user-bg);
  color: var(--user);
  border: 1px solid var(--line);
}

.bubble--assistant {
  align-self: flex-start;
  background: var(--llm-bg);
  color: var(--llm);
}

.bubble--error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  align-self: stretch;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 14px;
}

/* 错误气泡的关闭按钮（spec §13 要求错误提示可关闭） */
.bubble__close {
  flex-shrink: 0;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  opacity: 0.7;
}

.tool {
  align-self: flex-start;
  max-width: 88%;
  padding: 8px 12px;
  border-left: 3px solid var(--tool);
  border-radius: 6px;
  background: var(--tool-bg);
  color: var(--tool);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

.tool__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.tool__badge {
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 11px;
  opacity: 0.8;
}

.tool__body {
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.9;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.composer__input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  resize: none;
}

.composer__input:focus {
  outline: 2px solid var(--llm);
  outline-offset: -1px;
}

.composer__send {
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  background: var(--llm);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.composer__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 8: 安装并验证**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm install
pnpm -F web typecheck
pnpm -F web build
```
Expected: 三条都成功，`apps/web/dist/` 生成

- [ ] **Step 9: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/web demos/02-agent/package.json \
        demos/02-agent/pnpm-workspace.yaml demos/02-agent/pnpm-lock.yaml
git commit -m "feat(web): 前端骨架（React 19 + Vite 8，proxy 反代 /api）"
```

---

### Task 13: 前端契约、API 客户端与状态机

对应 spec §12 的「组件与状态」与「类型」。

**Files:**
- Create: `demos/02-agent/apps/web/src/{types.ts,api.ts,chatReducer.ts}`

**Interfaces:**
- Consumes: Task 12 的骨架；**L5 Task 10 定下的响应形状**（键名必须逐字对上）
- Produces: `TranscriptItem` / `CreateSessionResponse` / `SendMessageResponse` / `HistoryResponse` / `ApiErrorBody`；
  `ApiError`；`createSession()` / `sendMessage()` / `fetchHistory()`；
  `ChatItem` / `ChatState` / `Action` / `chatReducer` / `initialChatState`

- [ ] **Step 1: 写 `apps/web/src/types.ts`**

```ts
// 线上契约的**抄写**（spec D15）。
//
// 为什么不跨包 import 服务端的类型：那要把服务端的 @types/node 拖进前端 tsconfig，
// 而这份 tsconfig 刻意设了 `types: []` —— 前端不应依赖 Node 的类型。
// 而且线上契约本来就不是服务端的内部 `Message` 联合，它是 `TranscriptItem`，是另一个东西。
//
// 真正的守卫在 apps/server/test/http-app.test.ts：那里逐字断言了响应 JSON 的键与形状。
// 这份文件改了而那边没改，服务端测试不会红 —— 所以改这里之前先看一眼那份测试。

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** 模型给的原始 JSON 字符串 */
      argumentsText: string;
      /** true=成功，false=失败，null=没等到结果 */
      ok: boolean | null;
      result: string;
    };

/** `POST /api/sessions` 的响应 */
export interface CreateSessionResponse {
  sessionId: string;
  model: string;
}

/**
 * `POST /api/sessions/:id/messages` 的响应。
 *
 * `items` 是**本轮新增**的展示项（工具轨迹 + 回答），**不含用户那条** ——
 * 前端已经知道自己发了什么。整段会话由 `GET` 提供，两者同一种形状（spec §9）。
 */
export interface SendMessageResponse {
  items: TranscriptItem[];
  stopReason: 'answered' | 'max-steps';
}

/** `GET /api/sessions/:id/messages` 的响应。`items` 是**整段会话** */
export interface HistoryResponse {
  items: TranscriptItem[];
}

/** 所有非 2xx 响应的统一形状 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}
```

- [ ] **Step 2: 写 `apps/web/src/api.ts`**

```ts
// 与服务端说话的唯一入口。
//
// **路径一律是相对的**（`/api/...`）：dev 时由 Vite 的 proxy 反代到 :3000，
// 将来同源部署时不用改一行。写成 `http://localhost:3000/...` 会让 proxy 完全失效、
// 触发 CORS 报错，而那个报错会把人引向「加 cors 中间件」这个错误解法。

import type {
  ApiErrorBody,
  CreateSessionResponse,
  HistoryResponse,
  SendMessageResponse,
} from './types.ts';

const BASE = '/api';

/** 带状态码与业务 code 的错误，方便调用方区分「会话没了」与「其它失败」 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);

  if (!response.ok) {
    // 服务端保证错误体是 JSON；但万一不是（比如反向代理插了一页 HTML），
    // 也不能让 res.json() 的 SyntaxError 把真正的原因盖掉
    let code = 'unknown';
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // 保留上面的兜底文案
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

export async function createSession(): Promise<CreateSessionResponse> {
  return await request<CreateSessionResponse>('/sessions', { method: 'POST' });
}

export async function sendMessage(sessionId: string, message: string): Promise<SendMessageResponse> {
  return await request<SendMessageResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function fetchHistory(sessionId: string): Promise<HistoryResponse> {
  return await request<HistoryResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
}
```

`encodeURIComponent` 不是可省的礼节：会话 id 会被拼进 URL 路径，
虽然服务端生成的形状固定，但 `localStorage` 里的值是**用户可改的**（本文件 Review Focus 第 2 条）。

- [ ] **Step 3: 写 `apps/web/src/chatReducer.ts`**

```ts
// 对话框的状态机。**纯函数、不 import React** ——
// 前端本次没有测试框架，拆成纯模块是为了将来补测试时不必重构（spec D14，一笔明确的欠账）。

import type { TranscriptItem } from './types.ts';

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'tool'; name: string; argumentsText: string; ok: boolean | null; result: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'error'; text: string };

export interface ChatState {
  items: ChatItem[];
  status: 'idle' | 'sending';
  /** 顶部那条可关闭的提示（例如「会话已失效」） */
  notice: string | null;
  /** 生成稳定 id 用的计数器。放在 state 里，reducer 才能保持纯粹 */
  nextId: number;
}

// 注意这里**没有 sessionId**：它由 useChat 的 ref 持有。
// 放进 state 会是一份没人写的死状态 —— reducer 无权创建会话（那是网络请求），
// 而把同一个值存两处，迟早出现两者不一致的中间态。

export const initialChatState: ChatState = {
  items: [],
  status: 'idle',
  notice: null,
  nextId: 1,
};

export type Action =
  | { type: 'history/loaded'; items: TranscriptItem[] }
  | { type: 'session/lost'; notice: string }
  | { type: 'notice/dismiss' }
  | { type: 'item/dismiss'; id: string }
  | { type: 'user/send'; text: string }
  | { type: 'turn/success'; items: TranscriptItem[] }
  | { type: 'turn/error'; text: string };

/** 把服务端给的展示项转成带稳定 id 的本地项 */
function toChatItems(items: TranscriptItem[], startId: number): ChatItem[] {
  return items.map((item, offset) => {
    const id = `item-${startId + offset}`;
    if (item.kind === 'tool') {
      return {
        id,
        kind: 'tool' as const,
        name: item.name,
        argumentsText: item.argumentsText,
        ok: item.ok,
        result: item.result,
      };
    }
    return { id, kind: item.kind, text: item.text };
  });
}

export function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'history/loaded':
      // 整段替换：服务端是渲染顺序的唯一事实来源
      return {
        ...state,
        items: toChatItems(action.items, state.nextId),
        nextId: state.nextId + action.items.length,
      };

    case 'session/lost':
      // 会话在服务端没了（重启或淘汰）：清空界面并给一条提示。
      // **不自动新建会话** —— 新建推迟到用户下次发送时，
      // 否则每刷新一次页面，服务端就多一个没人用的会话
      // （useChat 负责清 ref 与 localStorage）
      return { ...state, items: [], notice: action.notice, nextId: 1 };

    case 'notice/dismiss':
      return { ...state, notice: null };

    case 'item/dismiss':
      // spec §13 要求前端显示「一条**可关闭的**错误气泡」。
      // 列表里唯一可关闭的就是错误项：user / assistant / tool 都是对话记录，不该能删；
      // 顶部那条 notice 走的是 notice/dismiss，与这里无关。
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };

    case 'user/send':
      return {
        ...state,
        status: 'sending',
        items: [...state.items, { id: `item-${state.nextId}`, kind: 'user', text: action.text }],
        nextId: state.nextId + 1,
      };

    case 'turn/success': {
      // 服务端回的是**本轮增量**：先是工具轨迹、最后是回答 —— 直接按序接在后面
      const appended = toChatItems(action.items, state.nextId);
      return {
        ...state,
        status: 'idle',
        items: [...state.items, ...appended],
        nextId: state.nextId + action.items.length,
      };
    }

    case 'turn/error':
      return {
        ...state,
        status: 'idle',
        items: [...state.items, { id: `item-${state.nextId}`, kind: 'error', text: action.text }],
        nextId: state.nextId + 1,
      };

    default: {
      // 穷尽性守卫：给 Action 加一个变体却忘了处理时，这行会编译报错
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
```

- [ ] **Step 4: 类型检查**

Run: `cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm -F web typecheck`
Expected: 退出码 0

- [ ] **Step 5: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/web/src/types.ts demos/02-agent/apps/web/src/api.ts \
        demos/02-agent/apps/web/src/chatReducer.ts
git commit -m "feat(web): 线上契约、API 客户端与对话框状态机"
```

---

### Task 14: 前端组件与会话恢复

对应 spec §12 的「会话恢复」——**首次发送时才建会话**，以及 404 的静默降级。

**Files:**
- Create: `demos/02-agent/apps/web/src/useChat.ts`
- Create: `demos/02-agent/apps/web/src/components/{MessageList,MessageBubble,ToolTrace,Composer}.tsx`
- Modify: `demos/02-agent/apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 13 的 `chatReducer` / `ApiError` / `createSession` / `sendMessage` / `fetchHistory`
- Produces: `useChat()`（`{ state, send, dismissNotice, dismissItem }`）；四个组件；可用的 `App`

- [ ] **Step 1: 写 `apps/web/src/useChat.ts`**

```ts
// 把「reducer + 网络请求 + localStorage」粘在一起。
//
// 会话恢复的两个关键决定（spec §12）：
//   1. **首次发送时才建会话**，不是 mount 就建 —— 否则每刷新一次页面，
//      服务端就多一个没人用的会话（服务端虽然会 FIFO 淘汰，但那是兜底不是设计）
//   2. 历史读回 404（服务端重启或会话被淘汰）**不报错**，静默清掉本地 id
//      并给一条可关闭的提示；下一次发送会自动新建

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ApiError, createSession, fetchHistory, sendMessage } from './api.ts';
import { chatReducer, initialChatState } from './chatReducer.ts';

const STORAGE_KEY = 'ai-chat-agent.sessionId';

function readStoredSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式或被禁 cookie 时 localStorage 会抛 —— 那就当没有历史，不影响使用
    return null;
  }
}

function writeStoredSessionId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 存不上只是「下次刷新恢复不了」，不该让发送失败
  }
}

export function useChat() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  // 用 ref 而不是直接读 state.sessionId：send 每次渲染都会重建，
  // 但闭包里的 state 是**那一次渲染的**，长回答回来后可能已经过期
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const stored = readStoredSessionId();
    if (stored === null) return;

    let cancelled = false;
    void (async () => {
      try {
        const history = await fetchHistory(stored);
        if (cancelled) return;
        sessionIdRef.current = stored;
        dispatch({ type: 'history/loaded', items: history.items });
      } catch (error) {
        if (cancelled) return;
        // 只有「会话不存在」才静默降级；其它错误该让用户看见
        if (error instanceof ApiError && error.status === 404) {
          writeStoredSessionId(null);
          sessionIdRef.current = null;
          dispatch({
            type: 'session/lost',
            notice: '上一次的会话已失效（服务端可能重启过），下一条消息会开启新会话。',
          });
          return;
        }
        dispatch({
          type: 'turn/error',
          text: `读取历史失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === '' || state.status === 'sending') return;

      dispatch({ type: 'user/send', text: trimmed });

      try {
        let sessionId = sessionIdRef.current;
        if (sessionId === null) {
          const created = await createSession();
          sessionId = created.sessionId;
          sessionIdRef.current = sessionId;
          writeStoredSessionId(sessionId);
        }

        const result = await sendMessage(sessionId, trimmed);
        dispatch({ type: 'turn/success', items: result.items });
      } catch (error) {
        // 会话在发送途中没了：清掉，下一次发送会自己新建
        if (error instanceof ApiError && error.status === 404) {
          sessionIdRef.current = null;
          writeStoredSessionId(null);
        }
        dispatch({
          type: 'turn/error',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [state.status],
  );

  const dismissNotice = useCallback(() => dispatch({ type: 'notice/dismiss' }), []);
  // 关掉列表里的一条错误气泡（spec §13）
  const dismissItem = useCallback((id: string) => dispatch({ type: 'item/dismiss', id }), []);

  return { state, send, dismissNotice, dismissItem };
}
```

- [ ] **Step 2: 写四个组件**

`apps/web/src/components/ToolTrace.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/**
 * 一次工具调用的轨迹。**这是本项目最想让人看到的东西** ——
 * 模型开了什么调用单、程序传了什么参、工具回了什么。
 *
 * `ok` 为 null 表示「没等到结果」（半截历史），用中性标记而不是红叉 ——
 * 它既不是成功也不是失败。
 */
export function ToolTrace({ item }: { item: ToolItem }) {
  const badge = item.ok === null ? '无结果' : item.ok ? '成功' : '失败';
  return (
    <div className="tool">
      <div className="tool__head">
        <span>⚙ {item.name}</span>
        <span className="tool__badge">{badge}</span>
      </div>
      <div className="tool__body">{item.argumentsText}</div>
      {item.result !== '' && <div className="tool__body">→ {item.result}</div>}
    </div>
  );
}
```

`apps/web/src/components/MessageBubble.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';

type BubbleItem = Extract<ChatItem, { kind: 'user' | 'assistant' | 'error' }>;

/**
 * `onDismiss` 只对错误气泡传 —— spec §13 要求错误提示是**可关闭的**。
 * user / assistant 是对话记录，不该能删。
 */
export function MessageBubble({ item, onDismiss }: { item: BubbleItem; onDismiss?: () => void }) {
  return (
    <div className={`bubble bubble--${item.kind}`}>
      <span>{item.text}</span>
      {onDismiss !== undefined && (
        <button type="button" className="bubble__close" onClick={onDismiss} aria-label="关闭这条错误">
          ×
        </button>
      )}
    </div>
  );
}
```

`apps/web/src/components/MessageList.tsx`：

```tsx
import type { ChatItem } from '../chatReducer.ts';
import { MessageBubble } from './MessageBubble.tsx';
import { ToolTrace } from './ToolTrace.tsx';

export function MessageList({
  items,
  sending,
  onDismissItem,
}: {
  items: ChatItem[];
  sending: boolean;
  onDismissItem: (id: string) => void;
}) {
  return (
    <div className="list">
      {items.length === 0 && !sending && (
        <p className="list__empty">
          问点什么吧。
          <br />
          试试「北京今天天气怎么样？」—— 会看到模型调用 weather 工具的完整轨迹。
        </p>
      )}

      {items.map((item) =>
        item.kind === 'tool' ? (
          <ToolTrace key={item.id} item={item} />
        ) : (
          <MessageBubble
            key={item.id}
            item={item}
            onDismiss={item.kind === 'error' ? () => onDismissItem(item.id) : undefined}
          />
        ),
      )}

      {sending && <div className="bubble bubble--assistant">…</div>}
    </div>
  );
}
```

`apps/web/src/components/Composer.tsx`：

```tsx
import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  const submit = (): void => {
    if (disabled || text.trim() === '') return;
    onSend(text);
    setText('');
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    submit();
  };

  // Enter 发送、Shift+Enter 换行。textarea 默认行为是换行，
  // 所以要显式拦住不带修饰键的那一次
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        className="composer__input"
        rows={1}
        value={text}
        placeholder={disabled ? '等待回答…' : '输入消息，Enter 发送'}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="composer__send" type="submit" disabled={disabled || text.trim() === ''}>
        发送
      </button>
    </form>
  );
}
```

- [ ] **Step 3: 改 `apps/web/src/App.tsx`**

```tsx
import { Composer } from './components/Composer.tsx';
import { MessageList } from './components/MessageList.tsx';
import { useChat } from './useChat.ts';

export default function App() {
  const { state, send, dismissNotice, dismissItem } = useChat();

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">ai-chat-agent</h1>
        <span className="app__meta">阶段二 · 工具调用</span>
      </header>

      {state.notice !== null && (
        <div className="notice">
          <span>{state.notice}</span>
          <button type="button" onClick={dismissNotice} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}

      <MessageList
        items={state.items}
        sending={state.status === 'sending'}
        onDismissItem={dismissItem}
      />
      <Composer disabled={state.status === 'sending'} onSend={(text) => void send(text)} />
    </main>
  );
}
```

- [ ] **Step 4: 类型检查与构建**

Run: `cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm -F web typecheck && pnpm -F web build`
Expected: 两条都成功

- [ ] **Step 5: 确认前端没有硬编码服务端地址**

Run:
```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent/apps/web
grep -rn "localhost:3000\|127.0.0.1:3000" src/ || echo "干净：src/ 里没有绝对地址"
```
Expected: 输出「干净：src/ 里没有绝对地址」

- [ ] **Step 6: 双进程手动冒烟**

```bash
# 终端 A
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm start
# 终端 B
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent && pnpm -F web dev
```

浏览器打开 http://localhost:5173，逐条确认：

1. 问「北京今天天气怎么样？」→ 先出现 `⚙ weather` 轨迹块（含参数与结果），再出现回答气泡
2. 刷新页面：历史还在（`user / tool / assistant` 三种气泡都渲染出来）
3. **刷新三次不会多建会话** —— 打开 DevTools 的 Network 面板，连刷三次页面，
   确认每次只发出 `GET /api/sessions/:id/messages`，**没有任何 `POST /api/sessions`**
   （第一次发送之前也不该有）。
   *不要*去数服务端的会话数：`SessionRegistry.size()` 刻意不暴露给 HTTP，
   在浏览器侧根本观测不到，写「服务端会话数不增长」是一条**没法验证**的验收项。
4. 杀掉服务端再刷新：出现「会话已失效」的**可关闭**提示，**不是白屏**
5. 此时再发一条消息：自动新建会话并正常回答
6. 让服务端返回一次错误（例如临时改坏 `.env.local` 里的 key 再重启）：
   界面出现一条红色错误气泡，且**点它的关闭按钮能关掉**（spec §13）

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/web
git commit -m "feat(web): 对话框组件、工具轨迹渲染与会话恢复"
```

---

### Task 15: 文档与既有产物同步

根 `AGENTS.md` 与根 `README.md` 已经在本项目之前改完了，本 Task 只负责 `demos/02-agent/` 自己的文档。
每份文档的头部 `> 回答：…` 一行**必须与根 `AGENTS.md` 的职责表一致，且只写一个问号**。

**Files:**
- Create: `demos/02-agent/{README.md,ARCHITECTURE.md,DECISIONS.md,EVALUATION.md}`、`docs/troubleshooting.md`
- Modify: `demos/02-agent/docs/how-agent-works.html`

**Interfaces:**
- Consumes: Task 1–14 的全部产物
- Produces: 五份文档

- [ ] **Step 1: 写 `README.md`**

头部必须是 `> 回答：这个项目怎么跑起来？`。至少覆盖：

- 项目定位（阶段二 · Tool Calling / Agent Loop · 前后端分离）
- 环境要求（Node ≥ 22、pnpm）
- **目录结构说明**：阶段根只有编排脚本与文档，两个应用在 `apps/` 下
- 环境变量表：`DEEPSEEK_API_KEY`（必需）/ `DEEPSEEK_BASE_URL` / `AI_CHAT_MODEL` /
  `AI_AGENT_PORT`（默认 3000）/ `AI_AGENT_HOST`（默认 127.0.0.1）
- 命令（**在阶段根执行**）：
  ```bash
  pnpm install         # 一次装完两个应用
  pnpm start           # 起服务端（:3000）
  pnpm -F web dev      # 起前端 dev server（:5173，/api 反代到 :3000）
  pnpm dev             # 并行起两个
  pnpm test            # 服务端测试
  pnpm run typecheck   # 两个应用都跑 tsc --noEmit
  pnpm -F web build    # 前端构建产物 → apps/web/dist
  ```
- 当前范围 / 尚未实现（照 `EVALUATION.md` 的未做清单列，**不要另写一份**）

- [ ] **Step 2: 写 `ARCHITECTURE.md`**

头部 `> 回答：这个系统由什么组成，一轮请求实际跑过了哪些步骤？`。至少覆盖：

- 分层图与依赖方向：`http → presentation → core → llm`、`tools → core`、`http → tools`
- 依赖规则表（允许 / 禁止），把 `express`、`node:fs`、`req`/`res`、`process.std*` 写进去
- **三条硬边界的依据**（谁在哪个文件里被强制、哪条 grep 或哪个测试钉住它）
- **一轮请求的完整数据流**：
  `POST /api/sessions/:id/messages` → `sessions.run`（串行锁）→ `runSessionTurn`
  → `client.chat(messages, {tools})` → 有 `tool_calls` → `registry.execute` → 回喂 → 收敛
  → `appendAll(added)` → `foldTranscript(turn.added)` → 200 JSON
- **`presentation` 这一层为什么存在** —— 说明「`Message` 是按模型需要组织的，
  展示项是按人的阅读顺序组织的」，以及实时路径与历史路径怎么共用同一个 `foldTranscript`
- `GET` 为什么**不加会话锁**
- 三个测试接缝各自长什么样：`LLMClient` / `ToolRegistry` / `createApp(deps)` + `listen(0)`

- [ ] **Step 3: 写 `DECISIONS.md`**

头部 `> 回答：为什么是这样设计的，放弃了什么？`。
**逐条抄 spec §18 的 D1–D21**，每条写：理由 / 放弃了什么 / 代价。不要只写结论。

- [ ] **Step 4: 写 `EVALUATION.md`**

头部 `> 回答：docs/ROADMAP.md 阶段的验收标准，现在达标到什么程度？`，并遵守本仓库的规矩：
**状态必须附证据，不接受「已完成」这类无证据的断言。**
「若某条验收项在路线里找不到落点，显式标出来」——这是这份文件最有价值的用途。

对上 ROADMAP 的**阶段 1**（本项目对应项）：

| 验收项 | 状态 | 证据 |
|---|---|---|
| 自己实现 Agent Loop | | `test/agent.test.ts` 的多步循环、`maxSteps` 恰好 N 次调用 |
| 自己定义 Tool | | `test/tools-registry.test.ts` 的三份 schema |
| 处理 Tool Result | | `test/agent.test.ts` 的回喂断言 |
| 实现基本任务循环 | | `test/http-app.test.ts` 的端到端天气轮 |
| 防止无限循环 | | `test/agent.test.ts` 的 `maxSteps` 用例 + `stopReason` |

再加一节 **「未做项与落点」**，逐条抄 spec §2 的「明确推迟」表。
**特别写清楚两件事**：① 会话只在服务端内存里，重启即丢；② 前端没有自动化测试。

- [ ] **Step 5: 写 `docs/troubleshooting.md`**

头部 `> 回答：遇到这个报错怎么定位和修？`。本次至少记这几条（每条都写
「问题 → 尝试 → 失败 → 原因 → 解决 → 经验」）：

- **服务端测试整个文件卡到超时** —— `server.close()` 被 undici 的 keep-alive 连接挂住；
  必须 `closeAllConnections()`
- **`import { Request } from 'express'` 运行时报「does not provide an export named」** ——
  只当类型用的导入没写 `import type`，而 `tsc --noEmit` 放行
- **`app.get('*')` 启动即抛「Missing parameter name」** —— express 5 的 path-to-regexp v8
  不再接受裸 `*`；404 兜底改用 `app.use`
- **不带 `Content-Type` 的 POST 返回 500 而不是 400** —— express 5 的 `req.body` 是 `undefined`
- **前端请求触发 CORS 报错** —— 多半是 `api.ts` 里写了绝对地址，绕过了 Vite proxy。
  正解不是加 `cors` 中间件
- **上游 400 说 tools 结构不对** —— 大概率是 `toWireTools` 少包了一层
  `{type:'function', function:{…}}`（见 L3 的 Task 5 Step 1 的核实结论）
- **L1/L2 期间 `pnpm test` 一直红** —— 那是 `deepseek.ts` 的值导入指向没被复制的 `sse.ts`，
  L3 会修掉；不是可以顺手提前修的
- 再把 01-llm 的三条**跨阶段通用**的坑复制过来：`@/` 别名与 loader、
  不用需要代码变换的 TS 特性、pnpm 的 `--` 不能带

- [ ] **Step 6: 改 `docs/how-agent-works.html`**

那份讲解页的「每个文件负责哪一步」表现在是按纯 CLI 写的。**逐行改成新结构**：

| 文件 | 负责什么 |
|---|---|
| `src/core/types.ts` | 定义 Message（含 tool 角色）、ToolCall、Tool |
| `src/core/tool-registry.ts` | ToolRegistry 接口：list() / execute() |
| `src/core/agent.ts` | runAgentTurn 循环：调 → 判断 → 执行 → 回喂，含 maxSteps |
| `src/core/session.ts` | 维护数组：append / appendMessage / appendAll / toMessages |
| `src/tools/*` | weather / get_time / calculator 的具体实现 |
| `src/llm/deepseek.ts` | 发 tools、解析 tool_calls / finish_reason |
| `src/http/app.ts` | 路由：把一轮请求交给 runSessionTurn，再把结果投影成 JSON |
| `src/presentation/transcript.ts` | 把 Message[] 折叠成展示项（实时与历史共用） |
| `apps/web/src/components/ToolTrace.tsx` | 把展示项渲染成工具轨迹气泡 |

并在「第一步」那张循环图下面补一句话：

> **Agent 只产出事实，界面的事归投影层。** `runAgentTurn` 返回的
> `final` / `added` / `stopReason` 里没有任何一个字段是为界面存在的；
> 「调了哪个工具、传了什么、成没成功」全部由 `presentation/transcript.ts`
> 从 `added` 推导出来。

- [ ] **Step 7: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent
git commit -m "docs: 02-agent 的四件套、troubleshooting 与讲解页同步"
```

---

### Task 16: 端到端冒烟

**Files:** 无（只跑验证）

- [ ] **Step 1: 全量质量门**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm run typecheck
pnpm test
pnpm -F web build
```
Expected: 三条全绿。**把实际数字记下来**（通过用例数、构建产物大小）

- [ ] **Step 2: 确认密钥没被带进任何产物**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git status --short
git check-ignore -v demos/02-agent/apps/server/.env.local \
  demos/02-agent/apps/web/node_modules demos/02-agent/apps/web/dist
key=$(grep -h DEEPSEEK_API_KEY demos/02-agent/apps/server/.env.local | cut -d= -f2 | head -c 12)
grep -rn "$key" demos/02-agent/apps/server/src demos/02-agent/apps/web/src demos/02-agent/docs \
  2>/dev/null || echo "源码与文档里没有密钥"
```
Expected: `.env.local` / `node_modules` / `dist` 都被忽略；源码里搜不到密钥前缀

- [ ] **Step 3: 服务端 + 接口冒烟（真实 API）**

```bash
cd /Users/mawq/workspaces/ai-agent-starter/demos/02-agent
pnpm start &
sleep 1
id=$(curl -sX POST localhost:3000/api/sessions | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
echo "=== 问天气 ==="
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"北京今天天气怎么样？"}'
echo
echo "=== 问算术（验证第二个工具） ==="
curl -sX POST "localhost:3000/api/sessions/$id/messages" \
  -H 'content-type: application/json' -d '{"message":"1+2*3 等于几"}'
echo
echo "=== 取历史 ==="
curl -s "localhost:3000/api/sessions/$id/messages"
kill %1
```
Expected: 每条响应里都能看到对应的工具轨迹；历史返回的 items 覆盖全部轮次

- [ ] **Step 4: 浏览器端到端**

```bash
pnpm start            # 终端 A
pnpm -F web dev       # 终端 B
```

逐条确认并**记录实际结果**：

1. http://localhost:5173 问「北京今天天气怎么样？」→ 先出现 `⚙ weather` 轨迹块，再出现回答
2. 问「1+2*3 等于几」→ 看到 `calculator` 轨迹
3. 问「现在几点」→ 看到 `get_time` 轨迹
4. 刷新页面 → 历史完整（三种气泡都在）
5. 连刷三次页面 → **Network 面板里只有 `GET .../messages`，没有 `POST /api/sessions`**
   （服务端会话数在浏览器侧观测不到，不要写成「会话数不增长」）
6. 杀掉服务端 → 刷新页面出现「会话已失效」提示而不是白屏；再发消息能自动新建会话
7. 等待回答期间输入框是禁用的
8. 制造一次错误（改坏 key 再重启）→ 出现红色错误气泡，**且能点关闭按钮关掉**

- [ ] **Step 5: 如实报告**

按根 `AGENTS.md` 的格式给出：

```text
TypeCheck: PASS / FAIL / N/A
Lint:      N/A（本仓库未配置 linter）
Test:      PASS / FAIL / N/A
Build:     N/A（服务端 noEmit）／前端 vite build PASS
```

任何一条没达标就**照实写出来**，不要用「应该没问题」代替。

---

## L6 与整个阶段的完成标准

- `pnpm run typecheck` 通过（两个应用）
- `pnpm test` 全绿（服务端 **120 条**）
- `pnpm -F web build` 成功
- 浏览器跑通天气例子，且**工具轨迹可见**
- 五份文档（README / ARCHITECTURE / DECISIONS / EVALUATION / troubleshooting）与代码一致

**明确不达标的两项，报告时必须如实写出，不能用「测试全绿」掩盖：**

1. **前端没有自动化测试。** `apps/web/src/chatReducer.ts` 是纯函数、本来最容易测，
   但本项目不引 vitest（spec D14）。它被拆成纯模块是**为了让将来补测试不必重构**，
   不是为了现在有覆盖。前端目前唯一的验证是 Task 14 Step 6 与 Task 16 Step 4 的手动冒烟。
2. **会话只在服务端内存里，重启即丢。** HTTP 的 `Session` 没有任何持久化（spec D3），
   服务端一重启，浏览器 `localStorage` 里的 id 就失效（会走「会话已失效」的降级分支）。
   这是有意取舍，但半年后回看时不能误以为「刷新不丢」等于「持久化」。

---

## 整个阶段做完之后

回到 [`../specs/2026-09-25-ai-chat-agent-web-design.md`](../specs/2026-09-25-ai-chat-agent-web-design.md)
的 **§17 验收** 逐条对照，并把结果写进 `EVALUATION.md`。
