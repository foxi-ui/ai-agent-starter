// 全项目共用的基础类型定义。
//
// 这里刻意只有类型、没有逻辑：消息结构是本项目与 LLM API 之间的
// 唯一契约，把它单独放在一处，其他地方都从这里引入。
// 将来要扩展消息形状（比如加 name、tool_calls），只需改这一个文件。

/**
 * 消息的三种角色。这是 OpenAI-compatible 接口的通用约定：
 *
 * - `system`    —— 给模型的固定指令（「你是谁、该怎么回答」）
 * - `user`      —— 用户说的话
 * - `assistant` —— 模型的回答
 */
export type Role = 'system' | 'user' | 'assistant';

/**
 * 一条对话消息，也是发给 API 的最小单位。
 *
 * 关键理解：模型本身不「记得」任何东西。所谓多轮对话，
 * 靠的是每次把完整的消息数组重新发过去。
 * 所以「上下文管理」= 维护好这个数组。
 */
export interface Message {
  /** 谁说的 */
  role: Role;
  /** 说了什么。这里是纯文本，不含任何格式标记 */
  content: string;
}

/**
 * `LLMClient.chat()` 的返回值。
 *
 * 目前只包一个 `content` 字段，而不是直接返回 `string`，
 * 是为了给后续增量（token 用量统计、结束原因等）留出扩展位，
 * 将来加字段不必改动所有调用方。
 */
export interface ChatResult {
  content: string;
}

/**
 * 模型停止生成的原因，取自服务端的 `finish_reason`。
 *
 * 联合类型是**宽松**的：服务端新增取值时，解析侧不做白名单校验，
 * 原样传出即可——未知取值不该让客户端崩掉。
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'aborted';

/**
 * 流式响应归一化后的事件。
 *
 * llm 层把「DeepSeek/OpenAI 的 SSE chunk」翻译成这三种事件，
 * cli 层只认这三种，不知道 SSE 的存在。
 *
 * 注意：**没有 `usage` 事件**。Token 统计属于 M4b，现在解析了也没有消费者，
 * 与其定义一个没人用的 `TokenUsage` 并连带写测试，不如等 M4b 一起做。
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'done'; reason: FinishReason };

/**
 * 一次请求的可选参数。
 *
 * 这些是「这一轮请求」的属性，不是 client 的身份——所以随请求传，
 * 而不是塞进 `LLMClientConfig` 让 client 变成有状态的。
 * 「当前模型」存在 `Session` 里（见 `core/session.ts`）。
 */
export interface ChatOptions {
  /** 本次请求使用的模型；不传则由 client 用它构造时的默认值 */
  model?: string;
  /**
   * 本轮的 thinking 开关。
   *
   * `false` → 请求体带 `thinking: { type: 'disabled' }`；
   * 为 `true` 或**不传** → 请求体完全不带这个字段（服务端默认开启，见
   * `docs/deepseek-api-facts.md`）。「默认行为不显式声明」沿用最小请求体的原则。
   *
   * 这里刻意用 `boolean` 而不是照抄 API 的 `{ type: 'enabled' | 'disabled' }`：
   * 本文件是**项目自己的**类型，不是 API 形状的镜像 —— 拼请求体是 `llm/` 层的职责。
   * 照抄的话，换服务商时这一层也要跟着改。
   */
  thinking?: boolean;
}
