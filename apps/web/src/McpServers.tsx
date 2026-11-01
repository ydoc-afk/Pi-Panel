import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import {
  IconBox,
  IconClipboardText,
  IconPlug,
  IconPlus,
  IconTerminal,
  IconWorld,
} from '@tabler/icons-react';
import {
  deleteMcpServer,
  discoverMcp,
  importMcp,
  listMcpPresets,
  listMcpServers,
  setMcpDefaultHidden,
  type McpPreset,
  type McpServer,
  type McpServerInput,
} from './api.js';
import { McpServerForm } from './McpServerForm.js';
import { ReaBuilder } from './ReaBuilder.js';
import { RegistryBrowser, registryNotes, registryPreset } from './RegistryBrowser.js';
import { McpToolList } from './McpToolList.js';
import { Collapsible, EmptyState, ErrorText, mono, PageHeader, Tip } from './ui.js';

const TYPE_INFO = {
  stdio: { label: 'Command', icon: IconTerminal },
  http: { label: 'URL', icon: IconWorld },
  managed: { label: 'Managed container', icon: IconBox },
} as const;

type Mode =
  | { kind: 'none' }
  | { kind: 'form'; preset?: McpServerInput & { name: string }; notes?: string[] }
  | { kind: 'import' }
  | { kind: 'edit'; id: number };

function StateBadge({ server, testing }: { server: McpServer; testing: boolean }) {
  if (testing)
    return (
      <Badge variant="light" color="gray">
        testing&hellip;
      </Badge>
    );
  const d = server.discovery;
  if (!d)
    return (
      <Badge variant="dot" color="gray" tt="none">
        not tested
      </Badge>
    );
  if (d.state === 'connected')
    return (
      <Badge variant="dot" color="green" tt="none">
        connected, {d.tools.length} tool{d.tools.length === 1 ? '' : 's'}
      </Badge>
    );
  return (
    <Badge variant="dot" color="red" tt="none">
      {d.state}
    </Badge>
  );
}

