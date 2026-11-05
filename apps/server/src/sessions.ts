import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { agentNote } from './agent-note.js';
import { runtimeNote } from './runtimes.js';
import {
  PUSH_DIALOG_TITLE,
  describePush,
  parsePushRequest,
  type ForgePusher,
  type PushRequest,
} from './agent-push.js';
import { SANDBOX_AGENT_DIR, agentDir } from './paths.js';
import type { McpStore } from './mcp-store.js';
import type { SamplesService } from './samples.js';
import type { SidecarManager } from './sidecars.js';
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
const FORGE_EXTENSION = new URL('../assets/panel-forge.js', import.meta.url);
/** Extension UI calls that block pi until the client answers. */
const UI_DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
/** Grace after a dialog's own timeout before the panel stops offering it. */
const UI_TIMEOUT_GRACE_MS = 1000;

export const sessionDto = (r: SessionRow) => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  status: r.status,
  providerId: r.provider_id,
  modelId: r.model_id,
  createdAt: r.created_at,
});

/** A dialog waiting for the user; push is set for the reserved push-to-repository confirmation. */
interface PendingUi {
  timer: ReturnType<typeof setTimeout> | null;
  push?: PushRequest;
  /** A push is running, so a second answer must not start another. */
  busy?: boolean;
}

export class SessionManager {
  private live = new Map<number, RpcClient>();
  private starting = new Map<number, Promise<RpcClient>>();
  private intentionalStops = new Set<RpcClient>();
  /** Extension dialogs waiting for an answer, per session, with the timer that retires them. */
  private readonly uiPending = new Map<number, Map<string, PendingUi>>();
  /** What each status and widget currently shows, so repeats and clears of nothing are dropped. */
  private readonly uiShown = new Map<number, Map<string, string>>();
  private listeners = new Map<number, Set<(m: StreamMessage) => void>>();
  private seqs = new Map<number, number>();
  /** Sessions whose pi process should be replaced as soon as their current run settles. */
  private restartWhenIdle = new Set<number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtime: ContainerRuntime,
    private readonly providers: ProviderStore,
    private readonly dataDir: string,
    private readonly mcp: McpStore,
    private readonly sidecars: SidecarManager,
    private readonly samples: SamplesService,
    private readonly pusher?: ForgePusher,
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

