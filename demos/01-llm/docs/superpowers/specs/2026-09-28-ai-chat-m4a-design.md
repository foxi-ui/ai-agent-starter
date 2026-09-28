# ai-chat M4a · 设计文档（上下文预算 + 两个开关）

- 日期：2026-09-28
- 状态：待 review
- 范围：M4a —— **上下文预算裁剪 + `--show-reasoning` + `--no-thinking`**
- 前置：M1（非流式多轮 + 最小错误处理）、M2（streaming + 命令）、M3（会话持久化）已完成
- 约束来源：`AGENTS.md`（跨阶段技术约束）、`ARCHITECTURE.md`、`DECISIONS.md` D7 / D13 / D18 / D21 / D22 / D26

---

## 1. 背景与目标

归档蓝图 `archive/01-llm/01-full-design.md` 的 M4 是一句话：

```text
M4 /usage + --no-thinking + --show-reasoning + 上下文预算
```

它捆了**四件耦合度差别很大**的事。本次拆成两个增量（沿用 M2a / M2b 的先例）：

| 增量 | 内容 | 为什么这样切 |
| --- | --- | --- |
| **M4a（本次）** | 上下文预算裁剪 + `--show-reasoning` + `--no-thinking` | 三件事彼此独立、**都不动 JSONL 格式契约**，且改动面小 |
| **M4b（下次）** | usage 解析 + 跨会话账本 + 成本估算 + `/usage` | 一条长链：`StreamEvent` → `ChatResult` → 日志记录 → store → 命令 → 渲染，**要改 JSONL 格式契约** |

**本次的排序理由**：先清掉不动契约的部分，把格式变更集中到 M4b 一次做完。

成功标准：

- 历史很长时，**实际发给模型的消息数组**会被裁到预算内，且模型仍能正确回答当前问题
- 裁剪**只影响这一轮请求**——会话内存与磁盘上的 JSONL 仍是完整历史
- `--show-reasoning` 能在终端看到思考全文，且 `pnpm start > answers.txt` 拿到的文件里**没有**思考文字
- `--no-thinking` 能真的关掉 thinking（请求体带 `thinking: { type: 'disabled' }`）
- 预算阈值可调小到几百 token，使裁剪在真实使用中**能被观察到**（否则这个模块只有单测、永远跑不到）

---

## 2. 范围界定

### 本次范围

- `src/core/context.ts`【新】：`estimateTokens` / `fitToBudget`，纯函数
- `src/core/types.ts`：`ChatOptions` 加 `thinking?: boolean`
- `src/llm/deepseek.ts`：按需在请求体里翻译出 `thinking: { type: 'disabled' }`
- `src/cli/args.ts`：新增 `--show-reasoning` / `--no-thinking` / `--max-context <n>` 与组合校验
- `src/cli/render.ts`：`showReasoning` 为真时把思考全文写到 **stderr**
- `src/cli/repl.ts`：组装（组装消息 → 裁剪 → 请求）、把 `thinking` 放进 `ChatOptions`、渲染选项
- `src/index.ts`：把三个开关从 `Args` 传到 `runRepl`
- 四份文档同步（见 §13）

### 明确推迟（本次不实现、不设计细节）

- **usage 解析、Token 账本、成本估算、`/usage` 命令** —— 归 **M4b**。本次**一行都不碰** JSONL 格式与会话日志
- **`--timeout`、错误分类（`LLMError.code`）、中断回滚、`-p` 一次性模式** —— 归 M6
- **`reasoning_effort`（`none/low/high/max`）** —— API 支持，但蓝图未列，YAGNI
- **REPL 内切换思考/显示的斜杠命令** —— 见 D-M4a-7
- **精确 tokenizer（tiktoken 等）** —— 见 D-M4a-1，零运行时依赖是硬约束
- **`--help` / `-h` 入口** —— 参数出错时的提示里带用法，但不做专门的 help

---

## 3. 设计决策汇总

每条都记了**被放弃的选项**，因为决策过程不在代码里。

### D-M4a-1. `estimateTokens` 用 `chars / 1.5`，**不是**蓝图 §7 的 `chars / 4`

归档蓝图 §7 写：

