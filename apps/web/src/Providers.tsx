import { useEffect, useState, type FormEvent } from 'react';
import { Button, Group, Paper, PasswordInput, Select, Stack, Text, TextInput } from '@mantine/core';
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
import { ErrorText, PageHeader, Tip } from './ui.js';

// Mirrors the server's rule for provider names.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

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
    <Stack>
      <PageHeader
        title="Providers"
        description="Where the agent gets its models. Keys are stored encrypted and never shown again."
      />
      <Paper withBorder p="md" radius="md" maw={560}>
        <ProviderForm key={providers.length} onSaved={() => void refresh()} />
      </Paper>
      {message && <Text size="sm">{message}</Text>}
      <ErrorText error={error} />
      <Stack gap="sm">
        {providers.map((p) => (
          <Paper key={p.id} withBorder p="md" radius="md">
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
              <Stack gap={4}>
                <Group gap="xs">
                  <Text fw={600}>{p.name}</Text>
                  <Text size="sm" c="dimmed">
                    {KIND_LABEL[p.kind]}
                  </Text>
                </Group>
                <Text size="sm" c="dimmed">
                  {p.baseUrl ?? 'default endpoint'} · {p.hasKey ? 'key stored' : 'no key'} ·{' '}
                  {p.models.length} model{p.models.length === 1 ? '' : 's'}
                </Text>
                {p.warning && (
                  <Text size="sm" c="orange">
                    {p.warning}
                  </Text>
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
                    <Button size="xs" variant="subtle" onClick={() => setEditing(p.id)}>
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
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
