// 会话状态：按顺序累积对话消息。
//
// 只负责「记住说过什么」，不碰网络、不负责打印、也不落盘。
//
// 相对 01-llm 的版本，这里**不复制三样**（见 spec D6）：
//   - `onChange` 变更广播：它的唯一用途是落盘，而本项目不做持久化（D3）
//   - `clear()`：唯一调用方是 `/clear` 命令，而本项目不做 CLI（D2）
//   - `set model` / 构造时的 history 参数：没有 `/model` 命令，也没有恢复会话的入口
//
// 于是它退回成一个**无副作用的纯类** —— 这正是它最好测试的形态。

import type { Message } from '@/core/types.ts';

export class Session {
  /**
   * 本会话使用的模型。
   *
   * 它是**会话的属性**而不是 client 的身份：client 保持无状态，
   * 每次请求把它作为 per-call 参数带下去（见 core/agent.ts）。
   */
  readonly model: string;

  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[];

  constructor(model: string) {
    // 刻意不用 `constructor(readonly model: string)` 这种参数属性写法：
    // 本项目靠 Node 的原生类型擦除直接跑 .ts，而擦除模式（strip-only）
    // 不支持 TS 独有的参数属性语法，会在运行时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    // 注意 tsc --noEmit 不会拦下它 —— 类型检查能过、运行才炸，所以只能靠这条注释守着。
    this.model = model;
    this.messages = [];
  }

  /**
   * 追加一条**用户或系统**消息。
   *
   * 参数只接受这两个角色是刻意的：assistant 消息可能带 `tool_calls`、
   * tool 消息必须带 `tool_call_id`，都不是 `(role, content)` 这种扁平签名
   * 写得出来的。收窄之后，「assistant 消息丢掉 tool_calls」这类 bug
   * **无法通过类型检查** —— 要写 assistant 只能走 appendMessage。
   */
  append(role: 'system' | 'user', content: string): void {
    this.messages.push({ role, content });
  }

  /** 追加一条任意形状的消息（含 assistant{tool_calls} 与 tool） */
  appendMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * 批量追加。**只在整轮成功后调用一次**（见 core/agent.ts 的 runSessionTurn）——
   * 中途失败时一条都不该落进上下文，否则历史里会出现伪造的回答。
   */
  appendAll(messages: Message[]): void {
    for (const message of messages) this.messages.push(message);
  }

  /**
   * 组装出「这一次要发给 API 的完整消息数组」。
   *
   * 返回 `[system, ...历史消息]`：system 提示永远排在最前。
   * 因为它是每次请求都要重新带上、且位置固定的稳定前缀，
   * 它不属于对话历史，所以不存在 `messages` 里，而是每次现加。
   *
   * @param systemPrompt 系统提示；传空串则不插入 system 消息
   */
  toMessages(systemPrompt: string): Message[] {
    const messages: Message[] = [];
    if (systemPrompt !== '') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    // 用 concat 生成新数组返回，保证「返回的不是内部那个数组」，
    // 免得调用方 push/splice 改到会话状态。
    //
    // 注意它**不保证元素隔离** —— concat 与 slice 一样只复制外层数组。
    // 这是刻意的：这个方法每轮请求都跑，结果直送 JSON.stringify，
    // 全链路上没有任何改动方，深拷贝只会为每轮多分配 N 个小对象。
    // 与 history() 的处置不同是**刻意分开**的，不是漏改 ——
    // 那边对外承诺「外部改不动内部状态」，且在冷路径上。
    return messages.concat(this.messages);
  }

  /**
   * 返回消息列表的**副本**，外部改不动内部状态。
   *
   * 必须是**深**拷贝：`tool_calls` 是数组、数组里还有 `function` 对象，
   * 只做 `{...m}` 的话，调用方一句
   * `h[0].tool_calls[0].function.name = 'x'` 就穿透改了会话状态。
   * （01-llm 的源码注释已经预言了这一刻：「将来若给 Message 加了嵌套字段，
   * 这一行必须同步升级」。）
   */
  history(): Message[] {
    return this.messages.map(cloneMessage);
  }
}

/**
 * 复制一条消息，含嵌套的 `tool_calls`。
 *
 * 单独抽出来而不是内联在 history() 里，是让「Message 有嵌套字段」这件事
 * 在类型层面看得见：将来再加嵌套字段，改这一处。
 */
function cloneMessage(message: Message): Message {
  if (message.role === 'assistant') {
    const copy: Message = { role: 'assistant', content: message.content };
    if (message.tool_calls) {
      copy.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: call.type,
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    }
    return copy;
  }
  return { ...message };
}
