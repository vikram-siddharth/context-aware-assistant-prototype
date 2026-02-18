type Props = {
  onNewChat: () => void;
  disabled: boolean;
};

export default function SessionControls({ onNewChat, disabled }: Props) {
  return (
    <div className="session-controls">
      <button onClick={onNewChat} disabled={disabled}>
        New Chat
      </button>
    </div>
  );
}
