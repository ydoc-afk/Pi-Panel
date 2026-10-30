import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMcpRegistry, toItem } from './mcp-registry.js';

const npmEntry = {
  server: {
    name: 'io.example/notes',
    title: 'Notes',
    description: 'Keep notes',
    version: '2.0.0',
    repository: { url: 'https://github.com/example/notes' },
    packages: [
      {
        registryType: 'npm',
        identifier: '@example/notes-mcp',
        version: '2.0.0',
        transport: { type: 'stdio' },
        environmentVariables: [
          { name: 'NOTES_TOKEN', isRequired: true, isSecret: true, description: 'API token' },
          { name: 'NOTES_DIR', default: '/workspace/notes' },
          { name: 'bad name!' },
        ],
      },
    ],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
};

const remoteEntry = {
  server: {
    name: 'io.example/remote',
    description: 'Hosted',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  },
};

const unsupportedEntry = {
  server: {
    name: 'io.example/docker-only',
    description: 'Docker only',
    version: '1.0.0',
    packages: [{ registryType: 'oci', identifier: 'example/img', version: '1.0.0' }],
  },
};

describe('toItem', () => {
  it('maps an npm stdio package to a pinned install and keeps only valid env names', () => {
    const item = toItem(npmEntry);
    expect(item).toMatchObject({
      name: 'io.example/notes',
      title: 'Notes',
      repository: 'https://github.com/example/notes',
      install: {
        kind: 'npm',
        identifier: '@example/notes-mcp',
        version: '2.0.0',
        env: [
          {
            name: 'NOTES_TOKEN',
            isRequired: true,
            isSecret: true,
            description: 'API token',
          },
          { name: 'NOTES_DIR', isRequired: false, isSecret: false, default: '/workspace/notes' },
        ],
      },
    });
  });

  it('maps a streamable-HTTP remote and leaves unsupported packages without an install', () => {
    expect(toItem(remoteEntry)?.install).toEqual({
      kind: 'remote',
      url: 'https://mcp.example.com/mcp',
    });
    expect(toItem(unsupportedEntry)?.install).toBeNull();
  });

  it('refuses entries without a name', () => {
    expect(toItem({ server: {} })).toBeNull();
  });
});

describe('GET /api/mcp/registry', () => {
  const registry = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  async function app(fetchFn: typeof fetch) {
    const a = Fastify();
    registerMcpRegistry(a, fetchFn);
    return a;
  }

  it('passes the search and cursor upstream and returns only the latest versions', async () => {
    const old = {
      ...npmEntry,
      _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } },
    };
    const upstream = registry({
      servers: [old, npmEntry, remoteEntry],
      metadata: { nextCursor: 'io.example/notes:2.0.0' },
    });
    const a = await app(upstream as unknown as typeof fetch);
    const res = await a.inject({ url: '/api/mcp/registry?q=notes&cursor=abc' });

    expect(res.statusCode).toBe(200);
    const url = new URL(String((upstream.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('search')).toBe('notes');
    expect(url.searchParams.get('cursor')).toBe('abc');
    expect(res.json().items.map((i: { name: string }) => i.name)).toEqual([
      'io.example/notes',
      'io.example/remote',
    ]);
    expect(res.json().nextCursor).toBe('io.example/notes:2.0.0');
  });

  it('reports upstream failures as 502', async () => {
    const down = (
      await app((async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch)
    ).inject({ url: '/api/mcp/registry' });
    expect((await down).statusCode).toBe(502);

    const bad = await app(registry({ nope: true }) as unknown as typeof fetch);
    expect((await bad.inject({ url: '/api/mcp/registry' })).statusCode).toBe(502);
  });
});
