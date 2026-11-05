import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentNote } from './agent-note.js';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';
import { pickFolder } from './repo-store.js';

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
  execFileSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    env: gitEnv,
    stdio: 'pipe',
  }).toString();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A bare repository `owner/name` under `remotes`, seeded with one commit on main. */
function seedRemote(root: string, remotes: string, slug: string) {
  const bare = join(remotes, `${slug}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(root, 'seed-'));
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), `# ${slug}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', bare, 'main');
  return { bare, seed };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pp-repos-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const ghRemotes = join(root, 'gh');
  const fgRemotes = join(root, 'fg');
  const hello = seedRemote(root, ghRemotes, 'octo/hello');
  const lib = seedRemote(root, ghRemotes, 'octo/lib');
  // Same name as the GitHub one, on the other forge: both want the folder "hello".
  const fgHello = seedRemote(root, fgRemotes, 'codyw/hello');

  const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/user')) return json({ login: 'octocat', id: 1 });
    if (u.endsWith('/repos/octo/hello')) return json({ default_branch: 'main' });
    if (u.endsWith('/repos/octo/hello/pulls') && init?.method === 'POST') {
      return json({ html_url: 'https://github.com/octo/hello/pull/3', number: 3 });
    }
    return json({ message: 'Not Found' }, 404);
  });
  const app = buildApp({
    db: openDb(':memory:'),
    runtime: new FakeRuntime(),
    dataDir,
    fetch: api as unknown as typeof fetch,
    github: { webBase: `file://${ghRemotes}`, allowProtocols: ['file'], dropPrivileges: false },
    forgejo: { webBase: `file://${fgRemotes}`, allowProtocols: ['file'], dropPrivileges: false },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const headers = {
    cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`,
  };
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  await call('PUT', '/api/github', { token: 'ghp_SECRETTOKEN1234567890' });
  await call('PUT', '/api/forgejo', {
    token: 'fgj_SECRETTOKEN1234567890',
    baseUrl: 'http://forgejo.test',
  });
  const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
  return {
    root,
    dataDir,
    app,
    call,
    project,
    hello,
    lib,
    fgHello,
    ws: join(dataDir, 'workspaces', String(project.id)),
    base: `/api/projects/${project.id}/repos`,
  };
}

describe('pickFolder', () => {
  it('names the folder after the repository, safely and uniquely', () => {
    expect(pickFolder('octo/hello', [])).toBe('hello');
    expect(pickFolder('octo/hello', ['hello'])).toBe('hello-2');
    expect(pickFolder('octo/hello', ['Hello', 'hello-2'])).toBe('hello-3');
    expect(pickFolder('octo/.hidden', [])).toBe('hidden');
    expect(pickFolder('octo/a b', [])).toBe('a-b');
    expect(pickFolder('octo/.git', [])).toBe('repo');
  });
});

describe('several repositories per project', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.root, { recursive: true, force: true });
  });

  const add = (host: string, repo: string) => t.call('POST', t.base, { host, repo });
  const list = async () => (await t.call('GET', t.base)).json();

  it('clones each repository into its own folder, whichever forge it is on', async () => {
    const a = await add('github', 'octo/hello');
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ path: '/workspace/hello', branch: 'main' });
    expect((await add('github', 'octo/lib')).json().path).toBe('/workspace/lib');
    // Same name on the other forge gets a different folder.
    expect((await add('forgejo', 'codyw/hello')).json().path).toBe('/workspace/hello-2');

    expect(existsSync(join(t.ws, 'hello', 'README.md'))).toBe(true);
    expect(existsSync(join(t.ws, 'hello-2', 'README.md'))).toBe(true);
    const { repos, accounts } = await list();
    expect(repos.map((r: { repo: string }) => r.repo)).toEqual([
      'octo/hello',
      'octo/lib',
      'codyw/hello',
    ]);
    expect(repos[0]).toMatchObject({ host: 'github', included: true, branch: 'main', changes: 0 });
    expect(accounts).toEqual({ github: true, forgejo: true });
    // The project list still shows the first repository.
    expect((await t.call('GET', `/api/projects/${t.project.id}`)).json().project.repo).toBe(
      'octo/hello',
    );
  });

  it('refuses a repository that is already part of the project', async () => {
    await add('github', 'octo/hello');
    const again = await add('github', 'octo/hello');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('already part of this project');
  });

  it('leaves nothing behind when a clone fails, and can retry', async () => {
    const bad = await add('github', 'octo/nothere');
    expect(bad.statusCode).toBe(409);
    expect(existsSync(join(t.ws, 'nothere'))).toBe(false);
    expect((await list()).repos).toHaveLength(0);
    expect((await add('github', 'octo/hello')).statusCode).toBe(201);
  });

  it('keeps a repository added next to a root one out of the root repository', async () => {
    // A project that predates this: its repository is the workspace root.
    expect(
      (await t.call('POST', `/api/projects/${t.project.id}/github/clone`, { repo: 'octo/hello' }))
        .statusCode,
    ).toBe(200);
    expect(existsSync(join(t.ws, 'README.md'))).toBe(true);
    expect((await list()).repos[0].path).toBe('/workspace');

    const added = await add('github', 'octo/lib');
    expect(added.json().path).toBe('/workspace/lib');
    expect(readFileSync(join(t.ws, '.git', 'info', 'exclude'), 'utf8')).toContain('/lib/');
    expect(git(t.ws, 'status', '--porcelain')).toBe('');
  });

  it('pulls fast-forward only, reports a diverged branch, and pulls all included', async () => {
    const hello = (await add('github', 'octo/hello')).json();
    await add('github', 'octo/lib');
    writeFileSync(join(t.hello.seed, 'new.txt'), 'x\n');
    git(t.hello.seed, 'add', '-A');
    git(t.hello.seed, 'commit', '-m', 'upstream');
    git(t.hello.seed, 'push', t.hello.bare, 'main');

    const pulled = await t.call('POST', `${t.base}/${hello.id}/pull`);
    expect(pulled.json()).toMatchObject({ repo: 'octo/hello', branch: 'main', updated: true });
    expect(existsSync(join(t.ws, 'hello', 'new.txt'))).toBe(true);
    expect((await t.call('POST', `${t.base}/${hello.id}/pull`)).json().updated).toBe(false);

    // A local commit and a different upstream one: not merged, reported.
    writeFileSync(join(t.ws, 'hello', 'mine.txt'), 'm\n');
    git(join(t.ws, 'hello'), 'add', '-A');
    git(join(t.ws, 'hello'), 'commit', '-m', 'local');
    writeFileSync(join(t.hello.seed, 'other.txt'), 'o\n');
    git(t.hello.seed, 'add', '-A');
    git(t.hello.seed, 'commit', '-m', 'upstream 2');
    git(t.hello.seed, 'push', t.hello.bare, 'main');
    const diverged = await t.call('POST', `${t.base}/${hello.id}/pull`);
    expect(diverged.statusCode).toBe(409);
    expect(diverged.json().error).toContain('Pull failed');

    const all = (await t.call('POST', `${t.base}/pull`)).json().results;
    expect(all).toHaveLength(2);
    expect(all.find((r: { repo: string }) => r.repo === 'octo/hello').ok).toBe(false);
    expect(all.find((r: { repo: string }) => r.repo === 'octo/lib').ok).toBe(true);
  });

  it('only touches included repositories when pulling and pushing all', async () => {
    const hello = (await add('github', 'octo/hello')).json();
    const lib = (await add('github', 'octo/lib')).json();
    expect((await t.call('PATCH', `${t.base}/${lib.id}`, { included: false })).json()).toEqual({
      id: lib.id,
      included: false,
    });
    expect((await t.call('PATCH', `${t.base}/${lib.id}`, { included: 'no' })).statusCode).toBe(400);

    writeFileSync(join(t.ws, 'hello', 'a.txt'), 'a\n');
    writeFileSync(join(t.ws, 'lib', 'b.txt'), 'b\n');
    const pushed = (await t.call('POST', `${t.base}/push`, { message: 'Update both' })).json()
      .results;
    expect(pushed.map((r: { repo: string }) => r.repo)).toEqual(['octo/hello']);
    expect(pushed[0]).toMatchObject({ ok: true, branch: 'main', committed: true });
    expect(git(t.hello.bare, 'log', '--format=%s', '-1', 'main').trim()).toBe('Update both');
    expect(git(t.lib.bare, 'log', '--format=%s', '-1', 'main').trim()).toBe('initial');

    expect((await list()).repos.find((r: { id: number }) => r.id === lib.id).changes).toBe(1);
    expect(hello.id).not.toBe(lib.id);
  });

  it('pushes one repository on a branch and opens a pull request on the right forge', async () => {
    const hello = (await add('github', 'octo/hello')).json();
    writeFileSync(join(t.ws, 'hello', 'f.txt'), 'f\n');
    const push = await t.call('POST', `${t.base}/${hello.id}/push`, {
      branch: 'topic',
      message: 'Add f',
    });
    expect(push.json()).toMatchObject({ repo: 'octo/hello', branch: 'topic', committed: true });
    expect(git(t.hello.bare, 'rev-parse', '--verify', 'topic').trim()).toHaveLength(40);

    const pr = await t.call('POST', `${t.base}/${hello.id}/pr`, { head: 'topic', title: 'Add f' });
    expect(pr.statusCode).toBe(201);
    expect(pr.json()).toMatchObject({ number: 3, base: 'main', head: 'topic' });
  });

  it('forgets a repository without deleting its files', async () => {
    const hello = (await add('github', 'octo/hello')).json();
    expect((await t.call('DELETE', `${t.base}/${hello.id}`)).statusCode).toBe(204);
    expect((await list()).repos).toHaveLength(0);
    expect(existsSync(join(t.ws, 'hello', 'README.md'))).toBe(true);
    expect((await t.call('GET', `/api/projects/${t.project.id}`)).json().project.repo).toBeNull();
    expect((await t.call('DELETE', `${t.base}/${hello.id}`)).statusCode).toBe(404);
  });

  it('reports a repository whose folder was removed instead of failing the whole list', async () => {
    await add('github', 'octo/hello');
    await add('github', 'octo/lib');
    rmSync(join(t.ws, 'lib'), { recursive: true, force: true });
    const { repos } = await list();
    expect(repos[0].error).toBeUndefined();
    expect(repos[1].error).toContain('missing');
  });

  it('refuses unknown projects, repositories and hosts', async () => {
    expect((await t.call('GET', '/api/projects/999/repos')).statusCode).toBe(404);
    expect((await t.call('POST', t.base, { host: 'gitlab', repo: 'a/b' })).statusCode).toBe(400);
    expect((await t.call('PATCH', `${t.base}/999`, { included: true })).statusCode).toBe(404);
    expect((await t.call('POST', `${t.base}/999/pull`)).statusCode).toBe(404);
  });
});

describe('the agent and several repositories', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.root, { recursive: true, force: true });
  });

  it('is told where each repository is and which are included', async () => {
    const note = agentNote(
      [
        { repo: 'octo/hello', host: null, folder: 'hello', included: true },
        { repo: 'codyw/lib', host: 'forgejo', folder: 'lib', included: false },
      ],
      null,
    )!;
    expect(note).toContain('2 repositories');
    expect(note).toContain('`octo/hello` (GitHub) in `/workspace/hello`: included');
    expect(note).toContain('`codyw/lib` (Forgejo) in `/workspace/lib`: NOT included');
    expect(note).not.toContain('pass `repo`');
    const both = agentNote(
      [
        { repo: 'a/b', host: null, folder: 'b', included: true },
        { repo: 'c/d', host: null, folder: 'd', included: true },
      ],
      null,
    )!;
    expect(both).toContain('pass `repo` (owner/name)');
  });
});

describe('the agent tools across repositories', () => {
  // Uses the real default pusher through the session dialog path, via the service it is built on.
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.root, { recursive: true, force: true });
  });

  /** Sends a prompt, approves any confirmation it raises, and returns the events once this turn settles. */
  async function ask(sessionId: number, text: string) {
    type Ev = { event: { type?: string; method?: string; id?: string } };
    const read = async () =>
      (await t.call('GET', `/api/sessions/${sessionId}/events`)).json().events as Ev[];
    const settled = (events: Ev[]) => events.filter((e) => e.event.type === 'agent_settled').length;
    const before = settled(await read());
    const answered = new Set<string>();
    await t.call('POST', `/api/sessions/${sessionId}/prompt`, { message: text });
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const events = await read();
      for (const e of events) {
        if (e.event.method === 'confirm' && e.event.id && !answered.has(e.event.id)) {
          answered.add(e.event.id);
          await t.call('POST', `/api/sessions/${sessionId}/ui-response`, {
            id: e.event.id,
            confirmed: true,
          });
        }
      }
      if (settled(events) > before) return JSON.stringify(events);
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('did not settle');
  }

  it('needs a repo name when several are included, and refuses one that is not included', async () => {
    const hello = (await t.call('POST', t.base, { host: 'github', repo: 'octo/hello' })).json();
    const lib = (await t.call('POST', t.base, { host: 'github', repo: 'octo/lib' })).json();
    const session = (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json()
      .session;

    // Two included, none named: refused at once, naming both.
    const ambiguous = await ask(session.id, '/push {"branch":"main"}');
    expect(ambiguous).toContain('Several repositories are included');
    expect(ambiguous).toContain('octo/hello, octo/lib');

    await t.call('PATCH', `${t.base}/${lib.id}`, { included: false });
    writeFileSync(join(t.ws, 'hello', 'agent.txt'), 'x\n');
    // One included: no name needed, and it is pushed after approval.
    const ok = await ask(session.id, '/push {"branch":"main","message":"From the agent"}');
    expect(ok).toContain('octo/hello');
    expect(git(t.hello.bare, 'log', '--format=%s', '-1', 'main').trim()).toBe('From the agent');

    // Naming the excluded one is refused.
    const refused = await ask(session.id, '/push {"repo":"octo/lib","branch":"main"}');
    expect(refused).toContain('not included in pushes');
    expect(git(t.lib.bare, 'log', '--format=%s', '-1', 'main').trim()).toBe('initial');
    expect(hello.id).toBeGreaterThan(0);
  });
});

describe('what members may do', () => {
  it('keeps clone, pull and push (which use the admin’s forge accounts) away from members', async () => {
    const { memberBlocked } = await import('./auth.js');
    const P = '/api/projects/:id/repos';
    for (const [method, path] of [
      ['POST', P],
      ['POST', `${P}/push`],
      ['POST', `${P}/pull`],
      ['POST', `${P}/:rid/push`],
      ['POST', `${P}/:rid/pull`],
      ['POST', `${P}/:rid/pr`],
    ] as const) {
      expect(memberBlocked(method, path), `${method} ${path}`).toBe(true);
    }
    // Looking at the list, choosing what is included and forgetting a repository stay open.
    expect(memberBlocked('GET', P)).toBe(false);
    expect(memberBlocked('PATCH', `${P}/:rid`)).toBe(false);
    expect(memberBlocked('DELETE', `${P}/:rid`)).toBe(false);
  });
});

describe('migration 7', () => {
  it('turns each existing project repository into a root repository row', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-mig-'));
    const path = join(root, 'db.sqlite');
    const db = openDb(path);
    db.prepare(
      "INSERT INTO projects (name, status, created_at, repo, repo_host) VALUES ('a','running',1,'o/r','forgejo')",
    ).run();
    db.prepare(
      "INSERT INTO projects (name, status, created_at, repo) VALUES ('b','running',1,'o/g')",
    ).run();
    db.prepare("INSERT INTO projects (name, status, created_at) VALUES ('c','running',1)").run();
    db.exec('DROP TABLE project_repos; DELETE FROM schema_migrations WHERE version = 7');
    db.close();

    const again = openDb(path);
    expect(
      again
        .prepare(
          'SELECT project_id, host, repo, folder, included FROM project_repos ORDER BY project_id',
        )
        .all(),
    ).toEqual([
      { project_id: 1, host: 'forgejo', repo: 'o/r', folder: '', included: 1 },
      { project_id: 2, host: 'github', repo: 'o/g', folder: '', included: 1 },
    ]);
    again.close();
    rmSync(root, { recursive: true, force: true });
  });
});
