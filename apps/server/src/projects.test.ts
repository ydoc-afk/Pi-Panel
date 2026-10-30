import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-test-'));
  const runtime = new FakeRuntime();
  const app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  return { app, runtime, dataDir, headers };
}

describe('projects', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(() => rmSync(t.dataDir, { recursive: true, force: true }));

  const create = (name: unknown) =>
    t.app.inject({ method: 'POST', url: '/api/projects', headers: t.headers, payload: { name } });

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: '/api/projects' })).statusCode).toBe(401);
  });

  it('creates a project with a workspace and a running container', async () => {
    const res = await create('My Project');
    expect(res.statusCode).toBe(201);
    const { project } = res.json();
    expect(project).toMatchObject({ name: 'My Project', status: 'running' });
    expect(t.runtime.containers.size).toBe(1);
    expect(existsSync(join(t.dataDir, 'workspaces', String(project.id)))).toBe(true);
  });

  it('lists and fetches projects', async () => {
    const { project } = (await create('alpha')).json();
    const list = await t.app.inject({ url: '/api/projects', headers: t.headers });
    expect(list.json().projects).toHaveLength(1);
    const one = await t.app.inject({ url: `/api/projects/${project.id}`, headers: t.headers });
    expect(one.json().project.name).toBe('alpha');
    expect((await t.app.inject({ url: '/api/projects/999', headers: t.headers })).statusCode).toBe(
      404,
    );
  });

  it('rejects invalid and duplicate names', async () => {
    expect((await create('')).statusCode).toBe(400);
    expect((await create('../etc')).statusCode).toBe(400);
    expect((await create(42)).statusCode).toBe(400);
    expect((await create('dup')).statusCode).toBe(201);
    expect((await create('dup')).statusCode).toBe(409);
  });

  it('rolls back when the container cannot be created', async () => {
    t.runtime.failNextCreate = true;
    expect((await create('broken')).statusCode).toBe(500);
    const list = await t.app.inject({ url: '/api/projects', headers: t.headers });
    expect(list.json().projects).toHaveLength(0);
    expect(existsSync(join(t.dataDir, 'workspaces'))).toBe(true);
    expect((await create('broken')).statusCode).toBe(201);
  });

  it('deletes the container, workspace, and row', async () => {
    const { project } = (await create('gone')).json();
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: t.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(t.runtime.containers.size).toBe(0);
    expect(existsSync(join(t.dataDir, 'workspaces', String(project.id)))).toBe(false);
    expect(
      (await t.app.inject({ url: `/api/projects/${project.id}`, headers: t.headers })).statusCode,
    ).toBe(404);
  });
});
