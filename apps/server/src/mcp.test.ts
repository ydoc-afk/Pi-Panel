import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { convertImport, redactValues, sanitizeDiscovery } from './mcp.js';
import { MCP_PRESETS } from './mcp-presets.js';
import { FakeRuntime, type EphemeralSpec, type ExecResult } from './runtime.js';

const SECRET = 'sekret-value-123';
const report = (body: object) =>
  `x\n@@PI_MCP_REPORT_BEGIN@@\n${JSON.stringify(body)}\n@@PI_MCP_REPORT_END@@\n`;

async function setup(opts: { maxConcurrent?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-mcp-'));
  const runtime = new FakeRuntime();
  const db = openDb(':memory:');
  const app = buildApp({ db, runtime, dataDir, mcp: { maxConcurrent: opts.maxConcurrent } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
  const agentFile = (name: string, projectId = project.id) =>
    join(dataDir, 'agents', String(projectId), name);
  return { app, db, runtime, dataDir, call, project, agentFile };
}

const stdio = (extra: Record<string, unknown> = {}) => ({
  name: 'spike',
  type: 'stdio',
  command: 'node',
  args: ['server.mjs'],
  env: [
    { key: 'GREETING', value: 'hello', secret: false },
    { key: 'API_TOKEN', value: SECRET, secret: true },
  ],
  ...extra,
});

describe('mcp', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  const create = (payload: Record<string, unknown>) => t.call('POST', '/api/mcp/servers', payload);
  const make = async (payload: Record<string, unknown> = stdio()) =>
    (await create(payload)).json().server;
  const enable = (serverId: number, change: Record<string, unknown> = { enabled: true }) =>
    t.call('PUT', `/api/projects/${t.project.id}/mcp/${serverId}`, change);
  const newSession = async () =>
    (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json().session;
  const prompt = (id: number, message = 'hi') =>
    t.call('POST', `/api/sessions/${id}/prompt`, { message });
  const status = async (id: number) =>
    (await t.call('GET', `/api/sessions/${id}`)).json().session.status;
  const until = async (cond: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition not met in time');
  };

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: '/api/mcp/servers' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: `/api/projects/${t.project.id}/mcp` })).statusCode).toBe(401);
  });

  describe('library', () => {
    it('stores secrets encrypted and never returns them', async () => {
      const res = await create(stdio());
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(SECRET);
      expect(res.json().server.env).toEqual([
        { key: 'GREETING', secret: false, value: 'hello', hasValue: true },
        { key: 'API_TOKEN', secret: true, hasValue: true },
      ]);
      expect((await t.call('GET', '/api/mcp/servers')).body).not.toContain(SECRET);
      const raw = t.db.prepare('SELECT env FROM mcp_servers').get() as { env: string };
      expect(raw.env).not.toContain(SECRET);
    });

    it('accepts http servers with secret headers', async () => {
      const res = await create({
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: [{ key: 'Authorization', value: `Bearer ${SECRET}`, secret: true }],
      });
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(SECRET);
      expect(res.json().server).toMatchObject({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        command: null,
      });
    });

    it('validates input', async () => {
      const bad: Record<string, unknown>[] = [
        stdio({ name: '' }),
        stdio({ name: 'has space' }),
        stdio({ name: '../x' }),
        stdio({ type: undefined }),
        stdio({ type: 'sse' }),
        stdio({ command: '' }),
        stdio({ args: 'not-an-array' }),
        stdio({ args: [1] }),
        stdio({ url: 'https://x.test' }),
        stdio({ timeout: 0 }),
        stdio({ timeout: 1.5 }),
        stdio({ timeout: 601 }),
        stdio({ exposure: 'everywhere' }),
        stdio({ env: [{ key: '1BAD', value: 'x' }] }),
        stdio({
          env: [
            { key: 'A', value: 'x' },
            { key: 'A', value: 'y' },
          ],
        }),
        stdio({ env: [{ key: 'S', secret: true }] }),
        stdio({ env: [{ key: 'A', value: 5 }] }),
        stdio({ description: 'x'.repeat(301) }),
        { name: 'h', type: 'http', url: 'ftp://x' },
        { name: 'h', type: 'http', url: 'not a url' },
        { name: 'h', type: 'http', url: 'https://x.test', command: 'node' },
        {
          name: 'h',
          type: 'http',
          url: 'https://x.test',
          headers: [{ key: 'bad header', value: 'x' }],
        },
      ];
      for (const payload of bad)
        expect((await create(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    });

    it('treats names that differ only in - and _ (or case) as the same server', async () => {
      expect((await create(stdio({ name: 'my-server' }))).statusCode).toBe(201);
      for (const name of ['my-server', 'my_server', 'MY_SERVER']) {
        expect((await create(stdio({ name }))).statusCode).toBe(409);
      }
    });

    it('keeps a secret when its value is omitted on update, and replaces it when given', async () => {
      const s = await make();
      const kept = await t.call('PUT', `/api/mcp/servers/${s.id}`, {
        env: [
          { key: 'API_TOKEN', secret: true },
          { key: 'EXTRA', value: '1' },
        ],
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json().server.env.map((e: { key: string }) => e.key)).toEqual([
        'API_TOKEN',
        'EXTRA',
      ]);
      await enable(s.id);
      await prompt((await newSession()).id);
      expect(t.runtime.execs[0]!.env!['PP_MCP_1_E_API_TOKEN']).toBe(SECRET);

      await t.call('PUT', `/api/mcp/servers/${s.id}`, {
        env: [{ key: 'API_TOKEN', secret: true, value: 'rotated-value' }],
      });
      const second = await newSession();
      await prompt(second.id);
      expect(t.runtime.execs.at(-1)!.env!['PP_MCP_1_E_API_TOKEN']).toBe('rotated-value');
    });

    it('forbids changing the name or type, and 404s for unknown servers', async () => {
      const s = await make();
      expect((await t.call('PUT', `/api/mcp/servers/${s.id}`, { name: 'other' })).statusCode).toBe(
        400,
      );
      expect(
        (await t.call('PUT', `/api/mcp/servers/${s.id}`, { type: 'http', url: 'https://x.test' }))
          .statusCode,
      ).toBe(400);
      expect((await t.call('PUT', '/api/mcp/servers/999', { description: 'x' })).statusCode).toBe(
        404,
      );
      expect((await t.call('DELETE', '/api/mcp/servers/999')).statusCode).toBe(404);
    });

    it('forgets discovered tools when the launch target changes', async () => {
      const s = await make();
      t.runtime.ephemeralHandler = () => ({
        code: 0,
        stdout: report({ state: 'connected', tools: [{ name: 'a' }] }),
        stderr: '',
        timedOut: false,
      });
      await t.call('POST', `/api/mcp/servers/${s.id}/discover`);
      expect(
        (await t.call('PUT', `/api/mcp/servers/${s.id}`, { description: 'new text' })).json().server
          .discovery,
      ).not.toBeNull();
      expect(
        (await t.call('PUT', `/api/mcp/servers/${s.id}`, { args: ['other.mjs'] })).json().server
          .discovery,
      ).toBeNull();
    });

    it('offers presets that are valid and pinned', async () => {
      const presets = (await t.call('GET', '/api/mcp/presets')).json()
        .presets as typeof MCP_PRESETS;
      expect(presets.map((p) => p.id)).toEqual(
        expect.arrayContaining(['memory', 'filesystem', 'rea', 'firecrawl']),
      );
      for (const p of presets) {
        expect((await create({ ...p.server, name: `${p.id}-copy` })).statusCode, p.id).toBe(201);
        if (p.server.type === 'managed') {
          expect(p.server.image, `${p.id} should pin an image tag`).toMatch(/:\d+\.\d+\.\d+$/);
        } else {
          const pkg = (p.server.args as string[]).find(
            (a) => /^@?[a-z][\w./-]*(@[\w.-]+)?$/.test(a) && a !== '-y',
          );
          expect(pkg, `${p.id} should pin a version`).toMatch(/@\d+\.\d+\.\d+$/);
        }
      }
    });
  });

  describe('per project', () => {
    it('writes a value-free mcp.json and passes values through the environment', async () => {
      const s = await make(
        stdio({
          exposure: 'deferred',
          timeout: 90,
          description: 'Spike server',
          cwd: '/workspace',
        }),
      );
      expect((await enable(s.id)).statusCode).toBe(200);
      await prompt((await newSession()).id);

      const text = readFileSync(t.agentFile('mcp.json'), 'utf8');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('hello');
      expect(JSON.parse(text)).toEqual({
        mcpServers: {
          spike: {
            description: 'Spike server',
            timeout: 90,
            exposure: 'deferred',
            command: 'node',
            args: ['server.mjs'],
            cwd: '/workspace',
            env: { GREETING: '${PP_MCP_1_E_GREETING}', API_TOKEN: '${PP_MCP_1_E_API_TOKEN}' },
          },
        },
      });
      expect(t.runtime.execs[0]!.env).toMatchObject({
        PI_CODING_AGENT_DIR: '/home/sandbox/.pi/agent',
        PP_MCP_1_E_GREETING: 'hello',
        PP_MCP_1_E_API_TOKEN: SECRET,
      });
    });

    it('maps http headers to env references and keeps values out of the file', async () => {
      const s = await make({
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: [
          { key: 'Authorization', value: `Bearer ${SECRET}`, secret: true },
          { key: 'X-Team', value: 'blue' },
        ],
      });
      await enable(s.id);
      await prompt((await newSession()).id);
      const text = readFileSync(t.agentFile('mcp.json'), 'utf8');
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text).mcpServers.remote).toEqual({
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: '${PP_MCP_1_H_0}', 'X-Team': '${PP_MCP_1_H_1}' },
      });
      expect(t.runtime.execs[0]!.env).toMatchObject({
        PP_MCP_1_H_0: `Bearer ${SECRET}`,
        PP_MCP_1_H_1: 'blue',
      });
    });

    it('includes only enabled servers and their own variables', async () => {
      const a = await make(stdio({ name: 'one' }));
      const b = await make(stdio({ name: 'two', env: [{ key: 'ONLY_TWO', value: 'x' }] }));
      await enable(a.id);
      await prompt((await newSession()).id);
      expect(
        Object.keys(JSON.parse(readFileSync(t.agentFile('mcp.json'), 'utf8')).mcpServers),
      ).toEqual(['one']);
      expect(
        Object.keys(t.runtime.execs[0]!.env!).some((k) => k.startsWith(`PP_MCP_${b.id}_`)),
      ).toBe(false);
    });

    it('writes an empty config when nothing is enabled, replacing stale content', async () => {
      const s = await make();
      await enable(s.id);
      const session = await newSession();
      await prompt(session.id);
      expect(
        Object.keys(JSON.parse(readFileSync(t.agentFile('mcp.json'), 'utf8')).mcpServers),
      ).toEqual(['spike']);
      await until(async () => (await status(session.id)) === 'idle');
      await enable(s.id, { enabled: false });
      await prompt(session.id, 'again');
      expect(JSON.parse(readFileSync(t.agentFile('mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
    });

    it('hides tools via toolExposure, preferring a project override over the server default', async () => {
      const s = await make();
      await t.call('PUT', `/api/mcp/servers/${s.id}/hidden`, { hidden: ['wipe', 'glob*'] });
      await enable(s.id);
      await prompt((await newSession()).id);
      // "*" is a pattern in pi, so tools whose names contain one are never emitted
      expect(
        JSON.parse(readFileSync(t.agentFile('mcp.json'), 'utf8')).mcpServers.spike.toolExposure,
      ).toEqual({ wipe: 'hidden' });

      const list = (await t.call('GET', `/api/projects/${t.project.id}/mcp`)).json().servers[0];
      expect(list).toMatchObject({
        enabled: true,
        hiddenOverride: null,
        hiddenTools: ['wipe', 'glob*'],
      });

      await enable(s.id, { hiddenTools: ['echo'] });
      const after = (await t.call('GET', `/api/projects/${t.project.id}/mcp`)).json().servers[0];
      expect(after).toMatchObject({ hiddenOverride: ['echo'], hiddenTools: ['echo'] });
      await enable(s.id, { hiddenTools: null });
      expect(
        (await t.call('GET', `/api/projects/${t.project.id}/mcp`)).json().servers[0].hiddenOverride,
      ).toBeNull();
    });

    it('validates project changes', async () => {
      const s = await make();
      expect((await enable(s.id, { enabled: 'yes' })).statusCode).toBe(400);
      expect((await enable(s.id, { hiddenTools: 'wipe' })).statusCode).toBe(400);
      expect((await enable(s.id, { hiddenTools: [''] })).statusCode).toBe(400);
      expect((await enable(999)).statusCode).toBe(404);
      expect(
        (await t.call('PUT', `/api/projects/999/mcp/${s.id}`, { enabled: true })).statusCode,
      ).toBe(404);
      expect((await t.call('GET', '/api/projects/999/mcp')).statusCode).toBe(404);
    });

    it('restarts idle sessions when a server is toggled and reports running ones as pending', async () => {
      const s = await make();
      const idle = await newSession();
      await prompt(idle.id);
      await until(async () => (await status(idle.id)) === 'idle');
      const proc = t.runtime.processes.find((p) => p.args[0] === '--mode')!;
      const res = await enable(s.id);
      expect(res.json()).toMatchObject({ restartedSessions: 1, pendingSessions: 0 });
      expect(proc.exited).toBe(true);

      const busy = await newSession();
      await prompt(busy.id, '/hang');
      await until(async () => (await status(busy.id)) === 'running');
      const busyProc = t.runtime.processes.filter((p) => p.args[0] === '--mode').at(-1)!;
      expect((await enable(s.id, { enabled: false })).json()).toMatchObject({ pendingSessions: 1 });
      // the running session keeps its process until the run settles, then is replaced
      expect(busyProc.exited).toBe(false);
      await t.call('POST', `/api/sessions/${busy.id}/abort`);
      await until(() => busyProc.exited);
      expect(await status(busy.id)).toBe('idle');
      expect((await prompt(busy.id, 'after')).statusCode).toBe(200);
      expect(t.runtime.processes.filter((p) => p.args[0] === '--mode').length).toBeGreaterThan(2);
    });

    it('detaches a deleted server from projects and restarts their idle sessions', async () => {
      const s = await make();
      await enable(s.id);
      const session = await newSession();
      await prompt(session.id);
      await until(async () => (await status(session.id)) === 'idle');
      const res = await t.call('DELETE', `/api/mcp/servers/${s.id}`);
      expect(res.json()).toMatchObject({ restartedSessions: 1 });
      expect((await t.call('GET', `/api/projects/${t.project.id}/mcp`)).json().servers).toEqual([]);
    });
  });

  describe('discovery', () => {
    const answer = (stdout: string, extra: Partial<ExecResult> = {}) => {
      t.runtime.ephemeralHandler = () => ({
        code: 0,
        stdout,
        stderr: '',
        timedOut: false,
        ...extra,
      });
    };
    const discover = (id: number) => t.call('POST', `/api/mcp/servers/${id}/discover`);
    const last = (): EphemeralSpec => t.runtime.ephemerals.at(-1)!;

    it('tests a server in a throwaway container with network and only its own values', async () => {
      const s = await make();
      answer(
        report({
          state: 'connected',
          sdkVersion: '1.4.0',
          tools: [
            { name: 'echo', description: 'Echo', annotations: { readOnlyHint: true } },
            { name: 'wipe', description: 'Deletes things', annotations: { destructiveHint: true } },
          ],
        }),
      );
      const res = await discover(s.id);
      expect(res.statusCode).toBe(200);
      const server = res.json().server;
      expect(server.discovery).toMatchObject({ state: 'connected', piVersion: '1.4.0' });
      expect(server.discovery.tools.map((x: { name: string }) => x.name)).toEqual(['echo', 'wipe']);

      const spec = last();
      expect(spec.networkDisabled).toBe(false);
      expect(spec.cmd).toEqual(['node', '/lab/mcp-discover.mjs']);
      expect(spec.env).toMatchObject({
        PI_CODING_AGENT_DIR: '/lab/agent',
        PP_MCP_1_E_GREETING: 'hello',
        PP_MCP_1_E_API_TOKEN: SECRET,
      });
      const cfg = spec.files.find((f) => f.path === 'lab/agent/mcp.json')!.content!.toString();
      expect(cfg).not.toContain(SECRET);
      expect(JSON.parse(cfg).mcpServers.spike.env.API_TOKEN).toBe('${PP_MCP_1_E_API_TOKEN}');
      expect(spec.files.some((f) => f.path === 'lab/mcp-discover.mjs')).toBe(true);
      // nothing from the host: no bind mounts exist in the spec at all, only copied files
      expect(spec.files.every((f) => f.path.startsWith('lab/'))).toBe(true);
    });

    it('hides destructive tools on first sight and respects later choices', async () => {
      const s = await make();
      const tools = (...names: [string, boolean?][]) =>
        report({
          state: 'connected',
          tools: names.map(([name, destructive]) => ({
            name,
            description: '',
            annotations: destructive ? { destructiveHint: true } : {},
          })),
        });
      answer(tools(['read'], ['wipe', true]));
      expect((await discover(s.id)).json().server.defaultHidden).toEqual(['wipe']);

      // the admin shows "wipe" again; a later discovery must not hide it a second time
      await t.call('PUT', `/api/mcp/servers/${s.id}/hidden`, { hidden: [] });
      answer(tools(['read'], ['wipe', true], ['format_disk', true], ['list']));
      expect((await discover(s.id)).json().server.defaultHidden).toEqual(['format_disk']);
    });

    it('records failures, timeouts and missing reports, never leaking secret values', async () => {
      const s = await make();
      answer(report({ state: 'failed', error: `spawn failed with token ${SECRET}`, tools: [] }));
      const failed = (await discover(s.id)).json().server.discovery;
      expect(failed).toMatchObject({ state: 'failed', error: 'spawn failed with token ***' });

      answer('', { timedOut: true, code: null });
      expect((await discover(s.id)).json().server.discovery).toMatchObject({
        state: 'timeout',
        error: 'The test timed out',
      });

      answer('garbage', { code: 1, stderr: `boom ${SECRET}` });
      const none = (await discover(s.id)).json();
      expect(none.server.discovery.state).toBe('error');
      expect(JSON.stringify(none)).not.toContain(SECRET);
      expect(none.server.discovery.error).toContain('***');
    });

    it('maps runtime failures to 502 without details, and 404s for unknown servers', async () => {
      const s = await make();
      t.runtime.ephemeralHandler = () => {
        throw new Error('docker exploded');
      };
      const res = await discover(s.id);
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain('docker exploded');
      expect((await discover(999)).statusCode).toBe(404);
    });

    it('allows one test per server at a time', async () => {
      const s = await make();
      let release!: (r: ExecResult) => void;
      t.runtime.ephemeralHandler = () => new Promise<ExecResult>((r) => (release = r));
      const first = discover(s.id);
      for (let i = 0; i < 100 && t.runtime.ephemerals.length === 0; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect((await discover(s.id)).statusCode).toBe(429);
      release({
        code: 0,
        stdout: report({ state: 'connected', tools: [] }),
        stderr: '',
        timedOut: false,
      });
      expect((await first).statusCode).toBe(200);
    });
  });

  describe('import', () => {
    const imp = (json: unknown, name?: string) =>
      t.call('POST', '/api/mcp/import', { json, ...(name ? { name } : {}) } as Record<
        string,
        unknown
      >);

    it('imports a Claude Desktop style config, marking secrets and placeholders', async () => {
      const res = await imp({
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {
              GITHUB_TOKEN: '${GITHUB_TOKEN}',
              LOG_LEVEL: 'debug',
              API_KEY: 'literal-key-value',
            },
          },
          docs: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'blue' },
          },
        },
      });
      expect(res.statusCode).toBe(201);
      const { servers, warnings } = res.json();
      expect(servers.map((s: { name: string }) => s.name)).toEqual(['github', 'docs']);
      expect(servers[0].env).toEqual([
        { key: 'GITHUB_TOKEN', secret: true, hasValue: false },
        { key: 'LOG_LEVEL', secret: false, value: 'debug', hasValue: true },
        { key: 'API_KEY', secret: true, hasValue: true },
      ]);
      expect(servers[1].headers).toEqual([
        { key: 'Authorization', secret: true, hasValue: false },
        { key: 'X-Team', secret: false, value: 'blue', hasValue: true },
      ]);
      expect(warnings.join('\n')).toMatch(/GITHUB_TOKEN referenced an environment variable/);
      expect(warnings.join('\n')).toMatch(/Authorization referenced an environment variable/);
      expect(res.body).not.toContain('literal-key-value');
    });

    it('skips what pi cannot run and reports why', async () => {
      const res = await imp({
        mcpServers: {
          legacy: { type: 'sse', url: 'https://x.test/sse' },
          weird: { type: 'carrier-pigeon', command: 'x' },
          runner: { command: 'node', env: { BAD: '!touch /tmp/x', GOOD: 'ok' } },
          'bad name!': { command: 'node' },
        },
      });
      const { servers, warnings } = res.json();
      expect(servers.map((s: { name: string }) => s.name)).toEqual(['runner']);
      expect(servers[0].env.map((e: { key: string }) => e.key)).toEqual(['GOOD']);
      const text = warnings.join('\n');
      expect(text).toMatch(/legacy: skipped, SSE/);
      expect(text).toMatch(/weird: skipped, unknown server type/);
      expect(text).toMatch(/BAD skipped, command-substitution/);
      expect(text).toMatch(/bad name!: not added/);
    });

    it('warns instead of failing on duplicates, accepts a bare server, and rejects junk', async () => {
      await make(stdio({ name: 'dup' }));
      const res = await imp({
        mcpServers: { dup: { command: 'node' }, fresh: { command: 'node' } },
      });
      expect(res.json().servers.map((s: { name: string }) => s.name)).toEqual(['fresh']);
      expect(res.json().warnings.join('\n')).toMatch(/dup: not added/);
      expect((await imp({ command: 'node', args: ['x.js'] }, 'bare')).json().servers[0].name).toBe(
        'bare',
      );
      for (const junk of [null, 'text', [], {}, { mcpServers: [] }])
        expect((await imp(junk)).statusCode).toBe(400);
    });
  });
});

