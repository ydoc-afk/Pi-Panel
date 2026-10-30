import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-test-'));
  const runtime = new FakeRuntime();
  const app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
  return { app, runtime, dataDir, headers, call, project };
}

const until = async (cond: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
};

describe('sessions', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  const newSession = async () =>
    (await t.call('POST', `/api/projects/${t.project.id}/sessions`, {})).json().session;
  const status = async (id: number) =>
    (await t.call('GET', `/api/sessions/${id}`)).json().session.status;
  const eventTypes = async (id: number) =>
    (await t.call('GET', `/api/sessions/${id}/events`))
      .json()
      .events.map((e: { event: { type: string } }) => e.event.type);

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/sessions/1/prompt', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('creates and lists sessions with default names', async () => {
    const s = await newSession();
    expect(s).toMatchObject({ name: 'Session 1', status: 'idle' });
    const list = await t.call('GET', `/api/projects/${t.project.id}/sessions`);
    expect(list.json().sessions).toHaveLength(1);
    expect((await t.call('POST', '/api/projects/999/sessions', {})).statusCode).toBe(404);
  });

  it('runs a prompt, persists events without deltas, and returns to idle', async () => {
    const s = await newSession();
    const res = await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'hi' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ disposition: 'started' });
    await until(
      async () =>
        (await status(s.id)) === 'idle' && (await eventTypes(s.id)).includes('agent_settled'),
    );
    const types = await eventTypes(s.id);
    expect(types).toContain('message_end');
    expect(types).not.toContain('message_update');
    expect(t.runtime.processes[0]?.args).toEqual(['--mode', 'rpc']);
  });

  it('streams live events (including deltas) over the websocket', async () => {
    const s = await newSession();
    const ws = await t.app.injectWS(`/api/sessions/${s.id}/stream`, { headers: t.headers });
    const seen: { seq: number; event: { type: string } }[] = [];
    ws.on('message', (data: Buffer) => seen.push(JSON.parse(data.toString())));
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'stream me' });
    await until(() => seen.some((m) => m.event.type === 'agent_settled'));
    expect(seen.some((m) => m.event.type === 'message_update')).toBe(true);
    const seqs = seen.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    ws.terminate();
  });

  it('replays missed events from a sequence number', async () => {
    const s = await newSession();
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'one' });
    await until(async () => (await eventTypes(s.id)).includes('agent_settled'));
    const all = (await t.call('GET', `/api/sessions/${s.id}/events`)).json().events;
    const half = all[Math.floor(all.length / 2)].seq;
    const rest = (await t.call('GET', `/api/sessions/${s.id}/events?after=${half}`)).json().events;
    expect(rest.every((e: { seq: number }) => e.seq > half)).toBe(true);
    expect(rest.length).toBeLessThan(all.length);
  });

  it('rejects a second prompt while running unless a streaming behavior is given', async () => {
    const s = await newSession();
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: '/hang' });
    await until(async () => (await status(s.id)) === 'running');
    expect(
      (await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'x' })).statusCode,
    ).toBe(409);
    const queued = await t.call('POST', `/api/sessions/${s.id}/prompt`, {
      message: 'x',
      streamingBehavior: 'followUp',
    });
    expect(queued.json()).toEqual({ disposition: 'queued' });
    expect((await t.call('POST', `/api/sessions/${s.id}/abort`)).statusCode).toBe(200);
    await until(async () => (await status(s.id)) === 'idle');
  });

  it('validates prompt input', async () => {
    const s = await newSession();
    expect(
      (await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: '  ' })).statusCode,
    ).toBe(400);
    expect(
      (
        await t.call('POST', `/api/sessions/${s.id}/prompt`, {
          message: 'x',
          streamingBehavior: 'bogus',
        })
      ).statusCode,
    ).toBe(400);
    expect((await t.call('POST', '/api/sessions/999/prompt', { message: 'x' })).statusCode).toBe(
      404,
    );
  });

  it('marks a crashed run as error, records the exit, and resumes with --session', async () => {
    const s = await newSession();
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: '/hang' });
    await until(async () => (await status(s.id)) === 'running');
    t.runtime.processes[0]!.crash(2);
    await until(async () => (await status(s.id)) === 'error');
    expect(await eventTypes(s.id)).toContain('panel_process_exit');

    const again = await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'back' });
    expect(again.statusCode).toBe(200);
    const args = t.runtime.processes[1]!.args;
    expect(args[0]).toBe('--mode');
    expect(args).toContain('--session');
    await until(async () => (await status(s.id)) === 'idle');
  });

  it('stops processes when a session or its project is deleted', async () => {
    const s = await newSession();
    await t.call('POST', `/api/sessions/${s.id}/prompt`, { message: 'hi' });
    await until(
      async () =>
        (await status(s.id)) === 'idle' && (await eventTypes(s.id)).includes('agent_settled'),
    );
    expect((await t.call('DELETE', `/api/sessions/${s.id}`)).statusCode).toBe(204);
    expect((await t.call('GET', `/api/sessions/${s.id}`)).statusCode).toBe(404);

    const s2 = await newSession();
    await t.call('POST', `/api/sessions/${s2.id}/prompt`, { message: '/hang' });
    await until(async () => (await status(s2.id)) === 'running');
    expect((await t.call('DELETE', `/api/projects/${t.project.id}`)).statusCode).toBe(204);
    expect((await t.call('GET', `/api/sessions/${s2.id}`)).statusCode).toBe(404);
  });
});
