import { useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  Grid,
  Group,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBrandOpenai,
  IconKey,
  IconLock,
  IconLockOpen,
  IconServer,
  IconSparkles,
} from '@tabler/icons-react';
import {
  createProvider,
  deleteProvider,
  discoverModels,
  listProviders,
  testProvider,
  updateProvider,
  type Provider,
  type ProviderKind,
} from './api.js';
import { EmptyState, ErrorText, PageHeader, Tip } from './ui.js';
import { timeAgo } from './dashboard/charts.js';

// Mirrors the server's rule for provider names.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const KIND_ICON = {
  anthropic: IconSparkles,
  openai: IconBrandOpenai,
  'openai-compatible': IconServer,
} as const;

/** How many model names to show on a provider card before summarising the rest. */
const MODEL_PREVIEW = 6;

const KIND_LABEL: Record<ProviderKind, string> = {
  'openai-compatible': 'OpenAI-compatible (llama.cpp, Unsloth Studio, ...)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function ProviderForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Provider;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? 'openai-compatible');
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(initial?.models.join(', ') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; count: number } | { ok: false; message: string } | null
  >(null);

  // Uses the settings in the form and checks them against the server. Nothing is saved.
  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const found = await testProvider({
        kind: initial?.kind ?? kind,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(initial ? { providerId: initial.id } : {}),
      });
      setTestResult({ ok: true, count: found.length });
      // Fill the model list from the server only when it is still empty, so typed values stay.
      if (!models.trim()) setModels(found.join(', '));
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const list = models
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    try {
      if (initial) {
        await updateProvider(initial.id, {
          name,
          baseUrl,
          models: list,
          ...(apiKey ? { apiKey } : {}),
        });
      } else {
        await createProvider({ kind, name, baseUrl, models: list, ...(apiKey ? { apiKey } : {}) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const compat = (initial?.kind ?? kind) === 'openai-compatible';
  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        {!initial && (
          <Select
            aria-label="Provider type"
            allowDeselect={false}
            value={kind}
            data={(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => ({
              value: k,
              label: KIND_LABEL[k],
            }))}
            onChange={(v) => v && setKind(v as ProviderKind)}
          />
        )}
        <TextInput
          label="Name"
          description="Letters, digits, spaces, dots, dashes and underscores, up to 64 characters"
          error={
            name && !NAME_RE.test(name.trim())
              ? 'Name has characters that are not allowed'
              : undefined
          }
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label="Base URL"
          placeholder={compat ? 'http://host.docker.internal:8080/v1' : 'Optional, e.g. a proxy'}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
        />
        <PasswordInput
          label="API key"
          autoComplete="off"
          placeholder={
            initial?.hasKey ? 'Leave blank to keep the stored key' : 'Optional for local servers'
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />
        <TextInput
          label="Models"
          description="Comma-separated, or use Discover models after saving"
          value={models}
          onChange={(e) => setModels(e.currentTarget.value)}
        />
        {testResult &&
          (testResult.ok ? (
            <Text size="sm" c="green">
              Connected: found {testResult.count} model{testResult.count === 1 ? '' : 's'}.
            </Text>
          ) : (
            <Text size="sm" c="red">
              {testResult.message}
            </Text>
          ))}
        <ErrorText error={error} />
        <Group gap="xs">
          <Button type="submit" disabled={busy || !NAME_RE.test(name.trim())}>
            {initial ? 'Save' : 'Add provider'}
          </Button>
          <Tip label="Checks the address and key, and lists the models it offers">
            <Button variant="default" loading={testing} onClick={() => void testConnection()}>
              Test connection
            </Button>
          </Tip>
          {onCancel && (
            <Button type="button" variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Group>
      </Stack>
    </form>
  );
}

export function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = () =>
    listProviders()
      .then(setProviders)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, []);

  async function act(action: () => Promise<string | void>) {
    setError('');
    setMessage('');
    try {
      const msg = await action();
      if (msg) setMessage(msg);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  return (
    <Stack gap="lg">
      <PageHeader
        icon={IconKey}
        title="Providers"
        description="Where the agent gets its models. Keys are stored encrypted and never shown again."
      />
      {message && <Text size="sm">{message}</Text>}
      <ErrorText error={error} />
      <Grid gap="lg" align="flex-start">
        <Grid.Col span={{ base: 12, lg: 7 }} order={{ base: 2, lg: 1 }}>
          <Stack gap="md">
            {providers.length === 0 && (
              <EmptyState icon={IconKey} title="No providers yet">
                Add Anthropic, OpenAI, or any OpenAI-compatible server so sessions have a model to
                talk to.
              </EmptyState>
            )}
            {providers.map((p) => {
              const KindIcon = KIND_ICON[p.kind];
              return (
                <Card key={p.id} padding="lg">
                  {editing === p.id ? (
                    <ProviderForm
                      initial={p}
                      onCancel={() => setEditing(null)}
                      onSaved={() => {
                        setEditing(null);
                        void refresh();
                      }}
                    />
                  ) : (
                    <Stack gap="sm">
                      <Group justify="space-between" wrap="nowrap" align="flex-start">
                        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                          <ThemeIcon variant="light" size={40} radius="md">
                            <KindIcon size={22} stroke={1.6} />
                          </ThemeIcon>
                          <Stack gap={0} style={{ minWidth: 0 }}>
                            <Text fw={650} truncate>
                              {p.name}
                            </Text>
                            <Text size="sm" c="dimmed" truncate>
                              {KIND_LABEL[p.kind]}
                            </Text>
                          </Stack>
                        </Group>
                        <Badge
                          variant="light"
                          color={p.hasKey ? 'green' : 'gray'}
                          leftSection={
                            p.hasKey ? <IconLock size={12} /> : <IconLockOpen size={12} />
                          }
                        >
                          {p.hasKey ? 'Key stored' : 'No key'}
                        </Badge>
                      </Group>
                      <Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
                        {p.baseUrl ?? 'Default endpoint'}
                      </Text>
                      <Group gap={6}>
                        {p.models.length === 0 ? (
                          <Text size="sm" c="dimmed">
                            No models yet. Use Discover models.
                          </Text>
                        ) : (
                          <>
                            {p.models.slice(0, MODEL_PREVIEW).map((m) => (
                              <Badge key={m} variant="default" tt="none" fw={500}>
                                {m}
                              </Badge>
                            ))}
                            {p.models.length > MODEL_PREVIEW && (
                              <Tip label={p.models.slice(MODEL_PREVIEW).join(', ')}>
                                <Badge variant="outline" color="gray" tt="none" fw={500}>
                                  +{p.models.length - MODEL_PREVIEW} more
                                </Badge>
                              </Tip>
                            )}
                          </>
                        )}
                      </Group>
                      {p.health && (
                        <Group gap={6} wrap="nowrap" c="red" align="flex-start">
                          <IconAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                          <Text size="sm" c="red">
                            {p.health.message}{' '}
                            <Text span size="xs" c="dimmed">
                              ({timeAgo(p.health.at)})
                            </Text>
                          </Text>
                        </Group>
                      )}
                      {p.warning && (
                        <Group gap={6} wrap="nowrap" c="orange">
                          <IconAlertTriangle size={16} style={{ flexShrink: 0 }} />
                          <Text size="sm" c="orange">
                            {p.warning}
                          </Text>
                        </Group>
                      )}
                      <Group gap="xs" mt={4}>
                        <Tip label="Ask the provider which models it serves">
                          <Button
                            size="xs"
                            variant="light"
                            onClick={() =>
                              void act(async () => {
                                const updated = await discoverModels(p.id);
                                return `${p.name}: found ${updated.models.length} models`;
                              })
                            }
                          >
                            Discover models
                          </Button>
                        </Tip>
                        <Tip label="Change the address, key or models">
                          <Button size="xs" variant="default" onClick={() => setEditing(p.id)}>
                            Edit
                          </Button>
                        </Tip>
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          onClick={() => {
                            if (confirm(`Delete provider "${p.name}"?`))
                              void act(() => deleteProvider(p.id));
                          }}
                        >
                          Delete
                        </Button>
                      </Group>
                    </Stack>
                  )}
                </Card>
              );
            })}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }} order={{ base: 1, lg: 2 }}>
          <Card padding="lg" style={{ position: 'sticky', top: 80 }}>
            <Stack gap="md">
              <div>
                <Text fw={650}>Add a provider</Text>
                <Text size="sm" c="dimmed">
                  Test the connection first to fill in the models it offers.
                </Text>
              </div>
              <ProviderForm key={providers.length} onSaved={() => void refresh()} />
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
