import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { agentNote } from './agent-note.js';
import {
  LAB_DIALOG_TITLE,
  LAB_REPLY_MAX_CHARS,
  labSessionNote,
  parseLabRunRequest,
} from './lab-session.js';
import { listRepos } from './repo-store.js';
import { runtimeNote } from './runtimes.js';
import {
  PR_DIALOG_TITLE,
  PUSH_DIALOG_TITLE,
  describePullRequest,
  describePush,
  parsePullRequestRequest,
  parsePushRequest,
  type ForgePusher,
  type PullRequestRequest,
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
  thinking_level: string | null;
  auto_compaction: number | null;
  kind: string;
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
const LAB_EXTENSION = new URL('../assets/panel-lab.js', import.meta.url);
/** Where the sandbox image keeps pi's documentation, for the lab design session to read. */
const PI_DOCS_DIR = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs';
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
  kind: r.kind,
  createdAt: r.created_at,
});

/** The thinking levels pi knows. Which ones a model offers is up to pi (get_available_thinking_levels). */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** What the session header shows about pi: thinking, compaction and token use. */
export interface PiState {
  /** pi is running for this session; the stats below need that. */
  running: boolean;
  thinkingLevel: string | null;
  availableThinkingLevels: string[];
  autoCompaction: boolean | null;
  isCompacting: boolean;
  model: { id: string; provider: string | null; contextWindow: number | null } | null;
  stats: {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    toolCalls: number;
    messages: number;
    context: { tokens: number | null; window: number | null; percent: number | null } | null;
  } | null;
}

/** What an approved reserved confirmation does on the host. */
type ForgeAction =
  { kind: 'push'; request: PushRequest } | { kind: 'pr'; request: PullRequestRequest };

