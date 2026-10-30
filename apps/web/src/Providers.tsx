import { useEffect, useState, type FormEvent } from 'react';
import {
  createProvider,
  deleteProvider,
  discoverModels,
  listProviders,
  updateProvider,
  type Provider,
  type ProviderKind,
} from './api.js';

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
    <form onSubmit={submit} style={{ display: 'grid', gap: 8, maxWidth: 480, margin: '12px 0' }}>
      {!initial && (
        <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
          {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      )}
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        placeholder={
          compat
            ? 'Base URL, e.g. http://host.docker.internal:8080/v1'
            : 'Base URL (optional, e.g. a proxy)'
        }
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <input
        type="password"
        autoComplete="off"
        placeholder={
          initial?.hasKey
            ? 'API key (leave blank to keep the stored key)'
            : 'API key (optional for local servers)'
        }
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <input
        placeholder="Models, comma-separated (or use Discover after saving)"
        value={models}
        onChange={(e) => setModels(e.target.value)}
      />
      {error && (
        <p role="alert" style={{ color: 'crimson', margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy || !name.trim()}>{initial ? 'Save' : 'Add provider'}</button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
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
    <section>
      <h2>Providers</h2>
      <ProviderForm key={providers.length} onSaved={() => void refresh()} />
      {message && <p>{message}</p>}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 12 }}>
        {providers.map((p) => (
          <li key={p.id}>
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
              <div>
                <strong>{p.name}</strong> <small>({KIND_LABEL[p.kind]})</small>
                <div>
                  {p.baseUrl ?? 'default endpoint'} &middot; {p.hasKey ? 'key stored' : 'no key'}{' '}
                  &middot; {p.models.length} model{p.models.length === 1 ? '' : 's'}
                </div>
                {p.warning && <div style={{ color: 'darkorange' }}>{p.warning}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button
                    onClick={() =>
                      void act(async () => {
                        const updated = await discoverModels(p.id);
                        return `${p.name}: found ${updated.models.length} models`;
                      })
                    }
                  >
                    Discover models
                  </button>
                  <button onClick={() => setEditing(p.id)}>Edit</button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete provider "${p.name}"?`))
                        void act(() => deleteProvider(p.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