> 无精确 tokenizer 时用估算：`tokens ≈ chars / 4`（中文约 1.5 字符/token，英文约 4，取 4 作保守上界）。

**这句话的「保守」方向是反的。** `chars / 4` 对英文是准的，对中文是**低估**：3 个汉字约合 2 token，而 `chars / 4` 只给 0.75。低估的后果是「以为还没超预算、实际已经超了」——正好是不保守的那一侧。保守的正确做法是取**更小的除数**（宁可高估、早裁剪）。

本项目对话以中文为主（README 与全部冒烟用例都是中文），所以取 **`Math.ceil(text.length / 1.5)`**。

**已知不精确处**（写进注释，避免将来被当成 bug）：

- 英文材料会被高估约 2.7 倍 —— 这是**有意**偏向安全的一侧
- `String.length` 是 UTF-16 码元数：BMP 内的汉字算 1、emoji 等代理对算 2
- 估算**只用于预算决策**；真实用量以 API 返回的 `usage.prompt_tokens` 为准（M4b 消费）

**放弃：引入 tiktoken 之类的精确 tokenizer。** 那会破坏「核心层零运行时依赖」这条跨阶段硬约束，且要为不同模型各带一份词表。估算器的误差在这个用途上完全够用。

### D-M4a-2. 裁剪由 `repl` 调 `fitToBudget`，**不塞进 `Session`**

```text
session.toMessages(SYSTEM_PROMPT)   →  [system, ...完整历史]
        ↓  fitToBudget(messages, maxContext)
   [system, ...裁剪后的历史]        →  client.chatStream(...)
```

**为什么不让 `Session.toMessages()` 自己裁**：`Session` 是纯状态（D8 已经确立了「它不存 system prompt」的边界），让「预算」这个**策略**渗进状态层，会把一个可单测的纯函数变成 `Session` 的一个隐藏行为，也让「裁剪」和「组装」两件事再也分不开。

**放弃：在 `llm/deepseek.ts` 里裁。** 上下文策略不是传输层的职责，而且 `llm/` 层没有「轮」的概念。

### D-M4a-3. 「轮」按 **user 消息**切分，不按 role 交替推

裁剪的原子单位是「轮」，绝不拆半条消息（拆开会给模型一条没有问题的答案，比少一轮更糟）。但**不能用「user/assistant 交替」来推轮边界**：

> 成功的轮次是 `user, assistant`，而**失败的轮次只留 user 不留 assistant**（D7：失败的轮次不追加 assistant 消息）。
> 会话历史里于是可能出现 `[…, user(失败的那次), user(下一问), assistant]` —— 两个 user 相邻。

所以分段规则定义为：

```text
从 index 1 开始（index 0 是 system，永不参与裁剪）
每遇到一条 user 就开一个新组，直到下一条 user 之前
若 index 1 不是 user（文件开头就是 assistant 之类的残余），该残余单独成一组
```

**放弃：按「两条消息一组」机械切。** 那会在失败轮次处切错，把一次失败的提问和下一次的提问绑成一组丢掉。

### D-M4a-4. 裁剪发生时 **stderr 警告一行**

```text
[上下文] 已裁剪 N 条最早的消息（约 M token）
```

**为什么不能静默**：用户看到的现象是「模型怎么把我前面说的忘了」——静默的话这就是一个无法解释的怪现象。一行警告把它变成可归因的行为。

**为什么只警告一行、不是每条都报**：与 M3 的写盘失败降级（D-M3-7）同一个理由——每轮刷同一句会把屏幕占满。

**走 stderr**：正文与命令结果才走 stdout（D13 / D26）。裁剪是诊断信息。

### D-M4a-5. 裁剪是「**每次请求时的一次投影**」，不回写 `Session`、不影响落盘

裁剪结果**只用于本次请求**。`Session.messages` 与磁盘上的 JSONL 始终是完整历史。

**为什么**：那是「发给模型的内容」与「会话记得的内容」的区别，和 D7 的「屏幕上看到的 ≠ 模型记得的」是同一类边界。若把裁剪结果回写，`/clear` 之外的又一条静默删改历史的路径就出现了，且磁盘上会永久丢掉用户的对话。

