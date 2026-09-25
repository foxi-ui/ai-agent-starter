import type { ChatItem } from '../chatReducer.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/**
 * 一次工具调用的轨迹。**这是本项目最想让人看到的东西** ——
 * 模型开了什么调用单、程序传了什么参、工具回了什么。
 *
 * `ok` 为 null 表示「没等到结果」（半截历史），用中性标记而不是红叉 ——
 * 它既不是成功也不是失败。
 */
export function ToolTrace({ item }: { item: ToolItem }) {
  const badge = item.ok === null ? '无结果' : item.ok ? '成功' : '失败';
  return (
    <div className="tool">
      <div className="tool__head">
        <span>⚙ {item.name}</span>
        <span className="tool__badge">{badge}</span>
      </div>
      <div className="tool__body">{item.argumentsText}</div>
      {item.result !== '' && <div className="tool__body">→ {item.result}</div>}
    </div>
  );
}
