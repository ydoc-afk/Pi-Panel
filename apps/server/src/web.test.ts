import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

describe('serving the web UI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pp-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><title>Pi-Panel</title><div id="root"></div>',
    );
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (webDir: string) =>
    buildApp({
      db: openDb(':memory:'),
      runtime: new FakeRuntime(),
      dataDir: join(dir, 'data'),
      webDir,
    });

  it('serves index.html and assets without a login, since the login page is part of the UI', async () => {
    const app = make(dir);
    const root = await app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root">');
    const asset = await app.inject({ url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
    await app.close();
  });

  it('falls back to index.html for client-side routes but keeps /api as JSON', async () => {
    const app = make(dir);
    expect((await app.inject({ url: '/projects/3' })).body).toContain('<div id="root">');
    const api = await app.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(401); // the auth guard answers first
    expect(api.headers['content-type']).toMatch(/json/);
    expect((await app.inject({ url: '/api/health' })).json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('does not serve files outside the UI directory', async () => {
    writeFileSync(join(dir, '..', 'pp-secret.txt'), 'top secret');
    const app = make(dir);
    for (const url of ['/../pp-secret.txt', '/%2e%2e/pp-secret.txt', '/..%2fpp-secret.txt']) {
      const res = await app.inject({ url });
      expect(res.body, url).not.toContain('top secret');
    }
    await app.close();
    rmSync(join(dir, '..', 'pp-secret.txt'), { force: true });
  });

  it('serves nothing when there is no built UI', async () => {
    const app = make(join(dir, 'missing'));
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });
});
