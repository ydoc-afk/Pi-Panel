import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SANDBOX_AGENT_DIR, agentDir } from './paths.js';
import type { ProviderStore } from './providers.js';
import { RpcClient, type PiEvent } from './rpc-client.js';
import type { ContainerRuntime } from './runtime.js';

export class SessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface SessionRow {
  id: number;
  project_id: number;
  name: string;
  status: string;
  pi_session_file: string | null;
  provider_id: number | null;
  model_id: string | null;
  created_at: number;
}

export interface StreamMessage {
  seq: number;
  event: PiEvent;
}

/** High-volume events that are streamed live but not persisted; message_end carries the final text. */
const EPHEMERAL = new Set(['message_update', 'tool_execution_update']);
const REPLAY_LIMIT = 1000;

export const sessionDto = (r: SessionRow) => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  status: r.status,
  providerId: r.provider_id,
  modelId: r.model_id,
  createdAt: r.created_at,
});

export class SessionManager {
  private live = new Map<number, RpcClient>();
  private starting = new Map<number, Promise<RpcClient>>();
  private intentionalStops = new Set<RpcClient>();
  private listeners = new Map<number, Set<(m: StreamMessage) => void>>();
  private seqs = new Map<number, number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtime: ContainerRuntime,
    private readonly providers: ProviderStore,
    private readonly dataDir: string,
  ) {
    // No pi process survives a panel restart, so nothing can still be running.
    db.prepare("UPDATE sessions SET status = 'idle' WHERE status = 'running'").run();
  }

  row(id: number): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    if (!row) throw new SessionError(404, 'Session not found');
    return row;
  }

  listForProject(projectId: number) {
    return (
      this.db
        .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY id')
        .all(projectId) as unknown as SessionRow[]
    ).map(sessionDto);
  }

  create(
    projectId: number,
    opts: { name?: string; providerId?: number; modelId?: string } = {},
  ): SessionRow {
    const project = this.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as
      { status: string } | undefined;
    if (!project) throw new SessionError(404, 'Project not found');
    if (project.status !== 'running') throw new SessionError(409, 'Project is not running');
    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
    if (opts.providerId !== undefined) {
      if (!this.providers.find(opts.providerId)) throw new SessionError(404, 'Provider not found');
      if (!opts.modelId)
        throw new SessionError(400, 'modelId is required when a provider is chosen');
    }
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO sessions (project_id, name, status, provider_id, model_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          opts.name || `Session ${count + 1}`,
          'idle',
          opts.providerId ?? null,
          opts.providerId === undefined ? null : (opts.modelId ?? null),
          Date.now(),
        ).lastInsertRowid,
    );
    return this.row(id);
  }

  events(id: number, after: number): StreamMessage[] {
    this.row(id);
    return (
      this.db
        .prepare(
          'SELECT seq, data FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        )
        .all(id, after, REPLAY_LIMIT) as unknown as { seq: number; data: string }[]
    ).map((r) => ({ seq: r.seq, event: JSON.parse(r.data) as PiEvent }));
  }

  /** Replays persisted events after `after`, then delivers live ones. Returns an unsubscribe fn. */
  subscribe(id: number, after: number, send: (m: StreamMessage) => void): () => void {
    for (const m of this.events(id, after)) send(m);
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(send);
    return () => set.delete(send);
  }

  async prompt(id: number, message: string, streamingBehavior?: 'steer' | 'followUp') {
    const client = await this.ensureLive(id);
    let res;
    try {
      res = await client.request({
        type: 'prompt',
        message,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
    } catch (err) {
      throw new SessionError(502, err instanceof Error ? err.message : 'pi request failed');
    }
    if (!res.success) throw new SessionError(409, res.error ?? 'Prompt rejected');
    return (res.data ?? {}) as { disposition?: string };
  }

  async abort(id: number) {
    this.row(id);
    const client = this.live.get(id);
    if (!client) return;
    try {
      await client.request({ type: 'abort' });
    } catch (err) {
      throw new SessionError(502, err instanceof Error ? err.message : 'pi request failed');
    }
  }

  stop(id: number) {
    const client = this.live.get(id);
    if (client) this.stopClient(id, client);
  }

  stopProject(projectId: number) {
    const ids = this.db
      .prepare('SELECT id FROM sessions WHERE project_id = ?')
      .all(projectId) as unknown as { id: number }[];
    for (const { id } of ids) this.stop(id);
  }

  /** Stops pi processes of sessions that are not mid-run; returns how many stopped and how many are still running. */
  stopIdleForProject(projectId: number): { stopped: number; running: number } {
    const rows = this.db
      .prepare('SELECT id, status FROM sessions WHERE project_id = ?')
      .all(projectId) as unknown as { id: number; status: string }[];
    let stopped = 0;
    let running = 0;
    for (const { id, status } of rows) {
      if (!this.live.has(id)) continue;
      if (status === 'running') running++;
      else {
        this.stop(id);
        stopped++;
      }
    }
    return { stopped, running };
  }

  delete(id: number) {
    this.row(id);
    this.stop(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.listeners.delete(id);
    this.seqs.delete(id);
  }

  private stopClient(id: number, client: RpcClient) {
    this.intentionalStops.add(client);
    if (this.live.get(id) === client) this.live.delete(id);
    client.close();
  }

  private ensureLive(id: number): Promise<RpcClient> {
    this.row(id);
    const existing = this.live.get(id);
    if (existing) return Promise.resolve(existing);
    let starting = this.starting.get(id);
    if (!starting) {
      starting = this.start(id).finally(() => this.starting.delete(id));
      this.starting.set(id, starting);
    }
    return starting;
  }

  private async start(id: number): Promise<RpcClient> {
    const row = this.row(id);
    const project = this.db
      .prepare('SELECT container_id, status FROM projects WHERE id = ?')
      .get(row.project_id) as { container_id: string | null; status: string } | undefined;
    if (!project?.container_id || project.status !== 'running') {
      throw new SessionError(409, 'Project container is not running');
    }
    const cmd = [
      'pi',
      '--mode',
      'rpc',
      ...(row.pi_session_file ? ['--session', row.pi_session_file] : []),
    ];
    const provider = row.provider_id ? this.providers.find(row.provider_id) : undefined;
    let proc;
    try {
      await this.writeModelsJson(row.project_id);
      proc = await this.runtime.exec(project.container_id, {
        cmd,
        workdir: '/workspace',
        // Only the chosen provider's key is handed to this pi process.
        env: {
          PI_CODING_AGENT_DIR: SANDBOX_AGENT_DIR,
          ...(provider ? this.providers.envFor(provider.id) : {}),
        },
      });
    } catch {
      throw new SessionError(502, 'Failed to start pi in the project container');
    }
    const client = new RpcClient(proc);
    client.onEvent((event) => this.record(id, event));
    client.onClose((code, stderr) => this.handleClose(id, client, code, stderr));
    this.live.set(id, client);
    try {
      const state = await client.request({ type: 'get_state' });
      if (!state.success) throw new Error(state.error);
      const file = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
      if (file && file !== row.pi_session_file) {
        this.db.prepare('UPDATE sessions SET pi_session_file = ? WHERE id = ?').run(file, id);
      }
    } catch {
      this.stopClient(id, client);
      throw new SessionError(502, 'pi did not start correctly');
    }
    if (provider && row.model_id) {
      // set_model over RPC rather than --model: model ids such as "qwen2.5-coder:7b" would
      // collide with the CLI's ":<thinking>" suffix syntax.
      const res = await client
        .request({ type: 'set_model', provider: provider.piKey, modelId: row.model_id })
        .catch((err: Error) => ({ success: false, error: err.message }));
      if (!res.success) {
        this.stopClient(id, client);
        throw new SessionError(400, `Model not available: ${res.error ?? 'unknown error'}`);
      }
    }
    return client;
  }

  /** Writes the keyless models.json that pi reads from the project's agent dir. */
  private async writeModelsJson(projectId: number) {
    const dir = agentDir(this.dataDir, projectId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, 'models.json.tmp');
    await writeFile(tmp, JSON.stringify(this.providers.modelsJson(), null, 2) + '\n', {
      mode: 0o644,
    });
    await rename(tmp, join(dir, 'models.json'));
  }

  private handleClose(id: number, client: RpcClient, code: number | null, stderr: string) {
    if (this.live.get(id) === client) this.live.delete(id);
    if (this.intentionalStops.delete(client)) return;
    const wasRunning = this.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as
      { status: string } | undefined;
    if (!wasRunning) return;
    this.record(id, { type: 'panel_process_exit', code, stderr });
    this.db
      .prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run(wasRunning.status === 'running' ? 'error' : 'idle', id);
  }

  private nextSeq(id: number): number {
    let seq = this.seqs.get(id);
    if (seq === undefined) {
      seq = (
        this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM session_events WHERE session_id = ?')
          .get(id) as { m: number }
      ).m;
    }
    this.seqs.set(id, ++seq);
    return seq;
  }

  private record(id: number, event: PiEvent) {
    const seq = this.nextSeq(id);
    if (!EPHEMERAL.has(event.type)) {
      this.db
        .prepare('INSERT INTO session_events (session_id, seq, data) VALUES (?, ?, ?)')
        .run(id, seq, JSON.stringify(event));
    }
    if (event.type === 'agent_start') this.setStatus(id, 'running');
    else if (event.type === 'agent_settled') this.setStatus(id, 'idle');
    for (const send of this.listeners.get(id) ?? []) send({ seq, event });
  }

  private setStatus(id: number, status: string) {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SessionError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerSessions(app: FastifyInstance, manager: SessionManager) {
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);

  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => ({
    sessions: manager.listForProject(num(req.params.id)),
  }));

  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', (req, reply) =>
    handle(reply, () => {
      const { name, providerId, modelId } = (req.body ?? {}) as {
        name?: unknown;
        providerId?: unknown;
        modelId?: unknown;
      };
      if (
        providerId !== undefined &&
        (!Number.isInteger(providerId) || typeof modelId !== 'string')
      ) {
        return reply
          .code(400)
          .send({ error: 'providerId must be an integer and modelId a string' });
      }
      const session = manager.create(num(req.params.id), {
        name: typeof name === 'string' ? name.trim().slice(0, 80) : undefined,
        providerId: providerId as number | undefined,
        modelId: typeof modelId === 'string' ? modelId.trim().slice(0, 200) : undefined,
      });
      return reply.code(201).send({ session: sessionDto(session) });
    }),
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id', (req, reply) =>
    handle(reply, () => ({ session: sessionDto(manager.row(num(req.params.id))) })),
  );

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', (req, reply) =>
    handle(reply, () => {
      manager.delete(num(req.params.id));
      return reply.code(204).send();
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/sessions/:id/events',
    (req, reply) =>
      handle(reply, () => ({
        events: manager.events(num(req.params.id), num(req.query.after ?? '0')),
      })),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/prompt', (req, reply) =>
    handle(reply, async () => {
      const { message, streamingBehavior } = (req.body ?? {}) as {
        message?: unknown;
        streamingBehavior?: unknown;
      };
      if (typeof message !== 'string' || !message.trim() || message.length > 100_000) {
        return reply.code(400).send({ error: 'message must be a non-empty string' });
      }
      if (
        streamingBehavior !== undefined &&
        streamingBehavior !== 'steer' &&
        streamingBehavior !== 'followUp'
      ) {
        return reply.code(400).send({ error: 'streamingBehavior must be steer or followUp' });
      }
      return await manager.prompt(num(req.params.id), message, streamingBehavior);
    }),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/abort', (req, reply) =>
    handle(reply, async () => {
      await manager.abort(num(req.params.id));
      return { ok: true };
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/sessions/:id/stream',
    { websocket: true },
    (socket, req) => {
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = manager.subscribe(num(req.params.id), num(req.query.after ?? '0'), (m) =>
          socket.send(JSON.stringify(m)),
        );
      } catch {
        socket.close(1008, 'Session not found');
        return;
      }
      socket.on('close', () => unsubscribe?.());
    },
  );
}
