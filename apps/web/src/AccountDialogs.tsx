import { useEffect, useState, type FormEvent } from 'react';
import { Button, Group, Modal, PasswordInput, Stack, Table, Text } from '@mantine/core';
import { changePassword, getSystem, type SystemInfo } from './api.js';
import { ErrorText } from './ui.js';

export type AccountDialog = 'password' | 'about' | null;

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== again) return setError('The new passwords do not match');
    setBusy(true);
    try {
      const r = await changePassword(current, next);
      setDone(
        r.signedOutOthers > 0
          ? `Password changed. ${r.signedOutOthers} other sign-in${r.signedOutOthers === 1 ? ' was' : 's were'} ended.`
          : 'Password changed.',
      );
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Stack>
        <Text>{done}</Text>
        <Group justify="flex-end">
          <Button onClick={onDone}>Close</Button>
        </Group>
      </Stack>
    );
  }

  return (
    <form onSubmit={submit}>
      <Stack>
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="New password"
          description="At least 12 characters"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="New password again"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.currentTarget.value)}
          required
        />
        <Text size="xs" c="dimmed">
          Other browsers signed in as you will be signed out.
        </Text>
        <ErrorText error={error} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!current || next.length < 12}>
            Change password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function About() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    getSystem()
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <ErrorText error={error} />;
  if (!info) return <Text c="dimmed">Loading…</Text>;
  const rows: [string, string][] = [
    ['Pi-Panel', info.panelVersion],
    ['Database schema', String(info.schema)],
    ['Docker', info.docker ? 'reachable' : 'unreachable'],
    [
      'pi in the sandbox image',
      info.sandbox.present
        ? (info.sandbox.piVersion ?? 'unknown (image predates labels)')
        : 'image not built',
    ],
  ];
  return (
    <Stack>
      <Table>
        <Table.Tbody>
          {rows.map(([k, v]) => (
            <Table.Tr key={k}>
              <Table.Td c="dimmed">{k}</Table.Td>
              <Table.Td>{v}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed">
        To move projects to a newer pi, rebuild the sandbox image, then use Recreate container on
        each project. See docs/updates.md.
      </Text>
    </Stack>
  );
}

export function AccountDialogs({ open, onClose }: { open: AccountDialog; onClose: () => void }) {
  return (
    <>
      <Modal opened={open === 'password'} onClose={onClose} title="Change password">
        {open === 'password' && <PasswordForm onDone={onClose} />}
      </Modal>
      <Modal opened={open === 'about'} onClose={onClose} title="About Pi-Panel">
        {open === 'about' && <About />}
      </Modal>
    </>
  );
}
