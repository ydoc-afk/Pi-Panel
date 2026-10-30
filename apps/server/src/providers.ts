import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Secrets } from './secrets.js';

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * anthropic and openai map to pi's built-in providers (credentials via ANTHROPIC_API_KEY /
 * OPENAI_API_KEY, model catalog from pi). openai-compatible covers llama.cpp, Unsloth Studio and any
 * other server speaking the OpenAI chat-completions API; it is written to models.json.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible';
const KINDS: readonly ProviderKind[] = ['anthropic', 'openai', 'openai-compatible'];
const BUILTIN_KEY_ENV: Partial<Record<ProviderKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};
const DEFAULT_BASE: Record<'anthropic' | 'openai', string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const DISCOVER_TIMEOUT_MS = 10_000;

interface ProviderRow {
  id: number;
  name: string;
  kind: ProviderKind;
  pi_key: string;
  base_url: string | null;
  api_key_enc: string | null;
  models: string;
  created_at: number;
}

export interface Provider {
  id: number;
  name: string;
  kind: ProviderKind;
  piKey: string;
  baseUrl: string | null;
  hasKey: boolean;
  models: string[];
  warning?: string;
}

interface Input {
  kind?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function cleanBaseUrl(value: unknown): string | null {
  if (value === null || value === '' || value === undefined) return null;
  if (typeof value !== 'string') throw new ProviderError(400, 'baseUrl must be a string');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderError(400, 'baseUrl must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError(400, 'baseUrl must be a valid http(s) URL');
  }
  return url.toString().replace(/\/+$/, '');
}

function cleanModels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ProviderError(400, 'models must be an array of strings');
  const out = value.map((m) => (typeof m === 'string' ? m.trim() : ''));
  if (out.length > 1000 || out.some((m) => !m || m.length > 200)) {
    throw new ProviderError(400, 'models must be non-empty strings up to 200 characters');
  }
  return [...new Set(out)];
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

type Fetch = typeof fetch;

export class ProviderStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: Secrets,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private row(id: number): ProviderRow {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      ProviderRow | undefined;
    if (!row) throw new ProviderError(404, 'Provider not found');
    return row;
  }

  private toProvider(r: ProviderRow): Provider {
    const p: Provider = {
      id: r.id,
      name: r.name,
      kind: r.kind,
      piKey: r.pi_key,
      baseUrl: r.base_url,
      hasKey: r.api_key_enc !== null,
      models: JSON.parse(r.models) as string[],
    };
    if (r.base_url && LOCAL_HOSTS.has(new URL(r.base_url).hostname)) {
      p.warning =
        'localhost inside the sandbox container is not your machine. Use host.docker.internal to reach a server on the Docker host.';
    }
    return p;
  }

  list(): Provider[] {
    return (
      this.db.prepare('SELECT * FROM providers ORDER BY id').all() as unknown as ProviderRow[]
    ).map((r) => this.toProvider(r));
  }

  find(id: number): Provider | undefined {
    const r = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      ProviderRow | undefined;
    return r ? this.toProvider(r) : undefined;
  }

  get(id: number): Provider {
    return this.toProvider(this.row(id));
  }

