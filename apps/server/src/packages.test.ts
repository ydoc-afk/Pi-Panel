import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { parseNpmSource } from './packages.js';
import { FakeRuntime } from './runtime.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const GOOD = {
  description: 'Handy tools',
  license: 'MIT',
  repository: { url: 'git+https://github.com/acme/pi-tools.git' },
  keywords: ['pi-package'],
  dependencies: { lodash: '^4.0.0' },
  pi: { extensions: ['./e.ts', './f.ts'], skills: ['./skills'] },
  dist: { unpackedSize: 1234, fileCount: 5 },
  _npmUser: { name: 'acme' },
};

/** Fake registry: the manifest is derived from the requested path, with a few special packages. */
function registry(url: string | URL | Request) {
  const [, rawName = '', spec = 'latest'] = new URL(String(url)).pathname.split('/');
  const name = decodeURIComponent(rawName);
  const version = /^\d/.test(spec) ? spec : '1.2.3';
  if (name === 'missing') return json({ error: 'not found' }, 404);
  if (name === 'down') return json({}, 503);
  if (name === 'liar') return json({ name: 'something-else', version });
  if (name === 'sketchy') {
    return json({
      name,
      version,
      scripts: { postinstall: 'node steal.js', test: 'x' },
      deprecated: 'use something safer',
    });
  }
  return json({ name, version, ...GOOD });
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-pkg-'));
  const runtime = new FakeRuntime();
  const db = openDb(':memory:');
  const fetchMock = vi.fn(async (url: string | URL | Request) => registry(url));
  let clock = 1_000_000;
  const app = buildApp({
    db,
    runtime,
    dataDir,
    fetch: fetchMock as unknown as typeof fetch,
    packages: { registry: 'https://registry.test', now: () => clock },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });
  const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
  const settings = join(dataDir, 'agents', String(project.id), 'settings.json');
  return {
    app,
    db,
    runtime,
    dataDir,
    call,
    project,
    fetchMock,
    settings,
    tick: (ms: number) => (clock += ms),
  };
}

describe('parseNpmSource', () => {
  it.each([
    ['npm:left-pad', { name: 'left-pad', spec: undefined }],
    ['npm:left-pad@1.3.0', { name: 'left-pad', spec: '1.3.0' }],
    ['npm:@acme/pi-tools', { name: '@acme/pi-tools', spec: undefined }],
    ['npm:@acme/pi-tools@2.0.0-beta.1', { name: '@acme/pi-tools', spec: '2.0.0-beta.1' }],
    ['  npm:x@latest ', { name: 'x', spec: 'latest' }],
  ])('accepts %s', (input, expected) => expect(parseNpmSource(input)).toEqual(expected));

  it.each([
    'git:github.com/a/b',
    'https://github.com/a/b',
    './local',
    '/abs/path',
    'left-pad',
    'npm:',
    'npm:--global',
    'npm:foo --ignore-scripts=false',
    'npm:foo;rm -rf /',
    'npm:../x',
    'npm:Foo',
    'npm:foo@^1.0.0',
    'npm:foo@>=1',
    'npm:foo@1.x',
    'npm:@scope',
    `npm:${'a'.repeat(300)}`,
    42,
    undefined,
  ])('rejects %s', (input) => expect(() => parseNpmSource(input)).toThrow());
});

