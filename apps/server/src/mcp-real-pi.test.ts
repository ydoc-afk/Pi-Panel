// End-to-end check of MCP discovery against the real pi CLI and SDK and a real stdio MCP server.
// Everything runs locally except Docker. Enable with:
//   PI_SDK_ENTRY=<.../node_modules/@earendil-works/pi-coding-agent/dist/index.js>
//   PI_BIN=<.../node_modules/.bin/pi>
//   MCP_TEST_SERVER=<path to a stdio server script that can import @modelcontextprotocol/sdk>
// The server should put GREETING, SECRET_TOKEN and BANG into a tool description (see docs/mcp.md).
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createTar } from './tar.js';
import { FakeRuntime, type EphemeralSpec, type ExecResult } from './runtime.js';

const { PI_SDK_ENTRY, PI_BIN, MCP_TEST_SERVER } = process.env;
const HARNESS = new URL('../assets/mcp-discover.mjs', import.meta.url).pathname;
const run = promisify(execFile);
const SECRET = 'sekret-value-123';

describe.runIf(PI_SDK_ENTRY && PI_BIN && MCP_TEST_SERVER)('MCP against the real pi', () => {
  let dataDir: string;
  let app: ReturnType<typeof buildApp>;
  let runtime: FakeRuntime;
  let headers: { cookie: string };
  let projectId: number;
  const scratch: string[] = [];
  const marker = join(tmpdir(), `pp-mcp-bang-${process.pid}`);

  /** Stand-in for Docker: unpack the archive and run the harness as the container would. */
  async function runLocally(spec: EphemeralSpec): Promise<ExecResult> {
    const root = mkdtempSync(join(tmpdir(), 'pp-mcp-real-'));
    scratch.push(root);
    execFileSync('tar', ['-xf', '-', '-C', root], { input: createTar(spec.files) });
    const env: Record<string, string> = {
      PATH: process.env.PATH!,
      LAB_ROOT: join(root, 'lab'),
      PI_BIN: PI_BIN!,
      PI_SDK_ENTRY: PI_SDK_ENTRY!,
    };
    for (const [k, v] of Object.entries(spec.env ?? {}))
      env[k] = v.startsWith('/lab') ? join(root, v) : v;
    try {
      const { stdout, stderr } = await run('node', [join(root, 'lab/mcp-discover.mjs')], {
        env,
        timeout: 90_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr, timedOut: false };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', timedOut: false };
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-mcp-real-data-'));
    runtime = new FakeRuntime();
    runtime.ephemeralHandler = runLocally;
    app = buildApp({ db: openDb(':memory:'), runtime, dataDir, mcp: { harnessPath: HARNESS } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    projectId = (
      await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'p' } })
    ).json().project.id;
  });

  afterAll(async () => {
    await app?.close();
    for (const d of [dataDir, ...scratch, marker]) rmSync(d, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });

  it('connects to a real server, passes values through env references, and records tools', async () => {
    const created = await call('POST', '/api/mcp/servers', {
      name: 'spike',
      type: 'stdio',
      command: 'node',
      args: [MCP_TEST_SERVER!],
      env: [
        { key: 'GREETING', value: 'hi there', secret: false },
        { key: 'SECRET_TOKEN', value: SECRET, secret: true },
        { key: 'BANG', value: `!touch ${marker}`, secret: false },
      ],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().server.id;

    const res = await call('POST', `/api/mcp/servers/${id}/discover`);
    expect(res.statusCode).toBe(200);
    const server = res.json().server;
    expect(server.discovery.error).toBeNull();
    expect(server.discovery.state).toBe('connected');
    expect(server.discovery.piVersion).toMatch(/^\d+\.\d+\.\d+/);

    const tools = Object.fromEntries(
      server.discovery.tools.map((t: { name: string }) => [t.name, t]),
    );
    expect(Object.keys(tools).sort()).toEqual(['echo', 'info', 'wipe']);
    expect(tools.echo.description).toBe('Echo text back');
    expect(tools.wipe.annotations).toEqual({ destructiveHint: true });
    expect(tools.info.annotations).toEqual({ readOnlyHint: true });
    // values reached the server process; the secret is redacted before it is stored
    expect(tools.info.description).toContain('GREETING=hi there');
    expect(tools.info.description).toContain('TOKEN=***');
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
    // a value starting with "!" is data, never a command
    expect(tools.info.description).toContain(`BANG=!touch ${marker}`);
    expect(existsSync(marker)).toBe(false);
    // the destructive tool starts hidden
    expect(server.defaultHidden).toEqual(['wipe']);
  }, 120_000);

  it('reports a server that cannot start', async () => {
    const id = (
      await call('POST', '/api/mcp/servers', {
        name: 'broken',
        type: 'stdio',
        command: 'definitely-not-a-command',
      })
    ).json().server.id;
    const server = (await call('POST', `/api/mcp/servers/${id}/discover`)).json().server;
    expect(server.discovery.state).toBe('failed');
    expect(server.discovery.error).toMatch(/ENOENT/);
    expect(server.discovery.tools).toEqual([]);
  }, 120_000);

  it('generates a project config that the real pi accepts and connects with', async () => {
    const id = (await call('GET', '/api/mcp/servers'))
      .json()
      .servers.find((s: { name: string }) => s.name === 'spike').id;
    await call('PUT', `/api/projects/${projectId}/mcp/${id}`, { enabled: true });
    const session = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session;
    await call('POST', `/api/sessions/${session.id}/prompt`, { message: 'hi' });

    const agent = join(dataDir, 'agents', String(projectId));
    const config = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8'));
    expect(config.mcpServers.spike.toolExposure).toEqual({ wipe: 'hidden' });
    expect(JSON.stringify(config)).not.toContain(SECRET);

    // run the real CLI against that exact file, with the exact env the panel hands to pi
    const env = runtime.execs.find((e) => e.cmd[0] === 'pi' && e.cmd[1] === '--mode')!.env!;
    const proc = await run(PI_BIN!, ['mcp', 'list', '--json'], {
      env: {
        PATH: process.env.PATH!,
        HOME: agent,
        ...env,
        PI_CODING_AGENT_DIR: agent,
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      },
      timeout: 90_000,
    });
    const listed = JSON.parse(proc.stdout).servers as {
      name: string;
      state: string;
      tools: string[];
      error?: string;
    }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'spike', state: 'connected' });
    expect(listed[0]!.tools.sort()).toEqual(['echo', 'info', 'wipe']);
  }, 120_000);
});