export function McpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [testing, setTesting] = useState<number | null>(null);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = () =>
    listMcpServers()
      .then(setServers)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
    listMcpPresets()
      .then(setPresets)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function act(action: () => Promise<void>) {
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  const saved = () => {
    setMode({ kind: 'none' });
    void refresh();
  };

  const doImport = () =>
    act(async () => {
      let json: unknown;
      try {
        json = JSON.parse(importText);
      } catch {
        throw new Error('That is not valid JSON');
      }
      const result = await importMcp(json, importName.trim() || undefined);
      setWarnings(result.warnings);
      setNotice(
        `Imported ${result.servers.length} server${result.servers.length === 1 ? '' : 's'}.`,
      );
      setImportText('');
      setMode({ kind: 'none' });
      await refresh();
    });

  const reaPreset = presets.find((p) => p.id === 'rea');

  const presetNotes = (preset: McpServerInput & { name: string }) =>
    presets.find((p) => p.server === preset)?.notes ?? [];

  return (
    <Stack gap="lg">
      <PageHeader
        icon={IconPlug}
        title="MCP servers"
        description="Add servers here once, then switch them on per project. Command servers run inside the project container with the agent's permissions, and any secrets you give them are visible to the agent. Remote URL servers keep their own credentials."
      />

      {mode.kind === 'none' && (
        <Card padding="lg">
          <Stack gap="md">
            <div>
              <Text fw={650}>Add a server</Text>
              <Text size="sm" c="dimmed">
                Start from a ready-made server, describe your own, or search the public registry.
              </Text>
            </div>
            <Group gap="xs">
              {presets.map((p) => (
                <Tip key={p.id} label={p.description}>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => setMode({ kind: 'form', preset: p.server })}
                  >
                    {p.title}
                  </Button>
                </Tip>
              ))}
              <Tip label="Describe any command or URL server yourself">
                <Button size="xs" variant="default" onClick={() => setMode({ kind: 'form' })}>
                  Custom&hellip;
                </Button>
              </Tip>
              <Tip label="Import an mcpServers config from Claude Desktop, Cursor and similar">
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconClipboardText size={14} />}
                  onClick={() => setMode({ kind: 'import' })}
                >
                  Paste JSON&hellip;
                </Button>
              </Tip>
            </Group>
            <Collapsible title="Find servers in the MCP registry" defaultOpen={false}>
              <RegistryBrowser
                onAdd={(item) =>
                  setMode({
                    kind: 'form',
                    preset: registryPreset(item),
                    notes: registryNotes(item),
                  })
                }
              />
            </Collapsible>
          </Stack>
        </Card>
      )}

      {mode.kind === 'form' && (
        <Stack gap="xs">
          {(mode.notes ?? (mode.preset ? presetNotes(mode.preset) : [])).map((n) => (
            <Text key={n} size="sm" c="orange">
              {n}
            </Text>
          ))}
          <McpServerForm
            preset={mode.preset}
            onSaved={saved}
            onCancel={() => setMode({ kind: 'none' })}
          />
        </Stack>
      )}

      {mode.kind === 'import' && (
        <Card padding="lg" maw={640}>
          <Stack gap="sm">
            <Text size="sm">
              Paste an <code>mcpServers</code> config from Claude Desktop, Cursor and similar, or a
              single server. Values that look like secrets, or that reference environment variables,
              are added as empty secrets for you to fill in.
            </Text>
            <Textarea
              rows={8}
              value={importText}
              onChange={(e) => setImportText(e.currentTarget.value)}
              placeholder='{ "mcpServers": { ... } }'
              styles={{ input: mono }}
            />
            <TextInput
              placeholder="Name (only needed when pasting a single server)"
              value={importName}
              onChange={(e) => setImportName(e.currentTarget.value)}
            />
            <Group gap="xs">
              <Button disabled={!importText.trim()} onClick={() => void doImport()}>
                Import
              </Button>
              <Button variant="default" onClick={() => setMode({ kind: 'none' })}>
                Cancel
              </Button>
            </Group>
          </Stack>
        </Card>
      )}

      {notice && <Text size="sm">{notice}</Text>}
      {warnings.length > 0 && (
        <Stack gap={2}>
          {warnings.map((w) => (
            <Text key={w} size="sm" c="orange">
              {w}
            </Text>
          ))}
        </Stack>
      )}
      <ErrorText error={error} />

      <Stack gap="sm">
        {servers.length > 0 && (
          <Text fw={650} mt="xs">
            Library ({servers.length})
          </Text>
        )}
        {servers.map((s) => (
          <Card key={s.id} padding="lg">
            {mode.kind === 'edit' && mode.id === s.id ? (
              <McpServerForm
                initial={s}
                onSaved={saved}
                onCancel={() => setMode({ kind: 'none' })}
              />
            ) : (
              <Stack gap={6}>
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Tip label={TYPE_INFO[s.type].label}>
                    <ThemeIcon variant="light" size={36} radius="md">
                      {(() => {
                        const TypeIcon = TYPE_INFO[s.type].icon;
                        return <TypeIcon size={20} stroke={1.6} />;
                      })()}
                    </ThemeIcon>
                  </Tip>
                  <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                    <Group gap="xs" wrap="wrap">
                      <Text fw={650}>{s.name}</Text>
                      <StateBadge server={s} testing={testing === s.id} />
                    </Group>
                    <Text size="xs" c="dimmed">
                      {TYPE_INFO[s.type].label}
                    </Text>
                  </Stack>
                </Group>
                {s.description && (
                  <Text size="sm" c="dimmed">
                    {s.description}
                  </Text>
                )}
                <Text
                  size="xs"
                  ff="monospace"
                  c="dimmed"
                  px="xs"
                  py={6}
                  bg="var(--mantine-color-default-hover)"
                  style={{ wordBreak: 'break-all', borderRadius: 6 }}
                >
                  {s.type === 'http'
                    ? s.url
                    : s.type === 'managed'
                      ? `${s.image}: ${[s.command, ...s.args].join(' ')}`
                      : [s.command, ...s.args].join(' ')}
                </Text>
                {s.discovery?.error && (
                  <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                    {s.discovery.error}
                  </Text>
                )}
                <Group gap="xs" mt={4}>
                  <Tip label="Starts the server and lists the tools it offers">
                    <Button
                      size="xs"
                      variant="light"
                      disabled={testing !== null}
                      onClick={() =>
                        void act(async () => {
                          setTesting(s.id);
                          try {
                            await discoverMcp(s.id);
                          } finally {
                            setTesting(null);
                            await refresh();
                          }
                        })
                      }
                    >
                      Test connection
                    </Button>
                  </Tip>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => setMode({ kind: 'edit', id: s.id })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() => {
                      if (confirm(`Delete "${s.name}" from the library and from every project?`)) {
                        void act(async () => {
                          await deleteMcpServer(s.id);
                          await refresh();
                        });
                      }
                    }}
                  >
                    Delete
                  </Button>
                </Group>
                {s.discovery && s.discovery.tools.length > 0 && (
                  <Collapsible
                    defaultOpen={false}
                    title={`Tools shown to the model by default (${
                      s.discovery.tools.length - s.defaultHidden.length
                    } of ${s.discovery.tools.length})`}
                  >
                    <McpToolList
                      tools={s.discovery.tools}
                      hidden={s.defaultHidden}
                      onChange={(hidden) => {
                        // Optimistic: show the new state at once, then reconcile with the server.
                        setServers((cur) =>
                          cur.map((x) => (x.id === s.id ? { ...x, defaultHidden: hidden } : x)),
                        );
                        void act(async () => {
                          await setMcpDefaultHidden(s.id, hidden);
                          await refresh();
                        });
                      }}
                    />
                  </Collapsible>
                )}
              </Stack>
            )}
          </Card>
        ))}
        {servers.length === 0 && mode.kind === 'none' && (
          <EmptyState icon={IconPlug} title="No servers yet">
            Pick a starter above, or add your own. Then switch servers on per project.
          </EmptyState>
        )}
      </Stack>

      {mode.kind === 'none' && reaPreset && (
        <ReaBuilder onAdd={() => setMode({ kind: 'form', preset: reaPreset.server })} />
      )}
    </Stack>
  );
}