  create(input: Input): Provider {
    const kind = input.kind as ProviderKind;
    if (!KINDS.includes(kind))
      throw new ProviderError(400, `kind must be one of ${KINDS.join(', ')}`);
    if (typeof input.name !== 'string' || !NAME_RE.test(input.name.trim())) {
      throw new ProviderError(
        400,
        'Name must be 1-64 characters: letters, digits, spaces, dots, dashes, underscores',
      );
    }
    const name = input.name.trim();
    const baseUrl = cleanBaseUrl(input.baseUrl);
    if (kind === 'openai-compatible' && !baseUrl) {
      throw new ProviderError(400, 'baseUrl is required for OpenAI-compatible providers');
    }
    const models = input.models === undefined ? [] : cleanModels(input.models);
    const apiKey = this.cleanKey(input.apiKey);

    let piKey: string = kind;
    if (kind === 'openai-compatible') {
      // Prefixed so a custom provider can never shadow one of pi's built-in provider ids.
      piKey = `pp-${slug(name)}`;
      if (piKey === 'pp-') throw new ProviderError(400, 'Name must contain a letter or digit');
    } else if (this.db.prepare('SELECT 1 FROM providers WHERE kind = ?').get(kind)) {
      throw new ProviderError(409, `An ${kind} provider already exists`);
    }
    if (this.db.prepare('SELECT 1 FROM providers WHERE name = ? OR pi_key = ?').get(name, piKey)) {
      throw new ProviderError(409, 'A provider with that name already exists');
    }
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO providers (name, kind, pi_key, base_url, api_key_enc, models, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          kind,
          piKey,
          baseUrl,
          apiKey ? this.secrets.encrypt(apiKey) : null,
          JSON.stringify(models),
          Date.now(),
        ).lastInsertRowid,
    );
    return this.get(id);
  }

  /** `apiKey` undefined keeps the stored key, null clears it, a string replaces it. */
  update(id: number, input: Input): Provider {
    const row = this.row(id);
    const baseUrl = input.baseUrl === undefined ? row.base_url : cleanBaseUrl(input.baseUrl);
    if (row.kind === 'openai-compatible' && !baseUrl) {
      throw new ProviderError(400, 'baseUrl is required for OpenAI-compatible providers');
    }
    let name = row.name;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !NAME_RE.test(input.name.trim())) {
        throw new ProviderError(400, 'Invalid name');
      }
      name = input.name.trim();
      if (
        name !== row.name &&
        this.db.prepare('SELECT 1 FROM providers WHERE name = ? AND id != ?').get(name, id)
      ) {
        throw new ProviderError(409, 'A provider with that name already exists');
      }
    }
    const models =
      input.models === undefined ? row.models : JSON.stringify(cleanModels(input.models));
    const key = this.cleanKey(input.apiKey);
    const keyEnc =
      input.apiKey === undefined ? row.api_key_enc : key ? this.secrets.encrypt(key) : null;
    // pi_key stays fixed so existing sessions keep pointing at the same pi provider id.
    this.db
      .prepare(
        'UPDATE providers SET name = ?, base_url = ?, api_key_enc = ?, models = ? WHERE id = ?',
      )
      .run(name, baseUrl, keyEnc, models, id);
    return this.get(id);
  }

  delete(id: number) {
    this.row(id);
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  private cleanKey(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 4096)
      throw new ProviderError(400, 'Invalid apiKey');
    return value;
  }

  private apiKey(id: number): string | null {
    const enc = this.row(id).api_key_enc;
    return enc ? this.secrets.decrypt(enc) : null;
  }

  /** Environment variables that give a pi process access to this provider's key (and only it). */
  envFor(id: number): Record<string, string> {
    const row = this.row(id);
    const key = this.apiKey(id);
    if (!key) return {};
    return { [BUILTIN_KEY_ENV[row.kind] ?? `PP_KEY_${id}`]: key };
  }

  /** models.json content for pi. It never contains keys, only $ENV references. */
  modelsJson(): object {
    const providers: Record<string, unknown> = {};
    for (const r of this.db
      .prepare('SELECT * FROM providers ORDER BY id')
      .all() as unknown as ProviderRow[]) {
      if (r.kind === 'openai-compatible') {
        const models = (JSON.parse(r.models) as string[]).map((id) => ({ id }));
        if (models.length === 0) continue;
        providers[r.pi_key] = {
          name: r.name,
          baseUrl: r.base_url,
          api: 'openai-completions',
          // pi only offers a provider that has a key; servers that ignore auth get a placeholder.
          apiKey: r.api_key_enc ? `$PP_KEY_${r.id}` : 'none',
          models,
        };
      } else if (r.base_url) {
        providers[r.pi_key] = { baseUrl: r.base_url };
      }
    }
    return { $schema: 'https://pi.dev/schemas/models.schema.json', providers };
  }

  /** Fetches the provider's model list from its API and stores it. */
  async discover(id: number): Promise<string[]> {
    const row = this.row(id);
    const key = this.apiKey(id);
    let url: string;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (row.kind === 'anthropic') {
      if (!key) throw new ProviderError(400, 'An API key is required to list Anthropic models');
      url = `${row.base_url ?? DEFAULT_BASE.anthropic}/v1/models?limit=1000`;
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      if (row.kind === 'openai' && !key)
        throw new ProviderError(400, 'An API key is required to list OpenAI models');
      url = `${row.base_url ?? DEFAULT_BASE.openai}/models`;
      if (key) headers.authorization = `Bearer ${key}`;
    }
    let body: unknown;
    try {
      // Redirects are refused so credentials are never replayed to another host.
      const res = await this.fetchFn(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      });
      if (!res.ok) throw new ProviderError(502, `Provider returned HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(502, `Could not reach ${new URL(url).origin}`);
    }
    const list =
      (body as { data?: unknown; models?: unknown } | null)?.data ??
      (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(list)) throw new ProviderError(502, 'Unexpected response from /models');
    const ids = list
      .map((m) =>
        typeof m === 'string'
          ? m
          : ((m as { id?: unknown; name?: unknown; model?: unknown })?.id ??
            (m as { name?: unknown })?.name ??
            (m as { model?: unknown })?.model),
      )
      .filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 200);
    const models = [...new Set(ids)];
    this.db.prepare('UPDATE providers SET models = ? WHERE id = ?').run(JSON.stringify(models), id);
    return models;
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerProviders(app: FastifyInstance, store: ProviderStore) {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);

  app.get('/api/providers', async () => ({ providers: store.list() }));

  app.post('/api/providers', (req, reply) =>
    handle(reply, () =>
      reply.code(201).send({ provider: store.create((req.body ?? {}) as Input) }),
    ),
  );

  app.put<{ Params: { id: string } }>('/api/providers/:id', (req, reply) =>
    handle(reply, () => ({ provider: store.update(id(req.params.id), (req.body ?? {}) as Input) })),
  );

  app.delete<{ Params: { id: string } }>('/api/providers/:id', (req, reply) =>
    handle(reply, () => {
      store.delete(id(req.params.id));
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: { id: string } }>('/api/providers/:id/discover', (req, reply) =>
    handle(reply, async () => {
      const n = id(req.params.id);
      await store.discover(n);
      return { provider: store.get(n) };
    }),
  );
}
