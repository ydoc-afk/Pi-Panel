import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

const PASSWORD = 'correct-horse-battery';

function setup() {
  const app = buildApp({ db: openDb(':memory:'), runtime: new FakeRuntime() });
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

  describe('registration and approval', () => {
    const MEMBER = 'member-password-1';
    let admin: string;

    beforeEach(async () => {
      admin = cookieOf(await t.post('/api/auth/setup', { username: 'admin', password: PASSWORD }))!;
    });

    const get = (url: string, cookie: string) => t.app.inject({ url, headers: { cookie } });
    const register = (username = 'sam') =>
      t.post('/api/auth/register', { username, password: MEMBER });
    const idOf = async (username: string) =>
      ((await get('/api/admin/users', admin)).json() as { id: number; username: string }[]).find(
        (u) => u.username === username,
      )!.id;

    it('refuses registration before the admin exists', async () => {
      const fresh = setup();
      const res = await fresh.post('/api/auth/register', { username: 'sam', password: MEMBER });
      expect(res.statusCode).toBe(409);
    });

    it('creates a pending account that cannot sign in yet', async () => {
      expect((await register()).statusCode).toBe(202);
      const res = await t.post('/api/auth/login', { username: 'sam', password: MEMBER });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/waiting/);
      expect(cookieOf(res)).toBeUndefined();
      // A wrong password still looks like any other failed sign-in.
      const wrong = await t.post('/api/auth/login', {
        username: 'sam',
        password: 'not-the-password',
      });
      expect(wrong.statusCode).toBe(401);
    });

    it('rejects duplicate and invalid registrations', async () => {
      await register();
      expect((await register()).statusCode).toBe(409);
      expect((await register('admin')).statusCode).toBe(409);
      expect(
        (await t.post('/api/auth/register', { username: 'sam2', password: 'short' })).statusCode,
      ).toBe(400);
    });

    it('lets the admin approve, and then the member signs in with the member role', async () => {
      await register();
      const id = await idOf('sam');
      expect((await t.post(`/api/admin/users/${id}/approve`, {}, admin)).statusCode).toBe(200);
      const login = await t.post('/api/auth/login', { username: 'sam', password: MEMBER });
      expect(login.statusCode).toBe(200);
      expect(login.json().user.role).toBe('member');
      expect((await get('/api/projects', cookieOf(login)!)).statusCode).toBe(200);
    });

    it('keeps members away from admin routes and shared credentials', async () => {
      await register();
      await t.post(`/api/admin/users/${await idOf('sam')}/approve`, {}, admin);
      const member = cookieOf(
        await t.post('/api/auth/login', { username: 'sam', password: MEMBER }),
      )!;
      expect((await get('/api/admin/users', member)).statusCode).toBe(403);
      expect((await t.post('/api/providers', { name: 'x' }, member)).statusCode).toBe(403);
      expect((await t.post('/api/mcp/import', {}, member)).statusCode).toBe(403);
      expect((await get('/api/mcp/registry', member)).statusCode).toBe(403);
      expect((await get('/api/providers', member)).statusCode).toBe(200);
      expect((await get('/api/admin/users', admin)).statusCode).toBe(200);
    });

    it('rejecting a member ends their session', async () => {
      await register();
      const id = await idOf('sam');
      await t.post(`/api/admin/users/${id}/approve`, {}, admin);
      const member = cookieOf(
        await t.post('/api/auth/login', { username: 'sam', password: MEMBER }),
      )!;
      await t.post(`/api/admin/users/${id}/reject`, {}, admin);
      expect((await get('/api/projects', member)).statusCode).toBe(401);
      const again = await t.post('/api/auth/login', { username: 'sam', password: MEMBER });
      expect(again.statusCode).toBe(403);
    });

    it('does not let the admin account be changed or removed, and deletes members', async () => {
      const adminId = await idOf('admin');
      expect((await t.post(`/api/admin/users/${adminId}/reject`, {}, admin)).statusCode).toBe(400);
      const del = await t.app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${adminId}`,
        headers: { cookie: admin },
      });
      expect(del.statusCode).toBe(400);
      await register();
      const id = await idOf('sam');
      const ok = await t.app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${id}`,
        headers: { cookie: admin },
      });
      expect(ok.statusCode).toBe(200);
      expect((await get('/api/admin/users', admin)).json()).toHaveLength(1);
    });
  });
});
