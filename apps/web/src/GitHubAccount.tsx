import { useEffect, useState, type FormEvent } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Group,
  List,
  PasswordInput,
  TextInput,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  IconBrandGithub,
  IconCircleCheck,
  IconGitBranch,
  IconShieldLock,
} from '@tabler/icons-react';
import {
  connectGitHub,
  disconnectGitHub,
  getGitHub,
  testGitHub,
  type Forge,
  type GitHubAccount as Account,
} from './api.js';
import { ErrorText, PageHeader, Tip } from './ui.js';
import { askConfirm } from './ConfirmDialog.js';

export function GitHubAccount({ forge = 'github' }: { forge?: Forge }) {
  const forgejo = forge === 'forgejo';
  const name = forgejo ? 'Forgejo' : 'GitHub';
  const [account, setAccount] = useState<Account | null>(null);
  const [baseUrl, setBaseUrl] = useState('http://localhost:3001');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; login: string } | { ok: false; message: string } | null
  >(null);

  useEffect(() => {
    getGitHub(forge)
      .then(setAccount)
      .catch((e: Error) => setError(e.message));
  }, []);

  // With no token typed, this checks the stored one. Nothing is saved either way.
  async function test(value?: string) {
    setTesting(true);
    setTestResult(null);
    try {
      const user = await testGitHub(value, forge, baseUrl.trim());
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
      setAccount(await connectGitHub(token, forge, baseUrl.trim()));
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="lg">
      <PageHeader
        icon={forgejo ? IconGitBranch : IconBrandGithub}
        title={name}
        description={`One account for cloning, pushing and opening pull requests from projects. The token is stored encrypted.${forgejo ? ' Run your own with compose/forgejo.' : ''}`}
      />
      <Card padding="xl" maw={640}>
        {account?.connected ? (
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap" gap="md">
              <Group gap="md" wrap="nowrap">
                <Avatar size={52} radius="md" color="initials" name={account.login ?? '?'} />
                <Stack gap={2}>
                  <Group gap="xs">
                    <Text fw={650} size="lg">
                      {account.login}
                    </Text>
                    <Badge
                      variant="light"
                      color="green"
                      leftSection={<IconCircleCheck size={12} />}
                    >
                      Connected
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Projects clone, push and open pull requests as this account
                    {account.baseUrl ? ` on ${account.baseUrl}` : ''}.
                  </Text>
                </Stack>
              </Group>
            </Group>
            <Group gap="xs">
              <Tip label={`Asks ${name} whether the stored token still works`}>
                <Button size="xs" variant="light" loading={testing} onClick={() => void test()}>
                  Test stored token
                </Button>
              </Tip>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() => {
                  void askConfirm(`Disconnect ${name}? Stored token will be deleted.`).then(
                    (ok) => {
                      if (ok)
                        void disconnectGitHub(forge).then(() => setAccount({ connected: false }));
                    },
                  );
                }}
              >
                Disconnect
              </Button>
            </Group>
            {testLine}
          </Stack>
        ) : (
          <form onSubmit={connect}>
            <Stack gap="md">
              <Group gap="md" wrap="nowrap" align="flex-start">
                <ThemeIcon variant="light" size={44} radius="md" color="gray">
                  <IconShieldLock size={24} stroke={1.6} />
                </ThemeIcon>
                <Stack gap={4}>
                  <Text fw={650}>Connect a personal access token</Text>
                  <List size="sm" c="dimmed" spacing={2}>
                    <List.Item>
                      Needs read/write access to repository contents and pull requests.
                    </List.Item>
                    <List.Item>Encrypted at rest, and never enters a project container.</List.Item>
                  </List>
                </Stack>
              </Group>
              {forgejo && (
                <TextInput
                  label="Forgejo address"
                  description="Reachable from the panel. From inside Docker, use http://host.docker.internal:3001 rather than localhost."
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.currentTarget.value)}
                />
              )}
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
      </Card>
      <ErrorText error={error} />
    </Stack>
  );
}
