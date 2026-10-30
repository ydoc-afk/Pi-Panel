import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  McpError,
  type Discovery,
  type McpStore,
  type ServerDto,
  type ServerInput,
  type ToolInfo,
} from './mcp-store.js';
import { MCP_PRESETS } from './mcp-presets.js';
import { SANDBOX_UID } from './paths.js';
import type { ContainerRuntime } from './runtime.js';
import { parseSentinelReport } from './sentinel.js';
import type { SessionManager } from './sessions.js';
import type { SidecarManager, SidecarStatus } from './sidecars.js';
import type { TarEntry } from './tar.js';

export interface McpOptions {
  harnessPath?: string;
  discoverTimeoutMs?: number;
  maxConcurrent?: number;
}

const BEGIN = '@@PI_MCP_REPORT_BEGIN@@';
const END = '@@PI_MCP_REPORT_END@@';
const DEFAULT_HARNESS = new URL('../assets/mcp-discover.mjs', import.meta.url);
const SECRET_KEY_RE = /(key|token|secret|passw|credential|auth|cookie)/i;
const PLACEHOLDER_RE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Replaces known secret values in text, so an error echoed by a server cannot leak them. */
export function redactValues(text: string, values: Iterable<string>): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join('***');
  return out;
}

/** The discovery report comes from code that ran in the container, so rebuild it field by field. */
export function sanitizeDiscovery(
  raw: Record<string, unknown>,
  secrets: string[],
  now: number,
): Discovery {
  const states = ['connected', 'failed', 'disabled'] as const;
  const state = states.find((s) => s === raw.state) ?? 'error';
  const tools: ToolInfo[] = [];
  if (Array.isArray(raw.tools)) {
    for (const t of raw.tools.slice(0, 500)) {
      const tool = (t ?? {}) as {
        name?: unknown;
        description?: unknown;
        annotations?: Record<string, unknown>;
      };
      if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 200) continue;
      const annotations: ToolInfo['annotations'] = {};
      for (const k of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        if (typeof tool.annotations?.[k] === 'boolean')
          annotations[k] = tool.annotations[k] as boolean;
      }
      tools.push({
        name: tool.name,
        description: redactValues(clip(tool.description, 300), secrets),
        annotations,
      });
    }
  }
  return {
    state,
    error:
      typeof raw.error === 'string' && raw.error
        ? redactValues(raw.error.slice(0, 1000), secrets)
        : null,
    tools,
    discoveredAt: now,
    piVersion: typeof raw.sdkVersion === 'string' ? raw.sdkVersion.slice(0, 40) : null,
  };
}

/**
 * Converts a Claude Desktop / Cursor style config ({ mcpServers: { name: {...} } }, or one bare server)
 * into servers to create. Values that look like secrets, or that refer to environment variables of
 * the machine the config came from, become empty secrets for the admin to fill in.
 */
