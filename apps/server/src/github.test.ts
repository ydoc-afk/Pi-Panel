import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { parseRepo, redact } from './github.js';
import { FakeRuntime } from './runtime.js';

const TOKEN = 'ghp_SECRETTOKEN1234567890';
const REAL_GIT = execFileSync('which', ['git']).toString().trim();

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
    if (u.endsWith('/user')) return json({ login: 'octocat', id: 583231 });
    if (u.endsWith('/repos/octo/hello')) return json({ default_branch: 'main' });
    if (u.endsWith('/repos/octo/hello/pulls') && init?.method === 'POST') {
      return json({ html_url: 'https://github.com/octo/hello/pull/7', number: 7 });
    }
    return json({ message: 'Not Found' }, 404);
  });
  const db = openDb(':memory:');
  const app = buildApp({
    db,
    runtime: new FakeRuntime(),
    dataDir,
    fetch: api as unknown as typeof fetch,
    github: {
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

describe('github', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.root, { recursive: true, force: true });
  });

  const connect = () => t.call('PUT', '/api/github', { token: TOKEN });
  const base = () => `/api/projects/${t.project.id}/github`;
  const clone = (payload: Record<string, unknown> = { repo: 'octo/hello' }) =>
    t.call('POST', `${base()}/clone`, payload);
  const remoteLog = (branch: string) =>
    git(t.bare, 'log', '-1', '--format=%an|%ae|%s', branch).trim();

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: '/api/github' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: `${base()}/push` })).statusCode).toBe(401);
  });

  describe('account', () => {
    it('validates the token with GitHub, stores it encrypted, and never returns it', async () => {
      expect((await t.call('GET', '/api/github')).json()).toEqual({ connected: false });
      const res = await connect();
      expect(res.json()).toEqual({ connected: true, login: 'octocat' });
      expect(res.body).not.toContain(TOKEN);
      expect((await t.call('GET', '/api/github')).json()).toEqual({
        connected: true,
        login: 'octocat',
      });
      const raw = t.db.prepare('SELECT token_enc FROM github_account').get() as {
        token_enc: string;
      };
      expect(raw.token_enc).not.toContain(TOKEN);
      expect(t.api.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('rejects a token GitHub does not accept and stores nothing', async () => {
      t.api.mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));
      const res = await connect();
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(TOKEN);
      expect((await t.call('GET', '/api/github')).json()).toEqual({ connected: false });
      expect((await t.call('PUT', '/api/github', { token: 'has space' })).statusCode).toBe(400);
    });

    it('tests a pasted token without storing it', async () => {
      const res = await t.call('POST', '/api/github/test', { token: TOKEN });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ login: 'octocat', id: 583231 });
      expect(res.body).not.toContain(TOKEN);
      expect((await t.call('GET', '/api/github')).json()).toEqual({ connected: false });
    });

    it('tests the stored token when the field is blank', async () => {
      await connect();
      t.api.mockClear();
      expect((await t.call('POST', '/api/github/test', {})).json().login).toBe('octocat');
      expect(t.api.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('explains when there is nothing to test, and when GitHub rejects the token', async () => {
      const none = await t.call('POST', '/api/github/test', { token: '' });
      expect(none.statusCode).toBe(400);
      t.api.mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));
      const bad = await t.call('POST', '/api/github/test', { token: TOKEN });
      expect(bad.statusCode).toBe(502);
      expect(bad.body).not.toContain(TOKEN);
    });

    it('disconnects', async () => {
      await connect();
      expect((await t.call('DELETE', '/api/github')).statusCode).toBe(204);
      expect((await t.call('GET', '/api/github')).json()).toEqual({ connected: false });
    });
  });

  describe('clone and status', () => {
    it('clones into the workspace and links the project', async () => {
      await connect();
      const res = await clone();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ repo: 'octo/hello', branch: 'main' });
      expect(readFileSync(join(t.ws, 'README.md'), 'utf8')).toBe('# hello\n');
      expect((await t.call('GET', `/api/projects/${t.project.id}`)).json().project.repo).toBe(
        'octo/hello',
      );
      writeFileSync(join(t.ws, 'new.txt'), 'x');
      expect((await t.call('GET', base())).json()).toEqual({
        repo: 'octo/hello',
        branch: 'main',
        changes: 1,
      });
    });

    it('works without a token (public repositories)', async () => {
      expect((await clone()).statusCode).toBe(200);
    });

    it('rejects bad input, non-empty workspaces, and double links', async () => {
      expect((await clone({ repo: 'not a repo' })).statusCode).toBe(400);
      expect((await clone({ repo: 'octo/hello', branch: '-x' })).statusCode).toBe(400);
      writeFileSync(join(t.ws, 'agent-file'), 'x');
      expect((await clone()).statusCode).toBe(409);
      rmSync(join(t.ws, 'agent-file'));
      expect((await clone()).statusCode).toBe(200);
      expect((await clone()).statusCode).toBe(409);
    });

    it('leaves the workspace empty after a failed clone so it can be retried', async () => {
      const res = await clone({ repo: 'octo/missing' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/git clone failed/);
      expect(existsSync(join(t.ws, '.git'))).toBe(false);
      expect((await clone()).statusCode).toBe(200);
    });

    it('returns 404 for an unknown project', async () => {
      expect((await t.call('GET', '/api/projects/999/github')).statusCode).toBe(404);
    });
  });

  describe('push', () => {
    beforeEach(async () => {
      await connect();
      await clone();
    });
    const push = (payload: Record<string, unknown>) => t.call('POST', `${base()}/push`, payload);

    it('commits changes on a new branch and pushes it as the connected user', async () => {
      writeFileSync(join(t.ws, 'feature.txt'), 'hello');
      const res = await push({ branch: 'feature/x', message: 'Add feature' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        repo: 'octo/hello',
        branch: 'feature/x',
        committed: true,
      });
      expect(remoteLog('feature/x')).toBe(
        'octocat|583231+octocat@users.noreply.github.com|Add feature',
      );
      expect(git(t.bare, 'show', 'feature/x:feature.txt')).toBe('hello');
      expect((await t.call('GET', base())).json().changes).toBe(0);
    });

    it('pushes again without a new commit when nothing changed', async () => {
      writeFileSync(join(t.ws, 'a.txt'), 'a');
      await push({ branch: 'b1' });
      const again = await push({ branch: 'b1' });
      expect(again.json()).toMatchObject({ committed: false });
    });

    it('reports a rejected push as a conflict', async () => {
      const other = join(t.root, 'other');
      git(t.root, 'clone', t.bare, other);
      writeFileSync(join(other, 'remote.txt'), 'r');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'remote change');
      git(other, 'push', 'origin', 'main');
      writeFileSync(join(t.ws, 'local.txt'), 'l');
      const res = await push({ branch: 'main' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/Push failed/);
    });

    it('validates input and preconditions', async () => {
      for (const branch of ['', '-x', 'a..b', 'x@{1}', 'has space', 42]) {
        expect((await push({ branch })).statusCode).toBe(400);
      }
      expect((await push({ branch: 'ok', message: 7 })).statusCode).toBe(400);
      await t.call('DELETE', '/api/github');
      expect((await push({ branch: 'ok' })).statusCode).toBe(409);
    });

    it('requires a linked repository', async () => {
      const p2 = (await t.call('POST', '/api/projects', { name: 'p2' })).json().project;
      const res = await t.call('POST', `/api/projects/${p2.id}/github/push`, { branch: 'x' });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('hostile workspaces', () => {
    beforeEach(async () => {
      await connect();
      await clone();
      writeFileSync(join(t.ws, 'change.txt'), 'x');
    });
    const push = () => t.call('POST', `${base()}/push`, { branch: 'evil' });
    const marker = () => join(t.root, 'pwned');

    it('does not run repository hooks', async () => {
      const hook = join(t.ws, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, `#!/bin/sh\ntouch ${marker()}\n`);
      chmodSync(hook, 0o755);
      expect((await push()).statusCode).toBe(200);
      expect(existsSync(marker())).toBe(false);
    });

    it.each([
      ['core.fsmonitor', `[core]\n\tfsmonitor = touch ${'MARKER'}\n`],
      ['url rewriting', '[url "file:///evil/"]\n\tinsteadOf = file:///\n'],
      ['credential helper', '[credential]\n\thelper = !touch MARKER\n'],
      ['include', '[include]\n\tpath = /etc/passwd\n'],
      ['custom remote helper', '[remote "origin"]\n\tvcs = evil\n'],
      ['signing program', '[gpg]\n\tprogram = touch MARKER\n'],
    ])('rejects a workspace config with %s', async (_name, snippet) => {
      appendFileSync(join(t.ws, '.git', 'config'), snippet.replace('MARKER', marker()));
      const res = await push();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/disallowed setting/);
      expect(existsSync(marker())).toBe(false);
      expect((await t.call('GET', base())).statusCode).toBe(409);
    });

    it('rejects a .git that is a symlink or a file', async () => {
      renameSync(join(t.ws, '.git'), join(t.root, 'real-git'));
      symlinkSync(join(t.root, 'real-git'), join(t.ws, '.git'));
      expect((await push()).statusCode).toBe(409);
      rmSync(join(t.ws, '.git'));
      writeFileSync(join(t.ws, '.git'), `gitdir: ${join(t.root, 'real-git')}\n`);
      expect((await push()).statusCode).toBe(409);
    });

    it('rejects object alternates', async () => {
      mkdirSync(join(t.ws, '.git', 'objects', 'info'), { recursive: true });
      writeFileSync(join(t.ws, '.git', 'objects', 'info', 'alternates'), '/somewhere/else\n');
      expect((await push()).statusCode).toBe(409);
    });
  });

  describe('token handling', () => {
    it('passes the token only as command-scope, origin-scoped config, never in arguments', async () => {
      const bin = join(t.root, 'shim');
      mkdirSync(bin);
      const shim = join(bin, 'git');
      writeFileSync(
        shim,
        `#!/bin/sh\nenv >> ${t.root}/env.txt\nprintf '%s\\n' "$@" >> ${t.root}/args.txt\nexec ${REAL_GIT} "$@"\n`,
      );
      chmodSync(shim, 0o755);
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath}`;
      try {
        await connect();
        expect((await clone()).statusCode).toBe(200);
      } finally {
        process.env.PATH = oldPath;
      }
      const env = readFileSync(join(t.root, 'env.txt'), 'utf8');
      const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
      expect(env).toContain(`GIT_CONFIG_KEY_0=http.file://${t.remotes}/.extraHeader`);
      expect(env).toContain(`GIT_CONFIG_VALUE_0=Authorization: Basic ${b64}`);
      expect(env).toContain('GIT_TERMINAL_PROMPT=0');
      const args = readFileSync(join(t.root, 'args.txt'), 'utf8');
      expect(args).not.toContain(TOKEN);
      expect(args).not.toContain(b64);
      expect(args).toContain('core.hooksPath=/dev/null');
      // nothing persisted in the cloned repository
      expect(readFileSync(join(t.ws, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
      expect(readFileSync(join(t.ws, '.git', 'config'), 'utf8')).not.toContain(b64);
    });

    it('redacts the token and its base64 form from text', () => {
      const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
      const out = redact(`failed ${TOKEN} header ${b64}`, TOKEN);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(b64);
      expect(redact('plain', undefined)).toBe('plain');
    });
  });

  describe('pull requests', () => {
    const pr = (payload: Record<string, unknown>) => t.call('POST', `${base()}/pr`, payload);
    beforeEach(async () => {
      await connect();
      await clone();
    });

    it('opens a PR against the default branch', async () => {
      const res = await pr({ head: 'feature/x', title: 'Add feature', body: 'Details' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        url: 'https://github.com/octo/hello/pull/7',
        number: 7,
        base: 'main',
        head: 'feature/x',
      });
      const post = t.api.mock.calls.find(
        (c) => c[1]?.method === 'POST' && String(c[0]).endsWith('/pulls'),
      )!;
      expect(JSON.parse(post[1]!.body as string)).toEqual({
        title: 'Add feature',
        head: 'feature/x',
        base: 'main',
        body: 'Details',
      });
      expect(post[1]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('surfaces GitHub errors without leaking the token', async () => {
      t.api.mockImplementation(async (url) =>
        String(url).endsWith('/pulls')
          ? json(
              {
                message: 'Validation Failed',
                errors: [{ message: `No commits between ${TOKEN}` }],
              },
              422,
            )
          : json({ default_branch: 'main' }),
      );
      const res = await pr({ head: 'x', title: 't' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/Validation Failed/);
      expect(res.body).not.toContain(TOKEN);
    });

    it('validates input and requires a connection', async () => {
      expect((await pr({ head: 'x', title: '' })).statusCode).toBe(400);
      expect((await pr({ head: '-x', title: 't' })).statusCode).toBe(400);
      await t.call('DELETE', '/api/github');
      expect((await pr({ head: 'x', title: 't' })).statusCode).toBe(409);
    });
  });
});

describe.runIf(process.getuid?.() === 0)('privilege drop (running as root)', () => {
  it('runs git as the sandbox user, so files it creates are not root-owned', async () => {
    const t = await setup({ dropPrivileges: true });
    try {
      // uid 1000 must be able to traverse the test directories and write the bare remote.
      execFileSync('chmod', ['-R', 'a+rwX', t.root]);
      execFileSync('chown', ['-R', '1000:1000', t.remotes]);
      chmodSync(t.root, 0o755);
      await t.call('PUT', '/api/github', { token: TOKEN });
      const cloned = await t.call('POST', `/api/projects/${t.project.id}/github/clone`, {
        repo: 'octo/hello',
      });
      expect(cloned.statusCode, cloned.body).toBe(200);
      expect(statSync(join(t.ws, '.git')).uid).toBe(1000);
      expect(statSync(join(t.ws, 'README.md')).uid).toBe(1000);
      writeFileSync(join(t.ws, 'f.txt'), 'f');
      execFileSync('chown', ['1000:1000', join(t.ws, 'f.txt')]);
      const pushed = await t.call('POST', `/api/projects/${t.project.id}/github/push`, {
        branch: 'dropped',
      });
      expect(pushed.statusCode).toBe(200);
      expect(
        execFileSync('git', ['--git-dir', t.bare, 'log', '-1', '--format=%s', 'dropped'], {
          env: gitEnv,
        })
          .toString()
          .trim(),
      ).toBe('Update from Pi-Panel');
      // the panel's own secret key is unreadable by uid 1000
      const secret = join(t.dataDir, 'secret.key');
      writeFileSync(secret, 'x', { mode: 0o600 });
      expect(execFileSync('cat', [secret]).toString()).toBe('x'); // root can read it
      expect(() => execFileSync('cat', [secret], { uid: 1000, gid: 1000, stdio: 'pipe' })).toThrow(
        /Permission denied|status 1/,
      );
    } finally {
      await t.app.close();
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});

describe('parseRepo', () => {
  it.each([
    ['octo/hello', 'octo/hello'],
    ['https://github.com/octo/hello', 'octo/hello'],
    ['https://github.com/octo/hello.git', 'octo/hello'],
    ['https://github.com/octo/hello/', 'octo/hello'],
    ['  octo/hello.js  ', 'octo/hello.js'],
  ])('accepts %s', (input, expected) => expect(parseRepo(input)).toBe(expected));

  it.each([
    '',
    'octo',
    'octo/',
    '/hello',
    'a/b/c',
    'octo/..',
    '-octo/x',
    'ssh://github.com/o/r',
    'octo/he llo',
    42,
  ])('rejects %s', (input) => expect(() => parseRepo(input)).toThrow());
});