**代价**：每一轮都要重算一次（O(消息数) 次估算）。这个量级完全无所谓；将来若真的成为瓶颈，再谈缓存。

### D-M4a-6. `--show-reasoning` 的思考正文走 **stderr**

按既有分流契约的**字面**立论，「用户主动要的东西该走 stdout」——用户开了开关，思考就是主动要的。但这条不采纳，理由是：

- stdout 的既有契约是「**模型回答 + 命令结果**」，`pnpm start > answers.txt` 能拿到一份干净的回答文件，这是被 EVALUATION 的证据专门验证过的行为
- 思考通常**比答案长得多**（D22 的注释就写了这点），一旦进 stdout，重定向场景基本被毁
- 终端上两条流都显示，交互式观看**没有任何损失**；只有 `2>/dev/null` 时才看不到——那是用户自己关掉的

**放弃：思考走 stdout 并用 `[思考] …` 包裹。** 那样文件里仍不只有回答；「能在文件里搜出来」这个好处，抵不上契约被破坏的代价。

**放弃：两条流都写（stdout 给用户、stderr 给诊断）。** 同一份内容打两遍，重定向时出现两份，是更差的选择。

### D-M4a-7. 只做 **CLI 启动开关**，不做 REPL 内的斜杠命令

`--show-reasoning` / `--no-thinking` 在启动时定死，进程内不变。

**为什么不做 `/reasoning on|off` 这类命令**：那会让开关变成**可变的会话状态**。而 M3 的 `model` 记录已经立了「可变会话状态要落盘」的先例，于是「要不要落盘」这个问题立刻就要回答——

- 落盘 → **本次就要动 JSONL 格式契约**，而那是 M4b 的活
- 不落盘 → 同一类状态一半落盘一半不落盘，先例就烂了

两个出口都不好。而 CLI 开关是「**本次启动的偏好**」，不是会话状态，天然不落盘，问题根本不出现。

**放弃：只做 REPL 命令。** 那样 `printf '问题' | pnpm start --no-thinking` 这种一次性管道用法就没了，而它正是**冒烟测试最方便的形态**（见 §12）。

**代价**：想中途切换只能重启进程（`--resume` 能接着聊，代价可接受）。

**关联**：`--max-context` 同理（见 D-M4a-9）。

### D-M4a-8. `--no-thinking` + `--show-reasoning` 同时给 → **报错**

关了 thinking，服务端就不会吐 `reasoning_content`，`--show-reasoning` 于是**什么都不会显示**。

**为什么报错而不是静默接受**：这与 `args.ts` 里「未知参数必须报错」是同一条立论（`--resum` 被静默忽略会让人以为续上了会话）——**静默地没做用户要的事，比报错更糟**。用户会以为「我开了显示思考，模型这次没思考」，而事实是它思考了、只是被自己关掉了。

**放弃：静默接受。** 好处是「无条件带上两个开关的脚本不失败」，但这个便利换来的是一类无法从输出中察觉的误解。

**放弃：自动让 `--no-thinking` 赢并警告一行。** 在参数解析阶段就警告，与「参数错误一律抛错 + 退出码 1」的既有形状不一致。

### D-M4a-9. `--max-context <n>` 用 **CLI 开关**，不用环境变量

**理由**：这个参数的主要用途是「**调小到几百 token，让裁剪在真实使用中能被观察到**」——是一次性实验参数，不是长期配置。环境变量的位置留给长期配置（对齐 `DEEPSEEK_BASE_URL` / `AI_CHAT_MODEL` / `AI_CHAT_HOME` 的定位）。

**默认值 64_000**（软预算）。取十进制的 64K 而不是 2^16，因为它约束的是 **token 数**不是字节数。

**放弃：环境变量 `AI_CHAT_MAX_CONTEXT`。** 适合长期配置，但对「跑一次看看裁剪长什么样」这个主要用途来说太笨重（要 export / 要改 .env.local）。

**放弃：两个都支持（环境变量给默认、开关覆盖）。** 两处配置来源就要回答优先级问题，为一个学习项目里几乎不触发的模块付这个代价不值得。

