type Props = {
  onNewChat: () => void;
  onOpenMemories: () => void;
  onSwitchUser: () => void;
  disabled: boolean;
};

export default function SessionControls({ onNewChat, onOpenMemories, onSwitchUser, disabled }: Props) {
  return (
    <div className="session-controls">
      <button onClick={onOpenMemories} disabled={disabled}>
        Memories
      </button>
      <button onClick={onNewChat} disabled={disabled}>
        New Chat
      </button>
      <button onClick={onSwitchUser} disabled={disabled}>
        Switch User
      </button>
    </div>
  );
}
