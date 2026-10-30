import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  Group,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  createProvider,
  deleteProvider,
  discoverModels,
  listProviders,
  updateProvider,
  type Provider,
  type ProviderKind,
} from './api.js';
import { ErrorText } from './ui.js';

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
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
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
        <ErrorText error={error} />
        <Group gap="xs">
          <Button type="submit" disabled={busy || !name.trim()}>
            {initial ? 'Save' : 'Add provider'}
          </Button>
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
      <Title order={2}>Providers</Title>
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
                  <Button size="xs" variant="subtle" onClick={() => setEditing(p.id)}>
                    Edit
                  </Button>
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
