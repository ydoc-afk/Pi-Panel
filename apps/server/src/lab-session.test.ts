import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { LAB_REPLY_MAX_CHARS, labSessionNote, parseLabRunRequest } from './lab-session.js';
import { agentDir } from './paths.js';
import { FakeRuntime } from './runtime.js';

describe('parseLabRunRequest', () => {
  it('needs a path, and passes tests through for the lab to validate', () => {
    expect(parseLabRunRequest('{"path":"lab/x"}')).toEqual({ path: 'lab/x' });
    expect(parseLabRunRequest('{"path":"lab/x","tests":[{"tool":"t"}]}')).toEqual({
      path: 'lab/x',
      tests: [{ tool: 't' }],
    });
    for (const bad of [undefined, '', 'nope', '[]', '{}', '{"path":""}', '{"path":3}']) {
      expect(parseLabRunRequest(bad)).toBeNull();
    }
  });
});

describe('labSessionNote', () => {
  it('points at pi’s docs, the lab folder and the tool, and says what a pass means', () => {
    const note = labSessionNote('/docs');
    expect(note).toContain('/docs/extensions.md');
    expect(note).toContain('/workspace/lab/<package-name>/');
    expect(note).toContain('lab_run');
    expect(note).toContain('not a security review');
  });
});

describe('the package lab design session', () => {
  let dataDir: string;
  let runtime: FakeRuntime;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let projectId: number;
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  const put = (rel: string, content: string) => {
    const path = join(dataDir, 'workspaces', String(projectId), rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const events = async (id: number) =>
    (await call('GET', `/api/sessions/${id}/events`)).json().events as {
      event: { type?: string; method?: string; message?: unknown };
    }[];
  /** Sends a prompt and returns the text the fake pi replied with once the turn settles. */
  async function ask(sessionId: number, text: string) {
    const settled = (await events(sessionId)).filter(
      (e) => e.event.type === 'agent_settled',
    ).length;
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message: text });
    for (let i = 0; i < 400; i++) {
      const ev = await events(sessionId);
      if (ev.filter((e) => e.event.type === 'agent_settled').length > settled) {
        return JSON.stringify(ev);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('did not settle');
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-labs-'));
    runtime = new FakeRuntime();
    app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    projectId = (await call('POST', '/api/projects', { name: 'p' })).json().project.id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is made once per project and kept out of the session list', async () => {
    const a = (await call('GET', `/api/projects/${projectId}/lab/session`)).json().session;
    const b = (await call('GET', `/api/projects/${projectId}/lab/session`)).json().session;
    expect(a).toMatchObject({ kind: 'lab', projectId });
    expect(b.id).toBe(a.id);
    expect((await call('GET', `/api/projects/${projectId}/sessions`)).json().sessions).toEqual([]);
    // Ordinary sessions are numbered as if the lab one were not there.
    const chat = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session;
    expect(chat).toMatchObject({ name: 'Session 1', kind: 'chat' });
    expect((await call('GET', `/api/projects/${projectId}/sessions`)).json().sessions).toHaveLength(
      1,
    );
    expect((await call('GET', '/api/projects/999/lab/session')).statusCode).toBe(404);
  });

  it('starts pi with the lab instructions and tool, which other sessions do not get', async () => {
    const lab = (await call('GET', `/api/projects/${projectId}/lab/session`)).json().session;
    await ask(lab.id, 'hello');
    const proc = runtime.processes[0]!;
    expect(proc.args).toContain('--append-system-prompt');
    expect(runtime.execs[0]!.env).toMatchObject({ PI_PANEL_SESSION_KIND: 'lab' });
    const dir = agentDir(dataDir, projectId);
    expect(readFileSync(join(dir, 'lab-session.md'), 'utf8')).toContain('lab_run');
    expect(readFileSync(join(dir, 'extensions', 'panel-lab.js'), 'utf8')).toContain(
      "name: 'lab_run'",
    );

    const chat = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session;
    await ask(chat.id, 'hello');
    expect(runtime.processes[1]!.args).not.toContain('--append-system-prompt');
    expect(runtime.execs[1]!.env).not.toHaveProperty('PI_PANEL_SESSION_KIND');
  });

  it('runs the lab for the design session without asking the user, and returns pi’s report', async () => {
    put('lab/hello/package.json', '{"name":"hello","keywords":["pi-package"]}');
    runtime.ephemeralHandler = () => ({
      code: 0,
      stdout:
        '@@PI_LAB_REPORT_BEGIN@@\n{"extensions":{"loaded":["e.ts"]},"tests":[]}\n@@PI_LAB_REPORT_END@@\n',
      stderr: '',
      timedOut: false,
    });
    const lab = (await call('GET', `/api/projects/${projectId}/lab/session`)).json().session;
    const text = await ask(lab.id, '/lab {"path":"lab/hello","tests":[]}');
    expect(text).toContain('result: ');
    expect(text).toContain('completed');
    expect(text).toContain('e.ts');
    expect(runtime.ephemerals).toHaveLength(1);
    // No confirmation was raised and the reserved dialog is not shown or stored.
    expect(
      (await events(lab.id)).some(
        (e) => e.event.method === 'confirm' || e.event.method === 'input',
      ),
    ).toBe(false);
  });

  it('tells the agent when the package is missing or the request is bad', async () => {
    const lab = (await call('GET', `/api/projects/${projectId}/lab/session`)).json().session;
    expect(await ask(lab.id, '/lab {"path":"lab/nothing"}')).toMatch(/Lab run failed|ok\\":false/);
    expect(await ask(lab.id, '/lab {"nope":1}')).toContain('malformed');
    expect(runtime.ephemerals).toHaveLength(0);
    expect(existsSync(join(dataDir, 'workspaces', String(projectId), 'lab'))).toBe(false);
  });

  it('refuses the lab to an ordinary session', async () => {
    put('lab/hello/package.json', '{"name":"hello"}');
    const chat = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session;
    expect(await ask(chat.id, '/lab {"path":"lab/hello"}')).toContain(
      'only be run from the package lab session',
    );
    expect(runtime.ephemerals).toHaveLength(0);
  });

  it('cuts a very long report', async () => {
    put('lab/hello/package.json', '{"name":"hello"}');
    runtime.ephemeralHandler = () => ({
      code: 0,
      stdout: `@@PI_LAB_REPORT_BEGIN@@\n${JSON.stringify({ blob: 'x'.repeat(LAB_REPLY_MAX_CHARS * 2) })}\n@@PI_LAB_REPORT_END@@\n`,
      stderr: '',
      timedOut: false,
    });
    const lab = (await call('GET', `/api/projects/${projectId}/lab/session`)).json().session;
    expect(await ask(lab.id, '/lab {"path":"lab/hello"}')).toContain('report cut at');
  });
});
