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
