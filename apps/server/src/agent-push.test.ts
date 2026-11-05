import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describePullRequest,
  describePush,
  parsePullRequestRequest,
  parsePushRequest,
  type ForgePusher,
} from './agent-push.js';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { agentDir } from './paths.js';
import { addRepo } from './repo-store.js';
import { FakeRuntime } from './runtime.js';

describe('parsePushRequest', () => {
  it('accepts a branch with an optional message', () => {
    expect(parsePushRequest('{"branch":"main"}')).toEqual({ branch: 'main' });
    expect(parsePushRequest('{"branch":"x","message":"hi"}')).toEqual({
      branch: 'x',
      message: 'hi',
    });
  });

  it('rejects anything else', () => {
    for (const bad of [
      undefined,
      '',
      'nope',
      '[]',
      '{}',
      '{"branch":""}',
      '{"branch":5}',
      `{"branch":"${'a'.repeat(201)}"}`,
      '{"branch":"b","message":7}',
    ]) {
      expect(parsePushRequest(bad)).toBeNull();
    }
  });

  it('describes the push in the panel’s own words', () => {
    const text = describePush('Forgejo', 'codyw/Rufus_Decomp', {
      branch: 'main',
      message: 'Add\nit',
    });
    expect(text).toContain('branch "main" to Forgejo repository codyw/Rufus_Decomp');
    expect(text).toContain('with the message "Add it"');
  });
});

describe('parsePullRequestRequest', () => {
  it('accepts a head and title with optional body and base', () => {
    expect(parsePullRequestRequest('{"head":"topic","title":"Add x"}')).toEqual({
      head: 'topic',
      title: 'Add x',
    });
    expect(parsePullRequestRequest('{"head":"t","title":"T","body":"b","base":"main"}')).toEqual({
      head: 't',
      title: 'T',
      body: 'b',
      base: 'main',
    });
  });

  it('rejects anything else', () => {
    for (const bad of [
      undefined,
      'nope',
      '{}',
      '{"head":"t"}',
      '{"head":"","title":"T"}',
      '{"head":"t","title":"  "}',
      `{"head":"t","title":"${'a'.repeat(257)}"}`,
      '{"head":"t","title":"T","body":3}',
      '{"head":"t","title":"T","base":3}',
    ]) {
      expect(parsePullRequestRequest(bad)).toBeNull();
    }
  });

  it('describes the pull request in the panel’s own words', () => {
    expect(describePullRequest('Forgejo', 'o/r', { head: 't', title: 'Add\nx' })).toBe(
      'The agent asks to open a pull request on Forgejo repository o/r: "Add x", from branch "t" into the default branch.',
    );
  });
});

interface Ev {
  type?: string;
  method?: string;
  id?: string;
  title?: string;
  message?: unknown;
  placeholder?: string;
}

