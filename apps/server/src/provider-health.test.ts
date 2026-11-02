import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { describeProviderError } from './providers.js';
import { FakeRuntime } from './runtime.js';

describe('describeProviderError', () => {
  it('explains a rejected key', () => {
    const r = describeProviderError('Provider returned HTTP 401');
    expect(r.status).toBe(401);
    expect(r.message).toMatch(/rejected the API key \(HTTP 401\)/);
    expect(describeProviderError('403 Forbidden').status).toBe(403);
  });

  it('recognises rate limits, missing models, server errors and unreachable hosts', () => {
    expect(describeProviderError('429 rate limited').message).toMatch(/rate limiting/);
    expect(describeProviderError('HTTP 404').message).toMatch(/base URL/);
    expect(describeProviderError('502 Bad Gateway')).toMatchObject({ status: 502 });
    expect(describeProviderError('connect ECONNREFUSED 10.0.0.1:8080')).toMatchObject({
      status: null,
      message: expect.stringMatching(/could not be reached/),
    });
  });

  it('copes with empty text and ignores digits that are not statuses', () => {
    expect(describeProviderError('').message).toBe('The model returned an error');
    expect(describeProviderError('used 12345 tokens').status).toBeNull();
  });
});

describe('provider health from session failures', () => {
  let dataDir: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { cookie: string };
  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, payload });
  const until = async (cond: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 300; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition not met in time');
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-health-'));
    app = buildApp({ db: openDb(':memory:'), runtime: new FakeRuntime(), dataDir });
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

  async function sessionWithProvider() {
    const provider = (
      await call('POST', '/api/providers', {
        kind: 'openai-compatible',
        name: 'Llama',
        baseUrl: 'http://192.168.1.143:8080/v1',
        apiKey: 'old-key',
        models: ['m1'],
      })
    ).json().provider;
    const project = (await call('POST', '/api/projects', { name: 'p' })).json().project;
    const session = (
      await call('POST', `/api/projects/${project.id}/sessions`, {
        providerId: provider.id,
        modelId: 'm1',
      })
    ).json().session;
    return { provider, session };
  }

  const prompt = async (sessionId: number, message: string) => {
    const before = (await call('GET', `/api/sessions/${sessionId}/events`)).json().events.length;
    await call('POST', `/api/sessions/${sessionId}/prompt`, { message });
    await until(async () => {
      const events = (await call('GET', `/api/sessions/${sessionId}/events`)).json().events;
      return (
        events.length > before &&
        events
          .slice(before)
          .some((e: { event: { type: string } }) => e.event.type === 'agent_settled')
      );
    });
  };
  const providerOf = async (id: number) =>
    (await call('GET', '/api/providers')).json().providers.find((p: { id: number }) => p.id === id);

  it('marks the provider failing, tells the session, and counts it on the dashboard', async () => {
    const { provider, session } = await sessionWithProvider();
    expect((await providerOf(provider.id)).health).toBeUndefined();

    await prompt(session.id, '/fail Provider returned HTTP 401');

    const p = await providerOf(provider.id);
    expect(p.health).toMatchObject({ status: 401 });
    expect(p.health.message).toMatch(/rejected the API key/);

    const events = (await call('GET', `/api/sessions/${session.id}/events`)).json().events;
    const notice = events.find((e: { event: { type: string } }) => e.event.type === 'panel_notice');
    expect(notice.event).toMatchObject({ level: 'error' });
    expect(notice.event.message).toMatch(/HTTP 401/);

    const dash = (await call('GET', '/api/dashboard')).json();
    expect(dash.providers.failing).toBe(1);
    expect(dash.activity.days.reduce((n: number, d: { errors: number }) => n + d.errors, 0)).toBe(
      1,
    );
  });

  it('clears the mark when a later call succeeds', async () => {
    const { provider, session } = await sessionWithProvider();
    await prompt(session.id, '/fail 429 rate limited');
    expect((await providerOf(provider.id)).health).toMatchObject({ status: 429 });
    await prompt(session.id, 'hello');
    expect((await providerOf(provider.id)).health).toBeUndefined();
    expect((await call('GET', '/api/dashboard')).json().providers.failing).toBe(0);
  });
});