  /**
   * Replays every persisted event after `after`, then delivers live ones. Returns an unsubscribe fn.
   * Replay pages through the whole backlog: a client reconnecting after a long gap must not miss
   * events. It is synchronous, so nothing recorded meanwhile can slip between replay and live.
   */
  subscribe(id: number, after: number, send: (m: StreamMessage) => void): () => void {
    let cursor = after;
    for (;;) {
      const page = this.events(id, cursor);
      for (const m of page) send(m);
      if (page.length < REPLAY_LIMIT) break;
      cursor = page[page.length - 1]!.seq;
    }
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
      if (status === 'running') {
        // Let the run finish, then replace the process so it picks up the new configuration.
        this.restartWhenIdle.add(id);
        running++;
      } else {
        this.stop(id);
        stopped++;
      }
    }
    return { stopped, running };
  }

  rename(id: number, name: string) {
    this.row(id);
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
    return this.row(id);
  }

  delete(id: number) {
    this.row(id);
    this.stop(id);
    this.forgetUi(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.listeners.delete(id);
    this.seqs.delete(id);
  }

  /** Drops dialog timers and shown-state without recording anything: the session is going away. */
  private forgetUi(id: number) {
    for (const { timer } of this.uiPending.get(id)?.values() ?? []) if (timer) clearTimeout(timer);
    this.uiPending.delete(id);
    this.uiShown.delete(id);
  }

  private stopClient(id: number, client: RpcClient) {
    this.restartWhenIdle.delete(id);
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
    let sidecarsResult: Awaited<ReturnType<SidecarManager['ensureForProject']>> | undefined;
    try {
      // Managed MCP servers must be up before pi starts, or it would list them as failed.
      sidecarsResult = await this.sidecars.ensureForProject(row.project_id);
      const mcp = await this.writeAgentConfig(row.project_id);
      proc = await this.runtime.exec(project.container_id, {
        cmd,
        workdir: '/workspace',
        // Only the chosen provider's key is handed to this pi process.
        env: {
          PI_CODING_AGENT_DIR: SANDBOX_AGENT_DIR,
          ...(provider ? this.providers.envFor(provider.id) : {}),
          // Values for the ${VAR} references in mcp.json, for this project's enabled servers only.
          ...mcp.env,
        },
      });
    } catch {
      throw new SessionError(502, 'Failed to start pi in the project container');
    }
    const client = new RpcClient(proc);
    client.onEvent((event) => this.record(id, event));
    for (const f of sidecarsResult?.failed ?? []) {
      this.record(id, {
        type: 'panel_notice',
        level: 'warning',
        message: `MCP server "${f.server}" could not start: ${f.error}`,
      });
    }
    client.onClose((code, stderr) => this.handleClose(id, client, code, stderr));
    this.live.set(id, client);
    // A new pi process starts with no statuses or widgets; tell the views to forget the old ones.
    this.record(id, { type: 'panel_ui_reset' });
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

  /** Writes the keyless config files pi reads from the project's agent dir. */
  private async writeAgentConfig(projectId: number) {
    const dir = agentDir(this.dataDir, projectId);
    await mkdir(dir, { recursive: true });
    const write = async (name: string, content: object) => {
      const tmp = join(dir, `${name}.tmp`);
      await writeFile(tmp, JSON.stringify(content, null, 2) + '\n', { mode: 0o644 });
      await rename(tmp, join(dir, name));
    };
    await write('models.json', this.providers.modelsJson());
    // Always written, even when empty, so servers removed in the panel do not linger in the file.
    const mcp = this.mcp.projectConfig(projectId, { samples: this.samples.names(projectId) });
    await write('mcp.json', mcp.config);
    // AGENTS.md in the agent dir is pi's global context. Removed when the project has no repository,
    // so unlinking one does not leave stale instructions behind.
    const link = this.db
      .prepare('SELECT repo, repo_host, applied_runtime FROM projects WHERE id = ?')
      .get(projectId) as
      { repo: string | null; repo_host: string | null; applied_runtime: string } | undefined;
    const note = agentNote(
      link?.repo ?? null,
      link?.repo_host ?? null,
      // The container's runtime, not the one chosen for the next recreate.
      link ? runtimeNote(link.applied_runtime) : null,
    );
    const extension = join(dir, 'extensions', 'panel-forge.js');
    if (note) {
      const tmp = join(dir, 'AGENTS.md.tmp');
      await writeFile(tmp, note, { mode: 0o644 });
      await rename(tmp, join(dir, 'AGENTS.md'));
    } else {
      await rm(join(dir, 'AGENTS.md'), { force: true });
    }
    if (link?.repo) {
      // The push tool the note refers to: installed only where there is a repository to push to.
      await mkdir(join(dir, 'extensions'), { recursive: true });
      await writeFile(extension, await readFile(FORGE_EXTENSION), { mode: 0o644 });
    } else {
      await rm(extension, { force: true });
    }
    return mcp;
  }

  private handleClose(id: number, client: RpcClient, code: number | null, stderr: string) {
    if (this.live.get(id) === client) {
      this.live.delete(id);
      this.clearUi(id);
    }
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

  /**
   * A failed model call ends the assistant message with stopReason "error". Remember it on the
   * provider so the Providers page and dashboard show it, and say so in this session too. A
   * finished call clears the mark. Aborts are the user's own doing, not a provider fault.
   */
  private trackProviderHealth(id: number, event: PiEvent) {
    const msg = event.message as
      { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.role !== 'assistant') return;
    const row = this.db.prepare('SELECT provider_id FROM sessions WHERE id = ?').get(id) as
      { provider_id: number | null } | undefined;
    if (!row?.provider_id) return;
    if (msg.stopReason === 'error' || msg.errorMessage) {
      const health = this.providers.recordFailure(row.provider_id, msg.errorMessage ?? '');
      this.record(id, {
        type: 'panel_notice',
        level: 'error',
        message: `Model provider error: ${health.message}`,
      });
    } else if (msg.stopReason !== 'aborted') {
      this.providers.clearFailure(row.provider_id);
    }
  }

  /**
   * Decides whether an extension UI request is worth recording. Extensions re-send the same status or
   * clear a widget that is not showing many times a minute (one session logged over a thousand of
   * each), so only changes are kept. Dialogs are remembered until answered, timed out or abandoned.
   */
  private acceptUi(id: number, event: PiEvent): boolean {
    const method = event.method;
    if (typeof method !== 'string') return true;
    let key: string | undefined;
    let value: string | null = null;
    if (method === 'setStatus' && typeof event.statusKey === 'string') {
      key = `status:${event.statusKey}`;
      value = typeof event.statusText === 'string' ? event.statusText : null;
    } else if (method === 'setWidget' && typeof event.widgetKey === 'string') {
      key = `widget:${event.widgetKey}`;
      value = Array.isArray(event.widgetLines)
        ? JSON.stringify([event.widgetLines, event.widgetPlacement ?? 'aboveEditor'])
        : null;
    }
    if (key !== undefined) {
      let shown = this.uiShown.get(id);
      if (!shown) this.uiShown.set(id, (shown = new Map()));
      if ((shown.get(key) ?? null) === value) return false;
      if (value === null) shown.delete(key);
      else shown.set(key, value);
      return true;
    }
    let push: PushRequest | undefined;
    if (method === 'input' && event.title === PUSH_DIALOG_TITLE && typeof event.id === 'string') {
      push = this.acceptPush(id, event);
      if (!push) return false; // answered (refused) without bothering the user
    }
    if (UI_DIALOGS.has(method) && typeof event.id === 'string') {
      let pending = this.uiPending.get(id);
      if (!pending) this.uiPending.set(id, (pending = new Map()));
      const requestId = event.id;
      const ms = typeof event.timeout === 'number' && event.timeout > 0 ? event.timeout : 0;
      pending.set(requestId, {
        timer: ms
          ? setTimeout(() => this.retireUi(id, requestId, 'timeout'), ms + UI_TIMEOUT_GRACE_MS)
          : null,
        ...(push ? { push } : {}),
      });
    }
    return true;
  }

  private retireUi(id: number, requestId: string, reason: 'answered' | 'timeout' | 'closed') {
    const pending = this.uiPending.get(id);
    if (!pending?.has(requestId)) return false;
    const timer = pending.get(requestId)?.timer;
    if (timer) clearTimeout(timer);
    pending.delete(requestId);
    if (pending.size === 0) this.uiPending.delete(id);
    this.record(id, { type: 'panel_ui_resolved', id: requestId, reason });
    return true;
  }

  /**
   * An agent's push_to_repo tool asked for a push. Turn its dialog into a confirmation written by the
   * panel (the agent's own words never reach the user as the question), or answer it right away when
   * there is nothing to confirm: no linked repository, or a malformed request.
   */
  private acceptPush(id: number, event: PiEvent): PushRequest | undefined {
    const refuse = (error: string) => {
      try {
        this.live.get(id)?.send({
          type: 'extension_ui_response',
          id: event.id,
          value: JSON.stringify({ ok: false, error }),
        });
      } catch {
        // pi is gone; nothing is waiting.
      }
      return undefined;
    };
    const request = parsePushRequest(event.placeholder);
    if (!request) return refuse('The push request was malformed.');
    const row = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(id) as
      { project_id: number } | undefined;
    const link = row ? this.pusher?.link(row.project_id) : null;
    if (!link) return refuse('This project is not linked to a GitHub or Forgejo repository.');
    // What the user sees: the panel's wording, shown as a plain yes/no question.
    event.method = 'confirm';
    event.title = `Push to ${link.forge}?`;
    event.message = describePush(link.forge, link.repo, request);
    delete event.placeholder;
    return request;
  }

  /** Runs an approved push from the host and reports the outcome as the agent will read it. */
  private async runPush(sessionId: number, request: PushRequest): Promise<string> {
    const row = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as
      { project_id: number } | undefined;
    if (!row || !this.pusher)
      return JSON.stringify({ ok: false, error: 'Pushing is unavailable.' });
    try {
      return JSON.stringify({ ok: true, ...(await this.pusher.push(row.project_id, request)) });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : 'Push failed',
      });
    }
  }

  /** Delivers the user's answer to an extension dialog. */
  async respondUi(
    id: number,
    body: { id?: unknown; value?: unknown; confirmed?: unknown; cancelled?: unknown },
  ) {
    this.row(id);
    const requestId = body.id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
      throw new SessionError(400, 'id must be the request id');
    }
    const answers = [body.value, body.confirmed, body.cancelled].filter((v) => v !== undefined);
    if (answers.length !== 1) {
      throw new SessionError(400, 'Send exactly one of value, confirmed or cancelled');
    }
    let answer: Record<string, unknown>;
    if (typeof body.value === 'string' && body.value.length <= 100_000)
      answer = { value: body.value };
    else if (typeof body.confirmed === 'boolean') answer = { confirmed: body.confirmed };
    else if (body.cancelled === true) answer = { cancelled: true };
    else throw new SessionError(400, 'value must be a string, confirmed a boolean, cancelled true');
    const client = this.live.get(id);
    const entry = this.uiPending.get(id)?.get(requestId);
    if (!client || !entry || entry.busy) {
      throw new SessionError(409, 'That question is no longer waiting for an answer');
    }
    if (entry.push) {
      // Only yes or no is meaningful here; the outcome of an approved push goes back to the agent.
      if (typeof body.confirmed !== 'boolean' && body.cancelled !== true) {
        throw new SessionError(400, 'Answer with confirmed or cancelled');
      }
      if (body.confirmed === true) {
        entry.busy = true;
        answer = { value: await this.runPush(id, entry.push) };
      } else {
        answer = { cancelled: true };
      }
    }
    try {
      client.send({ type: 'extension_ui_response', id: requestId, ...answer });
    } catch {
      this.retireUi(id, requestId, 'closed');
      throw new SessionError(502, 'pi is not running');
    }
    this.retireUi(id, requestId, 'answered');
  }

  /** The pi process is gone: nothing is waiting on its dialogs and its statuses no longer apply. */
  private clearUi(id: number) {
    for (const requestId of [...(this.uiPending.get(id)?.keys() ?? [])]) {
      this.retireUi(id, requestId, 'closed');
    }
    this.uiShown.delete(id);
  }

  private record(id: number, event: PiEvent) {
    if (event.type === 'extension_ui_request' && !this.acceptUi(id, event)) return;
    const seq = this.nextSeq(id);
    if (!EPHEMERAL.has(event.type)) {
      try {
        this.db
          .prepare(
            'INSERT INTO session_events (session_id, seq, data, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(id, seq, JSON.stringify(event), Date.now());
      } catch (err) {
        // The session was deleted while pi was still emitting (or a timer fired): nothing to keep.
        if ((err as { errcode?: number }).errcode === 787) return;
        throw err;
      }
    }
    if (event.type === 'message_end') this.trackProviderHealth(id, event);
    if (event.type === 'agent_start') this.setStatus(id, 'running');
    else if (event.type === 'agent_settled') this.setStatus(id, 'idle');
    for (const send of this.listeners.get(id) ?? []) send({ seq, event });
    if (event.type === 'agent_settled' && this.restartWhenIdle.delete(id)) this.stop(id);
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

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', (req, reply) =>
    handle(reply, () => {
      const { name } = (req.body ?? {}) as { name?: unknown };
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean || clean.length > 80) {
        return reply.code(400).send({ error: 'Name must be 1-80 characters' });
      }
      return { session: sessionDto(manager.rename(num(req.params.id), clean)) };
    }),
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

  app.post<{ Params: { id: string } }>('/api/sessions/:id/ui-response', (req, reply) =>
    handle(reply, async () => {
      await manager.respondUi(num(req.params.id), (req.body ?? {}) as Record<string, unknown>);
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