describe('push_to_repo through the session dialog', () => {
  let dataDir: string;
  let db: ReturnType<typeof openDb>;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let projectId: number;
  let sessionId: number;
  let linked: { forge: 'GitHub' | 'Forgejo'; repo: string } | null;
  const pushImpl = vi.fn();
  const prImpl = vi.fn();
  const pusher: ForgePusher = {
    link: () => linked,
    push: (id, request) => pushImpl(id, request),
    pullRequest: (id, request) => prImpl(id, request),
  };
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });
  const events = async () =>
    (
      (await call('GET', `/api/sessions/${sessionId}/events`)).json().events as {
        event: Ev;
      }[]
    ).map((m) => m.event);
  const until = async (cond: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition not met in time');
  };
  const dialog = async () => (await events()).find((e) => e.method === 'confirm');
  const reply = async () => {
    await until(async () => (await events()).some((e) => e.type === 'agent_settled'));
    return JSON.stringify(
      (await events()).find(
        (e) =>
          e.type === 'message_end' &&
          (e.message as { role?: string } | undefined)?.role === 'assistant',
      ),
    );
  };
  const respond = (body: Record<string, unknown>) =>
    call('POST', `/api/sessions/${sessionId}/ui-response`, body);
  const ask = (request: string) =>
    call('POST', `/api/sessions/${sessionId}/prompt`, { message: `/push ${request}` });

  beforeEach(async () => {
    pushImpl.mockReset();
    prImpl.mockReset();
    linked = { forge: 'Forgejo', repo: 'codyw/Rufus_Decomp' };
    dataDir = mkdtempSync(join(tmpdir(), 'pp-push-'));
    db = openDb(':memory:');
    app = buildApp({ db, runtime: new FakeRuntime(), dataDir, agentPush: pusher });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    projectId = (await call('POST', '/api/projects', { name: 'p' })).json().project.id;
    sessionId = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session.id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('asks the user in the panel’s own words, and pushes only after they approve', async () => {
    pushImpl.mockResolvedValue({
      repo: 'codyw/Rufus_Decomp',
      branch: 'main',
      commit: 'abc1234def',
      committed: false,
    });
    await ask('{"branch":"main","message":"Add decompilation"}');
    await until(async () => !!(await dialog()));

    const d = (await dialog())!;
    expect(d.title).toBe('Push to Forgejo?');
    expect(d.message).toContain('branch "main" to Forgejo repository codyw/Rufus_Decomp');
    expect(d.placeholder).toBeUndefined(); // the agent's JSON is not shown or stored
    expect(pushImpl).not.toHaveBeenCalled();

    expect((await respond({ id: d.id, confirmed: true })).statusCode).toBe(200);
    expect(pushImpl).toHaveBeenCalledWith(projectId, {
      branch: 'main',
      message: 'Add decompilation',
    });
    const text = await reply();
    expect(text).toContain('abc1234def');
    expect(text).toContain('\\"ok\\":true');
  });

  it('does not push when the user says no, and tells the agent', async () => {
    await ask('{"branch":"main"}');
    await until(async () => !!(await dialog()));
    await respond({ id: (await dialog())!.id, confirmed: false });
    expect(await reply()).toContain('result: cancelled');
    expect(pushImpl).not.toHaveBeenCalled();
  });

  it('does not push when the dialog is dismissed', async () => {
    await ask('{"branch":"main"}');
    await until(async () => !!(await dialog()));
    await respond({ id: (await dialog())!.id, cancelled: true });
    expect(await reply()).toContain('result: cancelled');
    expect(pushImpl).not.toHaveBeenCalled();
  });

  it('reports a failed push to the agent, with the reason', async () => {
    pushImpl.mockRejectedValue(new Error('Push failed: remote rejected'));
    await ask('{"branch":"main"}');
    await until(async () => !!(await dialog()));
    await respond({ id: (await dialog())!.id, confirmed: true });
    const text = await reply();
    expect(text).toContain('\\"ok\\":false');
    expect(text).toContain('remote rejected');
  });

  it('answers at once, without asking, when the project has no linked repository', async () => {
    linked = null;
    await ask('{"branch":"main"}');
    const text = await reply();
    expect(text).toContain('not linked to a GitHub or Forgejo repository');
    expect(await dialog()).toBeUndefined();
    expect(pushImpl).not.toHaveBeenCalled();
  });

  it('answers at once, without asking, when the request is malformed', async () => {
    await ask('not json');
    expect(await reply()).toContain('malformed');
    expect(await dialog()).toBeUndefined();
    expect(pushImpl).not.toHaveBeenCalled();
  });

  it('refuses answers that are not yes or no, and a second answer while pushing', async () => {
    let finish!: (v: unknown) => void;
    pushImpl.mockReturnValue(new Promise((r) => (finish = r)));
    await ask('{"branch":"main"}');
    await until(async () => !!(await dialog()));
    const id = (await dialog())!.id;

    expect((await respond({ id, value: 'push it' })).statusCode).toBe(400);
    const first = respond({ id, confirmed: true });
    await until(async () => pushImpl.mock.calls.length === 1);
    expect((await respond({ id, confirmed: true })).statusCode).toBe(409);
    finish({ repo: 'r', branch: 'main', commit: 'c0ffee1', committed: true });
    expect((await first).statusCode).toBe(200);
    expect(pushImpl).toHaveBeenCalledTimes(1);
  });
});

