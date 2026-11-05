import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

const PASSWORD = 'correct-horse-battery';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-life-'));
  const runtime = new FakeRuntime();
  const app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: PASSWORD },
  });
  const cookie = `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => app.inject({ method, url, headers: { cookie, ...headers }, payload });
  const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
  return { app, runtime, dataDir, cookie, call, project };
}

describe('project container lifecycle', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  const statusOf = async () =>
    (await t.call('GET', `/api/projects/${t.project.id}`)).json().project.status;
  const containerId = () => [...t.runtime.containers.keys()][0]!;

  it('notices a stopped container and starts it again', async () => {
    t.runtime.stopped.add(containerId());
    expect(await statusOf()).toBe('stopped');
    const list = (await t.call('GET', '/api/projects')).json().projects;
    expect(list[0].status).toBe('stopped');
    expect((await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).statusCode).toBe(
      409,
    );

    const res = await t.call('POST', `/api/projects/${t.project.id}/restart`);
    expect(res.statusCode).toBe(200);
    expect(res.json().project.status).toBe('running');
    expect(t.runtime.stopped.size).toBe(0);
    expect(t.runtime.containers.size).toBe(1);
  });

  it('replaces a missing container on restart, keeping the project', async () => {
    const old = containerId();
    await t.runtime.remove(old);
    expect(await statusOf()).toBe('missing');
    const res = await t.call('POST', `/api/projects/${t.project.id}/restart`);
    expect(res.json().project.status).toBe('running');
    expect(containerId()).not.toBe(old);
    expect((await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).statusCode).toBe(
      201,
    );
  });

  it('recreates the container and stops running sessions', async () => {
    const old = containerId();
    const s = (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json().session;
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: '/hang' });
    let exited = false;
    t.runtime.processes[0]!.onExit(() => (exited = true));
    const res = await t.call('POST', `/api/projects/${t.project.id}/recreate`);
    expect(res.statusCode).toBe(200);
    expect(res.json().project.status).toBe('running');
    expect(t.runtime.containers.has(old)).toBe(false);
    expect(t.runtime.containers.size).toBe(1);
    expect(exited).toBe(true);
    // The new container's mounts are the same project directories.
    expect(t.runtime.containers.get(containerId())!.workspacePath).toMatch(/workspaces\/\d+$/);
  });

  it('keeps the old status when Docker cannot be reached', async () => {
    const original = t.runtime.containerState.bind(t.runtime);
    t.runtime.containerState = async () => {
      throw new Error('docker down');
    };
    expect(await statusOf()).toBe('running');
    t.runtime.containerState = original;
  });
});

describe('sessions and accounts', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  it('renames a session and validates the name', async () => {
    const s = (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json().session;
    const ok = await t.call('PATCH', `/api/sessions/${s.id}`, { name: '  Refactor auth  ' });
    expect(ok.json().session.name).toBe('Refactor auth');
    expect((await t.call('PATCH', `/api/sessions/${s.id}`, { name: ' ' })).statusCode).toBe(400);
    expect((await t.call('PATCH', '/api/sessions/999', { name: 'x' })).statusCode).toBe(404);
  });

  it('changes the password and signs out other browsers only', async () => {
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    });
    const otherCookie = `pp_session=${other.cookies.find((c) => c.name === 'pp_session')!.value}`;

    const wrong = await t.call('POST', '/api/auth/password', {
      current: 'not-it-at-all',
      next: 'a-brand-new-password',
    });
    expect(wrong.statusCode).toBe(403);
    const short = await t.call('POST', '/api/auth/password', { current: PASSWORD, next: 'short' });
    expect(short.statusCode).toBe(400);

    const ok = await t.call('POST', '/api/auth/password', {
      current: PASSWORD,
      next: 'a-brand-new-password',
    });
    expect(ok.json()).toEqual({ ok: true, signedOutOthers: 1 });
    expect((await t.call('GET', '/api/projects')).statusCode).toBe(200);
    expect(
      (await t.app.inject({ url: '/api/projects', headers: { cookie: otherCookie } })).statusCode,
    ).toBe(401);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'a-brand-new-password' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('needs a signed-in user to change a password', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { current: PASSWORD, next: 'a-brand-new-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('reports versions for the About box', async () => {
    const res = await t.call('GET', '/api/system');
    expect(res.json()).toMatchObject({
      docker: true,
      sandbox: { present: true, piVersion: '1.4.0' },
    });
    expect(res.json().schema).toBeGreaterThanOrEqual(2);
    t.runtime.sandboxImageAvailable = false;
    expect((await t.call('GET', '/api/system')).json().sandbox).toEqual({
      present: false,
      piVersion: null,
    });
    expect((await t.app.inject({ url: '/api/system' })).statusCode).toBe(401);
  });
});
