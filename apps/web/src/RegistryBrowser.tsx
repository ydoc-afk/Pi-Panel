import { useState, type FormEvent } from 'react';
import { Anchor, Badge, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import type { McpServerInput } from './api.js';
import { searchRegistry, type RegistryItem } from './api.js';
import { ErrorText } from './ui.js';

/** A server name the panel accepts: letters, digits, dashes and underscores. */
export const serverName = (registryName: string) =>
  (registryName.split('/').pop() ?? registryName)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';

/** The form values for a registry entry. Versions stay pinned to what the registry lists. */
export function registryPreset(item: RegistryItem): McpServerInput & { name: string } {
  const install = item.install;
  if (!install) throw new Error(`${item.name} cannot be added from here yet`);
  const name = serverName(item.name);
  const description = item.description.slice(0, 200);
  if (install.kind === 'remote') {
    return { name, type: 'http', url: install.url, headers: [], description };
  }
  return {
    name,
    type: 'stdio',
    command: 'npx',
    args: ['-y', `${install.identifier}@${install.version}`],
    env: install.env.map((e) => ({ key: e.name, value: e.default ?? '', secret: e.isSecret })),
    description,
  };
}

/** Review notes shown above the form, so a third-party server is never saved unread. */
export function registryNotes(item: RegistryItem): string[] {
  const install = item.install;
  if (!install) return [];
  if (install.kind === 'remote') {
    return [
      'A hosted MCP endpoint run by its publisher. Add any headers it needs, and check its terms before sending it project data.',
    ];
  }
  const notes = [
    `Third-party package from the MCP registry: ${install.identifier}@${install.version}. Read its code on npm before you save. It runs with the agent's permissions inside the project container.`,
  ];
  const required = install.env.filter((e) => e.isRequired).map((e) => e.name);
  if (required.length > 0) notes.push(`Fill in the required values: ${required.join(', ')}.`);
  return notes;
}

function Entry({ item, onAdd }: { item: RegistryItem; onAdd: () => void }) {
  const install = item.install;
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs" wrap="wrap">
            <Text fw={600}>{item.title}</Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {item.name}
            </Text>
            {install?.kind === 'npm' && (
              <Badge variant="light" size="sm">
                npm {install.version}
              </Badge>
            )}
            {install?.kind === 'remote' && (
              <Badge variant="light" color="teal" size="sm">
                hosted
              </Badge>
            )}
            {!install && (
              <Badge variant="light" color="gray" size="sm">
                not supported yet
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {item.description}
          </Text>
          {item.repository && (
            <Anchor href={item.repository} target="_blank" rel="noopener noreferrer" size="xs">
              source
            </Anchor>
          )}
        </Stack>
        <Button size="xs" disabled={!install} onClick={onAdd}>
          Add
        </Button>
      </Group>
    </Paper>
  );
}

/** Searches the official MCP registry. Add opens the server form filled in, for review. */
export function RegistryBrowser({ onAdd }: { onAdd: (item: RegistryItem) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<RegistryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');

  async function search(e?: FormEvent, cursor?: string) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await searchRegistry(q.trim(), cursor);
      setItems((cur) => (cursor ? [...cur, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="sm">
      <form onSubmit={(e) => void search(e)}>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="Search the MCP registry, e.g. github, postgres, filesystem"
            aria-label="Search the MCP registry"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
          <Button type="submit" variant="light" loading={busy}>
            Search
          </Button>
        </Group>
      </form>
      <Text size="xs" c="dimmed">
        Servers from the official MCP registry. Adding one opens its form for review before anything
        is saved.
      </Text>
      <ErrorText error={error} />
      {searched && items.length === 0 && !busy && <Text c="dimmed">No servers found.</Text>}
      <Stack gap="xs">
        {items.map((item) => (
          <Entry key={item.name} item={item} onAdd={() => onAdd(item)} />
        ))}
      </Stack>
      {nextCursor && (
        <Group>
          <Button
            variant="default"
            size="xs"
            loading={busy}
            onClick={() => void search(undefined, nextCursor)}
          >
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}
