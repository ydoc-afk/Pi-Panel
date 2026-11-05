import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { openDb, schemaVersion } from './db.js';
import { sandboxLimits } from './docker-runtime.js';
import { FakeRuntime } from './runtime.js';
import { FailureThrottle } from './throttle.js';

const PASSWORD = 'correct-horse-battery';
const MEMBER = 'member-password-1';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-hard-'));
  dirs.push(dataDir);
  const db = openDb(':memory:');
  const runtime = new FakeRuntime();
  const app = buildApp({ db, runtime, dataDir });
  const admin = cookieOf(
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: PASSWORD },
    }),
  );
  return { app, db, runtime, admin };
}

async function withMember(t: Awaited<ReturnType<typeof setup>>) {
  await t.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'sam', password: MEMBER },
  });
  await t.app.inject({
    method: 'POST',
    url: '/api/admin/users/2/approve',
    headers: { cookie: t.admin },
  });
  return cookieOf(
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'sam', password: MEMBER },
    }),
  );
}

describe('member restrictions', () => {
  it('cannot be sidestepped with percent-encoded paths', async () => {
    const t = await setup();
    const member = await withMember(t);
    for (const url of ['/api/providers', '/api/%70roviders', '/api/provider%73']) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: { cookie: member },
        payload: {},
      });
      expect(res.statusCode, url).toBe(403);
    }
    const mcp = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/%73ervers',
      headers: { cookie: member },
      payload: {},
    });
    expect(mcp.statusCode).toBe(403);
    const push = await t.app.inject({
      method: 'POST',
      url: '/api/projects/1/github/%70ush',
      headers: { cookie: member },
      payload: {},
    });
    expect(push.statusCode).toBe(403);
    await t.app.close();
  });
});

describe('sign-in throttling', () => {
  it('refuses further attempts from an address after repeated failures', async () => {
    const t = await setup();
    const attempt = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password },
      });
    for (let i = 0; i < 10; i++) expect((await attempt('wrong-password-x')).statusCode).toBe(401);
    const blocked = await attempt(PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await t.app.close();
  });

  it('counts failures in a sliding window', () => {
    let now = 0;
    const th = new FailureThrottle(2, 1000, () => now);
    th.fail('a');
    th.fail('a');
    expect(th.retryAfter('a')).toBe(1);
    expect(th.retryAfter('b')).toBe(0);
    now = 1001;
    expect(th.retryAfter('a')).toBe(0);
    th.fail('a');
    th.reset('a');
    expect(th.retryAfter('a')).toBe(0);
  });
});

describe('cross-origin requests', () => {
  it('refuses writes and websocket upgrades from another origin', async () => {
    const t = await setup();
    const post = (origin?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { cookie: t.admin, host: 'panel.local:3000', ...(origin ? { origin } : {}) },
        payload: { name: `p${Math.random().toString(36).slice(2, 8)}` },
      });
    expect((await post('http://panel.local:8080')).statusCode).toBe(403);
    expect((await post('http://evil.example')).statusCode).toBe(403);
    expect((await post('http://panel.local:3000')).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(201);

    const ws = await t.app.inject({
      method: 'GET',
      url: '/api/sessions/1/stream',
      headers: {
        cookie: t.admin,
        host: 'panel.local:3000',
        origin: 'http://panel.local:8080',
        upgrade: 'websocket',
        connection: 'upgrade',
      },
    });
    expect(ws.statusCode).toBe(403);
    await t.app.close();
  });

  it('sends security headers', async () => {
    const t = await setup();
    const res = await t.app.inject({ url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    await t.app.close();
  });
});

describe('maintenance', () => {
  it('purges expired sign-in sessions on startup', async () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES ('a', 'x', 0)",
    ).run();
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)').run(
      'old',
      1,
    );
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)').run(
      'live',
      Date.now() + 60_000,
    );
    const app = buildApp({ db, runtime: new FakeRuntime() });
    await app.ready();
    const left = db.prepare('SELECT token_hash FROM auth_sessions').all() as {
      token_hash: string;
    }[];
    expect(left.map((r) => r.token_hash)).toEqual(['live']);
    await app.close();
  });

  it('records applied migrations and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-mig-'));
    dirs.push(dir);
    const path = join(dir, 'm.db');
    const db = openDb(path);
    const v = schemaVersion(db);
    expect(v).toBeGreaterThanOrEqual(2);
    db.close();
    const again = openDb(path);
    expect(schemaVersion(again)).toBe(v);
    expect(
      (again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
    ).toBe(v);
    expect(
      (again.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
    ).toBe('wal');
    again.close();
  });

  it('reports Docker reachability in the health check without failing it', async () => {
    const t = await setup();
    expect((await t.app.inject({ url: '/api/health' })).json()).toMatchObject({
      status: 'ok',
      db: true,
      docker: true,
    });
    t.runtime.reachable = false;
    const res = await t.app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'degraded', docker: false });
    await t.app.close();
  });

  it('reads sandbox limits from the environment', () => {
    expect(sandboxLimits({})).toEqual({ memoryBytes: 2048 * 1024 * 1024, nanoCpus: 2e9 });
    expect(sandboxLimits({ SANDBOX_MEMORY_MB: '512', SANDBOX_CPUS: '0.5' })).toEqual({
      memoryBytes: 512 * 1024 * 1024,
      nanoCpus: 5e8,
    });
    expect(sandboxLimits({ SANDBOX_CPUS: 'lots' }).nanoCpus).toBe(2e9);
  });
});

describe('session stream replay', () => {
  it('replays the whole backlog on connect, not just the first page', async () => {
    const t = await setup();
    const headers = { cookie: t.admin };
    const project = (
      await t.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'p' } })
    ).json().project;
    const session = (
      await t.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/sessions`,
        headers,
        payload: {},
      })
    ).json().session;
    const insert = t.db.prepare(
      'INSERT INTO session_events (session_id, seq, data) VALUES (?, ?, ?)',
    );
    for (let seq = 1; seq <= 2500; seq++) insert.run(session.id, seq, '{"type":"tick"}');

    // A real socket: the backlog is sent as soon as it opens, before injectWS would hand it over.
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const seqs: number[] = [];
    const ws = new WebSocket(
      `${address.replace('http', 'ws')}/api/sessions/${session.id}/stream?after=100`,
      { headers },
    );
    ws.on('message', (data: Buffer) => seqs.push(JSON.parse(data.toString()).seq));
    for (let i = 0; i < 200 && seqs.length < 2400; i++) await new Promise((r) => setTimeout(r, 5));
    ws.terminate();
    expect(seqs.length).toBe(2400);
    expect(seqs[0]).toBe(101);
    expect(seqs.at(-1)).toBe(2500);
    await t.app.close();
  });
});