describe('open_pull_request through the session dialog', () => {
  // Reuses the push suite's setup by repeating it; kept separate so each suite reads on its own.
  let dataDir: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let projectId: number;
  let sessionId: number;
  let linked: { forge: 'GitHub' | 'Forgejo'; repo: string } | null;
  const prImpl = vi.fn();
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });
  const events = async () =>
    ((await call('GET', `/api/sessions/${sessionId}/events`)).json().events as { event: Ev }[]).map(
      (m) => m.event,
    );
  const until = async (cond: () => Promise<boolean>) => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition not met in time');
  };
  const dialog = async () => (await events()).find((e) => e.method === 'confirm');
  const reply = async () => {
    await until(async () => (await events()).some((e) => e.type === 'agent_settled'));
    return JSON.stringify(
      (await events()).find(
        (e) =>
          e.type === 'message_end' &&
          (e.message as { role?: string } | undefined)?.role === 'assistant',
      ),
    );
  };
  const ask = (request: string) =>
    call('POST', `/api/sessions/${sessionId}/prompt`, { message: `/pr ${request}` });

  beforeEach(async () => {
    prImpl.mockReset();
    linked = { forge: 'Forgejo', repo: 'codyw/totk-pc-recomp' };
    dataDir = mkdtempSync(join(tmpdir(), 'pp-pr-'));
    app = buildApp({
      db: openDb(':memory:'),
      runtime: new FakeRuntime(),
      dataDir,
      agentPush: {
        link: () => linked,
        push: () => Promise.reject(new Error('unused')),
        pullRequest: (id, request) => prImpl(id, request),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    projectId = (await call('POST', '/api/projects', { name: 'p' })).json().project.id;
    sessionId = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session.id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('asks in the panel’s words and opens the pull request only after approval', async () => {
    prImpl.mockResolvedValue({
      url: 'http://forge/o/r/pulls/7',
      number: 7,
      base: 'main',
      head: 'task/x',
    });
    await ask('{"head":"task/x","title":"Remember installer paths","body":"## What"}');
    await until(async () => !!(await dialog()));
    const d = (await dialog())!;
    expect(d.title).toBe('Open a pull request on Forgejo?');
    expect(d.message).toContain('"Remember installer paths", from branch "task/x"');
    expect(d.placeholder).toBeUndefined();
    expect(prImpl).not.toHaveBeenCalled();

    await call('POST', `/api/sessions/${sessionId}/ui-response`, { id: d.id, confirmed: true });
    expect(prImpl).toHaveBeenCalledWith(projectId, {
      head: 'task/x',
      title: 'Remember installer paths',
      body: '## What',
    });
    expect(await reply()).toContain('http://forge/o/r/pulls/7');
  });

  it('does nothing when the user declines', async () => {
    await ask('{"head":"t","title":"T"}');
    await until(async () => !!(await dialog()));
    await call('POST', `/api/sessions/${sessionId}/ui-response`, {
      id: (await dialog())!.id,
      confirmed: false,
    });
    expect(await reply()).toContain('result: cancelled');
    expect(prImpl).not.toHaveBeenCalled();
  });

  it('reports a failure to the agent, and refuses unlinked projects and bad requests at once', async () => {
    prImpl.mockRejectedValue(new Error('Forgejo rejected the request (401)'));
    await ask('{"head":"t","title":"T"}');
    await until(async () => !!(await dialog()));
    await call('POST', `/api/sessions/${sessionId}/ui-response`, {
      id: (await dialog())!.id,
      confirmed: true,
    });
    expect(await reply()).toContain('401');
  });

  it('answers at once when the project has no repository', async () => {
    linked = null;
    await ask('{"head":"t","title":"T"}');
    expect(await reply()).toContain('not linked to a GitHub or Forgejo repository');
    expect(await dialog()).toBeUndefined();
  });

  it('answers at once when the request is malformed', async () => {
    await ask('{"head":"t"}');
    expect(await reply()).toContain('malformed');
    expect(await dialog()).toBeUndefined();
  });
});

describe('push tool installation', () => {
  it('is installed for a linked project and removed when the link goes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pp-push-inst-'));
    const db = openDb(':memory:');
    const app = buildApp({ db, runtime: new FakeRuntime(), dataDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const headers = {
      cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`,
    };
    const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers, payload });
    const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
    const file = join(agentDir(dataDir, project.id), 'extensions', 'panel-forge.js');
    const start = async () => {
      const s = (await call('POST', `/api/projects/${project.id}/sessions`, {})).json().session;
      await call('POST', `/api/sessions/${s.id}/prompt`, { message: 'hi' });
      for (let i = 0; i < 300; i++) {
        const ev = (await call('GET', `/api/sessions/${s.id}/events`)).json().events;
        if (ev.some((e: { event: { type: string } }) => e.event.type === 'agent_settled')) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    await start();
    expect(existsSync(file)).toBe(false);
    addRepo(db, project.id, 'forgejo', 'o/r', '');
    await start();
    expect(readFileSync(file, 'utf8')).toContain("name: 'push_to_repo'");
    expect(readFileSync(file, 'utf8')).toContain("name: 'open_pull_request'");
    db.prepare('DELETE FROM project_repos WHERE project_id = ?').run(project.id);
    await start();
    expect(existsSync(file)).toBe(false);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
