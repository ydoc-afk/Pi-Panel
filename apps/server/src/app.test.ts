import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

describe('health endpoint', () => {
  it('returns ok', async () => {
    const app = buildApp({ db: openDb(':memory:'), runtime: new FakeRuntime() });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: true, docker: true });
  });
});

describe('sandbox image check', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reports whether the sandbox image is present, behind login', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pp-app-'));
    dirs.push(dataDir);
    const runtime = new FakeRuntime();
    const app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
    expect((await app.inject({ url: '/api/sandbox' })).statusCode).toBe(401);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const cookie = `pp_session=${setup.cookies.find((c) => c.name === 'pp_session')!.value}`;
    const get = () => app.inject({ method: 'GET', url: '/api/sandbox', headers: { cookie } });

    expect((await get()).json()).toEqual({ available: true });
    runtime.sandboxImageAvailable = false;
    expect((await get()).json()).toEqual({ available: false });
    await app.close();
  });

  it('keeps the REA build behind login and rejects bad input before building', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pp-app-'));
    dirs.push(dataDir);
    const runtime = new FakeRuntime();
    const app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
    expect(
      (await app.inject({ method: 'POST', url: '/api/rea/build', payload: {} })).statusCode,
    ).toBe(401);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const headers = {
      cookie: `pp_session=${setup.cookies.find((c) => c.name === 'pp_session')!.value}`,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/rea/build',
      headers,
      payload: { ghidraUrl: 'http://example.com/g.zip', ghidraSha256: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(runtime.builds).toEqual([]);
    await app.close();
  });
});
