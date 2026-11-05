import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentNote } from './agent-note.js';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { agentDir } from './paths.js';
import { FakeRuntime } from './runtime.js';

describe('agentNote', () => {
  it('is empty without a linked repository', () => {
    expect(agentNote(null, null)).toBeNull();
  });

  it('names the repository and forge, and forbids pushing or asking for tokens', () => {
    const forgejo = agentNote('codyw/Rufus_Decomp', 'forgejo')!;
    expect(forgejo).toContain('Forgejo repository `codyw/Rufus_Decomp`');
    expect(forgejo).toMatch(/Do not run `git push`/);
    expect(forgejo).toMatch(/Do not ask the user for a token/);
    expect(agentNote('o/r', null)).toContain('GitHub repository `o/r`');
    // The failure that sent agents to curl the API and ask for a token.
    expect(forgejo).toContain('open_pull_request');
    expect(forgejo).toMatch(/Forgejo API with curl or node/);
  });
});

describe('AGENTS.md in the agent dir', () => {
  let dataDir: string;
  let db: ReturnType<typeof openDb>;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-note-'));
    db = openDb(':memory:');
    app = buildApp({ db, runtime: new FakeRuntime(), dataDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function startSession(projectId: number) {
    const s = (await call('POST', `/api/projects/${projectId}/sessions`, {})).json().session;
    await call('POST', `/api/sessions/${s.id}/prompt`, { message: 'hi' });
    for (let i = 0; i < 300; i++) {
      const events = (await call('GET', `/api/sessions/${s.id}/events`)).json().events;
      if (events.some((e: { event: { type: string } }) => e.event.type === 'agent_settled')) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('session did not settle');
  }

  it('is written for a linked project and removed when the link goes', async () => {
    const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
    const file = join(agentDir(dataDir, project.id), 'AGENTS.md');

    await startSession(project.id);
    expect(existsSync(file)).toBe(false);

    db.prepare(
      "UPDATE projects SET repo = 'codyw/Rufus_Decomp', repo_host = 'forgejo' WHERE id = ?",
    ).run(project.id);
    await startSession(project.id);
    expect(readFileSync(file, 'utf8')).toContain('Forgejo repository `codyw/Rufus_Decomp`');

    db.prepare('UPDATE projects SET repo = NULL, repo_host = NULL WHERE id = ?').run(project.id);
    await startSession(project.id);
    expect(existsSync(file)).toBe(false);
  });
});
