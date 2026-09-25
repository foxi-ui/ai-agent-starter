import type { ChatItem } from '../chatReducer.ts';
import { MessageBubble } from './MessageBubble.tsx';
import { ToolTrace } from './ToolTrace.tsx';

export function MessageList({
  items,
  sending,
  onDismissItem,
}: {
  items: ChatItem[];
  sending: boolean;
  onDismissItem: (id: string) => void;
}) {
  return (
    <div className="list">
      {items.length === 0 && !sending && (
        <p className="list__empty">
          问点什么吧。
          <br />
          试试「北京今天天气怎么样？」—— 会看到模型调用 weather 工具的完整轨迹。
        </p>
      )}

      {items.map((item) =>
        item.kind === 'tool' ? (
          <ToolTrace key={item.id} item={item} />
        ) : (
          <MessageBubble
            key={item.id}
            item={item}
            onDismiss={item.kind === 'error' ? () => onDismissItem(item.id) : undefined}
          />
        ),
      )}

      {sending && <div className="bubble bubble--assistant">…</div>}
    </div>
  );
}
