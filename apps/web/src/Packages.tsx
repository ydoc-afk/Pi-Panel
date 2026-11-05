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
  deletePackageSet,
  installPackage,
  listPackageSets,
  listPackages,
  previewPackage,
  removePackage,
  savePackageSet,
  type InstalledPackage,
  type PackageSetStatus,
  type PackageChange,
  type PackageReview,
} from './api.js';
import { Collapsible, ErrorText } from './ui.js';
import { askConfirm } from './ConfirmDialog.js';

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
    <Stack gap="md">
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
                      void askConfirm(`Remove ${p.source}?`).then((ok) => {
                        if (!ok) return;
                        void run(async () =>
                          applied('Removed', await removePackage(projectId, p.source)),
                        );
                      });
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
      <PackageSets
        projectId={projectId}
        installedCount={packages?.length ?? 0}
        onInstalled={(change) => applied('Installed', change)}
      />
    </Stack>
  );
}

/**
 * Named groups of packages. Saving one records the exact versions this project uses; applying one
 * to a project shows the same review as adding a package by hand, for every package it would add,
 * and installs nothing until the whole list is approved.
 */
export function PackageSets({
  projectId,
  installedCount,
  onInstalled,
}: {
  projectId: number;
  installedCount: number;
  onInstalled: (change: PackageChange) => void;
}) {
  const [sets, setSets] = useState<PackageSetStatus[] | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<{
    set: PackageSetStatus;
    reviews: PackageReview[];
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    listPackageSets(projectId)
      .then(setSets)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, [projectId, installedCount]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const review = (set: PackageSetStatus) =>
    run(async () => {
      // Reviewing records the exact version as reviewed, which is what install requires.
      const reviews: PackageReview[] = [];
      for (const source of set.missing) reviews.push(await previewPackage(projectId, source));
      setPending({ set, reviews });
    });

  const install = () =>
    run(async () => {
      if (!pending) return;
      let last: PackageChange | undefined;
      for (const r of pending.reviews) last = await installPackage(projectId, r.source);
      if (last) onInstalled(last);
      setNotice(`Applied "${pending.set.name}": ${pending.reviews.length} package(s) installed.`);
      setPending(null);
      await refresh();
    });

  return (
    <Collapsible title={`Package sets${sets ? ` (${sets.length})` : ''}`} defaultOpen={false}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Save the packages this project uses as a set, then apply it to other projects. Applying
          shows the same review as adding a package, and installs only after you approve.
        </Text>
        {sets?.map((set) => {
          const todo = set.missing.length;
          return (
            <Paper key={set.id} withBorder p="sm" radius="md">
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="xs">
                    <Text fw={600}>{set.name}</Text>
                    <Badge variant="light" color={todo === 0 ? 'teal' : 'gray'}>
                      {set.installed.length} of {set.sources.length} installed
                    </Badge>
                  </Group>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      disabled={busy || todo === 0}
                      onClick={() => void review(set)}
                    >
                      {todo === 0 ? 'Applied' : `Review ${todo} to install`}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() => {
                        void askConfirm(
                          `Delete the set "${set.name}"? Installed packages stay.`,
                        ).then((ok) => {
                          if (ok)
                            void run(async () => {
                              await deletePackageSet(set.id);
                              await refresh();
                            });
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </Group>
                </Group>
                <Group gap={6}>
                  {set.sources.map((s) => (
                    <Code key={s.source}>{s.source.replace(/^npm:/, '')}</Code>
                  ))}
                </Group>
                {set.different.map((d) => (
                  <Text key={d.source} size="xs" c="orange">
                    This project has {d.installed.replace(/^npm:/, '')}; the set records{' '}
                    {d.source.replace(/^npm:/, '')}. It is left alone.
                  </Text>
                ))}
              </Stack>
            </Paper>
          );
        })}
        {pending && (
          <Paper withBorder p="md" radius="md" maw={700}>
            <Stack gap="sm">
              <Text fw={700}>Review before installing "{pending.set.name}"</Text>
              {pending.reviews.map((r) => (
                <Stack key={r.source} gap={2}>
                  <Group gap="xs">
                    <Text fw={600}>
                      {r.name}@{r.version}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {r.license ?? 'no license'} · {r.publisher ?? 'unknown publisher'} ·{' '}
                      {r.resources
                        ? `${r.resources.extensions} ext, ${r.resources.skills} skills`
                        : 'no pi manifest'}
                    </Text>
                  </Group>
                  {r.warnings.map((w) => (
                    <Text key={w} size="sm" c="orange">
                      {w}
                    </Text>
                  ))}
                  <Anchor href={r.links.files} target="_blank" rel="noopener noreferrer" size="xs">
                    browse files
                  </Anchor>
                </Stack>
              ))}
              <Text size="sm" c="dimmed">
                Packages run with the agent&apos;s permissions inside this project&apos;s container.
                Install scripts are disabled. These exact versions will be installed.
              </Text>
              <Group gap="xs">
                <Button disabled={busy} onClick={() => void install()}>
                  Install {pending.reviews.length} package(s)
                </Button>
                <Button variant="default" disabled={busy} onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </Paper>
        )}
        <Group gap="xs" align="flex-end">
          <TextInput
            placeholder="Name for a set of this project's packages"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            w={320}
            maxLength={60}
          />
          <Button
            variant="default"
            disabled={busy || !name.trim() || installedCount === 0}
            onClick={() =>
              void run(async () => {
                const r = await savePackageSet(name.trim(), projectId);
                setName('');
                setNotice(
                  `Saved "${r.set.name}" with ${r.set.sources.length} package(s)` +
                    (r.skipped
                      ? `. ${r.skipped} not pinned to an exact version were left out.`
                      : '.'),
                );
                await refresh();
              })
            }
          >
            Save current packages as a set
          </Button>
        </Group>
        {notice && <Text size="sm">{notice}</Text>}
        <ErrorText error={error} />
      </Stack>
    </Collapsible>
  );
}
