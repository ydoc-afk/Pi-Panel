import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconClockHour4 } from '@tabler/icons-react';
import { login, register, setupAdmin, type User } from './api.js';
import { ErrorText } from './ui.js';

type Mode = 'signin' | 'register';

export function AuthForm({ setup, onAuthed }: { setup: boolean; onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);

  const registering = !setup && mode === 'register';
  const creating = setup || registering;

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setPassword('');
    setConfirm('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (registering && password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (registering) {
        await register(username, password);
        setRequested(true);
      } else {
        const { user } = await (setup ? setupAdmin : login)(username, password);
        onAuthed(user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (requested) {
    return (
      <Card withBorder padding="xl" radius="md">
        <Stack>
          <Alert icon={<IconClockHour4 size={18} />} color="teal" title="Request sent">
            Your account <b>{username}</b> is waiting for the admin to approve it. Once they do,
            sign in with the password you just chose.
          </Alert>
          <Button
            variant="default"
            onClick={() => {
              setRequested(false);
              switchMode('signin');
            }}
          >
            Back to sign in
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Card withBorder padding="xl" radius="md">
      <form onSubmit={submit}>
        <Stack>
          <div>
            <Title order={3}>
              {setup ? 'Create admin account' : registering ? 'Request an account' : 'Welcome back'}
            </Title>
            <Text size="sm" c="dimmed">
              {setup
                ? 'This first account is the admin. It approves everyone else.'
                : registering
                  ? 'The admin has to approve your account before you can sign in.'
                  : 'Sign in to your Pi-Panel.'}
            </Text>
          </div>
          {!setup && (
            <SegmentedControl
              fullWidth
              value={mode}
              onChange={(v) => switchMode(v as Mode)}
              data={[
                { label: 'Sign in', value: 'signin' },
                { label: 'Register', value: 'register' },
              ]}
            />
          )}
          <TextInput
            label="Username"
            description={creating ? '3 to 64 characters' : undefined}
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
          <PasswordInput
            label="Password"
            description={creating ? '12 or more characters' : undefined}
            autoComplete={creating ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          {registering && (
            <PasswordInput
              label="Confirm password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
            />
          )}
          <ErrorText error={error} />
          <Button type="submit" loading={busy}>
            {setup ? 'Create account' : registering ? 'Request account' : 'Sign in'}
          </Button>
        </Stack>
      </form>
    </Card>
  );
}
