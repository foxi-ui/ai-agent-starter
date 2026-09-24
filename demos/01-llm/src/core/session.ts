// 会话状态：按顺序累积对话消息。
//
// 只负责「记住说过什么」，不碰网络、也不负责打印。
// 正因为没有副作用，这一层才能在无网络下被单独测试。

import type { Message, Role } from '@/core/types.ts';

/**
 * 一段对话的消息记录。
 *
 * 注意：上下文只存在于进程内存中，程序退出即清空。
 * 持久化到磁盘属于后续增量。
 */
export class Session {
  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[] = [];

  /**
   * 本会话当前使用的模型。
   *
   * 它属于「会话状态」而不是「client 配置」——`/model` 能中途切换它，
   * 每次请求再把它作为 per-call 参数传给 client。
   */
  private currentModel: string;

  /**
   * @param model 初始模型，通常来自 `resolveConfig` 的 `config.model`
   */
  constructor(model: string) {
    // 刻意不用 `constructor(private currentModel: string)` 这种参数属性写法：
    // 本项目靠 Node 的原生类型擦除直接跑 .ts，而擦除模式（strip-only）
    // 不支持 TS 独有的参数属性语法，会在运行时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    // 注意 tsc --noEmit 不会拦下它 —— 类型检查能过、运行才炸，所以只能靠这条注释守着。
    this.currentModel = model;
  }

  /**
   * 追加一条消息到会话末尾。
   *
   * @param role 谁说的：user 是用户，assistant 是 AI
   * @param content 消息正文
   */
  append(role: Role, content: string): void {
    this.messages.push({ role, content });
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
    // 用 concat 生成新数组返回，避免把内部数组的引用暴露出去，
    // 防止调用方在无意中改到这个 Session 的内部状态
    return messages.concat(this.messages);
  }

  /** 当前模型 */
  get model(): string {
    return this.currentModel;
  }

  /** 切换当前模型；只影响后续请求，不改动已有消息 */
  set model(name: string) {
    this.currentModel = name;
  }

  /**
   * 清空所有消息，返回清掉的条数。
   *
   * 不影响当前模型 —— `/clear` 清的是对话内容，不是会话配置。
   * 返回条数是为了让调用方能给出「已清空 N 条消息」这种有信息量的反馈。
   */
  clear(): number {
    const removed = this.messages.length;
    this.messages = [];
    return removed;
  }

  /**
   * 返回消息列表的**副本**。
   *
   * 返回副本而不是内部数组的引用：`/history` 的渲染只需要读，
   * 让它拿到引用就等于开了一个「顺手改到会话状态」的口子。
   */
  history(): Message[] {
    return this.messages.slice();
  }
}
