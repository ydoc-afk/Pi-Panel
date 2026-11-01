import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

const PASSWORD = 'correct-horse-battery';
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`;

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

async function setup(answer: (s: Seen) => Response | Promise<Response>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-updates-'));
  const seen: Seen[] = [];
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const s: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  const app = buildApp({
    db: openDb(':memory:'),
    runtime: new FakeRuntime(),
    dataDir,
    fetch: fakeFetch,
  });
  const admin = cookieOf(
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: PASSWORD },
    }),
  );
  const call = (method: 'GET' | 'POST', url: string, payload?: object, cookie = admin) =>
    app.inject({ method, url, payload, headers: { cookie } });
  const setToken = () => {
    mkdirSync(join(dataDir, 'updater'), { recursive: true });
    writeFileSync(join(dataDir, 'updater', 'token'), 'a'.repeat(64));
  };
  return { app, dataDir, seen, call, setToken, admin };
}

describe('update routes', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup(
      (s) =>
        new Response(JSON.stringify({ path: new URL(s.url).pathname, ok: true }), {
          status: s.url.endsWith('/update') ? 202 : 200,
        }),
    );
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  it('says when the updater is not set up', async () => {
    const running = await t.call('GET', '/api/admin/updates/running');
    expect(running.json()).toMatchObject({ commit: null, configured: false });
    expect(typeof running.json().schema).toBe('number');
    const res = await t.call('GET', '/api/admin/updates/status');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ configured: false });
    expect(t.seen).toEqual([]);
  });

  it('forwards to the updater with the shared token', async () => {
    t.setToken();
    const res = await t.call('GET', '/api/admin/updates/status');
    expect(res.json()).toEqual({ path: '/status', ok: true });
    expect(t.seen[0]).toMatchObject({
      url: 'http://updater:8080/status',
      method: 'GET',
      auth: `Bearer ${'a'.repeat(64)}`,
    });

    const sha = 'b'.repeat(40);
    const apply = await t.call('POST', '/api/admin/updates/apply', { branch: 'main', sha });
    expect(apply.statusCode).toBe(202);
    expect(t.seen[1]).toMatchObject({
      url: 'http://updater:8080/update',
      body: { branch: 'main', sha },
    });

    expect((await t.call('POST', '/api/admin/updates/apply', { branch: 'main' })).statusCode).toBe(
      400,
    );
    await t.call('GET', '/api/admin/updates/job?after=12');
    await t.call('GET', '/api/admin/updates/job?after=../../x');
    expect(t.seen.slice(-2).map((s) => s.url)).toEqual([
      'http://updater:8080/job?after=12',
      'http://updater:8080/job?after=0',
    ]);
  });

  it('reports an updater that does not answer', async () => {
    await t.app.close();
    t = await setup(() => {
      throw new Error('ECONNREFUSED');
    });
    t.setToken();
    const res = await t.call('POST', '/api/admin/updates/check');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ configured: true });
  });

  it('is for the admin only, and refuses cross-origin writes', async () => {
    t.setToken();
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'sam', password: 'member-password-1' },
    });
    await t.call('POST', '/api/admin/users/2/approve');
    const member = cookieOf(
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'sam', password: 'member-password-1' },
      }),
    );
    for (const [method, url] of [
      ['GET', '/api/admin/updates/status'],
      ['GET', '/api/admin/updates/running'],
      ['POST', '/api/admin/updates/rollback'],
    ] as const) {
      expect((await t.call(method, url, {}, member)).statusCode).toBe(403);
    }
    expect((await t.app.inject({ url: '/api/admin/updates/status' })).statusCode).toBe(401);
    const cross = await t.app.inject({
      method: 'POST',
      url: '/api/admin/updates/rollback',
      headers: {
        cookie: t.admin,
        origin: 'http://evil.example',
      },
    });
    expect(cross.statusCode).toBe(403);
    expect(t.seen).toEqual([]);
  });
});
