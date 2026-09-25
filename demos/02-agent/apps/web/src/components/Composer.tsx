import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  const submit = (): void => {
    if (disabled || text.trim() === '') return;
    onSend(text);
    setText('');
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    submit();
  };

  // Enter 发送、Shift+Enter 换行。textarea 默认行为是换行，
  // 所以要显式拦住不带修饰键的那一次
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        className="composer__input"
        rows={1}
        value={text}
        placeholder={disabled ? '等待回答…' : '输入消息，Enter 发送'}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="composer__send" type="submit" disabled={disabled || text.trim() === ''}>
        发送
      </button>
    </form>
  );
}
