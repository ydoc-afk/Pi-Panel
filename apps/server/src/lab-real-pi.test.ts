// End-to-end check of the lab against the real pi SDK. Everything runs locally except Docker: the
// fake runtime unpacks the same tar archive into a temp dir and runs the same harness script.
// Enable with PI_SDK_ENTRY=<path to node_modules/@earendil-works/pi-coding-agent/dist/index.js>.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createTar } from './tar.js';
import { FakeRuntime, type EphemeralSpec, type ExecResult } from './runtime.js';

const SDK = process.env.PI_SDK_ENTRY;
const HARNESS = new URL('../assets/lab-harness.mjs', import.meta.url).pathname;
const run = promisify(execFile);

describe.runIf(SDK)('lab against the real pi SDK', () => {
  let dataDir: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let projectId: number;
  let ws: string;
  const scratch: string[] = [];

  /** Stand-in for Docker: unpack the archive and run the harness exactly as the container would. */
  async function runLocally(spec: EphemeralSpec): Promise<ExecResult> {
    const root = mkdtempSync(join(tmpdir(), 'pp-lab-real-'));
    scratch.push(root);
    execFileSync('tar', ['-xf', '-', '-C', root], { input: createTar(spec.files) });
    try {
      const { stdout, stderr } = await run(
        'node',
        [spec.cmd[1]!.replace('/lab/', `${root}/lab/`)],
        {
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'lab/home'),
            LAB_ROOT: join(root, 'lab'),
            PI_SDK_ENTRY: SDK,
          },
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return { code: 0, stdout, stderr, timedOut: false };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', timedOut: false };
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-lab-real-data-'));
    const runtime = new FakeRuntime();
    runtime.ephemeralHandler = runLocally;
    app = buildApp({ db: openDb(':memory:'), runtime, dataDir, lab: { harnessPath: HARNESS } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    projectId = (
      await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'p' } })
    ).json().project.id;
    ws = join(dataDir, 'workspaces', String(projectId));
  });

  afterAll(async () => {
    await app?.close();
    for (const d of [dataDir, ...scratch]) rmSync(d, { recursive: true, force: true });
  });

  const call = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/projects/${projectId}/lab/${url}`, headers, payload });
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  };

  it('loads and tests a freshly scaffolded package with all four resource kinds', async () => {
    const scaffold = await call('scaffold', {
      name: 'my-tools',
      kinds: ['extension', 'skill', 'prompt', 'theme'],
    });
    expect(scaffold.statusCode).toBe(201);
    const { package: pkg, sampleTests } = scaffold.json();
    const res = (await call('run', { path: pkg.path, tests: sampleTests })).json();
    expect(res.status).toBe('completed');
    const r = res.report;
    expect(r.harnessError).toBeNull();
    expect(r.sessionError).toBeNull();
    expect(r.extensionErrors).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.package).toMatchObject({ name: 'my-tools', piPackage: true, hasManifest: true });
    expect(r.tools.map((t: { name: string }) => t.name)).toEqual(['my_tools_greet']);
    expect(r.tools[0].parameters.properties.name.type).toBe('string');
    expect(r.commands.map((c: { name: string }) => c.name)).toContain('my-tools-hello');
    expect(r.skills.map((s: { name: string }) => s.name)).toEqual(['my-tools']);
    expect(r.prompts.map((p: { name: string }) => p.name)).toEqual(['my-tools']);
    expect(r.themes.map((t: { name: string }) => t.name)).toEqual(['my-tools']);
    expect(r.tests).toHaveLength(1);
    expect(r.tests[0]).toMatchObject({ status: 'passed', ok: true, output: 'Hello, World!' });
  });

  it('reports each kind of tool-test outcome', async () => {
    put(
      'lab/outcomes/package.json',
      JSON.stringify({
        name: 'outcomes',
        keywords: ['pi-package'],
        pi: { extensions: ['./x.ts'] },
      }),
    );
    put(
      'lab/outcomes/x.ts',
      `import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({ name: "div", label: "Div", description: "divide", parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id: string, p: any) { if (p.b === 0) throw new Error("division by zero"); return { content: [{ type: "text", text: String(p.a / p.b) }], details: {} }; } });
  pi.registerTool({ name: "soft", label: "Soft", description: "returns an error result", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "nope" }], isError: true, details: {} }; } });
  pi.registerTool({ name: "slow", label: "Slow", description: "never finishes", parameters: Type.Object({}),
    async execute() { await new Promise(() => {}); } });
}`,
    );
    const tests = [
      { tool: 'div', input: { a: 6, b: 3 }, expectContains: '2' },
      { tool: 'div', input: { a: 1, b: 0 } },
      { tool: 'div', input: { a: 1, b: 0 }, expectError: true },
      { tool: 'div', input: { a: 'six', b: 3 } },
      { tool: 'div', input: { a: 6, b: 3 }, expectContains: 'wrong' },
      { tool: 'soft', input: {} },
      { tool: 'soft', input: {}, expectError: true },
      { tool: 'missing', input: {} },
    ];
    const r = (await call('run', { path: 'lab/outcomes', tests })).json().report;
    expect(r.extensionErrors).toEqual([]);
    expect(r.tests.map((t: { status: string; ok: boolean }) => [t.status, t.ok])).toEqual([
      ['passed', true],
      ['threw', false],
      ['threw', true],
      ['invalid-input', false],
      ['passed', false],
      ['tool-error', false],
      ['tool-error', true],
      ['not-found', false],
    ]);
    expect(r.tests[1].error).toBe('division by zero');
    expect(r.tests[3].schemaErrors[0]).toMatch(/\/a must be number/);
    expect(r.tests[4].error).toMatch(/did not contain/);
    expect(r.ok).toBe(false);
  }, 60_000);

  it('surfaces load errors and resource diagnostics from a broken package', async () => {
    put(
      'lab/broken/package.json',
      JSON.stringify({
        name: 'broken',
        keywords: ['pi-package'],
        pi: { extensions: ['./extensions'], skills: ['./skills'], themes: ['./themes'] },
      }),
    );
    put('lab/broken/extensions/syntax.ts', 'export default function (pi) { this is not valid {{{');
    put('lab/broken/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\nbody\n');
    put('lab/broken/themes/bad.json', '{ "name": "bad", "vars": ');
    const r = (await call('run', { path: 'lab/broken' })).json().report;
    expect(r.ok).toBe(false);
    expect(r.extensionErrors).toHaveLength(1);
    expect(r.extensionErrors[0].path).toBe('./extensions/syntax.ts');
    expect(r.extensionErrors[0].error).toMatch(/ParseError/);
    const messages = r.diagnostics
      .map((d: { kind: string; message: string }) => `${d.kind}: ${d.message}`)
      .join('\n');
    expect(messages).toMatch(/skill: description is required/);
    expect(messages).toMatch(/theme: Failed to parse theme/);
    expect(JSON.stringify(r)).not.toContain('/lab/pkg');
  }, 60_000);

  it('flags a package with no pi resources as a failure', async () => {
    put('lab/empty/package.json', JSON.stringify({ name: 'empty', version: '1.0.0' }));
    put('lab/empty/readme.md', 'nothing here');
    const r = (await call('run', { path: 'lab/empty' })).json().report;
    expect(r.ok).toBe(false);
    expect(r.package.piPackage).toBe(false);
    expect(
      r.diagnostics.some(
        (d: { type: string; message: string }) =>
          d.type === 'error' && /No pi resources/.test(d.message),
      ),
    ).toBe(true);
  }, 60_000);
});