### D-M4a-10. `--no-thinking` 只在**关闭**时传字段

请求体只在 `thinking === false` 时带 `thinking: { type: 'disabled' }`；为 `true` 或未指定时**完全不带该字段**。

**理由**：沿用 M1 的「最小请求体」原则（原设计 §7：「本次不传 `stream`、`thinking`、`temperature`」）——**默认行为不需要显式声明**。API 侧 thinking 默认开启（见 `docs/deepseek-api-facts.md`），所以不传就是开启。

**好处**：`--no-thinking` 的请求体差异是一个精确的、可断言的契约（「多一个字段」而不是「字段值不同」），测试写起来没有歧义。

### D-M4a-11. `ChatOptions.thinking` 是 `boolean`，翻译在 `llm/` 层

```ts
// core/types.ts
export interface ChatOptions {
  model?: string;
  /** 本轮的 thinking 开关。false → 请求体带 { thinking: { type: 'disabled' } } */
  thinking?: boolean;
}
```

**为什么不在 `ChatOptions` 里直接用 `{ type: 'enabled' | 'disabled' }`**：`core/types.ts` 是**项目自己的**类型，不是 API 的形状。照抄 API 结构会把「DeepSeek 怎么拼请求体」泄露到 core 层，让 `ChatOptions` 成为 API 的镜像——那样换服务商时 core 也要改。

**与 `llm/client.ts` 的既有约定一致**：接口描述「一次调用要什么」，具体形状由实现翻译。

---

## 4. 架构与数据流

### 一轮对话（本次改动处标 ★）

```text
You: 什么是闭包
  │
  ├─ parseCommand → 不是命令
  ├─ session.append('user', '什么是闭包')          ← 内存与磁盘都记完整历史（不变）
  │
  ├─ messages = session.toMessages(SYSTEM_PROMPT)  → [system, ...完整历史]
  │
  ├─ ★ fitted = fitToBudget(messages, options.maxContext)
  │      ├─ 未超预算 → 原样返回，无警告
  │      └─ 超了     → 丢最老的整轮，stderr 一行警告
  │
  ├─ ★ client.chatStream(fitted.messages, { model: session.model, thinking })
  │
  ├─ for await (event)
  │      ├─ text-delta      → stdout（不变）
  │      └─ reasoning-delta → ★ showReasoning ? stderr 全文 : stderr 一行 [思考中…]
  │
  └─ session.append('assistant', text)             ← 完整正文落盘（不变）
```

**注意 `session.append('assistant', text)` 存的是完整回答**，与「发给模型的被裁过的历史」无关——这正是 D-M4a-5 要守住的边界。

### 启动

```text
pnpm start [--resume <id>] [--show-reasoning] [--no-thinking] [--max-context <n>]
  │
  ├─ resolveConfig(process.env)                  // 缺 key → stderr + exit 1（不变）
  ├─ ★ parseArgs(argv)                           // 含三个新开关与组合校验
  └─ runRepl(client, { ..., ★showReasoning, ★noThinking, ★maxContext })
```

**`resolveConfig` 仍排在 `parseArgs` 之前**（M3 的既有顺序）：缺 key 与参数写错同时发生时先报缺 key。

---

## 5. 目录结构

```text
01-llm/
  src/
    index.ts              # 【改】把三个开关传给 runRepl
    cli/
      args.ts             # 【改】三个新开关 + 组合校验 + DEFAULT_MAX_CONTEXT
      repl.ts             # 【改】裁剪接线、thinking 透传、渲染选项
      render.ts           # 【改】showReasoning 分支
      config.ts           # 不变
      store.ts            # 不变
    core/
      context.ts          # 【新】estimateTokens / fitToBudget
      types.ts            # 【改】ChatOptions 加 thinking?
      session.ts          # 不变（裁剪刻意不进这里，见 D-M4a-2）
      journal.ts          # 不变（本次不动 JSONL，见 D-M4a-7）
      commands.ts         # 不变
    llm/
      deepseek.ts         # 【改】按需翻译出 thinking 字段
      client.ts           # 不变
      sse.ts              # 不变
  test/
    context.test.ts       # 【新】
    args.test.ts          # 【扩】
    render.test.ts        # 【扩】
    deepseek.test.ts      # 【扩】
    repl.test.ts          # 【扩】
```

