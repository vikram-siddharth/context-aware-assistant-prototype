import { useState, useCallback, useRef } from 'react';
import type { Message, ReasoningStepData, OrchestratorEvent } from './types';
import { sendMessage } from './api/chat';
import ChatWindow from './components/ChatWindow';
import MessageInput from './components/MessageInput';
import SessionControls from './components/SessionControls';
import MemoryModal from './components/MemoryModal';
import WorkoutModal from './components/WorkoutModal';
import LoginScreen from './components/LoginScreen';
import './App.css';

function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingReasoning, setPendingReasoning] = useState<ReasoningStepData[]>([]);
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [workoutModalOpen, setWorkoutModalOpen] = useState(false);
  const sessionIdRef = useRef(crypto.randomUUID());

  const handleLogin = useCallback((id: string) => {
    setUserId(id);
    sessionIdRef.current = crypto.randomUUID();
  }, []);

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
      await sendMessage(text, sessionIdRef.current, userId!, onEvent);
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
  }, [userId]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setPendingReasoning([]);
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  const handleSwitchUser = useCallback(() => {
    setMessages([]);
    setPendingReasoning([]);
    sessionIdRef.current = crypto.randomUUID();
    setUserId(null);
  }, []);

  if (!userId) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>Your Personal Workout Planning Assistant</h1>
        <SessionControls
          onNewChat={handleNewChat}
          onOpenMemories={() => setMemoryModalOpen(true)}
          onOpenWorkouts={() => setWorkoutModalOpen(true)}
          onSwitchUser={handleSwitchUser}
          disabled={isStreaming}
        />
      </header>
      <main className="app__main">
        <ChatWindow
          messages={messages}
          pendingReasoning={pendingReasoning}
          isStreaming={isStreaming}
        />
        <MessageInput onSend={handleSend} disabled={isStreaming} />
      </main>
      <MemoryModal open={memoryModalOpen} onClose={() => setMemoryModalOpen(false)} userId={userId} />
      <WorkoutModal open={workoutModalOpen} onClose={() => setWorkoutModalOpen(false)} userId={userId} />
    </div>
  );
}

export default App;
