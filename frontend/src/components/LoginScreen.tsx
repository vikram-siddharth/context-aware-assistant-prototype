import { useState, FormEvent } from 'react';

type Props = {
  onLogin: (userId: string) => void;
};

export default function LoginScreen({ onLogin }: Props) {
  const [name, setName] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const userId = name.trim().toLowerCase();
    if (userId) {
      onLogin(userId);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-screen__card">
        <h1 className="login-screen__title">Your Personal Workout Planning Assistant</h1>
        <p className="login-screen__subtitle">What's your name?</p>
        <form className="login-screen__form" onSubmit={handleSubmit}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            autoFocus
          />
          <button type="submit" disabled={!name.trim()}>
            Let's go
          </button>
        </form>
      </div>
    </div>
  );
}