---

## 6. 类型与函数契约

### `core/context.ts`【新】

```ts
import type { Message } from '@/core/types.ts';

/**
 * 估算一段文本的 token 数（保守上界）。
 *
 * 除数取 1.5 而不是蓝图 §7 写的 4，理由见 spec D-M4a-1：
 * chars/4 对中文是低估，方向恰好不保守。
 */
export function estimateTokens(text: string): number;

/** fitToBudget 的结果 */
export interface FittedContext {
  /** 实际要发给模型的消息数组 */
  messages: Message[];
  /** 被丢掉的消息条数；未裁剪时为 0 */
  dropped: number;
  /** 被丢掉的消息的估算 token 数；未裁剪时为 0 */
  droppedTokens: number;
}

/**
 * 把 [system, ...历史] 裁到预算内。
 *
 * 两条不可违反的规则：**system 永不裁**、**最后一组永不裁**（那是当前问题）。
 * 裁剪单位是「轮」，按 user 消息切分（见 D-M4a-3）。
 *
 * @param messages 已组装好的完整数组，index 0 是 system，最后一条是当前 user 消息
 * @param budget 软预算（token）。<= 0 时定义为「只保留 system 与最后一条」，不是兜底
 */
export function fitToBudget(messages: Message[], budget: number): FittedContext;
```

### `core/types.ts` 改动

```ts
export interface ChatOptions {
  model?: string;
  /** 本轮的 thinking 开关；不传 = 交给服务端默认（开启）。见 D-M4a-10 / D-M4a-11 */
  thinking?: boolean;
}
```

### `cli/args.ts` 改动

```ts
export const DEFAULT_MAX_CONTEXT = 64_000;

export type Args = {
  showReasoning: boolean;
  noThinking: boolean;
  maxContext: number;
} & (
  | { kind: 'fresh' }
  | { kind: 'resume'; id: string }
);
```

用法文案随之更新：

```text
用法：pnpm start [--resume <会话 id>] [--show-reasoning] [--no-thinking] [--max-context <n>]
```

（`--resume` 那条「不要写 `pnpm start -- --resume`」的守卫注释与 README 的说明**一字不动**。）

### `cli/render.ts` 改动

```ts
export function createStreamRenderer(options: {
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  /** 展开思考全文（stderr）。false 时维持 D22 的一行指示 */
  showReasoning: boolean;
}): StreamRenderer;
```

### `cli/repl.ts` 改动

`ReplOptions` 增加三个字段：

```ts
export interface ReplOptions {
  // ...既有字段不变（input / output / errorOutput / prompt / model / sessionId / history / store）
  /** 展开思考全文，来自 --show-reasoning */
  showReasoning: boolean;
  /** 关闭 thinking，来自 --no-thinking */
  noThinking: boolean;
  /** 上下文软预算（token），来自 --max-context */
  maxContext: number;
}
```

### `llm/deepseek.ts` 改动

请求体在 `options.thinking === false` 时加一个字段，`chat()` 与 `chatStream()` **都要**（否则两个方法行为不一致）：

```ts
{ model, messages, ...(options?.thinking === false ? { thinking: { type: 'disabled' } } : {}) }
```

---

## 7. 三个开关的契约

### `--show-reasoning`

| showReasoning | 首个 reasoning-delta 时 | 后续 delta | 收尾 |
| --- | --- | --- | --- |
| `false`（默认） | stderr 一行 `[思考中…]`，此后不再输出 | 丢弃 | 无 |
| `true` | stderr 写 `[思考] ` 前缀 | 逐个写 `text` 到 stderr | 补**一个**换行 |

**模型没吐 reasoning 时两种模式都不写任何前缀**——沿用既有 `wrotePrefix` 的模式：前缀只在真有内容时才写。所以「服务端忽略了 thinking 参数」这种情况不会留下一个孤零零的 `[思考] `。

### `--no-thinking`

| 输入 | 请求体 |
| --- | --- |
| 不传（默认） | **不含** `thinking` 字段 |
| `--no-thinking` | `"thinking": { "type": "disabled" }` |

