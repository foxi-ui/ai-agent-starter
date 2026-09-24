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
}