describe('helpers', () => {
  it('redacts every known secret value, ignoring very short ones', () => {
    expect(redactValues('a=sekret-value-123 b=other', ['sekret-value-123', 'other', 'ab'])).toBe(
      'a=*** b=***',
    );
    expect(redactValues('nothing here', [])).toBe('nothing here');
  });

  it('rebuilds a hostile discovery report field by field', () => {
    const d = sanitizeDiscovery(
      {
        state: 'owned',
        error: 'e'.repeat(5000),
        sdkVersion: 'v'.repeat(100),
        tools: [
          {
            name: 'ok',
            description: 'd'.repeat(2000),
            annotations: { readOnlyHint: true, destructiveHint: 'yes', extra: true },
          },
          { name: 42 },
          { name: '' },
          { name: 'n'.repeat(300) },
          null,
          ...Array.from({ length: 600 }, (_, i) => ({ name: `t${i}` })),
        ],
        __proto__: { polluted: true },
      },
      [],
      123,
    );
    expect(d.state).toBe('error');
    expect(d.error).toHaveLength(1000);
    expect(d.piVersion).toHaveLength(40);
    expect(d.discoveredAt).toBe(123);
    // only the first 500 entries are examined, and invalid ones among them are dropped
    expect(d.tools.length).toBeGreaterThan(450);
    expect(d.tools.length).toBeLessThanOrEqual(500);
    expect(d.tools[0]).toEqual({
      name: 'ok',
      description: 'd'.repeat(300),
      annotations: { readOnlyHint: true },
    });
    expect(d.tools.some((x) => x.name === '' || x.name.length > 200)).toBe(false);
  });

  it('converts a bare server using the fallback name', () => {
    expect(convertImport({ command: 'node' }, 'mine').servers[0]).toMatchObject({
      name: 'mine',
      type: 'stdio',
      command: 'node',
    });
    expect(convertImport({ url: 'https://x.test/mcp' }).servers[0]).toMatchObject({
      name: 'server',
      type: 'http',
    });
  });
});
