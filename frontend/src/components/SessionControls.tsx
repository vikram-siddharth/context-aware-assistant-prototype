type Props = {
  onNewChat: () => void;
  onOpenMemories: () => void;
  onOpenWorkouts: () => void;
  onSwitchUser: () => void;
  disabled: boolean;
};

export default function SessionControls({ onNewChat, onOpenMemories, onOpenWorkouts, onSwitchUser, disabled }: Props) {
  return (
    <div className="session-controls">
      <button onClick={onOpenWorkouts} disabled={disabled}>
        Workouts
      </button>
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
