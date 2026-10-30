import { useEffect, useState, type FormEvent } from 'react';
import { Button, Group, PasswordInput, Stack, Text } from '@mantine/core';
import {
  connectGitHub,
  disconnectGitHub,
  getGitHub,
  testGitHub,
  type GitHubAccount as Account,
} from './api.js';
import { ErrorText, PageHeader, Tip } from './ui.js';

export function GitHubAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; login: string } | { ok: false; message: string } | null
  >(null);

  useEffect(() => {
    getGitHub()
      .then(setAccount)
      .catch((e: Error) => setError(e.message));
  }, []);

  // With no token typed, this checks the stored one. Nothing is saved either way.
  async function test(value?: string) {
    setTesting(true);
    setTestResult(null);
    try {
      const user = await testGitHub(value);
      setTestResult({ ok: true, login: user.login });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Token test failed',
      });
    } finally {
      setTesting(false);
    }
  }

  const testLine = testResult && (
    <Text size="sm" c={testResult.ok ? 'green' : 'red'}>
      {testResult.ok ? `Token works: it belongs to ${testResult.login}.` : testResult.message}
    </Text>
  );

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
      <PageHeader
        title="GitHub"
        description="One account for cloning, pushing and opening pull requests from projects. The token is stored encrypted."
      />
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
          <Tip label="Asks GitHub whether the stored token still works">
            <Button size="xs" variant="light" loading={testing} onClick={() => void test()}>
              Test stored token
            </Button>
          </Tip>
          {testLine}
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
            <Group gap="xs">
              <Button type="submit" loading={busy} disabled={!token.trim()}>
                Connect
              </Button>
              <Button
                variant="default"
                loading={testing}
                disabled={!token.trim()}
                onClick={() => void test(token.trim())}
              >
                Test token
              </Button>
            </Group>
            {testLine}
          </Stack>
        </form>
      )}
      <ErrorText error={error} />
    </Stack>
  );
}
