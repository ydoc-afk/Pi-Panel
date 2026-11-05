import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { agentDir } from './paths.js';
import { FakeRuntime } from './runtime.js';

describe('package sets', () => {
  let dataDir: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let projectId: number;
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  /** What `pi install` would have left in the project's settings.json. */
  const install = (id: number, packages: unknown[]) => {
    const dir = agentDir(dataDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages }));
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-sets-'));
    app = buildApp({ db: openDb(':memory:'), runtime: new FakeRuntime(), dataDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    projectId = (await call('POST', '/api/projects', { name: 'p' })).json().project.id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires authentication', async () => {
    expect((await app.inject({ url: '/api/package-sets' })).statusCode).toBe(401);
  });

  it('saves the exact-version npm packages a project uses, and counts the ones it cannot save', async () => {
    install(projectId, [
      'npm:@acme/tools@1.2.3',
      { source: 'npm:pi-notes@0.4.0', extensions: [] },
      'npm:floating@latest',
      'git:github.com/x/y',
    ]);
    const res = await call('POST', '/api/package-sets', {
      name: 'Research',
      fromProjectId: projectId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().skipped).toBe(2);
    expect(res.json().set).toMatchObject({
      name: 'Research',
      sources: [
        { source: 'npm:@acme/tools@1.2.3', name: '@acme/tools', version: '1.2.3' },
        { source: 'npm:pi-notes@0.4.0', name: 'pi-notes', version: '0.4.0' },
      ],
    });
    expect((await call('GET', '/api/package-sets')).json().sets).toHaveLength(1);
  });

  it('refuses a project with nothing to save, and bad sources', async () => {
    expect(
      (await call('POST', '/api/package-sets', { name: 'x', fromProjectId: projectId })).statusCode,
    ).toBe(400);
    const bad = (sources: unknown) => call('POST', '/api/package-sets', { name: 'x', sources });
    expect((await bad([])).statusCode).toBe(400);
    expect((await bad(['npm:pi-notes'])).statusCode).toBe(400); // no version
    expect((await bad(['npm:pi-notes@^1.0.0'])).statusCode).toBe(400); // a range
    expect((await bad(['git:github.com/x/y'])).statusCode).toBe(400); // not npm
    expect((await bad(['npm:a@1.0.0', 'npm:a@1.0.1'])).statusCode).toBe(400); // same package twice
    expect(
      (await call('POST', '/api/package-sets', { name: '  ', sources: ['npm:a@1.0.0'] }))
        .statusCode,
    ).toBe(400);
  });

  it('keeps names unique, and renames or edits a set', async () => {
    const make = (name: string, v = '1.0.0') =>
      call('POST', '/api/package-sets', { name, sources: [`npm:pi-notes@${v}`] });
    const a = (await make('One')).json().set;
    expect((await make('One')).statusCode).toBe(409);
    const b = (await make('Two', '2.0.0')).json().set;
    expect((await call('PUT', `/api/package-sets/${b.id}`, { name: 'One' })).statusCode).toBe(409);
    const edited = await call('PUT', `/api/package-sets/${a.id}`, {
      name: 'Renamed',
      sources: ['npm:pi-notes@1.1.0', 'npm:other@2.0.0'],
    });
    expect(edited.json().set).toMatchObject({ name: 'Renamed' });
    expect(edited.json().set.sources).toHaveLength(2);
    expect((await call('PUT', '/api/package-sets/999', { name: 'x' })).statusCode).toBe(404);
  });

  it('says what applying a set to a project would add', async () => {
    await call('POST', '/api/package-sets', {
      name: 'Kit',
      sources: ['npm:a@1.0.0', 'npm:b@2.0.0', 'npm:c@3.0.0'],
    });
    const other = (await call('POST', '/api/projects', { name: 'other' })).json().project.id;
    install(other, ['npm:a@1.0.0', 'npm:b@2.5.0']);

    const empty = (await call('GET', `/api/projects/${projectId}/package-sets`)).json().sets[0];
    expect(empty.missing).toEqual(['npm:a@1.0.0', 'npm:b@2.0.0', 'npm:c@3.0.0']);
    expect(empty.installed).toEqual([]);

    const partial = (await call('GET', `/api/projects/${other}/package-sets`)).json().sets[0];
    expect(partial.installed).toEqual(['npm:a@1.0.0']);
    expect(partial.different).toEqual([{ source: 'npm:b@2.0.0', installed: 'npm:b@2.5.0' }]);
    expect(partial.missing).toEqual(['npm:c@3.0.0']);
  });

  it('deletes a set', async () => {
    const set = (
      await call('POST', '/api/package-sets', { name: 'Gone', sources: ['npm:a@1.0.0'] })
    ).json().set;
    expect((await call('DELETE', `/api/package-sets/${set.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/package-sets')).json().sets).toEqual([]);
    expect((await call('DELETE', `/api/package-sets/${set.id}`)).statusCode).toBe(404);
  });
});
