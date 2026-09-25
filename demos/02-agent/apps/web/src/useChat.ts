// 把「reducer + 网络请求 + localStorage」粘在一起。
//
// 会话恢复的两个关键决定（spec §12）：
//   1. **首次发送时才建会话**，不是 mount 就建 —— 否则每刷新一次页面，
//      服务端就多一个没人用的会话（服务端虽然会 FIFO 淘汰，但那是兜底不是设计）
//   2. 历史读回 404（服务端重启或会话被淘汰）**不报错**，静默清掉本地 id
//      并给一条可关闭的提示；下一次发送会自动新建

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ApiError, createSession, fetchHistory, sendMessage } from './api.ts';
import { chatReducer, initialChatState } from './chatReducer.ts';

const STORAGE_KEY = 'ai-chat-agent.sessionId';

function readStoredSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式或被禁 cookie 时 localStorage 会抛 —— 那就当没有历史，不影响使用
    return null;
  }
}

function writeStoredSessionId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 存不上只是「下次刷新恢复不了」，不该让发送失败
  }
}

export function useChat() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  // 用 ref 而不是直接读 state.sessionId：send 每次渲染都会重建，
  // 但闭包里的 state 是**那一次渲染的**，长回答回来后可能已经过期
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const stored = readStoredSessionId();
    if (stored === null) return;

    let cancelled = false;
    void (async () => {
      try {
        const history = await fetchHistory(stored);
        if (cancelled) return;
        sessionIdRef.current = stored;
        dispatch({ type: 'history/loaded', items: history.items });
      } catch (error) {
        if (cancelled) return;
        // 只有「会话不存在」才静默降级；其它错误该让用户看见
        if (error instanceof ApiError && error.status === 404) {
          writeStoredSessionId(null);
          sessionIdRef.current = null;
          dispatch({
            type: 'session/lost',
            notice: '上一次的会话已失效（服务端可能重启过），下一条消息会开启新会话。',
          });
          return;
        }
        dispatch({
          type: 'turn/error',
          text: `读取历史失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === '' || state.status === 'sending') return;

      dispatch({ type: 'user/send', text: trimmed });

      try {
        let sessionId = sessionIdRef.current;
        if (sessionId === null) {
          const created = await createSession();
          sessionId = created.sessionId;
          sessionIdRef.current = sessionId;
          writeStoredSessionId(sessionId);
        }

        const result = await sendMessage(sessionId, trimmed);
        dispatch({ type: 'turn/success', items: result.items });
      } catch (error) {
        // 会话在发送途中没了：清掉，下一次发送会自己新建
        if (error instanceof ApiError && error.status === 404) {
          sessionIdRef.current = null;
          writeStoredSessionId(null);
        }
        dispatch({
          type: 'turn/error',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [state.status],
  );

  const dismissNotice = useCallback(() => dispatch({ type: 'notice/dismiss' }), []);
  // 关掉列表里的一条错误气泡（spec §13）
  const dismissItem = useCallback((id: string) => dispatch({ type: 'item/dismiss', id }), []);

  return { state, send, dismissNotice, dismissItem };
}
