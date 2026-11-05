import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { parseForgejoUrl, parseRepo, redact } from './github.js';
import { FakeRuntime } from './runtime.js';

const TOKEN = 'fgj_SECRETTOKEN1234567890';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Seed',
  GIT_AUTHOR_EMAIL: 'seed@example.com',
  GIT_COMMITTER_NAME: 'Seed',
  GIT_COMMITTER_EMAIL: 'seed@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup(opts: { dropPrivileges?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-gh-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const remotes = join(root, 'remotes');
  const bare = join(remotes, 'octo', 'hello.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--bare', '-b', 'main');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), '# hello\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', bare, 'main');

  const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === 'http://forgejo.test/api/v1/user') return json({ login: 'forgejo_admin', id: 1 });
    if (u.endsWith('/api/v1/repos/octo/hello')) return json({ default_branch: 'main' });
    if (u.endsWith('/api/v1/repos/octo/hello/pulls') && init?.method === 'POST') {
      return json({ html_url: 'http://forgejo.test/octo/hello/pulls/7', number: 7 });
    }
    return json({ message: 'Not Found' }, 404);
  });
  const db = openDb(':memory:');
  const app = buildApp({
    db,
    runtime: new FakeRuntime(),
    dataDir,
    fetch: api as unknown as typeof fetch,
    forgejo: {
      webBase: `file://${remotes}`,
      allowProtocols: ['file'],
      dropPrivileges: opts.dropPrivileges ?? false,
    },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
  const ws = join(dataDir, 'workspaces', String(project.id));
  return { root, dataDir, bare, api, db, app, call, project, ws, remotes };
}

const URL_ = 'http://forgejo.test';

describe('forgejo', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.root, { recursive: true, force: true });
  });

  const connect = () => t.call('PUT', '/api/forgejo', { token: TOKEN, baseUrl: URL_ });
  const base = () => `/api/projects/${t.project.id}/forgejo`;

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: '/api/forgejo' })).statusCode).toBe(401);
  });

  it('stores the instance URL and an encrypted token, and sends the token as "token"', async () => {
    expect((await t.call('GET', '/api/forgejo')).json()).toEqual({ connected: false });
    const res = await connect();
    expect(res.json()).toEqual({ connected: true, login: 'forgejo_admin', baseUrl: URL_ });
    expect(res.body).not.toContain(TOKEN);
    const raw = t.db.prepare('SELECT token_enc FROM forgejo_account').get() as {
      token_enc: string;
    };
    expect(raw.token_enc).not.toContain(TOKEN);
    expect(t.api.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `token ${TOKEN}` });
    // GitHub stays untouched
    expect((await t.call('GET', '/api/github')).json()).toEqual({ connected: false });
  });

  it('rejects unsafe instance URLs', async () => {
    for (const baseUrl of ['ftp://x', 'http://u:p@x', 'http://x?a=1', 'nope', 5]) {
      const res = await t.call('PUT', '/api/forgejo', { token: TOKEN, baseUrl });
      expect(res.statusCode, String(baseUrl)).toBe(400);
    }
    expect(parseForgejoUrl('http://localhost:3001/')).toBe('http://localhost:3001');
    expect(parseForgejoUrl('https://git.example.com/forge/')).toBe('https://git.example.com/forge');
  });

  it('tests a token without storing it', async () => {
    const res = await t.call('POST', '/api/forgejo/test', { token: TOKEN, baseUrl: URL_ });
    expect(res.json()).toEqual({ login: 'forgejo_admin', id: 1 });
    expect((await t.call('GET', '/api/forgejo')).json()).toEqual({ connected: false });
  });

  it('parses repository names, including underscores and instance URLs', () => {
    expect(parseRepo('forgejo_admin/Pi-Panel', 'forgejo', URL_)).toBe('forgejo_admin/Pi-Panel');
    expect(parseRepo(`${URL_}/a_b/c.git`, 'forgejo', URL_)).toBe('a_b/c');
    expect(() => parseRepo('a/b/c', 'forgejo', URL_)).toThrow();
    expect(() => parseRepo('forgejo_admin/x', 'github')).toThrow();
  });

  it('redacts a Basic credential that includes the login', () => {
    const b64 = Buffer.from(`forgejo_admin:${TOKEN}`).toString('base64');
    expect(redact(`x ${b64} ${TOKEN}`, TOKEN, 'forgejo_admin')).toBe('x *** ***');
  });

  it('clones, pushes as the Forgejo user, and opens a pull request', async () => {
    await connect();
    const cloned = await t.call('POST', `${base()}/clone`, { repo: 'octo/hello' });
    expect(cloned.statusCode).toBe(200);
    expect(existsSync(join(t.ws, 'README.md'))).toBe(true);
    writeFileSync(join(t.ws, 'new.txt'), 'hi\n');
    const pushed = await t.call('POST', `${base()}/push`, { branch: 'pi/x', message: 'add file' });
    expect(pushed.statusCode).toBe(200);
    expect(git(t.bare, 'log', '-1', '--format=%an|%ae|%s', 'pi/x').trim()).toBe(
      'forgejo_admin|1+forgejo_admin@noreply.forgejo.test|add file',
    );
    const pr = await t.call('POST', `${base()}/pr`, { head: 'pi/x', title: 'Add file' });
    expect(pr.statusCode).toBe(201);
    expect(pr.json()).toMatchObject({ url: `${URL_}/octo/hello/pulls/7`, base: 'main' });
    const row = t.db.prepare('SELECT repo, repo_host FROM projects').get();
    expect(row).toMatchObject({ repo: 'octo/hello', repo_host: 'forgejo' });
  });

  it('requires an account to clone, and keeps GitHub and Forgejo links separate', async () => {
    expect((await t.call('POST', `${base()}/clone`, { repo: 'octo/hello' })).statusCode).toBe(409);
    await connect();
    await t.call('POST', `${base()}/clone`, { repo: 'octo/hello' });
    const status = (await t.call('GET', `/api/projects/${t.project.id}/github`)).json();
    expect(status).toMatchObject({ repo: null, linkedTo: 'forgejo' });
    const push = await t.call('POST', `/api/projects/${t.project.id}/github/push`, { branch: 'b' });
    expect(push.statusCode).toBe(409);
    expect(push.json().error).toContain('Forgejo');
  });

  it('keeps members away from the account and pushing', async () => {
    const { memberBlocked } = await import('./auth.js');
    expect(memberBlocked('PUT', '/api/forgejo')).toBe(true);
    expect(memberBlocked('POST', '/api/forgejo/test')).toBe(true);
    expect(memberBlocked('POST', '/api/projects/:id/forgejo/push')).toBe(true);
    expect(memberBlocked('POST', '/api/projects/:id/forgejo/clone')).toBe(true);
  });
});
