import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureToken, processRunner, updaterServer } from './updater-main.js';
import {
  PREVIOUS_TAG,
  Updater,
  cleanRemote,
  githubWebUrl,
  redact,
  schemaFromSource,
  settingsDrift,
  type Job,
  type Runner,
} from './updater.js';

const dbSource = (versions: number[]) =>
  `export const x = 1;\nconst MIGRATIONS = [\n${versions.map((v) => `  { version: ${v}, name: 'm${v}' },`).join('\n')}\n];\n`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare origin, a developer clone that pushes to it, and the panel's own checkout. */
function setupRepos(root: string) {
  const origin = join(root, 'origin.git');
  const dev = join(root, 'dev');
  const panel = join(root, 'panel');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, dev]);
  for (const repo of [dev]) {
    git(repo, 'config', 'user.email', 'dev@example.com');
    git(repo, 'config', 'user.name', 'Dev');
  }
  const commit = (file: string, content: string, message: string) => {
    mkdirSync(join(dev, file, '..'), { recursive: true });
    writeFileSync(join(dev, file), content);
    git(dev, 'add', '-A');
    git(dev, 'commit', '--quiet', '-m', message);
    return git(dev, 'rev-parse', 'HEAD');
  };
  commit('apps/server/src/db.ts', dbSource([1, 2]), 'Initial');
  git(dev, 'push', '--quiet', 'origin', 'main');
  git(dev, 'checkout', '--quiet', '-b', 'nightly');
  commit('apps/server/src/db.ts', dbSource([1, 2, 3]), 'Add migration 3');
  git(dev, 'push', '--quiet', 'origin', 'nightly');
  git(dev, 'checkout', '--quiet', 'main');
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', origin, panel]);
  git(panel, 'config', 'user.email', 'host@example.com');
  git(panel, 'config', 'user.name', 'Host');
  const pushMain = (message: string) => {
    git(dev, 'checkout', '--quiet', 'main');
    const sha = commit(`notes/${message}.txt`, message, message);
    git(dev, 'push', '--quiet', 'origin', 'main');
    return sha;
  };
  return { origin, dev, panel, pushMain };
}

interface DockerFake {
  calls: string[];
  composeEnv: Record<string, string>;
  containerEnv: string[];
  container: string;
  failBuild: boolean;
  /** Called when the panel is started, e.g. to simulate a migration of the database. */
  onUp?: () => void;
}

/** Real git (it is the subject); Docker answered by a script so every step can be checked. */
function runner(docker: DockerFake): Runner {
  const real = processRunner('/');
  return {
    async run(cmd, args, opts) {
      if (cmd === 'git') return real.run(cmd, args, opts);
      const line = args.join(' ');
      docker.calls.push(line);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (line === 'compose config --format json') {
        return ok(
          JSON.stringify({
            name: 'proj',
            services: { 'pi-panel': { environment: docker.composeEnv } },
          }),
        );
      }
      if (line === 'compose ps -q pi-panel') return ok(docker.container);
      if (args[0] === 'inspect') return ok(JSON.stringify(docker.containerEnv));
      if (args[0] === 'compose' && args[1] === 'build') {
        opts?.onLine?.('#1 building');
        return docker.failBuild ? { code: 1, stdout: '', stderr: 'build broke' } : ok();
      }
      if (args[0] === 'compose' && args[1] === 'up') docker.onUp?.();
      return ok();
    },
  };
}

function healthFetch(state: { up: boolean; schema: number }): typeof fetch {
  return (async () => {
    if (!state.up) throw new Error('connection refused');
    return new Response(JSON.stringify({ status: 'ok', schema: state.schema }));
  }) as typeof fetch;
}

