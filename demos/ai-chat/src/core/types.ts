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