export function convertImport(
  json: unknown,
  fallbackName?: string,
): { servers: ServerInput[]; warnings: string[] } {
  const warnings: string[] = [];
  const servers: ServerInput[] = [];
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new McpError(400, 'Expected a JSON object');
  const root = json as Record<string, unknown>;
  const map =
    root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : root.command || root.url
        ? { [fallbackName ?? 'server']: root }
        : null;
  if (!map) throw new McpError(400, 'No "mcpServers" object found');

  for (const [name, value] of Object.entries(map)) {
    const e = (value ?? {}) as Record<string, unknown>;
    const type = e.type === undefined ? (e.url ? 'http' : 'stdio') : e.type;
    if (type === 'sse') {
      warnings.push(
        `${name}: skipped, SSE servers are not supported by pi (use a streamable HTTP endpoint)`,
      );
      continue;
    }
    if (type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
      warnings.push(`${name}: skipped, unknown server type "${String(type)}"`);
      continue;
    }
    const entry: ServerInput = { name, type: type === 'stdio' ? 'stdio' : 'http' };
    if (typeof e.description === 'string') entry.description = e.description;
    if (typeof e.timeout === 'number') entry.timeout = e.timeout;
    if (typeof e.exposure === 'string') entry.exposure = e.exposure;
    const entries = (obj: unknown) => {
      const out: { key: string; value: string; secret: boolean }[] = [];
      if (!obj || typeof obj !== 'object') return out;
      for (const [key, raw] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof raw !== 'string') continue;
        if (raw.startsWith('!')) {
          warnings.push(`${name}: ${key} skipped, command-substitution values are not supported`);
          continue;
        }
        const placeholder = PLACEHOLDER_RE.test(raw);
        const secret = placeholder || SECRET_KEY_RE.test(key);
        if (placeholder)
          warnings.push(
            `${name}: ${key} referenced an environment variable (${raw.slice(0, 60)}); enter its value`,
          );
        out.push({ key, value: placeholder ? '' : raw, secret });
      }
      return out;
    };
    if (entry.type === 'stdio') {
      entry.command = e.command;
      if (Array.isArray(e.args)) entry.args = e.args;
      if (typeof e.cwd === 'string') entry.cwd = e.cwd;
      entry.env = entries(e.env);
    } else {
      entry.url = e.url;
      entry.headers = entries(e.headers);
    }
    servers.push(entry);
  }
  return { servers, warnings };
}

export class McpService {
  private readonly harnessPath: URL | string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly testing = new Set<number>();
  private active = 0;

  constructor(
    private readonly db: DatabaseSync,
    readonly store: McpStore,
    private readonly runtime: ContainerRuntime,
    private readonly sessions: SessionManager,
    readonly sidecars: SidecarManager,
    opts: McpOptions = {},
  ) {
    this.harnessPath = opts.harnessPath ?? DEFAULT_HARNESS;
    this.timeoutMs = opts.discoverTimeoutMs ?? 120_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
  }

