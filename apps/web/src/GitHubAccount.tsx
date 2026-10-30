import { useEffect, useState, type FormEvent } from 'react';
import { Button, Group, PasswordInput, Stack, Text, Title } from '@mantine/core';
import {
  connectGitHub,
  disconnectGitHub,
  getGitHub,
  type GitHubAccount as Account,
} from './api.js';
import { ErrorText } from './ui.js';

export function GitHubAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getGitHub()
      .then(setAccount)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setAccount(await connectGitHub(token));
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <Title order={2}>GitHub</Title>
      {account?.connected ? (
        <Group gap="sm">
          <Text>
            Connected as{' '}
            <Text span fw={700} inherit>
              {account.login}
            </Text>
          </Text>
          <Button
            size="xs"
            variant="subtle"
            color="red"
            onClick={() => {
              if (confirm('Disconnect GitHub? Stored token will be deleted.')) {
                void disconnectGitHub().then(() => setAccount({ connected: false }));
              }
            }}
          >
            Disconnect
          </Button>
        </Group>
      ) : (
        <form onSubmit={connect}>
          <Stack maw={520} gap="sm">
            <Text size="sm" c="dimmed">
              Add a personal access token. It needs read/write access to repository contents and
              pull requests for the repositories you want to push to. It is encrypted at rest and
              never enters a project container.
            </Text>
            <PasswordInput
              label="Personal access token"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
            />
            <Group>
              <Button type="submit" loading={busy} disabled={!token.trim()}>
                Connect
              </Button>
            </Group>
          </Stack>
        </form>
      )}
      <ErrorText error={error} />
    </Stack>
  );
}
