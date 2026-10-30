import { useState, type FormEvent } from 'react';
import { Button, Card, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { login, setupAdmin, type User } from './api.js';
import { ErrorText } from './ui.js';

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
    <Card withBorder padding="xl" radius="md">
      <form onSubmit={submit}>
        <Stack>
          <Title order={3}>{setup ? 'Create admin account' : 'Sign in'}</Title>
          <TextInput
            label="Username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
          <PasswordInput
            label="Password"
            description={setup ? '12 or more characters' : undefined}
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <ErrorText error={error} />
          <Button type="submit" loading={busy}>
            {setup ? 'Create account' : 'Sign in'}
          </Button>
        </Stack>
      </form>
    </Card>
  );
}
