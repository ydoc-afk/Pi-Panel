// End-to-end check of a managed server against the real REA (rea-agents) over streamable HTTP, driven
// through the real pi CLI and SDK. Everything runs locally except Docker. Enable with:
//   REA_NODE=<a Node >= 22.23.4 / 24.22.1 binary>   REA_ENTRY=<.../node_modules/rea-agents/scripts/rea.mjs>
//   PI_BIN=<.../node_modules/.bin/pi>   PI_SDK_ENTRY=<.../pi-coding-agent/dist/index.js>
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createTar } from './tar.js';
import { FakeRuntime, type EphemeralSpec, type ExecResult } from './runtime.js';

const { REA_NODE, REA_ENTRY, PI_BIN, PI_SDK_ENTRY } = process.env;
const HARNESS = new URL('../assets/mcp-discover.mjs', import.meta.url).pathname;
const run = promisify(execFile);

describe.runIf(REA_NODE && REA_ENTRY && PI_BIN && PI_SDK_ENTRY)(
  'REA over HTTP with the real pi',
  () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    let rea: ChildProcess;
    let dataDir: string;
    let app: ReturnType<typeof buildApp>;
    let headers: { cookie: string };
    let projectId: number;
    const scratch: string[] = [];

    /** Stand-in for Docker: run the real harness, pointing the sidecar's alias at the local REA process. */
    async function runLocally(spec: EphemeralSpec): Promise<ExecResult> {
      const root = mkdtempSync(join(tmpdir(), 'pp-rea-real-'));
      scratch.push(root);
      execFileSync('tar', ['-xf', '-', '-C', root], { input: createTar(spec.files) });
      const cfgPath = join(root, 'lab/agent/mcp.json');
      writeFileSync(
        cfgPath,
        readFileSync(cfgPath, 'utf8').replace(
          /http:\/\/mcp-\d+:8765\/mcp/,
          `http://127.0.0.1:${port}/mcp`,
        ),
      );
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
          timeout: 120_000,
          maxBuffer: 20 * 1024 * 1024,
        });
        return { code: 0, stdout, stderr, timedOut: false };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          code: e.code ?? 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          timedOut: false,
        };
      }
    }

    beforeAll(async () => {
      rea = spawn(
        REA_NODE!,
        [REA_ENTRY!, 'mcp', '--http', '--host', '127.0.0.1', '--port', String(port)],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('REA did not announce its HTTP endpoint')),
          60_000,
        );
        rea.stderr!.on('data', (d: Buffer) => {
          if (d.toString().includes('MCP transport listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        rea.on('exit', (code) => reject(new Error(`REA exited early (${code})`)));
      });
      dataDir = mkdtempSync(join(tmpdir(), 'pp-rea-real-data-'));
      const runtime = new FakeRuntime();
      runtime.ephemeralHandler = runLocally;
      app = buildApp({
        db: openDb(':memory:'),
        runtime,
        dataDir,
        mcp: { harnessPath: HARNESS },
        sidecars: { readyTimeoutMs: 500, pollMs: 5 },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'correct-horse-battery' },
      });
      headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
      projectId = (
        await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'p' } })
      ).json().project.id;
    }, 90_000);

    afterAll(async () => {
      rea?.kill();
      await app?.close();
      for (const d of [dataDir, ...scratch]) rmSync(d, { recursive: true, force: true });
    });

    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers, payload });

    it('lists the whole REA catalog and hides the destructive tools by default', async () => {
      const preset = (await call('GET', '/api/mcp/presets'))
        .json()
        .presets.find((p: { id: string }) => p.id === 'rea');
      const created = await call('POST', '/api/mcp/servers', preset.server);
      expect(created.statusCode).toBe(201);
      const id = created.json().server.id;

      const res = await call('POST', `/api/mcp/servers/${id}/discover`);
      expect(res.statusCode).toBe(200);
      const server = res.json().server;
      expect(server.discovery.error).toBeNull();
      expect(server.discovery.state).toBe('connected');
      const tools = server.discovery.tools as {
        name: string;
        description: string;
        annotations: { destructiveHint?: boolean };
      }[];
      expect(tools.length).toBeGreaterThan(100);
      expect(tools.every((t) => t.description.length > 0)).toBe(true);
      const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
      expect(destructive.length).toBeGreaterThan(10);
      expect([...server.defaultHidden].sort()).toEqual([...destructive].sort());
    }, 150_000);

    it('generates a config that hides those tools for a project', async () => {
      const server = (await call('GET', '/api/mcp/servers')).json().servers[0];
      await call('PUT', `/api/projects/${projectId}/mcp/${server.id}`, { enabled: true });
      const session = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json()
        .session;
      await call('POST', `/api/sessions/${session.id}/prompt`, { message: 'hi' });
      const cfg = JSON.parse(
        readFileSync(join(dataDir, 'agents', String(projectId), 'mcp.json'), 'utf8'),
      ).mcpServers.rea;
      expect(cfg.url).toBe(`http://mcp-${server.id}:8765/mcp`);
      expect(cfg.exposure).toBe('deferred');
      expect(Object.keys(cfg.toolExposure).sort()).toEqual([...server.defaultHidden].sort());
      expect(Object.values(cfg.toolExposure).every((v) => v === 'hidden')).toBe(true);
      expect(cfg.description).toMatch(/none are uploaded yet|\/samples\//);
    }, 60_000);
  },
);
