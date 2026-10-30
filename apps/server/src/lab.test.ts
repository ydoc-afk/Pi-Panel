import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { cleanRelPath } from './lab.js';
import { scaffoldFiles } from './lab-templates.js';
import { FakeRuntime, type ExecResult, type EphemeralSpec } from './runtime.js';

const report = (body: object) =>
  `noise before\n@@PI_LAB_REPORT_BEGIN@@\n${JSON.stringify(body)}\n@@PI_LAB_REPORT_END@@\n`;

async function setup(opts: { maxConcurrent?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-lab-'));
  const runtime = new FakeRuntime();
  const app = buildApp({
    db: openDb(':memory:'),
    runtime,
    dataDir,
    lab: { maxConcurrent: opts.maxConcurrent },
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
  const ws = join(dataDir, 'workspaces', String(project.id));
  const put = (rel: string, content: string | Buffer = 'x') => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  };
  return { app, runtime, dataDir, call, project, ws, put, headers };
}

describe('cleanRelPath', () => {
  it.each(['lab/x', 'a', 'a/b/c', 'lab/x/'])('accepts %s', (p) =>
    expect(() => cleanRelPath(p)).not.toThrow(),
  );
  it.each([
    '',
    '.',
    '..',
    '../x',
    'a/../../x',
    '/abs',
    'a\\b',
    'a\0b',
    42,
    undefined,
    'x'.repeat(300),
  ])('rejects %s', (p) => expect(() => cleanRelPath(p)).toThrow());
});

describe('lab', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });
  const base = () => `/api/projects/${t.project.id}/lab`;
  const packages = async () => (await t.call('GET', `${base()}/packages`)).json().packages;
  const run = (payload: Record<string, unknown>) => t.call('POST', `${base()}/run`, payload);

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: `${base()}/packages` })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ method: 'POST', url: `${base()}/run`, payload: {} })).statusCode,
    ).toBe(401);
  });

  describe('list', () => {
    it('finds packages by manifest, keyword, or resource directories', async () => {
      t.put(
        'a/package.json',
        JSON.stringify({ name: 'with-manifest', pi: { extensions: ['./e'] } }),
      );
      t.put('b/package.json', JSON.stringify({ name: 'by-keyword', keywords: ['pi-package'] }));
      t.put('c/skills/x/SKILL.md');
      t.put('c/themes/t.json');
      t.put('plain/package.json', JSON.stringify({ name: 'not-pi' }));
      t.put('plain/readme.md');
      expect(await packages()).toEqual([
        { path: 'a', name: 'with-manifest', kinds: [] },
        { path: 'b', name: 'by-keyword', kinds: [] },
        { path: 'c', name: null, kinds: ['skill', 'theme'] },
      ]);
    });

    it('ignores node_modules, hidden dirs, symlinks, and the insides of packages', async () => {
      t.put(
        'node_modules/dep/package.json',
        JSON.stringify({ name: 'dep', keywords: ['pi-package'] }),
      );
      t.put('.hidden/package.json', JSON.stringify({ name: 'h', keywords: ['pi-package'] }));
      t.put('outer/package.json', JSON.stringify({ name: 'outer', keywords: ['pi-package'] }));
      t.put(
        'outer/inner/package.json',
        JSON.stringify({ name: 'inner', keywords: ['pi-package'] }),
      );
      mkdirSync(join(t.dataDir, 'elsewhere', 'skills'), { recursive: true });
      symlinkSync(join(t.dataDir, 'elsewhere'), join(t.ws, 'linked'));
      expect((await packages()).map((p: { path: string }) => p.path)).toEqual(['outer']);
    });

    it('tolerates a broken package.json and 404s for unknown projects', async () => {
      t.put('x/package.json', '{not json');
      t.put('x/extensions/a.ts');
      expect(await packages()).toEqual([{ path: 'x', name: null, kinds: ['extension'] }]);
      expect((await t.call('GET', '/api/projects/999/lab/packages')).statusCode).toBe(404);
    });
  });

  describe('scaffold', () => {
    const scaffold = (payload: Record<string, unknown>) =>
      t.call('POST', `${base()}/scaffold`, payload);

    it('writes a starter package for the chosen kinds and returns sample tests', async () => {
      const res = await scaffold({
        name: 'my-tools',
        kinds: ['extension', 'skill', 'prompt', 'theme'],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.package).toEqual({
        path: 'lab/my-tools',
        name: 'my-tools',
        kinds: ['extension', 'skill', 'prompt', 'theme'],
      });
      expect(body.files).toEqual([
        'package.json',
        'extensions/my-tools.ts',
        'skills/my-tools/SKILL.md',
        'prompts/my-tools.md',
        'themes/my-tools.json',
      ]);
      expect(body.sampleTests).toEqual([
        { tool: 'my_tools_greet', input: { name: 'World' }, expectContains: 'Hello, World!' },
      ]);
      expect(await packages()).toEqual([
        {
          path: 'lab/my-tools',
          name: 'my-tools',
          kinds: ['extension', 'skill', 'prompt', 'theme'],
        },
      ]);
    });

    it('only writes what was asked for and omits sample tests without an extension', async () => {
      const res = await scaffold({ name: 'just-a-skill', kinds: ['skill'] });
      expect(res.json().files).toEqual(['package.json', 'skills/just-a-skill/SKILL.md']);
      expect(res.json().sampleTests).toEqual([]);
    });

    it('rejects bad names and kinds, existing packages, and a symlinked lab directory', async () => {
      for (const name of ['', 'Upper', '../x', 'a b', '-lead', 'x'.repeat(41), 42]) {
        expect((await scaffold({ name, kinds: ['skill'] })).statusCode).toBe(400);
      }
      for (const kinds of [[], ['bogus'], 'skill', undefined]) {
        expect((await scaffold({ name: 'ok', kinds })).statusCode).toBe(400);
      }
      expect((await scaffold({ name: 'dup', kinds: ['skill'] })).statusCode).toBe(201);
      expect((await scaffold({ name: 'dup', kinds: ['skill'] })).statusCode).toBe(409);
      symlinkSync(tmpdir(), join(t.ws, 'lab-link'));
      rmSync(join(t.ws, 'lab'), { recursive: true });
      symlinkSync(tmpdir(), join(t.ws, 'lab'));
      expect((await scaffold({ name: 'evil', kinds: ['skill'] })).statusCode).toBe(409);
    });

    it('generates valid JSON and the expected template content', () => {
      const files = scaffoldFiles('demo-pkg', ['extension', 'theme']);
      const pkg = JSON.parse(files.find((f) => f.path === 'package.json')!.content);
      expect(pkg).toMatchObject({
        name: 'demo-pkg',
        keywords: ['pi-package'],
        pi: { extensions: ['./extensions'], themes: ['./themes'] },
      });
      const theme = JSON.parse(files.find((f) => f.path === 'themes/demo-pkg.json')!.content);
      expect(theme.name).toBe('demo-pkg');
      expect(Object.keys(theme.colors).length).toBeGreaterThan(20);
      expect(files.find((f) => f.path === 'extensions/demo-pkg.ts')!.content).toContain(
        'name: "demo_pkg_greet"',
      );
    });
  });

  describe('run', () => {
    beforeEach(() => {
      t.put('lab/p/package.json', JSON.stringify({ name: 'p', keywords: ['pi-package'] }));
      t.put('lab/p/extensions/a.ts', 'export default function () {}');
      t.put('lab/p/run.sh', '#!/bin/sh\n');
    });
    const last = () => t.runtime.ephemerals.at(-1)!;
    const answer = (result: Partial<ExecResult>) => {
      t.runtime.ephemeralHandler = () => ({
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...result,
      });
    };

    it('copies the package into a network-less, credential-less throwaway container', async () => {
      answer({ stdout: report({ ok: true, tools: [] }) });
      const res = await run({
        path: 'lab/p',
        tests: [{ tool: 't', input: { a: 1 }, expectContains: 'x' }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'completed', report: { ok: true } });
      const spec: EphemeralSpec = last();
      expect(spec.networkDisabled).toBe(true);
      expect(spec.cmd).toEqual(['node', '/lab/harness.mjs']);
      expect(Object.keys(spec.env ?? {}).sort()).toEqual(
        [
          'HOME',
          'NPM_CONFIG_UPDATE_NOTIFIER',
          'PI_OFFLINE',
          'PI_SKIP_VERSION_CHECK',
          'PI_TELEMETRY',
        ].sort(),
      );
      const paths = spec.files.map((f) => f.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'lab/harness.mjs',
          'lab/job.json',
          'lab/pkg/package.json',
          'lab/pkg/extensions/',
          'lab/pkg/extensions/a.ts',
        ]),
      );
      expect(spec.files.every((f) => f.uid === 1000 && f.gid === 1000)).toBe(true);
      expect(spec.files.find((f) => f.path === 'lab/pkg/run.sh')!.mode).toBe(0o644);
      expect(
        JSON.parse(spec.files.find((f) => f.path === 'lab/job.json')!.content!.toString()),
      ).toEqual({
        tests: [{ tool: 't', input: { a: 1 }, expectContains: 'x' }],
        testTimeoutMs: 30000,
      });
    });

    it('does not copy node_modules, .git, symlinks, or oversized files, and says so', async () => {
      t.put('lab/p/node_modules/dep/index.js');
      t.put('lab/p/.git/config');
      t.put('lab/p/big.bin', Buffer.alloc(3 * 1024 * 1024));
      mkdirSync(join(t.dataDir, 'secret-dir'), { recursive: true });
      writeFileSync(join(t.dataDir, 'secret-dir', 'k'), 'secret');
      symlinkSync(join(t.dataDir, 'secret-dir'), join(t.ws, 'lab/p/escape'));
      symlinkSync(join(t.dataDir, 'secret-dir', 'k'), join(t.ws, 'lab/p/escape-file'));
      answer({ stdout: report({ ok: true }) });
      const res = await run({ path: 'lab/p' });
      const paths = last()
        .files.map((f) => f.path)
        .join('\n');
      expect(paths).not.toMatch(/node_modules|\.git|escape|big\.bin|secret/);
      const skipped: string[] = res.json().run.skipped;
      expect(skipped.join('\n')).toMatch(/node_modules/);
      expect(skipped.join('\n')).toMatch(/escape \(symlink\)/);
      expect(skipped.join('\n')).toMatch(/escape-file \(symlink\)/);
      expect(skipped.join('\n')).toMatch(/big\.bin \(over/);
    });

    it('rejects traversal, absolute paths, and symlinks that leave the workspace', async () => {
      mkdirSync(join(t.dataDir, 'outside'), { recursive: true });
      symlinkSync(join(t.dataDir, 'outside'), join(t.ws, 'sneaky'));
      for (const path of ['../x', '/etc', 'lab/../../x', '', 'sneaky']) {
        expect((await run({ path })).statusCode).toBe(400);
      }
      expect((await run({ path: 'lab/missing' })).statusCode).toBe(404);
      t.put('file.txt');
      expect((await run({ path: 'file.txt' })).statusCode).toBe(400);
      expect(t.runtime.ephemerals).toHaveLength(0);
    });

    it('validates tests', async () => {
      const bad: unknown[] = [
        'x',
        [{ tool: '', input: {} }],
        [{ tool: 't' }],
        [{ tool: 't', input: [] }],
        [{ tool: 't', input: {}, expectContains: 5 }],
        [{ tool: 't', input: {}, expectError: 'yes' }],
        [{ tool: 't', input: { big: 'x'.repeat(70_000) } }],
        Array.from({ length: 21 }, () => ({ tool: 't', input: {} })),
      ];
      for (const tests of bad) expect((await run({ path: 'lab/p', tests })).statusCode).toBe(400);
      expect(t.runtime.ephemerals).toHaveLength(0);
    });

    it('refuses packages that are too large', async () => {
      for (let i = 0; i < 6; i++) t.put(`lab/p/blob${i}.bin`, Buffer.alloc(1900 * 1024));
      const res = await run({ path: 'lab/p' });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toMatch(/too large/);
    });

    it('reports a timeout, a missing report, and runtime failures distinctly', async () => {
      answer({ timedOut: true, code: null, stdout: 'partial' });
      expect(await run({ path: 'lab/p' }).then((r) => r.json())).toMatchObject({
        status: 'timeout',
        report: null,
      });

      answer({ stdout: 'just logs', stderr: 'e'.repeat(5000), code: 1 });
      const none = (await run({ path: 'lab/p' })).json();
      expect(none).toMatchObject({ status: 'no-report', report: null, run: { exitCode: 1 } });
      expect(none.run.stderr).toHaveLength(2000);

      t.runtime.ephemeralHandler = () => {
        throw new Error('docker exploded');
      };
      const res = await run({ path: 'lab/p' });
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain('docker exploded');
    });

    it('trusts only the last, well-formed report block', async () => {
      answer({
        stdout: `${report({ ok: true, forged: true })}${report({ ok: false, real: true })}`,
      });
      expect((await run({ path: 'lab/p' })).json().report).toEqual({ ok: false, real: true });
      answer({ stdout: '@@PI_LAB_REPORT_BEGIN@@\n[1,2]\n@@PI_LAB_REPORT_END@@' });
      expect((await run({ path: 'lab/p' })).json().status).toBe('no-report');
      answer({
        stdout: `@@PI_LAB_REPORT_BEGIN@@\n${JSON.stringify({ pad: 'x'.repeat(600 * 1024) })}\n@@PI_LAB_REPORT_END@@`,
      });
      expect((await run({ path: 'lab/p' })).json().status).toBe('no-report');
    });

    it('allows one run per project at a time', async () => {
      let release!: (r: ExecResult) => void;
      t.runtime.ephemeralHandler = () => new Promise<ExecResult>((r) => (release = r));
      const first = run({ path: 'lab/p' });
      for (let i = 0; i < 100 && t.runtime.ephemerals.length === 0; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect((await run({ path: 'lab/p' })).statusCode).toBe(429);
      release({ code: 0, stdout: report({ ok: true }), stderr: '', timedOut: false });
      expect((await first).statusCode).toBe(200);
      answer({ stdout: report({ ok: true }) });
      expect((await run({ path: 'lab/p' })).statusCode).toBe(200);
    });
  });
});

describe('lab global concurrency', () => {
  it('caps simultaneous runs across projects', async () => {
    const t = await setup({ maxConcurrent: 1 });
    try {
      const other = (await t.call('POST', '/api/projects', { name: 'q' })).json().project;
      for (const id of [t.project.id, other.id]) {
        const dir = join(t.dataDir, 'workspaces', String(id), 'pkg');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{}');
      }
      let release!: (r: ExecResult) => void;
      t.runtime.ephemeralHandler = () => new Promise<ExecResult>((r) => (release = r));
      const first = t.call('POST', `/api/projects/${t.project.id}/lab/run`, { path: 'pkg' });
      for (let i = 0; i < 100 && t.runtime.ephemerals.length === 0; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect(
        (await t.call('POST', `/api/projects/${other.id}/lab/run`, { path: 'pkg' })).statusCode,
      ).toBe(429);
      release({ code: 0, stdout: report({ ok: true }), stderr: '', timedOut: false });
      await first;
    } finally {
      await t.app.close();
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });
});