thinking 关闭后服务端不再返回 `reasoning_content`，所以 `reasoning-delta` 事件**根本不会出现**——渲染层不需要为这个组合写特例。组合本身在参数层就被拒了（D-M4a-8）。

### `--max-context <n>`

| 输入 | 结果 |
| --- | --- |
| 不传 | `DEFAULT_MAX_CONTEXT` = 64_000 |
| `--max-context 400` | 400 |
| `--max-context`（缺值） | 抛错：`--max-context 需要一个正整数` + 用法 |
| `--max-context abc` / `1.5` / `-1` / `0` / `''` | 抛错：同上 |
| `--max-context 999999999999999999999` | 抛错（超出安全整数范围） |

校验用 `/^\d+$/` 加 `Number.isSafeInteger(n) && n > 0`：正则先挡掉负数、小数、空串，再挡掉 0 与溢出。

### 参数组合

| 输入 | 结果 |
| --- | --- |
| `--no-thinking --show-reasoning` | 抛错：`--no-thinking 与 --show-reasoning 不能同时使用` + 用法 |
| 同一开关重复给（`--no-thinking --no-thinking`） | 接受，幂等 |
| 三个开关与 `--resume <id>` 任意顺序共存 | 接受 |
| `--max-context 400 --resume <id>` | 接受 |

**为什么布尔开关重复给要接受**：它们是开关不是参数，重复不改变语义；而 `--resume` 重复给目前会撞上「参数过多」的检查（它带值）。两者形状不同，行为不同是合理的。

---

## 8. `fitToBudget` 算法与边界

```text
输入：messages = [system, ...历史, 当前 user]，budget

1. total = Σ estimateTokens(m.content)
2. total <= budget                      → 原样返回 { dropped: 0, droppedTokens: 0 }
3. 分组（从 index 1 起）：
     每组 = 一条 user（或其后的 assistant）直到下一条 user 之前
     index 1 不是 user 时，开头残余单独成一组
4. 从最老的一组开始丢，每丢一组重新累减
5. 停在三处之一：
     total <= budget          → 停
     只剩最后一组              → 停（绝不能丢当前问题）
     已经无组可丢              → 停
```

| 边界情形 | 行为 |
| --- | --- |
| 未超预算 | 原样返回，`dropped: 0`，**不产生任何警告** |
| 历史为空（只有 system + 当前 user） | 永不裁，`dropped: 0` |
| 裁到只剩 system + 最后一组 | **停止** |
| 单条消息本身就超预算 | **不裁**，原样发给 API 让它报错。静默丢掉用户的问题比报错糟得多 |
| 开头有不以 user 起始的残余 | 单独成一组，最先被丢 |
| `messages` 长度为 0 或 1 | 原样返回，`dropped: 0`（没有可裁的东西） |
| `budget <= 0` | 定义为「只保留 system 与最后一条」——这是**语义定义**，不是兜底：让函数对任何输入都有定义，而不是靠调用方保证 |
| 历史里有两个相邻 user（失败轮次，D7） | 各成一组，可被分别丢弃 |
| 裁剪后仍超预算（比如最后一条自己就超） | 不报错、不循环——按上一条原样发出 |

**返回值只统计 `messages` 里的消息数**（`dropped` = 丢掉的消息**条数**，不是「组数」），因为警告文案说的是「N 条消息」。

---

## 9. 输出形状

### 裁剪警告（stderr，一行）

```text
[上下文] 已裁剪 4 条最早的消息（约 1180 token）
```

只在一轮**真的裁掉了东西**时出现（`dropped > 0`）。

### `--show-reasoning`（stderr）

```text
[思考] 用户问的是闭包的定义。我应该先给出一个简洁的定义，
然后……（思考全文）
```

`[思考] ` 之后**不换行**，思考正文紧接着写；收尾补一个换行。这样终端上与 `[思考中…]` 占同样的行数起点，且不会因为思考分成多行而在中间插空行。

### stdout（不变）

`You: 问题` / `AI: 回答`。**开了 `--show-reasoning` 也一样**——思考绝不进 stdout（D-M4a-6）。

