import { useState, useCallback, useRef } from 'react';
import type { Message, ReasoningStepData, OrchestratorEvent } from './types';
import { sendMessage } from './api/chat';
import ChatWindow from './components/ChatWindow';
import MessageInput from './components/MessageInput';
import SessionControls from './components/SessionControls';
import './App.css';

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingReasoning, setPendingReasoning] = useState<ReasoningStepData[]>([]);
  const sessionIdRef = useRef(crypto.randomUUID());

  const handleSend = useCallback(async (text: string) => {
    const userMessage: Message = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMessage]);
    setIsStreaming(true);
    setPendingReasoning([]);

    const reasoning: ReasoningStepData[] = [];
    let resultContent = '';

    const onEvent = (event: OrchestratorEvent) => {
      if (event.type === 'thinking' || event.type === 'action') {
        reasoning.push({ type: event.type, content: event.content });
        setPendingReasoning([...reasoning]);
      } else if (event.type === 'result') {
        resultContent = event.content;
      } else if (event.type === 'error') {
        resultContent = `Error: ${event.content}`;
      }
    };

    try {
      await sendMessage(text, sessionIdRef.current, onEvent);
    } catch (err) {
      resultContent = `Error: ${err instanceof Error ? err.message : 'Something went wrong'}`;
    }

    const assistantMessage: Message = {
      role: 'assistant',
      content: resultContent,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
    };

    setMessages((prev) => [...prev, assistantMessage]);
    setPendingReasoning([]);
    setIsStreaming(false);
  }, []);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setPendingReasoning([]);
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1>Context Aware Assistant</h1>
        <SessionControls onNewChat={handleNewChat} disabled={isStreaming} />
      </header>
      <main className="app__main">
        <ChatWindow
          messages={messages}
          pendingReasoning={pendingReasoning}
          isStreaming={isStreaming}
        />
        <MessageInput onSend={handleSend} disabled={isStreaming} />
      </main>
    </div>
  );
}

export default App;