/** A dialog waiting for the user; action is set for the reserved push and pull request confirmations. */
interface PendingUi {
  timer: ReturnType<typeof setTimeout> | null;
  action?: ForgeAction;
  /** The action is running, so a second answer must not start another. */
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
        .prepare("SELECT * FROM sessions WHERE project_id = ? AND kind = 'chat' ORDER BY id")
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
      this.db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND kind = 'chat'")
        .get(projectId) as {
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
      // The lab design session gets instructions on top of pi's own system prompt.
      ...(row.kind === 'lab'
        ? ['--append-system-prompt', `${SANDBOX_AGENT_DIR}/lab-session.md`]
        : []),
    ];
    const chosen = this.modelOf(row);
    const provider = chosen ? this.providers.find(chosen.providerId) : undefined;
    let proc;
    let sidecarsResult: Awaited<ReturnType<SidecarManager['ensureForProject']>> | undefined;
    try {
      // Managed MCP servers must be up before pi starts, or it would list them as failed.
      sidecarsResult = await this.sidecars.ensureForProject(row.project_id);
      const mcp = await this.writeAgentConfig(row.project_id, row.kind);
      proc = await this.runtime.exec(project.container_id, {
        cmd,
        workdir: '/workspace',
        // Only the chosen provider's key is handed to this pi process.
        env: {
          PI_CODING_AGENT_DIR: SANDBOX_AGENT_DIR,
          ...(row.kind === 'lab' ? { PI_PANEL_SESSION_KIND: 'lab' } : {}),
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
    if (provider && chosen) {
      // set_model over RPC rather than --model: model ids such as "qwen2.5-coder:7b" would
      // collide with the CLI's ":<thinking>" suffix syntax.
      const res = await client
        .request({ type: 'set_model', provider: provider.piKey, modelId: chosen.modelId })
        .catch((err: Error) => ({ success: false, error: err.message }));
      if (!res.success) {
        this.stopClient(id, client);
        throw new SessionError(400, `Model not available: ${res.error ?? 'unknown error'}`);
      }
    }
    // Controls the user changed earlier. A refusal (a level this model lacks) is not fatal: pi keeps
    // its own value and the header shows what it is really using.
    if (row.thinking_level) {
      await client
        .request({ type: 'set_thinking_level', level: row.thinking_level })
        .catch(() => null);
    }
    if (row.auto_compaction !== null) {
      await client
        .request({ type: 'set_auto_compaction', enabled: row.auto_compaction !== 0 })
        .catch(() => null);
    }
    return client;
  }

  /** Writes the keyless config files pi reads from the project's agent dir. */
  private async writeAgentConfig(projectId: number, kind = 'chat') {
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
    const repos = listRepos(this.db, projectId);
    const runtime = this.db
      .prepare('SELECT applied_runtime FROM projects WHERE id = ?')
      .get(projectId) as { applied_runtime: string } | undefined;
    const note = agentNote(
      repos.map((r) => ({ repo: r.repo, host: r.host, folder: r.folder, included: r.included })),
      null,
      // The container's runtime, not the one chosen for the next recreate.
      runtime ? runtimeNote(runtime.applied_runtime) : null,
    );
    if (kind === 'lab') {
      // The design session's instructions and its lab_run tool (which only registers for it).
      await mkdir(join(dir, 'extensions'), { recursive: true });
      await writeFile(join(dir, 'lab-session.md'), labSessionNote(PI_DOCS_DIR), { mode: 0o644 });
      await writeFile(join(dir, 'extensions', 'panel-lab.js'), await readFile(LAB_EXTENSION), {
        mode: 0o644,
      });
    }
    const extension = join(dir, 'extensions', 'panel-forge.js');
    if (note) {
      const tmp = join(dir, 'AGENTS.md.tmp');
      await writeFile(tmp, note, { mode: 0o644 });
      await rename(tmp, join(dir, 'AGENTS.md'));
    } else {
      await rm(join(dir, 'AGENTS.md'), { force: true });
    }
    if (repos.some((r) => r.included)) {
      // The push tools the note refers to: installed only where there is a repository to push to.
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
    const session = this.db
      .prepare('SELECT project_id, provider_id, model_id FROM sessions WHERE id = ?')
      .get(id) as Pick<SessionRow, 'project_id' | 'provider_id' | 'model_id'> | undefined;
    const row = session && this.modelOf(session);
    if (!row) return;
    if (msg.stopReason === 'error' || msg.errorMessage) {
      const health = this.providers.recordFailure(row.providerId, msg.errorMessage ?? '');
      this.record(id, {
        type: 'panel_notice',
        level: 'error',
        message: `Model provider error: ${health.message}`,
      });
    } else if (msg.stopReason !== 'aborted') {
      this.providers.clearFailure(row.providerId);
    }
  }

  /**
   * The model a session runs: the one it chose, else its project's default model. null means pi's own
   * default. Resolved each time pi starts, so changing the default applies to every session that did
   * not choose a model, including ones that already exist.
   */
  private modelOf(row: Pick<SessionRow, 'project_id' | 'provider_id' | 'model_id'>) {
    if (row.provider_id && row.model_id) {
      return { providerId: row.provider_id, modelId: row.model_id };
    }
    const d = this.db
      .prepare('SELECT default_provider_id, default_model_id FROM projects WHERE id = ?')
      .get(row.project_id) as
      { default_provider_id: number | null; default_model_id: string | null } | undefined;
    return d?.default_provider_id && d.default_model_id
      ? { providerId: d.default_provider_id, modelId: d.default_model_id }
      : null;
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
    if (method === 'input' && event.title === LAB_DIALOG_TITLE && typeof event.id === 'string') {
      void this.answerLabRun(id, event);
      return false; // answered by the panel; the user is not asked and nothing is recorded
    }
    let action: ForgeAction | undefined;
    if (
      method === 'input' &&
      (event.title === PUSH_DIALOG_TITLE || event.title === PR_DIALOG_TITLE) &&
      typeof event.id === 'string'
    ) {
      action = this.acceptForgeAction(id, event, event.title === PR_DIALOG_TITLE ? 'pr' : 'push');
      if (!action) return false; // answered (refused) without bothering the user
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
        ...(action ? { action } : {}),
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

  private labRunner?: (
    projectId: number,
    request: { path: string; tests?: unknown },
  ) => Promise<unknown>;

  /** Gives the manager the package lab, for the design session's lab_run tool. */
  setLabRunner(run: NonNullable<SessionManager['labRunner']>) {
    this.labRunner = run;
  }

  /** The lab_run tool asked to test a package. Only the lab design session may; others are refused. */
  private async answerLabRun(id: number, event: PiEvent) {
    const reply = (value: unknown) => {
      let text = JSON.stringify(value);
      if (text.length > LAB_REPLY_MAX_CHARS) {
        text = `${text.slice(0, LAB_REPLY_MAX_CHARS)} ...[report cut at ${LAB_REPLY_MAX_CHARS} characters]`;
      }
      try {
        this.live.get(id)?.send({ type: 'extension_ui_response', id: event.id, value: text });
      } catch {
        // pi is gone; nothing is waiting.
      }
    };
    const row = this.db.prepare('SELECT project_id, kind FROM sessions WHERE id = ?').get(id) as
      { project_id: number; kind: string } | undefined;
    if (!row || row.kind !== 'lab' || !this.labRunner) {
      return reply({ ok: false, error: 'The lab can only be run from the package lab session.' });
    }
    const request = parseLabRunRequest(event.placeholder);
    if (!request) return reply({ ok: false, error: 'The lab request was malformed.' });
    try {
      reply({ ok: true, ...((await this.labRunner(row.project_id, request)) as object) });
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : 'The lab run failed.' });
    }
  }

  /**
   * The project's package lab design session, made on first use. It is kept out of the session
   * list: the Lab tab shows it.
   */
  labSession(projectId: number): SessionRow {
    const existing = this.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND kind = 'lab' ORDER BY id LIMIT 1")
      .get(projectId) as SessionRow | undefined;
    if (existing) return existing;
    const project = this.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as
      { status: string } | undefined;
    if (!project) throw new SessionError(404, 'Project not found');
    if (project.status !== 'running') throw new SessionError(409, 'Project is not running');
    const id = Number(
      this.db
        .prepare(
          "INSERT INTO sessions (project_id, name, status, kind, created_at) VALUES (?, 'Package lab design', 'idle', 'lab', ?)",
        )
        .run(projectId, Date.now()).lastInsertRowid,
    );
    return this.row(id);
  }

  /**
   * An agent's push_to_repo or open_pull_request tool asked for something only the host can do. Turn
   * its dialog into a confirmation written by the panel (the agent's own words never reach the user as
   * the question), or answer it right away when there is nothing to confirm: no linked repository, or
   * a malformed request.
   */
  private acceptForgeAction(
    id: number,
    event: PiEvent,
    kind: ForgeAction['kind'],
  ): ForgeAction | undefined {
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
    const what = kind === 'pr' ? 'pull request' : 'push';
    const request =
      kind === 'pr'
        ? parsePullRequestRequest(event.placeholder)
        : parsePushRequest(event.placeholder);
    if (!request) return refuse(`The ${what} request was malformed.`);
    const row = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(id) as
      { project_id: number } | undefined;
    let link: ReturnType<ForgePusher['link']>;
    try {
      link = row ? (this.pusher?.link(row.project_id, request.repo) ?? null) : null;
    } catch (err) {
      return refuse(err instanceof Error ? err.message : 'That repository cannot be used.');
    }
    if (!link) return refuse('This project is not linked to a GitHub or Forgejo repository.');
    if (kind === 'pr' && !this.pusher?.pullRequest) {
      return refuse('Opening pull requests is unavailable.');
    }
    // What the user sees: the panel's wording, shown as a plain yes/no question.
    event.method = 'confirm';
    // Approving acts under the admin's forge account; the UI shows members only the decline button.
    event.panelAdminOnly = true;
    delete event.placeholder;
    if (kind === 'pr') {
      event.title = `Open a pull request on ${link.forge}?`;
      event.message = describePullRequest(link.forge, link.repo, request as PullRequestRequest);
      return { kind, request: request as PullRequestRequest };
    }
    event.title = `Push to ${link.forge}?`;
    event.message = describePush(link.forge, link.repo, request as PushRequest);
    return { kind, request: request as PushRequest };
  }

  /** Runs an approved action from the host and reports the outcome as the agent will read it. */
  private async runForgeAction(sessionId: number, action: ForgeAction): Promise<string> {
    const row = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as
      { project_id: number } | undefined;
    if (!row || !this.pusher) {
      return JSON.stringify({ ok: false, error: 'This action is unavailable.' });
    }
    try {
      const outcome =
        action.kind === 'pr'
          ? await this.pusher.pullRequest!(row.project_id, action.request)
          : await this.pusher.push(row.project_id, action.request);
      return JSON.stringify({ ok: true, ...outcome });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : `${action.kind === 'pr' ? 'Pull request' : 'Push'} failed`,
      });
    }
  }

  /** Delivers the user's answer to an extension dialog. */
  /** Thinking level, compaction and token use. Never starts pi: a stopped session reports what it will use. */
  async piState(id: number): Promise<PiState> {
    const row = this.row(id);
    const client = this.live.get(id);
    const state: PiState = {
      running: !!client,
      thinkingLevel: row.thinking_level,
      availableThinkingLevels: [],
      autoCompaction: row.auto_compaction === null ? null : row.auto_compaction !== 0,
      isCompacting: false,
      model: null,
      stats: null,
    };
    if (!client) return state;
    const ask = (type: string) =>
      client
        .request({ type })
        .then((r) => (r.success ? ((r.data ?? {}) as Record<string, unknown>) : null))
        .catch(() => null);
    const [st, levels, stats] = await Promise.all([
      ask('get_state'),
      ask('get_available_thinking_levels'),
      ask('get_session_stats'),
    ]);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    if (st) {
      if (typeof st.thinkingLevel === 'string') state.thinkingLevel = st.thinkingLevel;
      if (typeof st.autoCompactionEnabled === 'boolean')
        state.autoCompaction = st.autoCompactionEnabled;
      state.isCompacting = st.isCompacting === true;
      const m = st.model as
        { id?: unknown; provider?: unknown; contextWindow?: unknown } | undefined;
      if (m && typeof m.id === 'string') {
        state.model = {
          id: m.id,
          provider: typeof m.provider === 'string' ? m.provider : null,
          contextWindow: num(m.contextWindow),
        };
      }
    }
    if (Array.isArray(levels?.levels)) {
      state.availableThinkingLevels = (levels.levels as unknown[]).filter(
        (l): l is string => typeof l === 'string',
      );
    }
    if (stats) {
      const t = (stats.tokens ?? {}) as Record<string, unknown>;
      const c = stats.contextUsage as Record<string, unknown> | null | undefined;
      state.stats = {
        tokens: {
          input: num(t.input) ?? 0,
          output: num(t.output) ?? 0,
          cacheRead: num(t.cacheRead) ?? 0,
          cacheWrite: num(t.cacheWrite) ?? 0,
          total: num(t.total) ?? 0,
        },
        cost: num(stats.cost) ?? 0,
        toolCalls: num(stats.toolCalls) ?? 0,
        messages: num(stats.totalMessages) ?? 0,
        context: c
          ? { tokens: num(c.tokens), window: num(c.contextWindow), percent: num(c.percent) }
          : null,
      };
    }
    return state;
  }

  /** Sets the thinking level now if pi is running, and remembers it for when pi starts again. */
  async setThinkingLevel(id: number, level: unknown) {
    this.row(id);
    if (typeof level !== 'string' || !THINKING_LEVELS.includes(level)) {
      throw new SessionError(400, `level must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    const client = this.live.get(id);
    if (client) {
      const res = await client
        .request({ type: 'set_thinking_level', level })
        .catch((err: Error) => ({ success: false, error: err.message }));
      if (!res.success) throw new SessionError(400, res.error ?? 'pi rejected the thinking level');
    }
    this.db.prepare('UPDATE sessions SET thinking_level = ? WHERE id = ?').run(level, id);
    return this.piState(id);
  }

  async setAutoCompaction(id: number, enabled: unknown) {
    this.row(id);
    if (typeof enabled !== 'boolean') throw new SessionError(400, 'enabled must be true or false');
    const client = this.live.get(id);
    if (client) {
      const res = await client
        .request({ type: 'set_auto_compaction', enabled })
        .catch((err: Error) => ({ success: false, error: err.message }));
      if (!res.success) throw new SessionError(400, res.error ?? 'pi rejected the setting');
    }
    this.db
      .prepare('UPDATE sessions SET auto_compaction = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id);
    return this.piState(id);
  }

  /** Summarises older context now. Needs pi running; the summary is a model call, so it can take a while. */
  async compact(id: number, instructions?: unknown) {
    this.row(id);
    if (
      instructions !== undefined &&
      (typeof instructions !== 'string' || instructions.length > 2000)
    ) {
      throw new SessionError(400, 'instructions must be a string up to 2000 characters');
    }
    const client = this.live.get(id);
    if (!client)
      throw new SessionError(409, 'Start the session (send a prompt) before compacting it');
    let res;
    try {
      res = await client.request(
        { type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) },
        10 * 60_000,
      );
    } catch (err) {
      throw new SessionError(502, err instanceof Error ? err.message : 'pi request failed');
    }
    if (!res.success) throw new SessionError(409, res.error ?? 'Compaction failed');
    const d = (res.data ?? {}) as Record<string, unknown>;
    return {
      summary: typeof d.summary === 'string' ? d.summary.slice(0, 20_000) : '',
      tokensBefore: typeof d.tokensBefore === 'number' ? d.tokensBefore : null,
      tokensAfter: typeof d.estimatedTokensAfter === 'number' ? d.estimatedTokensAfter : null,
    };
  }

  async respondUi(
    id: number,
    body: { id?: unknown; value?: unknown; confirmed?: unknown; cancelled?: unknown },
    asAdmin = true,
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
    if (entry.action) {
      // Only yes or no is meaningful here; the outcome of an approved action goes back to the agent.
      if (typeof body.confirmed !== 'boolean' && body.cancelled !== true) {
        throw new SessionError(400, 'Answer with confirmed or cancelled');
      }
      // Approving acts under the admin's forge account, so only the admin may; anyone can decline.
      if (body.confirmed === true && !asAdmin) {
        throw new SessionError(403, 'Only the admin can approve pushes and pull requests');
      }
      if (body.confirmed === true) {
        entry.busy = true;
        answer = { value: await this.runForgeAction(id, entry.action) };
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

export function registerSessions(
  app: FastifyInstance,
  manager: SessionManager,
  /** Whether the request comes from the admin; members cannot approve pushes and pull requests. */
  isAdmin: (req: FastifyRequest) => boolean = () => false,
) {
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);

  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => ({
    sessions: manager.listForProject(num(req.params.id)),
  }));

  // The package lab's design session (made on first use). Not part of the session list.
  app.get<{ Params: { id: string } }>('/api/projects/:id/lab/session', (req, reply) =>
    handle(reply, () => ({ session: sessionDto(manager.labSession(num(req.params.id))) })),
  );

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

  // Thinking level, compaction and token use (see PiState).
  app.get<{ Params: { id: string } }>('/api/sessions/:id/pi', (req, reply) =>
    handle(reply, () => manager.piState(num(req.params.id))),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/thinking', (req, reply) =>
    handle(reply, () =>
      manager.setThinkingLevel(num(req.params.id), ((req.body ?? {}) as { level?: unknown }).level),
    ),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/auto-compaction', (req, reply) =>
    handle(reply, () =>
      manager.setAutoCompaction(
        num(req.params.id),
        ((req.body ?? {}) as { enabled?: unknown }).enabled,
      ),
    ),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/compact', (req, reply) =>
    handle(reply, () =>
      manager.compact(
        num(req.params.id),
        ((req.body ?? {}) as { instructions?: unknown }).instructions,
      ),
    ),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/abort', (req, reply) =>
    handle(reply, async () => {
      await manager.abort(num(req.params.id));
      return { ok: true };
    }),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/ui-response', (req, reply) =>
    handle(reply, async () => {
      await manager.respondUi(
        num(req.params.id),
        (req.body ?? {}) as Record<string, unknown>,
        isAdmin(req),
      );
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