  private projectExists(id: number) {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id))
      throw new McpError(404, 'Project not found');
  }

  /** Idle sessions get a fresh pi process (which re-reads mcp.json) on their next prompt. */
  private applyToProjects(projectIds: number[]) {
    let restarted = 0;
    let pending = 0;
    for (const id of projectIds) {
      const r = this.sessions.stopIdleForProject(id);
      restarted += r.stopped;
      pending += r.running;
    }
    return { restartedSessions: restarted, pendingSessions: pending };
  }

  private projectsUsing(serverId: number): number[] {
    return (
      this.db
        .prepare('SELECT project_id FROM project_mcp WHERE server_id = ? AND enabled = 1')
        .all(serverId) as unknown as { project_id: number }[]
    ).map((r) => r.project_id);
  }

  async update(id: number, input: ServerInput) {
    const before = this.store.get(id);
    const specBefore =
      before.type === 'managed' ? JSON.stringify(this.store.sidecarSpecFor(id)) : null;
    const server = this.store.update(id, input);
    if (server.type === 'managed' && JSON.stringify(this.store.sidecarSpecFor(id)) !== specBefore) {
      // The container definition or its environment changed: replace the running containers.
      for (const projectId of this.projectsUsing(id)) {
        await this.sidecars.stop(projectId, id);
        await this.sidecars.start(projectId, id).catch(() => undefined); // failures show in its status
      }
    }
    return { server, ...this.applyToProjects(this.projectsUsing(id)) };
  }

  async delete(id: number) {
    const server = this.store.get(id);
    if (server.type === 'managed') await this.sidecars.removeServer(id);
    const projects = this.store.delete(id);
    return this.applyToProjects(projects);
  }

  setDefaultHidden(id: number, hidden: unknown) {
    const server = this.store.setDefaultHidden(id, hidden);
    return { server, ...this.applyToProjects(this.projectsUsing(id)) };
  }

  private async sidecarStates(projectId: number): Promise<Record<number, SidecarStatus>> {
    const out: Record<number, SidecarStatus> = {};
    for (const p of this.store.projectServers(projectId)) {
      if (p.server.type === 'managed')
        out[p.server.id] = await this.sidecars.status(projectId, p.server.id);
    }
    return out;
  }

  async forProject(projectId: number) {
    this.projectExists(projectId);
    return {
      servers: this.store.projectServers(projectId),
      sidecars: await this.sidecarStates(projectId),
    };
  }

  async setForProject(
    projectId: number,
    serverId: number,
    change: { enabled?: unknown; hiddenTools?: unknown },
  ) {
    this.projectExists(projectId);
    const server = this.store.get(serverId);
    this.store.setProject(projectId, serverId, change);
    let sidecarError: string | undefined;
    if (server.type === 'managed' && typeof change.enabled === 'boolean') {
      try {
        if (change.enabled) await this.sidecars.start(projectId, serverId);
        else await this.sidecars.stop(projectId, serverId);
      } catch (err) {
        // The server stays enabled; the error is shown next to it and it is retried on the next session.
        sidecarError = err instanceof Error ? err.message : 'The container could not be started';
      }
    }
    return {
      servers: this.store.projectServers(projectId),
      sidecars: await this.sidecarStates(projectId),
      ...(sidecarError ? { sidecarError } : {}),
      ...this.applyToProjects([projectId]),
    };
  }

  async sidecarAction(projectId: number, serverId: number, action: unknown) {
    this.projectExists(projectId);
    if (this.store.get(serverId).type !== 'managed')
      throw new McpError(400, 'That server is not a managed container');
    if (action === 'stop') await this.sidecars.stop(projectId, serverId);
    else if (action === 'start') await this.sidecars.start(projectId, serverId);
    else if (action === 'restart') {
      await this.sidecars.stop(projectId, serverId);
      await this.sidecars.start(projectId, serverId);
    } else throw new McpError(400, 'action must be start, stop or restart');
    return { sidecar: await this.sidecars.status(projectId, serverId) };
  }

  async sidecarLogs(projectId: number, serverId: number, tail: unknown) {
    this.projectExists(projectId);
    const n = typeof tail === 'string' && /^\d+$/.test(tail) ? Number(tail) : 100;
    return { logs: await this.sidecars.logs(projectId, serverId, n) };
  }

  import(json: unknown, name?: unknown) {
    const { servers, warnings } = convertImport(json, typeof name === 'string' ? name : undefined);
    const created: ServerDto[] = [];
    for (const input of servers) {
      try {
        created.push(this.store.create(input));
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        warnings.push(`${String(input.name)}: not added, ${err.message}`);
      }
    }
    return { servers: created, warnings };
  }

  private async runHarness(
    name: string,
    config: Record<string, unknown>,
    env: Record<string, string>,
    network?: string,
  ) {
    const harness = await readFile(this.harnessPath);
    const owner = { uid: SANDBOX_UID, gid: SANDBOX_UID };
    const files: TarEntry[] = [
      { path: 'lab/', ...owner },
      ...['home', 'work', 'agent'].map((d) => ({ path: `lab/${d}/`, ...owner })),
      { path: 'lab/mcp-discover.mjs', content: harness, mode: 0o644, ...owner },
      {
        path: 'lab/agent/mcp.json',
        content: Buffer.from(JSON.stringify({ mcpServers: { [name]: config } })),
        mode: 0o644,
        ...owner,
      },
    ];
    try {
      return await this.runtime.runEphemeral({
        files,
        cmd: ['node', '/lab/mcp-discover.mjs'],
        env: {
          HOME: '/lab/home',
          PI_CODING_AGENT_DIR: '/lab/agent',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          ...env,
        },
        timeoutMs: this.timeoutMs,
        // Stdio and URL servers may need the network (npx downloads, remote APIs). A managed server is
        // tested on its own private network instead, with no route out. Nothing else is mounted.
        networkDisabled: false,
        ...(network ? { network } : {}),
      });
    } catch {
      throw new McpError(502, 'Failed to run the test container. Is the sandbox image built?');
    }
  }

  /** Connects to one library server and records its tools. */
  async discover(id: number): Promise<ServerDto> {
    const { name, config, env, secretValues } = this.store.testConfig(id);
    const managed = this.store.get(id).type === 'managed';
    const secrets = managed ? this.store.sidecarSpecFor(id).secretValues : secretValues;
    if (this.testing.has(id) || this.active >= this.maxConcurrent) {
      throw new McpError(429, 'A test is already running; try again in a moment');
    }
    this.testing.add(id);
    this.active++;
    try {
      const result = managed
        ? await this.sidecars.withTestSidecar(id, ({ network }) =>
            this.runHarness(name, config, env, network),
          )
        : await this.runHarness(name, config, env);
      const raw = result.timedOut ? null : parseSentinelReport(result.stdout, BEGIN, END);
      const discovery: Discovery = raw
        ? sanitizeDiscovery(raw, secrets, Date.now())
        : {
            state: result.timedOut ? 'timeout' : 'error',
            error: result.timedOut
              ? 'The test timed out'
              : redactValues(
                  `No result from the test container. ${result.stderr.slice(-500)}`.trim(),
                  secrets,
                ),
            tools: [],
            discoveredAt: Date.now(),
            piVersion: null,
          };
      this.store.saveDiscovery(id, discovery);
      return this.store.get(id);
    } finally {
      this.testing.delete(id);
      this.active--;
    }
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerMcp(app: FastifyInstance, svc: McpService) {
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };
  const body = (req: { body: unknown }) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/mcp/presets', async () => ({ presets: MCP_PRESETS }));
  app.get('/api/mcp/servers', async () => ({ servers: svc.store.list() }));
  app.post('/api/mcp/servers', (req, reply) =>
    handle(reply, () => reply.code(201).send({ server: svc.store.create(body(req)) })),
  );
  app.put<P>('/api/mcp/servers/:id', (req, reply) =>
    handle(reply, () => svc.update(num(req.params.id), body(req))),
  );
  app.delete<P>('/api/mcp/servers/:id', (req, reply) =>
    handle(reply, async () => reply.code(200).send(await svc.delete(num(req.params.id)))),
  );
  app.put<P>('/api/mcp/servers/:id/hidden', (req, reply) =>
    handle(reply, () => svc.setDefaultHidden(num(req.params.id), body(req).hidden)),
  );
  app.post<P>('/api/mcp/servers/:id/discover', (req, reply) =>
    handle(reply, async () => ({ server: await svc.discover(num(req.params.id)) })),
  );
  app.post('/api/mcp/import', (req, reply) =>
    handle(reply, () => reply.code(201).send(svc.import(body(req).json, body(req).name))),
  );

  app.get<P>('/api/projects/:id/mcp', (req, reply) =>
    handle(reply, () => svc.forProject(num(req.params.id))),
  );
  app.put<{ Params: { id: string; serverId: string } }>(
    '/api/projects/:id/mcp/:serverId',
    (req, reply) =>
      handle(reply, () => {
        const { enabled, hiddenTools } = body(req);
        return svc.setForProject(num(req.params.id), num(req.params.serverId), {
          enabled,
          hiddenTools,
        });
      }),
  );

  type SP = { Params: { id: string; serverId: string } };
  app.post<SP>('/api/projects/:id/mcp/:serverId/sidecar', (req, reply) =>
    handle(reply, () =>
      svc.sidecarAction(num(req.params.id), num(req.params.serverId), body(req).action),
    ),
  );
  app.get<SP & { Querystring: { tail?: string } }>(
    '/api/projects/:id/mcp/:serverId/sidecar/logs',
    (req, reply) =>
      handle(reply, () =>
        svc.sidecarLogs(num(req.params.id), num(req.params.serverId), req.query.tail),
      ),
  );
}
