import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentNote } from './agent-note.js';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { agentDir } from './paths.js';
import { FakeRuntime } from './runtime.js';
import { RUNTIME_VARIANTS, RuntimeBuilder, imageFor } from './runtimes.js';

async function settle(builder: RuntimeBuilder, id: string) {
  for (let i = 0; i < 200; i++) {
    const state = (await builder.list()).find((r) => r.id === id)!;
    if (state.build.status !== 'building') return state;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('build did not finish');
}

describe('runtime variants', () => {
  it('has a Dockerfile for every non-base profile, layered on its parent', () => {
    expect(RUNTIME_VARIANTS.map((v) => v.id)).toEqual(['base', 'python', 'native', 'full']);
    for (const v of RUNTIME_VARIANTS.filter((x) => x.id !== 'base')) {
      const text = readFileSync(
        new URL(`../../../docker/runtimes/${v.id}/Dockerfile`, import.meta.url),
        'utf8',
      );
      expect(text, v.id).toContain('FROM ${BASE_IMAGE}');
      expect(text, v.id).toContain('LABEL org.pi-panel.base-id=${BASE_ID}');
      expect(text, v.id).toMatch(/USER sandbox\s*\nLABEL org.pi-panel.runtime=/);
    }
  });
});

describe('RuntimeBuilder', () => {
  let runtime: FakeRuntime;
  let builder: RuntimeBuilder;
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-rt-'));
    runtime = new FakeRuntime();
    builder = new RuntimeBuilder(runtime, { dataDir });
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('lists the base as present and the variants as not built', async () => {
    const list = await builder.list();
    expect(list.map((r) => r.id)).toEqual(['base', 'python', 'native', 'full']);
    expect(list.find((r) => r.id === 'base')).toMatchObject({ present: true, stale: false });
    expect(list.find((r) => r.id === 'python')).toMatchObject({
      present: false,
      tag: 'pi-panel/sandbox-python:latest',
    });
  });

  it('builds a variant on the base image and records which base it used', async () => {
    await builder.start('python');
    const state = await settle(builder, 'python');
    expect(state).toMatchObject({ present: true, stale: false });
    expect(state.build.status).toBe('done');
    expect(runtime.builds[0]).toEqual({
      tag: 'pi-panel/sandbox-python:latest',
      buildArgs: { BASE_IMAGE: 'pi-panel/sandbox-base:latest', BASE_ID: 'sha256:base1' },
    });
    expect(builder.latestLog('python')).toContain('Image built');
    expect(builder.latestLog('native')).toBeNull();
  });

  it('marks a variant stale once the base image is rebuilt', async () => {
    await builder.start('python');
    await settle(builder, 'python');
    runtime.baseImageId = 'sha256:base2';
    expect((await builder.list()).find((r) => r.id === 'python')!.stale).toBe(true);
  });

  it('reports a failed build with its error', async () => {
    runtime.buildFailure = 'apt-get failed';
    await builder.start('python');
    const state = await settle(builder, 'python');
    expect(state.build).toMatchObject({ status: 'failed', error: 'apt-get failed' });
    expect(state.present).toBe(false);
  });

  it('builds missing parent profiles first, in order, and layers each on the previous', async () => {
    await builder.start('full');
    await settle(builder, 'full');
    expect(runtime.builds.map((b) => b.tag)).toEqual([
      'pi-panel/sandbox-python:latest',
      'pi-panel/sandbox-native:latest',
      'pi-panel/sandbox-full:latest',
    ]);
    expect(runtime.builds.map((b) => b.buildArgs.BASE_IMAGE)).toEqual([
      'pi-panel/sandbox-base:latest',
      'pi-panel/sandbox-python:latest',
      'pi-panel/sandbox-native:latest',
    ]);
    expect((await builder.list()).filter((r) => r.present).map((r) => r.id)).toEqual([
      'base',
      'python',
      'native',
      'full',
    ]);
  });

  it('skips parents that already exist, and marks a child stale when its parent is rebuilt', async () => {
    await builder.start('python');
    await settle(builder, 'python');
    await builder.start('native');
    await settle(builder, 'native');
    expect(runtime.builds.map((b) => b.tag)).toEqual([
      'pi-panel/sandbox-python:latest',
      'pi-panel/sandbox-native:latest',
    ]);
    runtime.imageInfos.set('pi-panel/sandbox-python:latest', {
      id: 'sha256:python-rebuilt',
      sizeBytes: 1,
      labels: {},
    });
    const list = await builder.list();
    expect(list.find((r) => r.id === 'native')!.stale).toBe(true);
  });

  it('fails the queued profiles when a parent fails', async () => {
    runtime.buildFailure = 'apt-get failed';
    await builder.start('native');
    await settle(builder, 'native');
    const list = await builder.list();
    expect(list.find((r) => r.id === 'python')!.build.status).toBe('failed');
    expect(list.find((r) => r.id === 'native')!.build.status).toBe('failed');
    expect(runtime.builds).toHaveLength(1);
  });

  it('refuses unknown runtimes, the base, a missing base image and parallel builds', async () => {
    await expect(builder.start('cobol')).rejects.toMatchObject({ status: 404 });
    await expect(builder.start('base')).rejects.toMatchObject({ status: 404 });
    runtime.sandboxImageAvailable = false;
    await expect(builder.start('python')).rejects.toMatchObject({ status: 409 });
    runtime.sandboxImageAvailable = true;
    let release!: () => void;
    runtime.buildGate = new Promise<void>((r) => (release = r));
    await builder.start('python');
    await expect(builder.start('native')).rejects.toMatchObject({ status: 409 });
    release();
    await settle(builder, 'python');
  });
});

describe('project runtime selection', () => {
  let dataDir: string;
  let runtime: FakeRuntime;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-rt-'));
    runtime = new FakeRuntime();
    app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((x) => x.name === 'pp_session')!.value}` };
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  async function build(id: string) {
    expect((await call('POST', `/api/runtimes/${id}/build`)).statusCode).toBe(202);
    for (let i = 0; i < 200; i++) {
      const list = (await call('GET', '/api/runtimes')).json().runtimes as {
        id: string;
        build: { status: string };
      }[];
      if (list.find((r) => r.id === id)!.build.status !== 'building') return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('defaults to the base image', async () => {
    const { project } = (await call('POST', '/api/projects', { name: 'p' })).json();
    expect(project).toMatchObject({ runtime: 'base', runtimePending: false });
    expect([...runtime.containers.values()][0]!.image).toBe('pi-panel/sandbox-base:latest');
  });

  it('refuses a runtime that is unknown or not built', async () => {
    const { project } = (await call('POST', '/api/projects', { name: 'p' })).json();
    const url = `/api/projects/${project.id}`;
    expect((await call('PATCH', url, { runtime: 'cobol' })).statusCode).toBe(400);
    expect((await call('PATCH', url, { runtime: 'python' })).statusCode).toBe(409);
    expect((await call('PATCH', '/api/projects/999', { runtime: 'base' })).statusCode).toBe(404);
  });

  it('applies a chosen runtime on recreate, not before', async () => {
    const { project } = (await call('POST', '/api/projects', { name: 'p' })).json();
    await build('python');
    const patched = (
      await call('PATCH', `/api/projects/${project.id}`, { runtime: 'python' })
    ).json();
    expect(patched.project).toMatchObject({ runtime: 'python', runtimePending: true });
    expect([...runtime.containers.values()][0]!.image).toBe('pi-panel/sandbox-base:latest');

    const re = (await call('POST', `/api/projects/${project.id}/recreate`, {})).json();
    expect(re.project).toMatchObject({ runtime: 'python', runtimePending: false });
    expect([...runtime.containers.values()].map((c) => c.image)).toEqual([
      'pi-panel/sandbox-python:latest',
    ]);
  });

  it('fails recreate when the chosen image has disappeared', async () => {
    const { project } = (await call('POST', '/api/projects', { name: 'p' })).json();
    await build('native');
    await call('PATCH', `/api/projects/${project.id}`, { runtime: 'native' });
    runtime.images.delete(imageFor(runtime, 'native'));
    const re = await call('POST', `/api/projects/${project.id}/recreate`, {});
    expect(re.statusCode).toBe(502);
  });

  it('tells the agent what the container has, once it is recreated', async () => {
    const { project } = (await call('POST', '/api/projects', { name: 'p' })).json();
    await build('python');
    await call('PATCH', `/api/projects/${project.id}`, { runtime: 'python' });
    await call('POST', `/api/projects/${project.id}/recreate`, {});
    const sess = (await call('POST', `/api/projects/${project.id}/sessions`, {})).json().session;
    await call('POST', `/api/sessions/${sess.id}/prompt`, { message: 'hi' });
    for (let i = 0; i < 300; i++) {
      const events = (await call('GET', `/api/sessions/${sess.id}/events`)).json().events;
      if (events.some((e: { event: { type: string } }) => e.event.type === 'agent_settled')) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const md = join(agentDir(dataDir, project.id), 'AGENTS.md');
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, 'utf8')).toContain('Python 3, pip, venv and uv are installed');
  });
});

describe('agentNote with a runtime', () => {
  it('is only the runtime section without a repository', () => {
    const note = agentNote(null, null, 'Python 3 is installed.')!;
    expect(note).toContain('# Tools in this sandbox');
    expect(note).not.toContain('Publishing');
  });

  it('combines both sections', () => {
    const note = agentNote('o/r', null, 'Go is installed.')!;
    expect(note).toContain('# Publishing your work');
    expect(note).toContain('Go is installed.');
  });
});
