import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { FakeRuntime } from './runtime.js';

const SECRET = 'sk-super-secret-value';

async function setup(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-test-'));
  const db = openDb(':memory:');
  const runtime = new FakeRuntime();
  const app = buildApp({ db, runtime, dataDir, fetch: fetchImpl });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers, payload });
  return { app, db, runtime, dataDir, call };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('providers', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const fetchMock = vi.fn();
  beforeEach(async () => {
    fetchMock.mockReset();
    t = await setup(fetchMock as unknown as typeof fetch);
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  const compat = (extra: Record<string, unknown> = {}) =>
    t.call('POST', '/api/providers', {
      kind: 'openai-compatible',
      name: 'Local llama',
      baseUrl: 'http://host.docker.internal:8080/v1',
      apiKey: SECRET,
      models: ['qwen2.5-coder:7b'],
      ...extra,
    });

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: '/api/providers' })).statusCode).toBe(401);
  });

  it('stores keys encrypted and never returns them', async () => {
    const res = await compat();
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SECRET);
    expect(res.json().provider).toMatchObject({
      kind: 'openai-compatible',
      hasKey: true,
      piKey: 'pp-local-llama',
    });
    expect((await t.call('GET', '/api/providers')).body).not.toContain(SECRET);
    const raw = t.db.prepare('SELECT api_key_enc FROM providers').get() as { api_key_enc: string };
    expect(raw.api_key_enc).not.toContain(SECRET);
    expect(existsSync(join(t.dataDir, 'secret.key'))).toBe(true);
  });

  it('validates input', async () => {
    expect((await compat({ kind: 'nope' })).statusCode).toBe(400);
    expect((await compat({ baseUrl: undefined })).statusCode).toBe(400);
    expect((await compat({ baseUrl: 'ftp://x' })).statusCode).toBe(400);
    expect((await compat({ baseUrl: 'not a url' })).statusCode).toBe(400);
    expect((await compat({ name: '../x' })).statusCode).toBe(400);
    expect((await compat({ models: ['ok', ''] })).statusCode).toBe(400);
    expect((await compat({ name: '---' })).statusCode).toBe(400);
  });

  it('rejects duplicates and a second built-in provider of the same kind', async () => {
    expect((await compat()).statusCode).toBe(201);
    expect((await compat()).statusCode).toBe(409);
    expect((await compat({ name: 'local-llama' })).statusCode).toBe(409); // same pi key
    const a = { kind: 'anthropic', name: 'Anthropic', apiKey: 'k' };
    expect((await t.call('POST', '/api/providers', a)).statusCode).toBe(201);
    expect((await t.call('POST', '/api/providers', { ...a, name: 'Another' })).statusCode).toBe(
      409,
    );
  });

  it('warns when the base URL points at localhost', async () => {
    const res = await compat({ baseUrl: 'http://localhost:8080/v1' });
    expect(res.json().provider.warning).toMatch(/host\.docker\.internal/);
    expect((await compat({ name: 'ok' })).json().provider.warning).toBeUndefined();
  });

  it('updates fields, keeps the key when omitted, and clears it with null', async () => {
    const id = (await compat()).json().provider.id;
    const kept = await t.call('PUT', `/api/providers/${id}`, { models: ['a', 'b'] });
    expect(kept.json().provider).toMatchObject({ hasKey: true, models: ['a', 'b'] });
    const cleared = await t.call('PUT', `/api/providers/${id}`, { apiKey: null });
    expect(cleared.json().provider.hasKey).toBe(false);
    expect((await t.call('PUT', '/api/providers/999', {})).statusCode).toBe(404);
  });

  it('deletes providers and detaches them from sessions', async () => {
    const pid = (await compat()).json().provider.id;
    const project = (await t.call('POST', '/api/projects', { name: 'p' })).json().project;
    const session = (
      await t.call('POST', `/api/projects/${project.id}/sessions`, {
        providerId: pid,
        modelId: 'm',
      })
    ).json().session;
    expect((await t.call('DELETE', `/api/providers/${pid}`)).statusCode).toBe(204);
    const after = (await t.call('GET', `/api/sessions/${session.id}`)).json().session;
    expect(after.providerId).toBeNull();
  });

  describe('model discovery', () => {
    it('lists models from an OpenAI-compatible server with bearer auth', async () => {
      fetchMock.mockResolvedValue(json({ data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }] }));
      const id = (await compat({ models: [] })).json().provider.id;
      const res = await t.call('POST', `/api/providers/${id}/discover`);
      expect(res.json().provider.models).toEqual(['m1', 'm2']);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://host.docker.internal:8080/v1/models');
      expect(init.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(init.redirect).toBe('error');
    });

    it('uses x-api-key and the version header for Anthropic', async () => {
      fetchMock.mockResolvedValue(json({ data: [{ id: 'claude-x' }] }));
      const id = (
        await t.call('POST', '/api/providers', {
          kind: 'anthropic',
          name: 'Anthropic',
          apiKey: SECRET,
        })
      ).json().provider.id;
      const res = await t.call('POST', `/api/providers/${id}/discover`);
      expect(res.json().provider.models).toEqual(['claude-x']);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect(init.headers['x-api-key']).toBe(SECRET);
      expect(init.headers['anthropic-version']).toBeDefined();
    });

    it('defaults OpenAI to its public API', async () => {
      fetchMock.mockResolvedValue(json({ data: [{ id: 'gpt-x' }] }));
      const id = (
        await t.call('POST', '/api/providers', { kind: 'openai', name: 'OpenAI', apiKey: SECRET })
      ).json().provider.id;
      await t.call('POST', `/api/providers/${id}/discover`);
      expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/models');
    });

    it('requires a key for hosted providers but not for local servers', async () => {
      const id = (await t.call('POST', '/api/providers', { kind: 'openai', name: 'OpenAI' })).json()
        .provider.id;
      expect((await t.call('POST', `/api/providers/${id}/discover`)).statusCode).toBe(400);
      fetchMock.mockResolvedValue(json({ data: [{ id: 'm' }] }));
      const local = (await compat({ name: 'nokey', apiKey: undefined })).json().provider.id;
      expect((await t.call('POST', `/api/providers/${local}/discover`)).statusCode).toBe(200);
      expect(fetchMock.mock.calls[0]![1].headers.authorization).toBeUndefined();
    });

    it('maps upstream failures to 502 without leaking the key', async () => {
      const id = (await compat()).json().provider.id;
      fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 401));
      const bad = await t.call('POST', `/api/providers/${id}/discover`);
      expect(bad.statusCode).toBe(502);
      expect(bad.body).toContain('401');
      fetchMock.mockRejectedValueOnce(new Error(`connect failed for ${SECRET}`));
      const down = await t.call('POST', `/api/providers/${id}/discover`);
      expect(down.statusCode).toBe(502);
      expect(down.body).not.toContain(SECRET);
      fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
      expect((await t.call('POST', `/api/providers/${id}/discover`)).statusCode).toBe(502);
    });
  });

  describe('test connection', () => {
    const body = { kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:8080/v1' };

    it('lists models from unsaved settings and stores nothing', async () => {
      fetchMock.mockResolvedValue(json({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      const res = await t.call('POST', '/api/providers/test', { ...body, apiKey: SECRET });
      expect(res.statusCode).toBe(200);
      expect(res.json().models).toEqual(['m1', 'm2']);
      expect(fetchMock.mock.calls[0]![0]).toBe('http://host.docker.internal:8080/v1/models');
      expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${SECRET}`);
      expect((await t.call('GET', '/api/providers')).json().providers).toEqual([]);
    });

    it('falls back to the stored key while editing a blank key field', async () => {
      const id = (await compat()).json().provider.id;
      fetchMock.mockResolvedValue(json({ data: [{ id: 'm' }] }));
      await t.call('POST', '/api/providers/test', { ...body, providerId: id });
      expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${SECRET}`);
    });

    it('validates the kind and base URL before calling out', async () => {
      const noUrl = await t.call('POST', '/api/providers/test', { kind: 'openai-compatible' });
      expect(noUrl.statusCode).toBe(400);
      const badKind = await t.call('POST', '/api/providers/test', { kind: 'nope', baseUrl: 'x' });
      expect(badKind.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports upstream failures without leaking the key', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 401));
      const res = await t.call('POST', '/api/providers/test', { ...body, apiKey: SECRET });
      expect(res.statusCode).toBe(502);
      expect(res.body).toContain('401');
      expect(res.body).not.toContain(SECRET);
    });
  });

  describe('sessions using providers', () => {
    const startSession = async (providerId?: number, modelId?: string) => {
      const project = (await t.call('POST', '/api/projects', { name: `p${Math.random()}` })).json()
        .project;
      const res = await t.call('POST', `/api/projects/${project.id}/sessions`, {
        providerId,
        modelId,
      });
      return { project, res, session: res.json().session };
    };
    const prompt = (id: number) => t.call('POST', `/api/sessions/${id}/prompt`, { message: 'hi' });

    it('writes a keyless models.json and passes only the chosen key', async () => {
      const compatP = (await compat()).json().provider;
      await t.call('POST', '/api/providers', {
        kind: 'anthropic',
        name: 'Anthropic',
        apiKey: 'ant-key',
      });
      const { project, session } = await startSession(compatP.id, 'qwen2.5-coder:7b');
      expect((await prompt(session.id)).statusCode).toBe(200);

      const file = join(t.dataDir, 'agents', String(project.id), 'models.json');
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('ant-key');
      expect(JSON.parse(text).providers['pp-local-llama']).toMatchObject({
        api: 'openai-completions',
        apiKey: `$PP_KEY_${compatP.id}`,
        models: [{ id: 'qwen2.5-coder:7b' }],
      });

      const env = t.runtime.execs[0]!.env!;
      expect(env).toEqual({
        PI_CODING_AGENT_DIR: '/home/sandbox/.pi/agent',
        [`PP_KEY_${compatP.id}`]: SECRET,
      });
      const setModel = t.runtime.processes[0]!.received.find((c) => c.type === 'set_model');
      expect(setModel).toMatchObject({ provider: 'pp-local-llama', modelId: 'qwen2.5-coder:7b' });
    });

    it('uses pi built-in env vars for Anthropic and OpenAI', async () => {
      const a = (
        await t.call('POST', '/api/providers', {
          kind: 'anthropic',
          name: 'Anthropic',
          apiKey: 'ant-key',
        })
      ).json().provider;
      const { session } = await startSession(a.id, 'claude-x');
      await prompt(session.id);
      expect(t.runtime.execs[0]!.env).toMatchObject({ ANTHROPIC_API_KEY: 'ant-key' });
      expect(t.runtime.processes[0]!.received.find((c) => c.type === 'set_model')).toMatchObject({
        provider: 'anthropic',
        modelId: 'claude-x',
      });
    });

    it('writes a base URL override for a built-in provider but no key', async () => {
      await t.call('POST', '/api/providers', {
        kind: 'openai',
        name: 'OpenAI',
        apiKey: 'oa-key',
        baseUrl: 'https://proxy.example.com/v1',
      });
      const { project, session } = await startSession();
      await prompt(session.id);
      const cfg = JSON.parse(
        readFileSync(join(t.dataDir, 'agents', String(project.id), 'models.json'), 'utf8'),
      );
      expect(cfg.providers.openai).toEqual({ baseUrl: 'https://proxy.example.com/v1' });
    });

    it('starts without provider env when none is chosen', async () => {
      const { session } = await startSession();
      await prompt(session.id);
      expect(t.runtime.execs[0]!.env).toEqual({ PI_CODING_AGENT_DIR: '/home/sandbox/.pi/agent' });
      expect(t.runtime.processes[0]!.received.some((c) => c.type === 'set_model')).toBe(false);
    });

    it('fails the prompt clearly when pi rejects the model', async () => {
      const p = (await compat()).json().provider;
      const { session } = await startSession(p.id, 'missing-model');
      const res = await prompt(session.id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Model not available/);
    });

    it('validates provider choice on session creation', async () => {
      const project = (await t.call('POST', '/api/projects', { name: 'v' })).json().project;
      const url = `/api/projects/${project.id}/sessions`;
      expect((await t.call('POST', url, { providerId: 999, modelId: 'm' })).statusCode).toBe(404);
      const p = (await compat()).json().provider;
      expect((await t.call('POST', url, { providerId: p.id })).statusCode).toBe(400);
      expect((await t.call('POST', url, { providerId: 'x', modelId: 'm' })).statusCode).toBe(400);
    });
  });
});
