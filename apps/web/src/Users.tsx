import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Card, Group, Stack, Table, Text } from '@mantine/core';
import { IconCheck, IconTrash, IconUsers, IconX } from '@tabler/icons-react';
import {
  approveAccount,
  listAccounts,
  rejectAccount,
  removeAccount,
  type AccountRow,
} from './api.js';
import { ErrorText, PageHeader, StatusBadge, Tip } from './ui.js';
import { askConfirm } from './ConfirmDialog.js';

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

  const pendingCount = rows.filter((u) => u.status === 'pending').length;

  return (
    <Stack gap="lg">
      <PageHeader
        icon={IconUsers}
        title="Users"
        description="People can register from the sign-in page. They cannot sign in until you approve them. Members can use projects and sessions; providers, GitHub, the MCP library and this page stay admin only."
        action={
          pendingCount > 0 ? (
            <Badge size="lg" variant="light" color="orange" tt="none">
              {pendingCount} waiting for approval
            </Badge>
          ) : undefined
        }
      />
      <ErrorText error={error} />
      <Card padding={0}>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Account</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Registered</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((u) => (
                <Table.Tr key={u.id}>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap">
                      <Avatar size={32} radius="md" color="initials" name={u.username} />
                      <Text fw={600}>{u.username}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={u.role === 'admin' ? 'violet' : 'blue'}>
                      {u.role}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={u.status} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {u.role !== 'admin' && (
                      <Group gap="xs" wrap="nowrap" justify="flex-end">
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
                              void askConfirm(`Delete the account "${u.username}"?`).then((ok) => {
                                if (ok) void act(u.id, () => removeAccount(u.id));
                              });
                            }}
                          >
                            Delete
                          </Button>
                        </Tip>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