---

## 10. 错误与边界

| 场景 | 行为 | 退出码 |
| --- | --- | --- |
| `--max-context` 缺值 / 非正整数 / 溢出 | stderr：错误 + 用法 | 1 |
| `--no-thinking` 与 `--show-reasoning` 同给 | stderr：错误 + 用法 | 1 |
| 未知参数（既有行为） | stderr：错误 + 用法 | 1 |
| 缺 `DEEPSEEK_API_KEY`（既有行为，且优先于参数错误） | stderr + 退出 | 1 |
| 裁剪发生 | stderr 一行警告，对话继续 | 0 |
| 裁剪后仍超预算 | 不报错，原样发出（大概率拿到 API 的 400） | 0 |
| `--show-reasoning` 但模型无思考内容 | 不写任何前缀 | 0 |
| 思考流中途出错 | 与正文同路径：走既有的 `renderer.finish()` 收尾 + `[error]` 到 stderr | 0 |

**退出码为 1 的三种情况都发生在发起任何网络请求之前**，所以针对它们的子进程测试不触网。

---

## 11. 注释要求（本次特别强调）

新增与改动处的注释要解释**为什么**，而不是复述代码。必须写清楚的点：

- `core/context.ts` —— 为什么除数是 1.5 而不是 4（D-M4a-1，含「英文会被高估 2.7 倍是有意的」）；为什么按 user 切轮而不是按 role 交替（D-M4a-3，含失败轮次那个反例）；为什么 system 与最后一组永不裁；`budget <= 0` 为什么是语义定义而不是兜底
- `cli/repl.ts` —— 为什么裁剪结果**不回写 Session**（D-M4a-5，「发给模型的」≠「会话记得的」）；为什么警告只报一次这类文案要与写盘失败的注释互相对照
- `cli/args.ts` —— 为什么两个开关互斥要报错（D-M4a-8，与「未知参数报错」同一条立论）；为什么 `--max-context` 是开关而不是环境变量
- `cli/render.ts` —— 为什么思考走 stderr 而不是 stdout（D-M4a-6，保住重定向契约）
- `llm/deepseek.ts` —— 为什么只在关闭时传字段（D-M4a-10，最小请求体）
- `core/types.ts` —— 为什么 `thinking` 是 boolean 而不是照抄 API 的对象形状（D-M4a-11）

既有代码里那些「别顺手改成 X」的守卫注释（`toMessages()` 的浅拷贝、`/model` 的查询分支、`args.ts` 的 `pnpm start --` 说明）**一条都不要动**。

---

## 12. 验证策略

### 新增 `test/context.test.ts`

| 对象 | 用例 |
| --- | --- |
| `estimateTokens` | 空串 → 0；纯中文；纯英文；取整方向（上取整）；含 emoji 的代理对 |
| `fitToBudget` | 未超不裁（逐条相等且 `dropped: 0`）；按整轮裁、不拆半条；system 永不裁；最后一组永不裁；只剩最后一组时停止；单条超预算不裁；开头残余单独成组；两个相邻 user 各成一组；`budget <= 0` 只留首尾；空数组与单元素数组；`dropped` 与 `droppedTokens` 的计数正确 |

### 扩既有测试

| 文件 | 新增用例 |
| --- | --- |
| `args.test.ts` | 三个开关各自的合法/非法；`--max-context` 的缺值 / `abc` / `1.5` / `-1` / `0` / `''` / 溢出各自抛错；两个开关冲突抛错且消息含用法；重复给幂等；与 `--resume` 任意顺序共存；默认值 64_000 |
| `render.test.ts` | `showReasoning: false` 仍是 `[思考中…]` 一行；`true` 时全文走 stderr 且 **stdout 无任何思考文字**；无 reasoning 时两种模式都不写前缀；收尾换行只补一个 |
| `deepseek.test.ts` | `thinking: false` → 请求体含 `{thinking:{type:'disabled'}}`；不传 → 请求体**不含** `thinking` 键；`thinking: true` → 也不含；`chat()` 与 `chatStream()` 都覆盖 |
| `repl.test.ts` | 塞小 `maxContext`，**断言实际发给 client 的 messages 数组被裁剪**（沿用 M1 验证上下文形状的既有手法）；同时断言 `store` 收到的仍是**完整**的 user/assistant 记录；裁剪时 stderr 出现一行警告；未裁剪时**没有**警告；`noThinking` 透传进 `ChatOptions` |

