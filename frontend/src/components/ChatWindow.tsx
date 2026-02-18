import { useEffect, useRef } from 'react';
import type { Message } from '../types';
import ReasoningStep from './ReasoningStep';

type Props = {
  messages: Message[];
  pendingReasoning: { type: 'thinking' | 'action'; content: string }[];
  isStreaming: boolean;
};

export default function ChatWindow({ messages, pendingReasoning, isStreaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingReasoning]);

  return (
    <div className="chat-window">
      {messages.length === 0 && !isStreaming && (
        <div className="chat-window__empty">
          Send a message to start a conversation.
        </div>
      )}

      {messages.map((msg, i) => (
        <div key={i} className={`chat-message chat-message--${msg.role}`}>
          <div className="chat-message__label">
            {msg.role === 'user' ? 'You' : 'Assistant'}
          </div>

          {msg.role === 'assistant' && msg.reasoning && msg.reasoning.length > 0 && (
            <div className="chat-message__reasoning">
              {msg.reasoning.map((step, j) => (
                <ReasoningStep key={j} step={step} />
              ))}
            </div>
          )}

          <div className="chat-message__content">{msg.content}</div>
        </div>
      ))}

      {isStreaming && pendingReasoning.length > 0 && (
        <div className="chat-message chat-message--assistant">
          <div className="chat-message__label">Assistant</div>
          <div className="chat-message__reasoning">
            {pendingReasoning.map((step, j) => (
              <ReasoningStep key={j} step={step} />
            ))}
          </div>
          <div className="chat-message__content chat-message__typing">
            Thinking...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
