import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

type Ev = { seq: number; event: Record<string, unknown> };

describe('extension UI over RPC', () => {
  let dataDir: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  let sessionId: number;
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });
  const events = async () =>
    (await call('GET', `/api/sessions/${sessionId}/events`)).json().events as Ev[];
  const until = async (cond: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition not met in time');
  };
  const has = async (pred: (e: Record<string, unknown>) => boolean) =>
    (await events()).some((m) => pred(m.event));
  const respond = (body: Record<string, unknown>) =>
    call('POST', `/api/sessions/${sessionId}/ui-response`, body);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-ui-'));
    app = buildApp({ db: openDb(':memory:'), runtime: new FakeRuntime(), dataDir });
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

  const askedId = async () =>
    (await events()).map((m) => m.event).find((e) => e.method === 'confirm')?.id as string;

  it('records UI changes once, and drops repeats and clears of nothing', async () => {
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message: '/ui' });
    await until(async () => has((e) => e.method === 'confirm'));
    const ui = (await events())
      .map((m) => m.event)
      .filter((e) => e.type === 'extension_ui_request');
    expect(ui.map((e) => e.method)).toEqual(['setStatus', 'setWidget', 'confirm']);
    expect((await events()).some((m) => m.event.type === 'panel_ui_reset')).toBe(true);
    await respond({ id: await askedId(), cancelled: true });
  });

  it('delivers the answer to pi and retires the dialog', async () => {
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message: '/ui' });
    await until(async () => has((e) => e.method === 'confirm'));
    const id = await askedId();

    const res = await respond({ id, confirmed: true });
    expect(res.statusCode).toBe(200);
    await until(async () => has((e) => e.type === 'agent_settled'));

    const resolved = (await events())
      .map((m) => m.event)
      .find((e) => e.type === 'panel_ui_resolved');
    expect(resolved).toMatchObject({ id, reason: 'answered' });
    const reply = (await events())
      .map((m) => m.event)
      .find(
        (e) => e.type === 'message_end' && (e.message as { role?: string }).role === 'assistant',
      );
    expect(JSON.stringify(reply)).toContain('\\"confirmed\\":true');

    // Answering twice, or a question that was never asked, is refused.
    expect((await respond({ id, confirmed: true })).statusCode).toBe(409);
    expect((await respond({ id: 'nope', cancelled: true })).statusCode).toBe(409);
  });

  it('rejects malformed answers without touching the pending dialog', async () => {
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message: '/ui' });
    await until(async () => has((e) => e.method === 'confirm'));
    const id = await askedId();
    expect((await respond({ confirmed: true })).statusCode).toBe(400);
    expect((await respond({ id })).statusCode).toBe(400);
    expect((await respond({ id, confirmed: 'yes' })).statusCode).toBe(400);
    expect((await respond({ id, value: 'a', confirmed: true })).statusCode).toBe(400);
    expect((await respond({ id, cancelled: false })).statusCode).toBe(400);
    expect((await respond({ id, cancelled: true })).statusCode).toBe(200);
  });

  it('retires a dialog whose own timeout passed', async () => {
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message: '/ui 50' });
    await until(async () => has((e) => e.type === 'panel_ui_resolved'), 4000);
    const resolved = (await events())
      .map((m) => m.event)
      .find((e) => e.type === 'panel_ui_resolved');
    expect(resolved).toMatchObject({ reason: 'timeout' });
    expect((await respond({ id: resolved!.id as string, cancelled: true })).statusCode).toBe(409);
  });

  it('can be deleted while a dialog is open, without a timer writing to the deleted session', async () => {
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message: '/ui 100' });
    await until(async () => has((e) => e.method === 'confirm'));
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}`, headers });
    expect(del.statusCode).toBe(204);
    // The dialog's timer would have fired about a second later; an uncaught error fails the run.
    await new Promise((r) => setTimeout(r, 1300));
    expect((await call('GET', `/api/sessions/${sessionId}`)).statusCode).toBe(404);
  });
});
