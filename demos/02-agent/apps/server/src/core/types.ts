// 全项目共用的基础类型定义。
//
// 这里刻意只有类型、没有逻辑：消息结构是本项目与 LLM API 之间的
// 唯一契约，把它单独放在一处，其他地方都从这里引入。
// 将来要扩展消息形状（比如加 name、tool_calls），只需改这一个文件。

/**
 * 消息的四种角色。这是 OpenAI-compatible 接口的通用约定：
 *
 * - `system`    —— 给模型的固定指令（「你是谁、该怎么回答」）
 * - `user`      —— 用户说的话
 * - `assistant` —— 模型的回答（可能不含正文、只开一张工具调用单）
 * - `tool`      —— **程序**执行工具后填回的结果，不是模型说的
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 一条对话消息，也是发给 API 的最小单位。
 *
 * 它是**可辨识联合**而不是扁平结构：三种角色的字段并不相同 ——
 * assistant 可能只开调用单没有说话（`content` 为 `null`），
 * tool 必须说明自己在回应哪一张调用单（`tool_call_id`）。
 * 写成扁平 interface 用可选字段糊过去，会让「assistant 忘了带 tool_calls」
 * 这类 bug 一路溜到运行时才发现。
 *
 * 关键理解：模型本身不「记得」任何东西。所谓多轮对话，
 * 靠的是每次把完整的消息数组重新发过去。
 */
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * `LLMClient.chat()` 的返回值。
 *
 * `content` 在工具调用轮次里可以是 `null` —— 模型那一轮没说话，只开了调用单。
 * 所以调用方**不能**假设它一定有正文；兜底成 `''` 会让「模型说了空话」
 * 与「模型没说话」变得无法区分。
 */
export interface ChatResult {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
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
 * 模型开出的一张「调用单」。
 *
 * 关键理解：模型**从不执行**任何函数。它只是输出了这个结构 ——
 * 函数名与参数都是文字，真正去执行的是我们的程序（见 tools/ 与 core/agent.ts）。
 *
 * `arguments` 是 **JSON 字符串**而不是对象：模型逐字生成文本，中途可能截断，
 * 所以它天然可能是非法 JSON，解析必须容错（见 core/agent.ts）。
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 工具的**声明** —— 发给模型看的那份说明，不是实现。
 *
 * 这里是**扁平形状**（name/description/parameters 平铺）。
 * 线上的 `tools` 数组元素要再包一层 `{type:'function', function:{…}}`，
 * 那层包装收敛在 llm/deepseek.ts 的 toWireTools() 里 ——
 * 内部的调用方只关心「叫什么、要什么参数」。
 */
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<
      string,
      { type: 'string' | 'number' | 'boolean' | 'integer'; description?: string }
    >;
    required?: string[];
  };
}

/**
 * 工具执行的结果。
 *
 * 失败**不是异常**，是一种正常结果：错误文本会被当作 `tool` 消息的 content
 * 回喂给模型，让它看到「工具报错了」后自行纠正（见 core/agent.ts）。
 */
export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

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
   * 本次请求携带的工具声明。
   *
   * 空数组与不传**语义不同**：不传 = 这次不带工具；空数组在部分
   * OpenAI 兼容实现上会 400，所以 llm 层对空数组按「不带」处理。
   */
  tools?: Tool[];
}
