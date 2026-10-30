import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime, type EphemeralSpec, type ExecResult } from './runtime.js';

const SECRET = 'sekret-value-123';
const report = (body: object) =>
  `@@PI_MCP_REPORT_BEGIN@@\n${JSON.stringify(body)}\n@@PI_MCP_REPORT_END@@\n`;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-side-'));
  const runtime = new FakeRuntime();
  const app = buildApp({
    db: openDb(':memory:'),
    runtime,
    dataDir,
    sidecars: { readyTimeoutMs: 150, pollMs: 5 },
  });
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
  return { app, runtime, dataDir, call, project, headers, agentFile };
}

const rea = (extra: Record<string, unknown> = {}) => ({
  name: 'rea',
  type: 'managed',
  image: 'pi-panel/rea:6.8.0',
  command: 'rea',
  args: ['mcp', '--http', '--host', '0.0.0.0', '--port', '8765'],
  port: 8765,
  readyLog: 'MCP transport listening',
  mountSamples: true,
  memoryMb: 2048,
  env: [
    { key: 'LICENSE_KEY', value: SECRET, secret: true },
    { key: 'REA_LOG_LEVEL', value: 'info' },
  ],
  ...extra,
});

describe('managed MCP servers', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  const create = (payload: Record<string, unknown>) => t.call('POST', '/api/mcp/servers', payload);
  const make = async (payload = rea()) => (await create(payload)).json().server;
  const enable = (serverId: number, projectId = t.project.id, enabled = true) =>
    t.call('PUT', `/api/projects/${projectId}/mcp/${serverId}`, { enabled });
  const sidecarCall = (action: string, serverId = 1, projectId = t.project.id) =>
    t.call('POST', `/api/projects/${projectId}/mcp/${serverId}/sidecar`, { action });
  const newSession = async () =>
    (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json().session;
  const prompt = (id: number) => t.call('POST', `/api/sessions/${id}/prompt`, { message: 'hi' });
  const sessionEvents = async (id: number) =>
    (await t.call('GET', `/api/sessions/${id}/events`))
      .json()
      .events.map((e: { event: Record<string, unknown> }) => e.event);

  describe('definition', () => {
    it('stores the container definition and keeps its secrets encrypted', async () => {
      const res = await create(rea());
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(SECRET);
      expect(res.json().server).toMatchObject({
        type: 'managed',
        image: 'pi-panel/rea:6.8.0',
        command: 'rea',
        port: 8765,
        readyLog: 'MCP transport listening',
        mountSamples: true,
        memoryMb: 2048,
      });
      expect(res.json().server.env[0]).toEqual({
        key: 'LICENSE_KEY',
        secret: true,
        hasValue: true,
      });
    });

    it('applies defaults and validates the container fields', async () => {
      const minimal = await create({
        name: 'min',
        type: 'managed',
        image: 'my/img:1',
        command: 'serve',
      });
      expect(minimal.json().server).toMatchObject({
        port: 8765,
        memoryMb: 4096,
        mountSamples: false,
        readyLog: null,
      });
      const bad: Record<string, unknown>[] = [
        rea({ name: 'a', image: '' }),
        rea({ name: 'b', image: undefined }),
        rea({ name: 'c', image: 'Has Upper:1' }),
        rea({ name: 'd', image: 'has space:1' }),
        rea({ name: 'e', image: 'x'.repeat(250) }),
        rea({ name: 'f', command: '' }),
        rea({ name: 'g', port: 0 }),
        rea({ name: 'h', port: 70000 }),
        rea({ name: 'i', port: 1.5 }),
        rea({ name: 'j', memoryMb: 100 }),
        rea({ name: 'k', memoryMb: 99999 }),
        rea({ name: 'l', mountSamples: 'yes' }),
        rea({ name: 'm', url: 'https://x.test' }),
        rea({ name: 'n', cwd: '/x' }),
        rea({ name: 'o', headers: [{ key: 'X', value: 'y' }] }),
      ];
      for (const payload of bad)
        expect((await create(payload)).statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    });

    it('lets pi-side types and managed types coexist', async () => {
      expect((await create({ name: 's', type: 'stdio', command: 'node' })).statusCode).toBe(201);
      expect((await create(rea())).statusCode).toBe(201);
    });
  });

  describe('starting for a project', () => {
    it('starts an isolated container on a private internal network', async () => {
      const server = await make();
      const res = await enable(server.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().sidecarError).toBeUndefined();
      expect(res.json().sidecars[server.id]).toEqual({ state: 'running', exitCode: null });

      const spec = t.runtime.sidecarStarts[0]!;
      expect(spec).toMatchObject({
        name: `pp-mcp-${t.project.id}-${server.id}`,
        image: 'pi-panel/rea:6.8.0',
        cmd: ['rea', 'mcp', '--http', '--host', '0.0.0.0', '--port', '8765'],
        network: `pp-net-${t.project.id}`,
        alias: `mcp-${server.id}`,
        memoryMb: 2048,
      });
      expect(spec.env).toEqual({ LICENSE_KEY: SECRET, REA_LOG_LEVEL: 'info' });
      expect(spec.mounts).toEqual([
        {
          source: join(t.dataDir, 'samples', String(t.project.id)),
          target: '/samples',
          readOnly: true,
        },
      ]);
      expect(spec.labels).toMatchObject({
        'pi-panel.sidecar': '1',
        'pi-panel.project': String(t.project.id),
      });
      // the network has no route out, and both the sidecar and the session container are on it
      const net = t.runtime.networks.get(`pp-net-${t.project.id}`)!;
      expect(net.internal).toBe(true);
      const sessionContainer = [...t.runtime.containers.keys()][0]!;
      expect(net.connected.has(sessionContainer)).toBe(true);
      expect([...net.connected].some((id) => t.runtime.sidecars.has(id))).toBe(true);
    });

    it('mounts nothing when the server does not use samples', async () => {
      const server = await make(rea({ mountSamples: false }));
      await enable(server.id);
      expect(t.runtime.sidecarStarts[0]!.mounts).toEqual([]);
    });

    it('keeps the container secrets out of pi entirely', async () => {
      const server = await make();
      await enable(server.id);
      await prompt((await newSession()).id);

      const cfg = JSON.parse(readFileSync(t.agentFile('mcp.json'), 'utf8')).mcpServers.rea;
      expect(cfg.url).toBe(`http://mcp-${server.id}:8765/mcp`);
      expect(cfg.env).toBeUndefined();
      expect(cfg.headers).toBeUndefined();
      expect(JSON.stringify(cfg)).not.toContain(SECRET);
      const piExec = t.runtime.execs.find((e) => e.cmd[1] === '--mode')!;
      expect(Object.values(piExec.env!)).not.toContain(SECRET);
      expect(Object.keys(piExec.env!).some((k) => k.startsWith('PP_MCP_'))).toBe(false);
      // the only place the secret exists outside the database is the container's own environment
      expect(Object.values(t.runtime.sidecarStarts[0]!.env)).toContain(SECRET);
    });

    it('tells the agent which sample files exist without mounting them into its container', async () => {
      const server = await make();
      await enable(server.id);
      const upload = (name: string) => {
        const boundary = '----x';
        return t.app.inject({
          method: 'POST',
          url: `/api/projects/${t.project.id}/samples`,
          headers: { ...t.headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\nDATA\r\n--${boundary}--\r\n`,
        });
      };
      await upload('a.exe');
      await upload('b.dll');
      await prompt((await newSession()).id);
      const desc = JSON.parse(readFileSync(t.agentFile('mcp.json'), 'utf8')).mcpServers.rea
        .description as string;
      expect(desc).toContain('/samples/a.exe');
      expect(desc).toContain('/samples/b.dll');
      expect(t.runtime.sidecarStarts[0]!.mounts[0]!.readOnly).toBe(true);
      // the session container is created with only its workspace and agent dir, never the samples
      expect(Object.keys([...t.runtime.containers.values()][0]!).sort()).toEqual([
        'agentDir',
        'projectId',
        'workspacePath',
      ]);
    });
  });

  describe('failures', () => {
    it('reports a container that never says it is ready, and removes it', async () => {
      t.runtime.sidecarLog = () => 'still starting...\nloading';
      const server = await make();
      const res = await enable(server.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().sidecarError).toMatch(/Not ready after/);
      expect(res.json().sidecarError).toContain('loading');
      expect(res.json().servers[0].enabled).toBe(true); // stays enabled; retried on the next session
      expect(t.runtime.sidecars.size).toBe(0);
      expect(res.json().sidecars[server.id].state).toBe('stopped');
    });

    it('reports a container that crashes on startup', async () => {
      t.runtime.sidecarInitialState = 'exited';
      t.runtime.sidecarLog = () => 'Error: JAVA_HOME is not set';
      const server = await make();
      const res = await enable(server.id);
      expect(res.json().sidecarError).toMatch(/stopped \(exit code 1\)/);
      expect(res.json().sidecarError).toContain('JAVA_HOME is not set');
      expect(t.runtime.sidecars.size).toBe(0);
    });

    it('points at the image when it cannot be started, without leaking details', async () => {
      t.runtime.failNextSidecar = true;
      const server = await make();
      const res = await enable(server.id);
      expect(res.json().sidecarError).toMatch(/Is the image "pi-panel\/rea:6\.8\.0" built/);
      expect(res.json().sidecarError).not.toMatch(/fake runtime/);
    });

    it('never leaks secret values through logs or errors', async () => {
      t.runtime.sidecarLog = () => `token=${SECRET} loading`;
      const server = await make();
      const res = await enable(server.id);
      expect(res.body).not.toContain(SECRET);
      expect(res.json().sidecarError).toContain('***');
      t.runtime.sidecarLog = () => `ready MCP transport listening key=${SECRET}`;
      await sidecarCall('start', server.id);
      const logs = (
        await t.call('GET', `/api/projects/${t.project.id}/mcp/${server.id}/sidecar/logs`)
      ).json().logs as string;
      expect(logs).toContain('***');
      expect(logs).not.toContain(SECRET);
    });
  });

  describe('lifecycle', () => {
    it('supports start, stop and restart, and reports state', async () => {
      const server = await make();
      await enable(server.id);
      const first = [...t.runtime.sidecars.keys()][0]!;
      expect((await sidecarCall('stop', server.id)).json().sidecar.state).toBe('stopped');
      expect(t.runtime.sidecars.size).toBe(0);
      expect((await sidecarCall('start', server.id)).json().sidecar.state).toBe('running');
      const second = [...t.runtime.sidecars.keys()][0]!;
      expect((await sidecarCall('restart', server.id)).json().sidecar.state).toBe('running');
      const third = [...t.runtime.sidecars.keys()][0]!;
      expect(new Set([first, second, third]).size).toBe(3);
      expect(t.runtime.sidecars.size).toBe(1);
      expect((await sidecarCall('explode', server.id)).statusCode).toBe(400);
    });

    it('rejects sidecar actions for servers that are not managed, and unknown things', async () => {
      const plain = (await create({ name: 'plain', type: 'stdio', command: 'node' })).json().server;
      expect((await sidecarCall('start', plain.id)).statusCode).toBe(400);
      expect((await sidecarCall('start', 999)).statusCode).toBe(404);
      expect((await sidecarCall('start', 1, 999)).statusCode).toBe(404);
    });

    it('notices a container that disappeared', async () => {
      const server = await make();
      await enable(server.id);
      t.runtime.sidecars.clear();
      const listed = (await t.call('GET', `/api/projects/${t.project.id}/mcp`)).json();
      expect(listed.sidecars[server.id].state).toBe('missing');
    });

    it('stops the container when the server is switched off for the project', async () => {
      const server = await make();
      await enable(server.id);
      expect(t.runtime.sidecars.size).toBe(1);
      const off = await enable(server.id, t.project.id, false);
      expect(off.json().sidecars[server.id].state).toBe('stopped');
      expect(t.runtime.sidecars.size).toBe(0);
    });

    it('serialises concurrent starts so only one container exists', async () => {
      const server = await make();
      await enable(server.id);
      await Promise.all([
        sidecarCall('restart', server.id),
        sidecarCall('start', server.id),
        sidecarCall('restart', server.id),
      ]);
      expect(t.runtime.sidecars.size).toBe(1);
    });

    it('restarts the container when its definition or environment changes, but not for a description', async () => {
      const server = await make();
      await enable(server.id);
      const idOf = () => [...t.runtime.sidecars.keys()][0]!;
      const before = idOf();
      await t.call('PUT', `/api/mcp/servers/${server.id}`, { description: 'new words' });
      expect(idOf()).toBe(before);
      await t.call('PUT', `/api/mcp/servers/${server.id}`, { memoryMb: 3000 });
      const afterMem = idOf();
      expect(afterMem).not.toBe(before);
      expect(t.runtime.sidecarStarts.at(-1)!.memoryMb).toBe(3000);
      await t.call('PUT', `/api/mcp/servers/${server.id}`, {
        env: [{ key: 'LICENSE_KEY', secret: true, value: 'rotated-9999' }],
      });
      expect(t.runtime.sidecarStarts.at(-1)!.env.LICENSE_KEY).toBe('rotated-9999');
      expect(t.runtime.sidecars.size).toBe(1);
    });
  });

  describe('sessions', () => {
    it('starts a missing container before pi starts, and carries on if it cannot', async () => {
      const server = await make();
      await enable(server.id);
      t.runtime.sidecars.clear(); // e.g. the Docker host rebooted
      const s1 = await newSession();
      expect((await prompt(s1.id)).statusCode).toBe(200);
      expect(t.runtime.sidecars.size).toBe(1);

      t.runtime.sidecars.clear();
      t.runtime.failNextSidecar = true;
      const s2 = await newSession();
      expect((await prompt(s2.id)).statusCode).toBe(200);
      const notice = (await sessionEvents(s2.id)).find(
        (e: Record<string, unknown>) => e.type === 'panel_notice',
      );
      expect(notice).toMatchObject({ level: 'warning' });
      expect(String(notice.message)).toMatch(/MCP server "rea" could not start/);
    });

    it('does nothing for projects with no managed servers', async () => {
      await prompt((await newSession()).id);
      expect(t.runtime.sidecarStarts).toHaveLength(0);
      expect(t.runtime.networks.size).toBe(0);
    });
  });

  describe('cleanup and isolation', () => {
    it('gives each project its own network and container', async () => {
      const server = await make();
      const other = (await t.call('POST', '/api/projects', { name: 'other' })).json().project;
      await enable(server.id);
      await enable(server.id, other.id);
      expect([...t.runtime.networks.keys()].sort()).toEqual(
        [`pp-net-${t.project.id}`, `pp-net-${other.id}`].sort(),
      );
      const names = t.runtime.sidecarStarts.map((s) => s.name);
      expect(new Set(names).size).toBe(2);
      // each sidecar is attached only to its own project's network
      for (const [name, net] of t.runtime.networks) {
        const members = [...net.connected].filter((id) => t.runtime.sidecars.has(id));
        expect(members).toHaveLength(1);
        expect(t.runtime.sidecars.get(members[0]!)!.spec.network).toBe(name);
      }
    });

    it('removes sidecars, the network, and uploaded samples when a project is deleted', async () => {
      const server = await make();
      await enable(server.id);
      const upload = await t.app.inject({
        method: 'POST',
        url: `/api/projects/${t.project.id}/samples`,
        headers: { ...t.headers, 'content-type': 'multipart/form-data; boundary=----x' },
        payload:
          '------x\r\nContent-Disposition: form-data; name="file"; filename="s.bin"\r\n\r\nDATA\r\n------x--\r\n',
      });
      expect(upload.statusCode).toBe(201);
      const dir = join(t.dataDir, 'samples', String(t.project.id));
      expect(existsSync(dir)).toBe(true);
      const res = await t.call('DELETE', `/api/projects/${t.project.id}`);
      expect(res.statusCode).toBe(204);
      expect(t.runtime.sidecars.size).toBe(0);
      expect(t.runtime.networks.size).toBe(0);
      expect(existsSync(dir)).toBe(false);
    });

    it("removes a server's containers in every project when it is deleted from the library", async () => {
      const server = await make();
      const other = (await t.call('POST', '/api/projects', { name: 'other' })).json().project;
      await enable(server.id);
      await enable(server.id, other.id);
      expect(t.runtime.sidecars.size).toBe(2);
      expect((await t.call('DELETE', `/api/mcp/servers/${server.id}`)).statusCode).toBe(200);
      expect(t.runtime.sidecars.size).toBe(0);
    });
  });

  describe('testing a library entry', () => {
    const answer = (stdout: string) => {
      t.runtime.ephemeralHandler = () => ({ code: 0, stdout, stderr: '', timedOut: false });
    };
    const discover = (id: number) => t.call('POST', `/api/mcp/servers/${id}/discover`);

    it('runs the server on its own throwaway network and cleans everything up', async () => {
      const server = await make();
      let during: { networks: string[]; sidecars: number } | undefined;
      t.runtime.ephemeralHandler = (spec: EphemeralSpec): ExecResult => {
        during = { networks: [...t.runtime.networks.keys()], sidecars: t.runtime.sidecars.size };
        expect(spec.network).toMatch(/^pp-net-test-/);
        const cfg = spec.files.find((f) => f.path === 'lab/agent/mcp.json')!.content!.toString();
        expect(JSON.parse(cfg).mcpServers.rea.url).toBe(`http://mcp-${server.id}:8765/mcp`);
        expect(cfg).not.toContain(SECRET);
        return {
          code: 0,
          stdout: report({
            state: 'connected',
            sdkVersion: '1.4.0',
            tools: [
              { name: 'inspect_x', description: 'Look', annotations: { readOnlyHint: true } },
              { name: 'set_comment', description: 'Edit', annotations: { destructiveHint: true } },
            ],
          }),
          stderr: '',
          timedOut: false,
        };
      };
      const res = await discover(server.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().server.discovery.state).toBe('connected');
      expect(res.json().server.defaultHidden).toEqual(['set_comment']);
      expect(during!.sidecars).toBe(1);
      expect(during!.networks[0]).toMatch(/^pp-net-test-/);
      // the test copy had no samples mounted and the project networks were untouched
      expect(t.runtime.sidecarStarts[0]!.mounts).toEqual([]);
      expect(t.runtime.sidecars.size).toBe(0);
      expect(t.runtime.networks.size).toBe(0);
    });

    it('cleans up when the container is not ready, and when the harness throws', async () => {
      const server = await make();
      t.runtime.sidecarLog = () => 'nope';
      const notReady = await discover(server.id);
      expect(notReady.statusCode).toBe(504);
      expect(t.runtime.sidecars.size).toBe(0);
      expect(t.runtime.networks.size).toBe(0);

      t.runtime.sidecarLog = () => 'MCP transport listening';
      t.runtime.ephemeralHandler = () => {
        throw new Error('docker exploded');
      };
      const boom = await discover(server.id);
      expect(boom.statusCode).toBe(502);
      expect(boom.body).not.toContain('docker exploded');
      expect(t.runtime.sidecars.size).toBe(0);
      expect(t.runtime.networks.size).toBe(0);
    });

    it("scrubs the container's secrets from what the test records", async () => {
      const server = await make();
      answer(report({ state: 'failed', error: `license ${SECRET} rejected`, tools: [] }));
      const res = await discover(server.id);
      expect(res.body).not.toContain(SECRET);
      expect(res.json().server.discovery.error).toBe('license *** rejected');
    });
  });
});
