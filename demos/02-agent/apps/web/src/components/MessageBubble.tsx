import type { ChatItem } from '../chatReducer.ts';

type BubbleItem = Extract<ChatItem, { kind: 'user' | 'assistant' | 'error' }>;

/**
 * `onDismiss` 只对错误气泡传 —— spec §13 要求错误提示是**可关闭的**。
 * user / assistant 是对话记录，不该能删。
 */
export function MessageBubble({ item, onDismiss }: { item: BubbleItem; onDismiss?: () => void }) {
  return (
    <div className={`bubble bubble--${item.kind}`}>
      <span>{item.text}</span>
      {onDismiss !== undefined && (
        <button type="button" className="bubble__close" onClick={onDismiss} aria-label="关闭这条错误">
          ×
        </button>
      )}
    </div>
  );
}