async function settled(u: Updater): Promise<Job> {
  for (let i = 0; i < 500; i++) {
    const job = u.currentJob();
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

describe('updater', () => {
  let root: string;
  let repos: ReturnType<typeof setupRepos>;
  let dataDir: string;
  let docker: DockerFake;
  let health: { up: boolean; schema: number };
  let u: Updater;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'pp-updater-'));
    repos = setupRepos(root);
    dataDir = join(repos.panel, 'data');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'pi-panel.db'), 'database v2');
    writeFileSync(join(dataDir, 'secret.key'), 'key');
    docker = {
      calls: [],
      composeEnv: { DATA_DIR: '/data', TRUST_PROXY: 'false' },
      containerEnv: ['DATA_DIR=/data', 'TRUST_PROXY=false', 'PATH=/usr/bin'],
      container: 'abc123',
      failBuild: false,
    };
    health = { up: true, schema: 2 };
    u = new Updater({
      repo: repos.panel,
      dataDir,
      channels: ['main', 'nightly'],
      runner: runner(docker),
      healthUrl: 'http://pi-panel:3000/api/health',
      fetch: healthFetch(health),
      healthTimeoutMs: 200,
      healthIntervalMs: 5,
    });
    await u.load();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports the checkout and what each channel has that it does not', async () => {
    const tip = repos.pushMain('fix-a');
    repos.pushMain('fix-b');
    const s = await u.check();
    expect(s).toMatchObject({ branch: 'main', channel: 'main', dirty: false, schema: 2 });
    expect(s.remotes.main).toMatchObject({ behind: 2, ahead: 0, schema: 2 });
    expect(s.remotes.main!.commits.map((c) => c.subject)).toEqual(['fix-b', 'fix-a']);
    expect(s.remotes.main!.commits[1]!.sha).toBe(tip);
    expect(s.remotes.nightly).toMatchObject({ behind: 1, schema: 3 });
    expect(s.head.subject).toBe('Initial');
  });

  it('updates: builds while the old panel runs, backs up, restarts and waits for health', async () => {
    const before = git(repos.panel, 'rev-parse', 'HEAD');
    const tip = repos.pushMain('fix-a');
    await u.check();
    const started = await u.start('main', tip);
    expect(started).toMatchObject({ kind: 'update', status: 'running' });
    const job = await settled(u);
    expect(job.status).toBe('succeeded');
    expect(job.from.sha).toBe(before);
    expect(git(repos.panel, 'rev-parse', 'HEAD')).toBe(tip);
    expect(
      docker.calls.filter(
        (c) =>
          !c.startsWith('compose config') &&
          !c.startsWith('compose ps') &&
          !c.startsWith('inspect'),
      ),
    ).toEqual([
      `image tag proj-pi-panel proj-pi-panel:${PREVIOUS_TAG}`,
      `compose build --build-arg PI_PANEL_COMMIT=${tip} pi-panel`,
      'compose stop pi-panel',
      'compose up -d --no-deps --no-build pi-panel',
    ]);
    expect(readFileSync(join(job.backup!, 'pi-panel.db'), 'utf8')).toBe('database v2');
    expect(readFileSync(join(job.backup!, 'secret.key'), 'utf8')).toBe('key');
    expect(job.log.some((l) => l.includes('#1 building'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dataDir, 'updater', 'state.json'), 'utf8'));
    expect(saved.job.status).toBe('succeeded');
  });

  it('only installs the tip it was shown, on a known channel, as a full hash', async () => {
    const old = repos.pushMain('fix-a');
    repos.pushMain('fix-b');
    await expect(u.start('main', old)).rejects.toMatchObject({ status: 409 });
    await expect(u.start('feature', old)).rejects.toMatchObject({ status: 400 });
    // A channel the remote does not have: the reason the fetch failed is passed on.
    const narrow = new Updater({
      repo: repos.panel,
      dataDir,
      channels: ['main', 'beta'],
      runner: runner(docker),
      healthUrl: 'x',
      fetch: healthFetch(health),
    });
    await expect(narrow.start('beta', old)).rejects.toThrow(
      /origin\/beta was not found. Fetching it failed: .*beta/,
    );
    expect((await narrow.status()).fetchErrors).toHaveProperty('beta');
    await expect(u.start('main', old.slice(0, 7))).rejects.toMatchObject({ status: 400 });
    expect(docker.calls).toEqual([]);
  });

  it('refuses with uncommitted changes or local commits', async () => {
    const tip = repos.pushMain('fix-a');
    writeFileSync(join(repos.panel, 'apps/server/src/db.ts'), 'edited');
    await expect(u.start('main', tip)).rejects.toThrow(/uncommitted changes/);
    git(repos.panel, 'checkout', '--', '.');
    writeFileSync(join(repos.panel, 'local.txt'), 'mine');
    git(repos.panel, 'add', 'local.txt');
    git(repos.panel, 'commit', '--quiet', '-m', 'local');
    await expect(u.start('main', tip)).rejects.toThrow(/not a fast-forward/);
  });

  it('will not move to code that expects an older database', async () => {
    // Running nightly's schema 3, the stable channel only knows schema 2.
    health.schema = 3;
    const tip = repos.pushMain('fix-a');
    await expect(u.start('main', tip)).rejects.toThrow(/schema 3.*expects schema 2/);
  });

  it('refuses when the running panel has settings compose would drop', async () => {
    docker.containerEnv = ['DATA_DIR=/data', 'TRUST_PROXY=true'];
    const tip = repos.pushMain('fix-a');
    await expect(u.start('main', tip)).rejects.toThrow(/TRUST_PROXY.*\.env/);
    docker.container = '';
    docker.containerEnv = ['DATA_DIR=/data', 'TRUST_PROXY=false'];
    await expect(u.start('main', tip)).rejects.toThrow(/No running pi-panel container/);
  });

  it('puts the commit back when the build fails, and never stops the panel', async () => {
    const before = git(repos.panel, 'rev-parse', 'HEAD');
    docker.failBuild = true;
    await u.start('main', repos.pushMain('fix-a'));
    const job = await settled(u);
    expect(job.status).toBe('rolled-back');
    expect(job.error).toMatch(/build broke/);
    expect(git(repos.panel, 'rev-parse', 'HEAD')).toBe(before);
    expect(docker.calls).not.toContain('compose stop pi-panel');
  });

  it('rolls back image, commit and database when the new panel does not come up', async () => {
    const before = git(repos.panel, 'rev-parse', 'HEAD');
    let starts = 0;
    docker.onUp = () => {
      starts++;
      if (starts === 1) {
        // The new version migrates the database, then never answers.
        writeFileSync(join(dataDir, 'pi-panel.db'), 'database v3');
        health.up = false;
      } else {
        health.up = true;
      }
    };
    // Switching to nightly moves the schema from 2 to 3, so the backup must come back.
    await u.check();
    const nightlyTip = (await u.status()).remotes.nightly!.sha;
    await u.start('nightly', nightlyTip);
    const job = await settled(u);
    expect(job.status).toBe('rolled-back');
    expect(job.kind).toBe('switch');
    expect(git(repos.panel, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repos.panel, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(dataDir, 'pi-panel.db'), 'utf8')).toBe('database v2');
    expect(docker.calls).toContain(`image tag proj-pi-panel:${PREVIOUS_TAG} proj-pi-panel`);
  });

  it('switches channel when the schema allows it, and can roll that back by hand', async () => {
    await u.check();
    const tip = (await u.status()).remotes.nightly!.sha;
    await u.start('nightly', tip);
    expect((await settled(u)).status).toBe('succeeded');
    expect(git(repos.panel, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('nightly');
    writeFileSync(join(dataDir, 'pi-panel.db'), 'database v3');

    await u.rollback();
    const back = await settled(u);
    expect(back).toMatchObject({ kind: 'rollback', status: 'succeeded' });
    expect(git(repos.panel, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(dataDir, 'pi-panel.db'), 'utf8')).toBe('database v2');
    await expect(u.rollback()).rejects.toMatchObject({ status: 409 });
  });

  it('keeps data on a roll back when the schema did not change', async () => {
    await u.start('main', repos.pushMain('fix-a'));
    await settled(u);
    writeFileSync(join(dataDir, 'pi-panel.db'), 'new sessions');
    await u.rollback();
    expect((await settled(u)).status).toBe('succeeded');
    expect(readFileSync(join(dataDir, 'pi-panel.db'), 'utf8')).toBe('new sessions');
  });

  it('marks a job that was running when the updater stopped as failed', async () => {
    mkdirSync(join(dataDir, 'updater'), { recursive: true });
    writeFileSync(
      join(dataDir, 'updater', 'state.json'),
      JSON.stringify({ job: { id: 4, status: 'running', log: [], finishedAt: null } }),
    );
    const fresh = new Updater({
      repo: repos.panel,
      dataDir,
      channels: ['main'],
      runner: runner(docker),
      healthUrl: 'x',
      fetch: healthFetch(health),
    });
    await fresh.load();
    expect(fresh.currentJob()).toMatchObject({ id: 4, status: 'failed' });
  });
});

