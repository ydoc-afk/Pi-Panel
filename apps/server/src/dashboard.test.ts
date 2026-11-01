import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { ACTIVITY_DAYS, buildDashboard, type DashboardDeps } from './dashboard.js';
import { openDb } from './db.js';
import { GitHubService } from './github.js';
import { McpStore } from './mcp-store.js';
import { ProviderStore } from './providers.js';
import { FakeRuntime } from './runtime.js';
import { Secrets } from './secrets.js';

const PASSWORD = 'correct-horse-battery';
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}`;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-dash-'));
  const runtime = new FakeRuntime();
  const db = openDb(':memory:');
  const app = buildApp({ db, runtime, dataDir });
  const admin = cookieOf(
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: PASSWORD },
    }),
  );
  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
    cookie = admin,
  ) => app.inject({ method, url, headers: { cookie }, payload });
  return { app, db, runtime, dataDir, admin, call };
}

const until = async (cond: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
};

/** Adds a persisted event directly, as the session manager would have. */
function addEvent(
  db: DatabaseSync,
  sessionId: number,
  event: Record<string, unknown>,
  createdAt: number | null,
) {
  const seq =
    (
      db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM session_events WHERE session_id = ?')
        .get(sessionId) as { n: number }
    ).n + 1;
  db.prepare(
    'INSERT INTO session_events (session_id, seq, data, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, seq, JSON.stringify(event), createdAt);
}

describe('dashboard endpoint', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  it('requires a signed-in user', async () => {
    expect((await t.app.inject({ url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('summarises an empty panel', async () => {
    const res = await t.call('GET', '/api/dashboard');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.activity.days).toHaveLength(ACTIVITY_DAYS);
    expect(d.activity.days.every((x: { prompts: number }) => x.prompts === 0)).toBe(true);
    expect(d.projects).toEqual({ total: 0, running: 0, items: [] });
    expect(d.sessions).toMatchObject({ total: 0, running: 0, recent: [] });
    expect(d.models).toEqual([]);
    expect(d.tools).toEqual([]);
    expect(d.providers).toEqual({ total: 0, withKey: 0, models: 0, warnings: 0 });
    expect(d.mcp).toMatchObject({ total: 0, connected: 0, tools: 0 });
    expect(d.github).toEqual({ connected: false, login: null });
    expect(d.sandbox).toEqual({ available: true });
    expect(d.users).toEqual({ total: 1, pending: 0 });
  });

  it('counts prompts from a real session run and ranks recent sessions', async () => {
    await t.call('POST', '/api/providers', {
      kind: 'anthropic',
      name: 'Anthropic',
      apiKey: 'sk-test',
      models: ['model-a', 'model-b'],
    });
    const provider = (await t.call('GET', '/api/providers')).json().providers[0];
    const project = (await t.call('POST', '/api/projects', { name: 'alpha' })).json().project;
    const first = (
      await t.call('POST', `/api/projects/${project.id}/sessions`, {
        providerId: provider.id,
        modelId: 'model-a',
      })
    ).json().session;
    const second = (await t.call('POST', `/api/projects/${project.id}/sessions`, {})).json()
      .session;

    await t.call('POST', `/api/sessions/${first.id}/prompt`, { message: 'hello' });
    await until(async () => {
      const d = (await t.call('GET', '/api/dashboard')).json();
      return d.activity.days.at(-1).prompts === 1 && d.sessions.running === 0;
    });

    const d = (await t.call('GET', '/api/dashboard')).json();
    expect(d.projects.items).toEqual([
      expect.objectContaining({
        id: project.id,
        name: 'alpha',
        sessions: 2,
        prompts: 1,
        lastActivityAt: expect.any(Number),
      }),
    ]);
    expect(d.sessions.total).toBe(2);
    // The session with activity sorts ahead of the newer, idle one.
    expect(d.sessions.recent.map((s: { id: number }) => s.id)).toEqual([first.id, second.id]);
    expect(d.sessions.recent[0]).toMatchObject({
      projectName: 'alpha',
      modelId: 'model-a',
      providerName: 'Anthropic',
      prompts: 1,
    });
    expect(d.sessions.recent[1].lastActivityAt).toBeNull();
    expect(d.models).toEqual([
      { model: 'model-a', sessions: 1 },
      { model: 'pi default', sessions: 1 },
    ]);
    expect(d.providers).toMatchObject({ total: 1, withKey: 1, models: 2 });
  });

  it('stamps new session events with the time they were recorded', async () => {
    const project = (await t.call('POST', '/api/projects', { name: 'alpha' })).json().project;
    const s = (await t.call('POST', `/api/projects/${project.id}/sessions`, {})).json().session;
    const before = Date.now();
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'hi' });
    await until(
      () =>
        (
          t.db
            .prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?')
            .get(s.id) as { n: number }
        ).n > 0,
    );
    const rows = t.db
      .prepare('SELECT created_at FROM session_events WHERE session_id = ?')
      .all(s.id) as { created_at: number | null }[];
    for (const r of rows) expect(r.created_at).toBeGreaterThanOrEqual(before);
  });

  it('keeps the user count from members', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'sam', password: 'member-password-1' },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'riley', password: 'member-password-1' },
    });
    await t.call('POST', '/api/admin/users/2/approve');
    expect((await t.call('GET', '/api/dashboard')).json().users).toEqual({ total: 3, pending: 1 });

    const member = cookieOf(
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'sam', password: 'member-password-1' },
      }),
    );
    const res = await t.call('GET', '/api/dashboard', undefined, member);
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toBeNull();
  });

  it('ignores a time zone offset that is not a whole number of minutes in range', async () => {
    for (const tz of ['abc', '1.5', '9999', '-9999']) {
      const res = await t.call('GET', `/api/dashboard?tz=${tz}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().activity.days).toHaveLength(ACTIVITY_DAYS);
    }
  });
});

