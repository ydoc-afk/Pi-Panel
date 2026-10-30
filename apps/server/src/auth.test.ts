import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';

const PASSWORD = 'correct-horse-battery';

function setup() {
  const app = buildApp({ db: openDb(':memory:') });
  const post = async (url: string, payload: Record<string, unknown>, cookie?: string) =>
    await app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
  return { app, post };
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === 'pp_session');
  return c ? `pp_session=${c.value}` : undefined;
};

describe('auth', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('reports setup required on a fresh install', async () => {
    const res = await t.app.inject({ url: '/api/auth/status' });
    expect(res.json()).toEqual({ setupRequired: true, user: null });
  });

  it('creates the admin on first run and logs them in', async () => {
    const res = await t.post('/api/auth/setup', { username: 'admin', password: PASSWORD });
    expect(res.statusCode).toBe(201);
    const cookie = cookieOf(res);
    expect(cookie).toBeDefined();
    const status = await t.app.inject({ url: '/api/auth/status', headers: { cookie } });
    expect(status.json().user.username).toBe('admin');
    expect(status.json().setupRequired).toBe(false);
  });

  it('refuses a second setup', async () => {
    await t.post('/api/auth/setup', { username: 'admin', password: PASSWORD });
    const res = await t.post('/api/auth/setup', { username: 'other', password: PASSWORD });
    expect(res.statusCode).toBe(409);
  });

  it('rejects short passwords', async () => {
    const res = await t.post('/api/auth/setup', { username: 'admin', password: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('logs in with valid credentials and rejects bad ones', async () => {
    await t.post('/api/auth/setup', { username: 'admin', password: PASSWORD });
    expect(
      (await t.post('/api/auth/login', { username: 'admin', password: 'wrong-password-1' }))
        .statusCode,
    ).toBe(401);
    expect(
      (await t.post('/api/auth/login', { username: 'nobody', password: PASSWORD })).statusCode,
    ).toBe(401);
    const ok = await t.post('/api/auth/login', { username: 'admin', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok)).toBeDefined();
  });

  it('logout invalidates the session', async () => {
    const setupRes = await t.post('/api/auth/setup', { username: 'admin', password: PASSWORD });
    const cookie = cookieOf(setupRes)!;
    await t.post('/api/auth/logout', {}, cookie);
    const status = await t.app.inject({ url: '/api/auth/status', headers: { cookie } });
    expect(status.json().user).toBeNull();
  });

  it('keeps health public and protects other api routes', async () => {
    expect((await t.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/projects' })).statusCode).toBe(401);
  });
});