describe('packages', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  const base = () => `/api/projects/${t.project.id}/packages`;
  const preview = (source: unknown) => t.call('POST', `${base()}/preview`, { source });
  const install = (source: unknown) => t.call('POST', base(), { source });
  const remove = (source: unknown) => t.call('POST', `${base()}/remove`, { source });
  const installed = async () =>
    (await t.call('GET', base())).json().packages as { source: string }[];

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: base() })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: base(), payload: {} })).statusCode).toBe(401);
  });

  describe('list', () => {
    it('is empty for a fresh project and tolerates a corrupt settings file', async () => {
      expect(await installed()).toEqual([]);
      writeFileSync(t.settings, '{not json');
      expect(await installed()).toEqual([]);
      writeFileSync(t.settings, JSON.stringify({ packages: 'nope' }));
      expect(await installed()).toEqual([]);
    });

    it('reads string and object entries and ignores junk', async () => {
      writeFileSync(
        t.settings,
        JSON.stringify({
          packages: [
            'npm:a@1.0.0',
            { source: 'npm:@s/b', extensions: [] },
            'git:github.com/x/y@v1',
            42,
            { source: 7 },
            '',
            'x'.repeat(400),
          ],
        }),
      );
      expect((await t.call('GET', base())).json().packages).toEqual([
        { source: 'npm:a@1.0.0', name: 'a', version: '1.0.0', filtered: false },
        { source: 'npm:@s/b', name: '@s/b', version: null, filtered: true },
        { source: 'git:github.com/x/y@v1', name: null, version: null, filtered: false },
      ]);
    });

    it('404s for an unknown project', async () => {
      expect((await t.call('GET', '/api/projects/999/packages')).statusCode).toBe(404);
    });
  });

  describe('preview', () => {
    it('resolves to an exact version and summarizes what to review', async () => {
      const res = await preview('npm:@acme/pi-tools');
      expect(res.statusCode).toBe(200);
      expect(t.fetchMock.mock.calls[0]![0]).toBe('https://registry.test/@acme%2Fpi-tools/latest');
      const r = res.json().review;
      expect(r).toMatchObject({
        source: 'npm:@acme/pi-tools@1.2.3',
        name: '@acme/pi-tools',
        version: '1.2.3',
        license: 'MIT',
        publisher: 'acme',
        dependencies: ['lodash@^4.0.0'],
        installScripts: [],
        resources: { extensions: 2, skills: 1, prompts: 0, themes: 0 },
        unpackedBytes: 1234,
        links: {
          npm: 'https://www.npmjs.com/package/@acme/pi-tools/v/1.2.3',
          files: 'https://unpkg.com/browse/@acme/pi-tools@1.2.3/',
        },
      });
      expect(r.warnings).toEqual([expect.stringMatching(/Includes extensions/)]);
    });

    it('looks up an explicit version', async () => {
      const r = (await preview('npm:left-pad@1.0.7')).json().review;
      expect(t.fetchMock.mock.calls[0]![0]).toBe('https://registry.test/left-pad/1.0.7');
      expect(r.source).toBe('npm:left-pad@1.0.7');
    });

    it('flags install scripts, deprecation, and missing provenance', async () => {
      const w: string[] = (await preview('npm:sketchy')).json().review.warnings;
      expect(w.join('\n')).toMatch(/Deprecated: use something safer/);
      expect(w.join('\n')).toMatch(/install-time scripts \(postinstall\)/);
      expect(w.join('\n')).toMatch(/Not marked as a pi package/);
      expect(w.join('\n')).toMatch(/No repository/);
      expect(w.join('\n')).toMatch(/No license/);
    });

    it('maps registry problems to clear errors', async () => {
      expect((await preview('npm:missing')).statusCode).toBe(404);
      expect((await preview('npm:down')).statusCode).toBe(502);
      expect((await preview('npm:liar')).statusCode).toBe(502);
      t.fetchMock.mockRejectedValueOnce(new Error('offline'));
      expect((await preview('npm:anything')).statusCode).toBe(502);
    });

    it('rejects unsupported sources without contacting the registry', async () => {
      for (const s of ['git:github.com/a/b', './local', 'npm:foo@^1', '--global']) {
        expect((await preview(s)).statusCode).toBe(400);
      }
      expect(t.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('install', () => {
    it('refuses to install anything that was not reviewed first', async () => {
      const res = await install('npm:acme@1.2.3');
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/Review this exact version/);
      expect(t.runtime.execs).toHaveLength(0);
    });

    it('refuses unpinned sources even after a review', async () => {
      await preview('npm:acme');
      expect((await install('npm:acme')).statusCode).toBe(400);
      expect((await install('npm:acme@latest')).statusCode).toBe(400);
    });

    it('only installs the exact version that was reviewed', async () => {
      await preview('npm:acme@1.2.3');
      expect((await install('npm:acme@1.2.4')).statusCode).toBe(409);
      expect((await install('npm:other@1.2.3')).statusCode).toBe(409);
      expect(t.runtime.execs).toHaveLength(0);
    });

    it('installs a reviewed package with install scripts disabled', async () => {
      const source = (await preview('npm:@acme/pi-tools')).json().review.source;
      const res = await install(source);
      expect(res.statusCode).toBe(200);
      expect(res.json().packages).toEqual([
        {
          source: 'npm:@acme/pi-tools@1.2.3',
          name: '@acme/pi-tools',
          version: '1.2.3',
          filtered: false,
        },
      ]);
      const exec = t.runtime.execs.find((e) => e.cmd[1] === 'install')!;
      expect(exec.cmd).toEqual(['pi', 'install', 'npm:@acme/pi-tools@1.2.3']);
      expect(exec.env).toEqual({
        PI_CODING_AGENT_DIR: '/home/sandbox/.pi/agent',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      });
      expect(JSON.parse(readFileSync(t.settings, 'utf8')).packages).toEqual([
        'npm:@acme/pi-tools@1.2.3',
      ]);
    });

    it('requires a fresh review once the previous one expires, and reviews are single-use', async () => {
      await preview('npm:acme@1.2.3');
      t.tick(16 * 60_000);
      expect((await install('npm:acme@1.2.3')).statusCode).toBe(409);
      await preview('npm:acme@1.2.3');
      expect((await install('npm:acme@1.2.3')).statusCode).toBe(200);
      expect((await install('npm:acme@1.2.3')).statusCode).toBe(409);
    });

    it('reports install failures and leaves the package list unchanged', async () => {
      await preview('npm:fail-pkg@1.0.0');
      const res = await install('npm:fail-pkg@1.0.0');
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/pi install failed: npm error 404/);
      expect(await installed()).toEqual([]);
    });

    it('requires a running project container', async () => {
      await preview('npm:acme@1.2.3');
      t.db.prepare("UPDATE projects SET status = 'stopped'").run();
      expect((await install('npm:acme@1.2.3')).statusCode).toBe(409);
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await preview('npm:acme@1.2.3');
      await install('npm:acme@1.2.3');
    });

    it('removes an installed package', async () => {
      const res = await remove('npm:acme@1.2.3');
      expect(res.statusCode).toBe(200);
      expect(res.json().packages).toEqual([]);
      expect(t.runtime.execs.find((e) => e.cmd[1] === 'remove')!.cmd).toEqual([
        'pi',
        'remove',
        'npm:acme@1.2.3',
      ]);
    });

    it('only accepts sources that are currently installed, so no arbitrary arguments reach the CLI', async () => {
      for (const s of ['npm:other@1.0.0', '--global', '-l', 'npm:acme@1.2.3 --local', 42]) {
        expect((await remove(s)).statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(t.runtime.execs.some((e) => e.cmd[1] === 'remove')).toBe(false);
      expect(await installed()).toHaveLength(1);
    });
  });

  describe('effect on sessions', () => {
    const startSession = async () => {
      const session = (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json()
        .session;
      return session as { id: number };
    };
    const rpcProcesses = () => t.runtime.processes.filter((p) => p.args[0] === '--mode');
    const until = async (cond: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 200; i++) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('condition not met in time');
    };
    const status = async (id: number) =>
      (await t.call('GET', `/api/sessions/${id}`)).json().session.status;

    it('restarts idle sessions so the next prompt loads the new package', async () => {
      const s = await startSession();
      await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'hi' });
      await until(async () => (await status(s.id)) === 'idle' && rpcProcesses().length === 1);
      await until(() => rpcProcesses()[0]!.received.length > 0);
      const first = rpcProcesses()[0]!;

      await preview('npm:acme@1.2.3');
      const res = await install('npm:acme@1.2.3');
      expect(res.json()).toMatchObject({ restartedSessions: 1, pendingSessions: 0 });
      expect(first.exited).toBe(true);
      expect(await status(s.id)).toBe('idle');

      expect(
        (await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'again' })).statusCode,
      ).toBe(200);
      const second = rpcProcesses()[1]!;
      expect(second.args).toContain('--session');
      expect(second.exited).toBe(false);
    });

    it('leaves a running session alone and reports it as pending', async () => {
      const s = await startSession();
      await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: '/hang' });
      await until(async () => (await status(s.id)) === 'running');
      await preview('npm:acme@1.2.3');
      const res = await install('npm:acme@1.2.3');
      expect(res.json()).toMatchObject({ restartedSessions: 0, pendingSessions: 1 });
      expect(rpcProcesses()[0]!.exited).toBe(false);
      await t.call('POST', `/api/sessions/${s.id}/abort`);
      await until(async () => (await status(s.id)) === 'idle');
    });
  });
});
