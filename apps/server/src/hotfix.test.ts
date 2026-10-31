import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

const PASSWORD = 'correct-horse-battery';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-hotfix-'));
  dirs.push(dataDir);
  const db = openDb(':memory:');
  const app = buildApp({ db, runtime: new FakeRuntime(), dataDir });
  const admin = cookieOf(
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: PASSWORD },
    }),
  );
  return { app, db, admin };
}

describe('member restrictions', () => {
  it('cannot be sidestepped with percent-encoded paths', async () => {
    const t = await setup();
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'sam', password: 'member-password-1' },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/users/2/approve',
      headers: { cookie: t.admin },
    });
    const member = cookieOf(
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'sam', password: 'member-password-1' },
      }),
    );
    for (const url of [
      '/api/providers',
      '/api/%70roviders',
      '/api/provider%73',
      '/api/mcp/%73ervers',
      '/api/projects/1/github/%70ush',
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: { cookie: member },
        payload: {},
      });
      expect(res.statusCode, url).toBe(403);
    }
    // Unknown API paths still need a sign-in before they 404.
    expect((await t.app.inject({ url: '/api/nope' })).statusCode).toBe(401);
    await t.app.close();
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

    // A real socket: the backlog is sent as soon as it opens.
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