describe('buildDashboard', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let deps: DashboardDeps;
  let sessionId: number;
  // Noon UTC on 15 March 2026.
  const now = Date.UTC(2026, 2, 15, 12);
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    t = await setup();
    const project = (await t.call('POST', '/api/projects', { name: 'alpha' })).json().project;
    sessionId = (await t.call('POST', `/api/projects/${project.id}/sessions`, {})).json().session
      .id;
    // The service objects are private to buildApp, so the function gets fresh ones over the same
    // database; only the database matters for activity.
    const secrets = new Secrets(t.dataDir);
    deps = {
      db: t.db,
      runtime: t.runtime,
      providers: new ProviderStore(t.db, secrets),
      mcp: new McpStore(t.db, secrets),
      github: new GitHubService(t.db, secrets, t.dataDir),
    };
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  it('buckets prompts, tool calls and errors by day, and ranks tools', async () => {
    const user = { type: 'message_end', message: { role: 'user', content: 'x' } };
    addEvent(t.db, sessionId, user, now - HOUR);
    addEvent(t.db, sessionId, user, now - 2 * HOUR);
    addEvent(t.db, sessionId, user, now - 3 * 24 * HOUR);
    addEvent(t.db, sessionId, { type: 'message_end', message: { role: 'assistant' } }, now);
    addEvent(t.db, sessionId, { type: 'tool_execution_start', toolName: 'bash' }, now - HOUR);
    addEvent(t.db, sessionId, { type: 'tool_execution_start', toolName: 'bash' }, now - HOUR);
    addEvent(t.db, sessionId, { type: 'tool_execution_start', toolName: 'read' }, now - HOUR);
    addEvent(
      t.db,
      sessionId,
      { type: 'tool_execution_end', toolName: 'bash', isError: true },
      now - HOUR,
    );
    addEvent(
      t.db,
      sessionId,
      { type: 'tool_execution_end', toolName: 'read', isError: false },
      now - HOUR,
    );
    addEvent(t.db, sessionId, { type: 'panel_process_exit', code: 1 }, now - 3 * 24 * HOUR);
    // Too old for the window, and from the future: both ignored.
    addEvent(t.db, sessionId, user, now - 30 * 24 * HOUR);
    addEvent(t.db, sessionId, user, now + HOUR);

    const d = await buildDashboard(deps, { isAdmin: true, tz: 0, now });
    const days = d.activity.days;
    expect(days).toHaveLength(ACTIVITY_DAYS);
    expect(days.at(-1)).toEqual({ date: '2026-03-15', prompts: 2, toolCalls: 3, errors: 1 });
    expect(days.at(-4)).toEqual({ date: '2026-03-12', prompts: 1, toolCalls: 0, errors: 1 });
    expect(days[0]!.date).toBe('2026-03-02');
    expect(d.tools).toEqual([
      { name: 'bash', calls: 2 },
      { name: 'read', calls: 1 },
    ]);
    // The assistant reply at noon is the latest activity, even though it is not a prompt.
    expect(d.sessions.recent[0]).toMatchObject({ prompts: 3, lastActivityAt: now });
  });

  it('uses the caller time zone for day boundaries', async () => {
    const user = { type: 'message_end', message: { role: 'user', content: 'x' } };
    // 23:30 UTC on 14 March is already 15 March in UTC+1.
    addEvent(t.db, sessionId, user, Date.UTC(2026, 2, 14, 23, 30));
    const utc = await buildDashboard(deps, { isAdmin: true, tz: 0, now });
    expect(utc.activity.days.at(-2)).toMatchObject({ date: '2026-03-14', prompts: 1 });
    const plusOne = await buildDashboard(deps, { isAdmin: true, tz: 60, now });
    expect(plusOne.activity.days.at(-1)).toMatchObject({ date: '2026-03-15', prompts: 1 });
  });

  it('counts prompts recorded before events had timestamps, using the message time', async () => {
    addEvent(
      t.db,
      sessionId,
      { type: 'message_end', message: { role: 'user', content: 'x', timestamp: now - HOUR } },
      null,
    );
    // A legacy tool event has no time of its own, so it cannot be placed on a day.
    addEvent(t.db, sessionId, { type: 'tool_execution_start', toolName: 'bash' }, null);
    const d = await buildDashboard(deps, { isAdmin: true, tz: 0, now });
    expect(d.activity.days.at(-1)).toMatchObject({ prompts: 1, toolCalls: 0 });
  });

  it('leaves the user count out for members', async () => {
    const d = await buildDashboard(deps, { isAdmin: false, tz: 0, now });
    expect(d.users).toBeNull();
  });
});
