import { Composer } from './components/Composer.tsx';
import { MessageList } from './components/MessageList.tsx';
import { useChat } from './useChat.ts';

export default function App() {
  const { state, send, dismissNotice, dismissItem } = useChat();

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">ai-chat-agent</h1>
        <span className="app__meta">阶段二 · 工具调用</span>
      </header>

      {state.notice !== null && (
        <div className="notice">
          <span>{state.notice}</span>
          <button type="button" onClick={dismissNotice} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}

      <MessageList
        items={state.items}
        sending={state.status === 'sending'}
        onDismissItem={dismissItem}
      />
      <Composer disabled={state.status === 'sending'} onSend={(text) => void send(text)} />
    </main>
  );
}
