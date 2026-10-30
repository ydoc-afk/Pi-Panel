import { useEffect, useState } from 'react';
import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck, IconTrash, IconX } from '@tabler/icons-react';
import {
  approveAccount,
  listAccounts,
  rejectAccount,
  removeAccount,
  type AccountRow,
} from './api.js';
import { ErrorText, PageHeader, Tip } from './ui.js';

const STATUS_COLOR = { pending: 'orange', approved: 'green', rejected: 'gray' } as const;

/** Admin only: review registrations and decide who can sign in. */
export function Users({ onChange }: { onChange?: (pending: number) => void }) {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = () =>
    listAccounts()
      .then((r) => {
        setRows(r);
        onChange?.(r.filter((x) => x.status === 'pending').length);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, []);

  async function act(id: number, action: () => Promise<unknown>) {
    setBusy(id);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack>
      <PageHeader
        title="Users"
        description="People can register from the sign-in page. They cannot sign in until you approve them. Members can use projects and sessions; providers, GitHub, the MCP library and this page stay admin only."
      />
      <ErrorText error={error} />
      <Stack gap="xs">
        {rows.map((u) => (
          <Paper key={u.id} withBorder p="sm" radius="md">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="wrap">
                <Text fw={600}>{u.username}</Text>
                <Badge variant="light" color={u.role === 'admin' ? 'violet' : 'blue'}>
                  {u.role}
                </Badge>
                <Badge variant="light" color={STATUS_COLOR[u.status]}>
                  {u.status}
                </Badge>
                <Text size="xs" c="dimmed">
                  registered {new Date(u.createdAt).toLocaleDateString()}
                </Text>
              </Group>
              {u.role !== 'admin' && (
                <Group gap="xs" wrap="nowrap">
                  {u.status !== 'approved' && (
                    <Tip label="Let this person sign in">
                      <Button
                        size="xs"
                        leftSection={<IconCheck size={14} />}
                        loading={busy === u.id}
                        onClick={() => void act(u.id, () => approveAccount(u.id))}
                      >
                        Approve
                      </Button>
                    </Tip>
                  )}
                  {u.status !== 'rejected' && (
                    <Tip
                      label={
                        u.status === 'approved'
                          ? 'Revoke access and end their sign-ins'
                          : 'Decline this registration'
                      }
                    >
                      <Button
                        size="xs"
                        variant="light"
                        color="orange"
                        leftSection={<IconX size={14} />}
                        disabled={busy === u.id}
                        onClick={() => void act(u.id, () => rejectAccount(u.id))}
                      >
                        {u.status === 'approved' ? 'Revoke' : 'Decline'}
                      </Button>
                    </Tip>
                  )}
                  <Tip label="Delete the account. They can register again.">
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      disabled={busy === u.id}
                      onClick={() => {
                        if (confirm(`Delete the account "${u.username}"?`))
                          void act(u.id, () => removeAccount(u.id));
                      }}
                    >
                      Delete
                    </Button>
                  </Tip>
                </Group>
              )}
            </Group>
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