describe('updater helpers', () => {
  it('reads the schema number from db.ts', () => {
    expect(schemaFromSource(dbSource([1, 2, 3]))).toBe(3);
    expect(schemaFromSource('addMissingColumns(db, "x", { version: 9 })')).toBe(0);
  });

  it('strips credentials from remotes and finds GitHub pages', () => {
    expect(cleanRemote('https://user:tok@github.com/o/r.git\n')).toBe('https://github.com/o/r.git');
    expect(
      redact("fatal: unable to access 'https://x-access-token:ghp_abc@github.com/o/r/': 403"),
    ).toBe("fatal: unable to access 'https://github.com/o/r/': 403");
    expect(redact('see git@github.com:o/r.git and https://github.com/o/r')).toBe(
      'see git@github.com:o/r.git and https://github.com/o/r',
    );
    expect(githubWebUrl('https://github.com/ydoc-afk/Pi-Panel.git')).toBe(
      'https://github.com/ydoc-afk/Pi-Panel',
    );
    expect(githubWebUrl('git@github.com:ydoc-afk/Pi-Panel.git')).toBe(
      'https://github.com/ydoc-afk/Pi-Panel',
    );
    expect(githubWebUrl('/srv/git/pi-panel.git')).toBeNull();
  });

  it('finds settings that differ between compose and the container', () => {
    expect(settingsDrift({ A: '1', B: 'x', C: null }, ['A=1', 'B=y', 'PATH=/bin'])).toEqual(['B']);
    expect(settingsDrift({ A: '1' }, [])).toEqual(['A']);
  });
});

describe('updater HTTP API', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('creates a private token and refuses requests without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-updater-api-'));
    dirs.push(dir);
    const token = await ensureToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'updater', 'token')).mode & 0o777).toBe(0o600);
    expect(await ensureToken(dir)).toBe(token);

    const fake = {
      status: async () => ({ ok: true }),
      currentJob: () => ({ id: 1, log: ['a', 'b', 'c'] }),
    } as unknown as Updater;
    const server = updaterServer(fake, token).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/status`)).status).toBe(401);
      expect(
        (await fetch(`${base}/status`, { headers: { authorization: 'Bearer nope' } })).status,
      ).toBe(401);
      const auth = { authorization: `Bearer ${token}` };
      expect(await (await fetch(`${base}/status`, { headers: auth })).json()).toEqual({ ok: true });
      const job = await (await fetch(`${base}/job?after=2`, { headers: auth })).json();
      expect(job.job).toMatchObject({ log: ['c'], logLength: 3 });
      const bad = await fetch(`${base}/update`, { method: 'POST', headers: auth, body: '{}' });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
    expect(existsSync(join(dir, 'updater', 'token'))).toBe(true);
  });
});
