# 架构

> 回答：项目由什么组成？模块之间如何依赖？
> 事实来源：`src/` 实际源码目录。

## 总览

三层内核，依赖方向**严格单向**：

```text
cli/      readline 主循环、打印、配置解析
  ↓  只依赖 core 与 llm 的公开接口
core/     会话状态、消息组装
  ↓  只依赖 core 自身类型
llm/      DeepSeek adapter：请求构造、响应解析、SSE 分帧与事件归一化
```

关键约束（由 spec 规定，代码需遵守）：

- `llm/` 与 `core/` **不 import `node:readline`**，**不写 `process.stdout` / `process.stderr`**。
  副作用只允许出现在 `cli/` 与 `src/index.ts`。
- 边界接口是 `LLMClient`。测试用替身替换它，使 CLI 行为能在**无网络**下断言。

这套骨架为后续增量（命令 / 落盘 / token 统计）预留了挂载点：新增能力主要落在
`llm/`（如何调用）与 `cli/`（如何交互），`core/` 保持稳定。
**streaming（M2a）已经按这个方式落过一遍** —— 新增 `llm/sse.ts` 与 `cli/render.ts`
两个文件，`core/types.ts` 只多了几个类型，`core/session.ts` 只多了一个 `model` 存取器。

## 模块职责

| 文件 | 层 | 职责 | 不负责 |
| --- | --- | --- | --- |
| `src/index.ts` | 入口 | 解析配置、组装依赖、启动 REPL；配置缺失时退出码 1 | 任何对话逻辑 |
| `src/cli/config.ts` | cli | 环境变量 → `Config`，集中默认值 | 读取 `process.env` 之外的事 |
| `src/cli/repl.ts` | cli | readline 主循环、调用 `LLMClient`、打印结果与错误 | HTTP、消息组装细节 |
| `src/core/types.ts` | core | `Role` / `Message` / `ChatResult` / `StreamEvent` / `FinishReason` / `ChatOptions` 类型定义 | 行为 |
| `src/core/session.ts` | core | 消息数组累积；`toMessages(systemPrompt)` 组装请求消息 | 网络、打印 |
| `src/llm/client.ts` | llm | `LLMClient` 接口 + `LLMClientConfig`（测试接缝） | 具体实现 |
| `src/llm/deepseek.ts` | llm | `fetch` 调用 `/chat/completions`、解析 `content`、非 2xx 抛错 | 打印、重试 |
| `src/llm/sse.ts` | llm | SSE 分帧（纯函数，只懂协议不懂 DeepSeek） | 网络、解码、事件语义 |
| `src/cli/render.ts` | cli | `StreamEvent` → stdout/stderr 的呈现 | 累积正文、网络 |
| `loader.mjs` | 构建 | 向 Node 注册 `@/` 别名钩子 | 业务逻辑 |
| `loader-hooks.mjs` | 构建 | 把 `@/x` 解析为 `src/x` 的真实文件 URL | 业务逻辑 |

## 接口边界

`src/llm/client.ts` 是整个架构的接缝：

```ts
export interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamEvent>;
}

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type LLMClientFactory = (config: LLMClientConfig) => LLMClient;
```

`ChatOptions` 是**每次请求**的参数（目前只有 `model`，将来还会加 thinking 开关），
定义在 `core/types.ts`。它随请求传，而不是塞进 `LLMClientConfig` —— 否则 client
会变成有状态的，多会话共享时互相污染（见 D17）。

- `cli/repl.ts` 只依赖 `LLMClient`，不知道 DeepSeek 的存在。
- `llm/deepseek.ts` 是它的一个实现。
- 测试直接传入手写替身（见 `test/repl.test.ts` 的 `fakeClient`），因此
  **REPL 的全部行为都能在没有网络、没有 API key 的情况下断言**。

这是「可测试性」在这里的具体含义：把网络调用收敛到一个接口后面。

## 依赖规则

| 允许 | 禁止 |
| --- | --- |
| `cli → core`、`cli → llm` | `core → cli`、`llm → cli` |
| `llm → core`（只取类型）；`llm/sse.ts` 是纯函数，不碰 IO | `core → llm` |
| 任意层 → `node:` 内置模块 | `llm` / `core` → `node:readline` |
| `core` / `llm` 导出纯函数与类型 | `core` / `llm` 写 `process.stdout` |

`core` 与 `llm` 之间只有类型依赖（`import type`），运行时不存在 `core → llm` 的边。

## `@/` 路径别名

源码统一用 `@/` 指向 `src/`：

```ts
import { Session } from '@/core/session.ts';
```

**这件事需要特别说明**，因为 Node 的原生类型擦除**不读取 `tsconfig.json` 的
`paths`**：

- `tsc` 依据 `tsconfig.json` 的 `paths` 做类型检查 → 别名对类型检查有效。
- Node 运行时完全不看 `paths` → 别名对运行时**无效**。

结果是：`@/` 出现在 `import type` 中能侥幸工作（该语句在运行前被整体擦除），
但一旦出现在**值导入**中，就会在运行时抛 `ERR_MODULE_NOT_FOUND`。

因此项目注册了一个 `resolve` 钩子把别名补上：

```text
loader.mjs         通过 node --import 加载，调用 module.register()
      ↓ 注册
loader-hooks.mjs   在钩子线程中把 @/x 解析为 src/x 的文件 URL
```

`package.json` 的 `start` 与 `test` 脚本都带上 `--import ./loader.mjs`
（`node --test` 会把 `--import` 传递给派生的测试子进程）。

> **注意**：`--import` 只是「导入」模块，并不会自动把其中的 `resolve` 导出当作钩子，
> 必须显式调用 `module.register()`。这是两个文件而非一个文件的原因。

`tsconfig.json` 同时开启了 `allowImportingTsExtensions`：本项目在值导入中写
`'./x.ts'` 显式扩展名（配合原生类型擦除），不开这个选项会报 `TS5097`。

## 重要约束

- **零运行时依赖**：`dependencies` 为空。`loader-hooks.mjs` 只用 `node:` 内置模块。
- **密钥不落代码**：`apiKey` 只从环境变量读入，经 `Config` 传给 adapter。
- **上下文只在内存**：进程退出即清空。持久化属于后续增量。
