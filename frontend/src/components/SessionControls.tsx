type Props = {
  onNewChat: () => void;
  onOpenMemories: () => void;
  disabled: boolean;
};

export default function SessionControls({ onNewChat, onOpenMemories, disabled }: Props) {
  return (
    <div className="session-controls">
      <button onClick={onOpenMemories} disabled={disabled}>
        Memories
      </button>
      <button onClick={onNewChat} disabled={disabled}>
        New Chat
      </button>
    </div>
  );
}
