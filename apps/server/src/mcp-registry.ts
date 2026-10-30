import type { FastifyInstance } from 'fastify';

/**
 * Search the official MCP registry (registry.modelcontextprotocol.io) so servers can be added from the
 * panel. Only what can run here is offered: npm packages over stdio, and remote streamable-HTTP
 * endpoints. Everything else is listed but cannot be added yet.
 */

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const REGISTRY_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 20;
const LATEST = 'io.modelcontextprotocol.registry/official';

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

export type RegistryInstall =
  | { kind: 'npm'; identifier: string; version: string; env: RegistryEnvVar[] }
  | { kind: 'remote'; url: string };

export interface RegistryItem {
  name: string;
  title: string;
  description: string;
  version: string;
  repository: string | null;
  install: RegistryInstall | null;
}

interface RawEntry {
  server?: {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    version?: unknown;
    repository?: { url?: unknown };
    packages?: {
      registryType?: unknown;
      identifier?: unknown;
      version?: unknown;
      transport?: { type?: unknown };
      environmentVariables?: RegistryEnvVar[];
    }[];
    remotes?: { type?: unknown; url?: unknown }[];
  };
  _meta?: Record<string, { isLatest?: unknown } | undefined>;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Maps one registry entry to what the panel can show and add. */
export function toItem(entry: RawEntry): RegistryItem | null {
  const s = entry.server;
  if (!s || typeof s.name !== 'string') return null;
  const pkg = (s.packages ?? []).find(
    (p) =>
      p.registryType === 'npm' &&
      (p.transport?.type ?? 'stdio') === 'stdio' &&
      typeof p.identifier === 'string' &&
      typeof p.version === 'string' &&
      p.version !== '',
  );
  const remote = (s.remotes ?? []).find(
    (r) => r.type === 'streamable-http' && typeof r.url === 'string' && /^https?:\/\//.test(r.url),
  );
  let install: RegistryInstall | null = null;
  if (pkg) {
    install = {
      kind: 'npm',
      identifier: str(pkg.identifier, 214),
      version: str(pkg.version, 64),
      env: (pkg.environmentVariables ?? [])
        .filter((e) => typeof e?.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name))
        .map((e) => ({
          name: e.name,
          description: str(e.description, 300) || undefined,
          isRequired: e.isRequired === true,
          isSecret: e.isSecret === true,
          default: str(e.default, 200) || undefined,
        })),
    };
  } else if (remote) {
    install = { kind: 'remote', url: str(remote.url, 2048) };
  }
  return {
    name: str(s.name, 200),
    title: str(s.title, 200) || str(s.name, 200),
    description: str(s.description, 500),
    version: str(s.version, 64),
    repository: typeof s.repository?.url === 'string' ? s.repository.url.slice(0, 500) : null,
    install,
  };
}

/** The registry lists every published version; keep only the latest of each server. */
const isLatest = (e: RawEntry) => e._meta?.[LATEST]?.isLatest !== false;

export function registerMcpRegistry(app: FastifyInstance, fetchFn: typeof fetch) {
  app.get<{ Querystring: { q?: string; cursor?: string } }>(
    '/api/mcp/registry',
    async (req, reply) => {
      const q = (req.query.q ?? '').trim().slice(0, 100);
      const cursor = (req.query.cursor ?? '').trim().slice(0, 300);
      const url = new URL(REGISTRY_URL);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (q) url.searchParams.set('search', q);
      if (cursor) url.searchParams.set('cursor', cursor);

      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        });
      } catch {
        return reply.code(502).send({ error: 'Could not reach the MCP registry' });
      }
      if (!res.ok)
        return reply.code(502).send({ error: `The MCP registry answered HTTP ${res.status}` });
      const body = (await res.json().catch(() => null)) as {
        servers?: RawEntry[];
        metadata?: { nextCursor?: unknown };
      } | null;
      if (!body || !Array.isArray(body.servers)) {
        return reply.code(502).send({ error: 'Unexpected response from the MCP registry' });
      }
      const items = body.servers
        .filter(isLatest)
        .map(toItem)
        .filter((i): i is RegistryItem => !!i);
      const nextCursor =
        typeof body.metadata?.nextCursor === 'string' ? body.metadata.nextCursor : null;
      return { items, nextCursor };
    },
  );
}
