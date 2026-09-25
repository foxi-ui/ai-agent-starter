// 把消息数组折叠成**给界面看的展示项**。
//
// 为什么要有这一层，而不是让 core 直接产出展示项：
// `Message` 是发给 API 的线格式，它按「模型需要什么」组织
// （assistant{tool_calls} 与 tool 是两条独立消息）；而界面要的是
// 「一次工具调用连它的结果」这样的一整块。两者的形状天然不同。
// 把投影放在 core 之外，agent 层就不必为了界面多返回任何字段（spec D4）。
//
// 实时路径（本轮新增）与历史路径（读回整段会话）共用这一个函数（spec D18）——
// 前端因此只需要一套渲染逻辑。
//
// 它**不 import http/**：这一层不知道 HTTP 存在，只认 Message。

import type { Message } from '@/core/types.ts';

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** 模型给的原始 JSON 字符串 */
      argumentsText: string;
      /** true=成功，false=失败，**null=没等到结果**（半截历史） */
      ok: boolean | null;
      result: string;
    };

/**
 * 判断一条 tool 消息是成功还是失败。
 *
 * 依据是一个**不变量**：成功路径的结果一定经过 `JSON.stringify`
 * （见 core/agent.ts 的 toToolContent），所以一定是合法 JSON；
 * 失败路径回的是人写的错误文本，解析必然失败。
 *
 * 之所以要这样反推而不是在消息里存一个标记位 —— `Message` 是发给 API 的
 * 线格式，多一个字段就是给上游发未知字段。宁可在这里多一层判断。
 *
 * **代价**：界面因此分不出「参数 JSON 非法」与「工具执行失败」。
 * 这是有意接受的 —— 两者的错误文本本身就写着原因
 * （`参数不是合法 JSON：{city: Beijing` vs `无法计算「1/0」：除数不能为 0`）。
 */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function foldTranscript(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  /** 已产出但还没等到结果的工具项，按 tool_call_id 索引到 items 里的下标 */
  const pending = new Map<string, number>();

  for (const message of messages) {
    // system 不在 Session 里（每次请求现加），这里只是防御性地跳过
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      items.push({ kind: 'user', text: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content !== null && message.content !== '') {
        items.push({ kind: 'assistant', text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        items.push({
          kind: 'tool',
          name: call.function.name,
          argumentsText: call.function.arguments,
          // 先占位成「没等到结果」，等后面的 tool 消息来把它改掉
          ok: null,
          result: '',
        });
        pending.set(call.id, items.length - 1);
      }
      continue;
    }

    // tool 消息：把结果填回它对应的那一项
    const index = pending.get(message.tool_call_id);
    if (index === undefined) continue; // 找不到调用单的孤儿 tool 消息，忽略
    const existing = items[index];
    if (!existing || existing.kind !== 'tool') continue;
    items[index] = { ...existing, ok: isJson(message.content), result: message.content };
    pending.delete(message.tool_call_id);
  }

  return items;
}
