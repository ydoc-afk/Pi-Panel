import { useState, type FormEvent } from 'react';
import { login, setupAdmin, type User } from './api.js';

export function AuthForm({ setup, onAuthed }: { setup: boolean; onAuthed: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await (setup ? setupAdmin : login)(username, password);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
      <h2>{setup ? 'Create admin account' : 'Sign in'}</h2>
      <input
        placeholder="Username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        placeholder={setup ? 'Password (12+ characters)' : 'Password'}
        autoComplete={setup ? 'new-password' : 'current-password'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && (
        <p role="alert" style={{ color: 'crimson', margin: 0 }}>
          {error}
        </p>
      )}
      <button disabled={busy}>{setup ? 'Create account' : 'Sign in'}</button>
    </form>
  );
}
