import { useEffect, useState, type FormEvent } from 'react';
import {
  Anchor,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { buildRea, getRea, type ReaState } from './api.js';
import { ErrorText } from './ui.js';

const SHA_RE = /^[0-9a-fA-F]{64}$/;
const URL_RE = /^https:\/\/\S+$/;

const STATUS_TEXT = {
  idle: '',
  building: 'Building. This downloads Ghidra and a JDK, so it can take a while.',
  done: 'Build finished. The image is ready.',
  failed: 'Build failed.',
} as const;

/**
 * One-step REA setup: paste a Ghidra release link and its checksum, and the panel builds the image
 * on this machine. Once it exists, the card offers to add REA to the library.
 */
export function ReaBuilder({ onAdd }: { onAdd: () => void }) {
  const [state, setState] = useState<ReaState | null>(null);
  const [url, setUrl] = useState('');
  const [sha, setSha] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    getRea()
      .then(setState)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, []);

  const building = state?.build.status === 'building';
  // Keep the log moving while a build runs, without a page reload.
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [building]);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setState(await buildRea(url.trim(), sha.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the build');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return error ? <ErrorText error={error} /> : <Loader size="sm" />;

  if (state.present) {
    return (
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={2}>
            <Text fw={600}>REA is built</Text>
            <Text size="sm" c="dimmed">
              The image <Code>{state.image}</Code> is on this machine.
            </Text>
          </Stack>
          <Button onClick={onAdd}>Add REA</Button>
        </Group>
      </Paper>
    );
  }

  const valid = URL_RE.test(url.trim()) && SHA_RE.test(sha.trim());
  const log = state.build.log.slice(-200);
  return (
    <Paper withBorder p="md" radius="md">
      <form onSubmit={start}>
        <Stack gap="sm">
          <Title order={4}>Build REA</Title>
          <Text size="sm" c="dimmed">
            REA runs Ghidra, so its image has to be built once on this machine. Paste the download
            link of a Ghidra release and its checksum, and the panel does the rest.
          </Text>
          <Text size="sm">
            For the checksum, download the zip and run <Code>sha256sum ghidra_*.zip</Code>. Releases
            are at{' '}
            <Anchor
              href="https://github.com/NationalSecurityAgency/ghidra/releases"
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
            >
              github.com/NationalSecurityAgency/ghidra/releases
            </Anchor>
            .
          </Text>
          <TextInput
            label="Ghidra download link"
            placeholder="https://github.com/NationalSecurityAgency/ghidra/releases/download/..."
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
          <TextInput
            label="SHA-256 checksum"
            placeholder="64 hexadecimal characters"
            value={sha}
            error={
              sha && !SHA_RE.test(sha.trim()) ? 'Must be 64 hexadecimal characters' : undefined
            }
            onChange={(e) => setSha(e.currentTarget.value)}
          />
          <Group>
            <Button type="submit" loading={busy} disabled={!valid || building}>
              Build REA image
            </Button>
          </Group>
          <ErrorText error={error} />
          {state.build.status !== 'idle' && (
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {STATUS_TEXT[state.build.status]}
              </Text>
              {state.build.status === 'failed' && state.build.error && (
                <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                  {state.build.error}
                </Text>
              )}
              <Code
                block
                style={{ fontSize: 12, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}
              >
                {log.join('\n') || '(waiting for output)'}
              </Code>
            </Stack>
          )}
        </Stack>
      </form>
    </Paper>
  );
}