**为什么「断言实际发出的形状」是这里的核心手法**：裁剪的全部意义就是「发出去的东西变了，而记住的东西没变」。只断言 `fitToBudget` 的返回值，测不到 repl 有没有把它接错线。

### 手动冒烟（真实网络，不进 CI）

```bash
# 1) --show-reasoning：思考在 stderr，stdout 干净
printf '用一句话说明什么是闭包\n' | pnpm --silent start --show-reasoning 1>out.txt 2>err.txt
#    err.txt 应含 [思考] 与思考全文；out.txt 应只有 You:/AI: 与回答，不含思考文字

# 2) --no-thinking：请求成功、无 reasoning
printf '用一句话说明什么是闭包\n' | pnpm --silent start --no-thinking 1>out2.txt 2>err2.txt
#    err2.txt 应是空的（没有 [思考中…]）；out2.txt 有正常回答

# 3) 裁剪被真实触发（这是 --max-context 存在的意义）
printf '问题一\n问题二\n问题三\n问题四\n' | pnpm --silent start --max-context 200 2>err3.txt
#    err3.txt 应出现 [上下文] 已裁剪 N 条最早的消息
#    且最后一个问题的回答仍然切题

# 4) 裁剪不影响落盘
cat .sessions/<id>.jsonl     # 8 条 message 记录一条不少

# 5) 冲突与非法参数
pnpm start --no-thinking --show-reasoning ; echo "exit=$?"   # 期望 exit=1 + 用法
pnpm start --max-context abc ; echo "exit=$?"                # 期望 exit=1 + 用法
```

**密钥不得进会话**：真实 key 只从 `.env.local` 读，任何贴出来的输出前先做泄漏扫描。

---

## 13. 文档同步

跟代码同一次改动一起更新：

| 文档 | 改什么 |
| --- | --- |
| `README.md` | 「常用命令」加三个开关与 `--max-context` 的可调性；「当前能力边界」把 `--show-reasoning` / `--no-thinking` 从「尚未实现」移出，新增「上下文预算裁剪（可调阈值）」；「项目结构」补 `core/context.ts` 与 `test/context.test.ts` |
| `ARCHITECTURE.md` | 模块图补 `context.ts`；「一轮请求」数据流补「组装 → **裁剪** → 请求」这一步，并点明裁剪结果不回写 |
| `DECISIONS.md` | 追加 D-M4a-1 ~ D-M4a-11（编号延续；不重排既有编号） |
| `EVALUATION.md` | 第 4 项那句「**未做（属 M4）**：`--show-reasoning` 展开思考全文、`--no-thinking`」要改成本次已做；六条验收项本身**不变**（本次不动那六条中的任何一条） |
| `docs/troubleshooting.md` | 实施过程中若踩到新坑，随手追加一条 |

---

## 14. 验收

```text
TypeCheck: pnpm run typecheck → 退出码 0
Lint:      N/A（本仓库未配置 linter）
Test:      pnpm test → 全绿（新增 test/context.test.ts）
Build:     N/A（noEmit，Node 直接运行 .ts）
```

外加 §12 的 5 项手动冒烟全部通过。

---

## 15. 实施顺序（供 writing-plans 参考）

按依赖关系，每一步都能独立跑 `typecheck`：

```text
1. core/context.ts + test/context.test.ts        —— 纯逻辑，不依赖任何现有文件
2. core/types.ts 的 ChatOptions.thinking
   + llm/deepseek.ts 的翻译 + test/deepseek.test.ts
3. cli/args.ts 三个开关 + test/args.test.ts      —— 纯函数，独立
4. cli/render.ts 的 showReasoning + test/render.test.ts
5. cli/repl.ts + index.ts 接线 + test/repl.test.ts
6. README / ARCHITECTURE / DECISIONS / EVALUATION
7. 手动冒烟 §12 的 5 项
```
