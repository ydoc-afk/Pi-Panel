import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

describe('pi controls on a session', () => {
  let dataDir: string;
  let runtime: FakeRuntime;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let sessionId: number;
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });
  const start = () => call('POST', `/api/sessions/${sessionId}/prompt`, { message: 'hi' });
  const pi = async () => (await call('GET', `/api/sessions/${sessionId}/pi`)).json();
  const settle = async () => {
    for (let i = 0; i < 300; i++) {
      const ev = (await call('GET', `/api/sessions/${sessionId}/events`)).json().events;
      if (ev.some((e: { event: { type: string } }) => e.event.type === 'agent_settled')) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('did not settle');
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-pi-'));
    runtime = new FakeRuntime();
    app = buildApp({ db: openDb(':memory:'), runtime, dataDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    headers = { cookie: `pp_session=${res.cookies.find((c) => c.name === 'pp_session')!.value}` };
    const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
    sessionId = (await call('POST', `/api/projects/${project.id}/sessions`, {})).json().session.id;
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports nothing about pi before it has started, and does not start it', async () => {
    expect(await pi()).toMatchObject({
      running: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      autoCompaction: null,
      stats: null,
    });
    expect(runtime.processes).toHaveLength(0);
  });

  it('reports thinking, compaction and token use once pi is running', async () => {
    await start();
    await settle();
    const s = await pi();
    expect(s).toMatchObject({
      running: true,
      thinkingLevel: 'medium',
      availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
      autoCompaction: true,
      isCompacting: false,
      model: { id: 'fake-model', contextWindow: 100000 },
    });
    expect(s.stats.tokens).toMatchObject({ input: 1000, output: 200, total: 1200 });
    expect(s.stats.context).toEqual({ tokens: 1200, window: 100000, percent: 1.2 });
    expect(s.stats.cost).toBeCloseTo(0.01);
  });

  it('changes the thinking level in pi and refuses unknown or unsupported ones', async () => {
    await start();
    await settle();
    const set = (level: unknown) => call('POST', `/api/sessions/${sessionId}/thinking`, { level });
    expect((await set('high')).json().thinkingLevel).toBe('high');
    expect(runtime.processes[0]!.received.filter((c) => c.type === 'set_thinking_level')).toEqual([
      expect.objectContaining({ level: 'high' }),
    ]);
    expect((await set('turbo')).statusCode).toBe(400);
    // Known to the panel but not offered by this model: pi's refusal is passed on.
    const refused = await set('xhigh');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('Unsupported');
    expect((await pi()).thinkingLevel).toBe('high');
  });

  it('remembers a thinking level and auto-compaction chosen before pi started, and applies them', async () => {
    const t = await call('POST', `/api/sessions/${sessionId}/thinking`, { level: 'low' });
    expect(t.json()).toMatchObject({ running: false, thinkingLevel: 'low' });
    const a = await call('POST', `/api/sessions/${sessionId}/auto-compaction`, { enabled: false });
    expect(a.json()).toMatchObject({ running: false, autoCompaction: false });
    await start();
    await settle();
    const received = runtime.processes[0]!.received;
    expect(received.find((c) => c.type === 'set_thinking_level')).toMatchObject({ level: 'low' });
    expect(received.find((c) => c.type === 'set_auto_compaction')).toMatchObject({
      enabled: false,
    });
    expect(await pi()).toMatchObject({ thinkingLevel: 'low', autoCompaction: false });
  });

  it('validates the auto-compaction setting', async () => {
    const res = await call('POST', `/api/sessions/${sessionId}/auto-compaction`, {
      enabled: 'yes',
    });
    expect(res.statusCode).toBe(400);
  });

  it('compacts a running session and reports the token drop', async () => {
    expect((await call('POST', `/api/sessions/${sessionId}/compact`, {})).statusCode).toBe(409);
    await start();
    await settle();
    const res = await call('POST', `/api/sessions/${sessionId}/compact`, {
      instructions: 'Keep the decisions',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tokensBefore: 1200,
      tokensAfter: 300,
      summary: 'Summary (Keep the decisions)',
    });
    expect((await pi()).stats.tokens.total).toBe(0);
    // Nothing left to compact: pi's reason is passed on.
    const again = await call('POST', `/api/sessions/${sessionId}/compact`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('Nothing to compact');
    const long = await call('POST', `/api/sessions/${sessionId}/compact`, {
      instructions: 'x'.repeat(2001),
    });
    expect(long.statusCode).toBe(400);
  });

  it('answers 404 for a session that does not exist', async () => {
    expect((await call('GET', '/api/sessions/999/pi')).statusCode).toBe(404);
    expect((await call('POST', '/api/sessions/999/compact', {})).statusCode).toBe(404);
  });
});
