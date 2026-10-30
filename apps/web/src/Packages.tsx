import { useEffect, useState, type FormEvent } from 'react';
import {
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import {
  installPackage,
  listPackages,
  previewPackage,
  removePackage,
  type InstalledPackage,
  type PackageChange,
  type PackageReview,
} from './api.js';
import { Collapsible, ErrorText } from './ui.js';

const kb = (n: number | null) =>
  n === null ? 'unknown' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;

function Review({
  review,
  busy,
  onInstall,
  onCancel,
}: {
  review: PackageReview;
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const r = review;
  const res = r.resources;
  return (
    <Paper withBorder p="md" radius="md" maw={600}>
      <Stack gap="sm">
        <Text fw={700}>
          {r.name}@{r.version}
        </Text>
        {r.description && <Text size="sm">{r.description}</Text>}
        {r.warnings.length > 0 && (
          <Stack gap={2}>
            {r.warnings.map((w) => (
              <Text key={w} size="sm" c="orange">
                {w}
              </Text>
            ))}
          </Stack>
        )}
        <Table verticalSpacing="xs" withRowBorders={false}>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td c="dimmed" w={130}>
                License
              </Table.Td>
              <Table.Td>{r.license ?? 'none listed'}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">Publisher</Table.Td>
              <Table.Td>{r.publisher ?? 'unknown'}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">Repository</Table.Td>
              <Table.Td>{r.repository ?? 'none listed'}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">Contents</Table.Td>
              <Table.Td>
                {res
                  ? `${res.extensions} extension(s), ${res.skills} skill(s), ${res.prompts} prompt(s), ${res.themes} theme(s)`
                  : 'no pi manifest'}
                {' · '}
                {r.fileCount ?? '?'} files, {kb(r.unpackedBytes)}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">Dependencies</Table.Td>
              <Table.Td>
                {r.dependencies.length === 0 ? 'none' : r.dependencies.join(', ')}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
        <Text size="sm">
          Inspect the code first:{' '}
          <Anchor href={r.links.files} target="_blank" rel="noopener noreferrer" size="sm">
            browse files
          </Anchor>{' '}
          &middot;{' '}
          <Anchor href={r.links.npm} target="_blank" rel="noopener noreferrer" size="sm">
            npm page
          </Anchor>
        </Text>
        <Text size="sm" c="dimmed">
          Packages run with the agent&apos;s permissions inside this project&apos;s container.
          Install scripts are disabled. This exact version will be installed.
        </Text>
        <Group gap="xs">
          <Button disabled={busy} onClick={onInstall}>
            Install {r.name}@{r.version}
          </Button>
          <Button variant="default" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function Packages({ projectId }: { projectId: number }) {
  const [packages, setPackages] = useState<InstalledPackage[] | null>(null);
  const [source, setSource] = useState('');
  const [review, setReview] = useState<PackageReview | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listPackages(projectId)
      .then(setPackages)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const applied = (verb: string, change: PackageChange) => {
    setPackages(change.packages);
    const parts = [`${verb}.`];
    if (change.restartedSessions > 0)
      parts.push(`${change.restartedSessions} idle session(s) will reload on their next prompt.`);
    if (change.pendingSessions > 0)
      parts.push(
        `${change.pendingSessions} running session(s) pick it up after they finish and restart.`,
      );
    setNotice(parts.join(' '));
  };

  const doReview = (e: FormEvent) => {
    e.preventDefault();
    setNotice('');
    void run(async () => {
      const value = source.trim();
      setReview(await previewPackage(projectId, value.startsWith('npm:') ? value : `npm:${value}`));
    });
  };

  return (
    <Collapsible title={`Pi packages${packages ? ` (${packages.length})` : ''}`}>
      <Stack gap="sm">
        {packages && packages.length > 0 && (
          <Stack gap="xs">
            {packages.map((p) => (
              <Group key={p.source} gap="xs">
                <Code>{p.source}</Code>
                {p.filtered && (
                  <Badge variant="light" color="gray" size="sm">
                    resources filtered
                  </Badge>
                )}
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove ${p.source}?`)) {
                      void run(async () =>
                        applied('Removed', await removePackage(projectId, p.source)),
                      );
                    }
                  }}
                >
                  Remove
                </Button>
              </Group>
            ))}
          </Stack>
        )}
        <form onSubmit={doReview}>
          <Group gap="xs" align="flex-end">
            <TextInput
              placeholder="npm package, e.g. @scope/name or npm:name@1.2.3"
              value={source}
              onChange={(e) => {
                setSource(e.currentTarget.value);
                setReview(null);
              }}
              w={380}
            />
            <Button type="submit" disabled={busy || !source.trim()}>
              Review
            </Button>
          </Group>
        </form>
        {review && (
          <Review
            review={review}
            busy={busy}
            onCancel={() => setReview(null)}
            onInstall={() =>
              void run(async () => {
                applied('Installed', await installPackage(projectId, review.source));
                setReview(null);
                setSource('');
              })
            }
          />
        )}
        {notice && <Text size="sm">{notice}</Text>}
        <ErrorText error={error} />
      </Stack>
    </Collapsible>
  );
}
