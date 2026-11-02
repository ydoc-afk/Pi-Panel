import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { currentUser } from './auth.js';
import type { GitHubService } from './github.js';
import type { McpStore } from './mcp-store.js';
import type { ProviderStore } from './providers.js';
import type { ContainerRuntime } from './runtime.js';

const DAY = 24 * 60 * 60 * 1000;
/** Days of activity the dashboard charts; the first half is the comparison period. */
export const ACTIVITY_DAYS = 14;
const RECENT_SESSIONS = 8;
const TOP_TOOLS = 8;
const TOP_MODELS = 8;

export interface DashboardDeps {
  db: DatabaseSync;
  runtime: ContainerRuntime;
  providers: ProviderStore;
  mcp: McpStore;
  github: GitHubService;
  forgejo: GitHubService;
}

export interface ActivityDay {
  /** Local calendar date of the bucket, YYYY-MM-DD in the caller's time zone. */
  date: string;
  prompts: number;
  toolCalls: number;
  errors: number;
}

interface EventRow {
  session_id: number;
  type: string | null;
  role: string | null;
  tool: string | null;
  is_error: number | null;
  stop_reason: string | null;
  created_at: number | null;
  message_ts: number | null;
}

interface SessionRow {
  id: number;
  project_id: number;
  project_name: string;
  name: string;
  status: string;
  model_id: string | null;
  provider_name: string | null;
  created_at: number;
}

interface ProjectRow {
  id: number;
  name: string;
  status: string;
  repo: string | null;
  created_at: number;
}

/** Day index of a timestamp in a time zone `tz` minutes ahead of UTC. */
const dayOf = (ms: number, tz: number) => Math.floor((ms + tz * 60_000) / DAY);
const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** Ranks name -> count pairs, largest first, ties by name so the order is stable. */
function ranked(counts: Map<string, number>, limit: number) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/**
 * Everything the home dashboard shows, in one read. Activity comes from persisted session events:
 * prompts are user messages, tool calls are tool starts, errors are failed tools and pi crashes.
 * Events recorded before timestamps were stored fall back to the message's own timestamp, so user
 * prompts from older sessions still count; their tool calls do not.
 */
export async function buildDashboard(
  deps: DashboardDeps,
  opts: { isAdmin: boolean; tz: number; now?: number },
) {
  const { db } = deps;
  const now = opts.now ?? Date.now();
  const today = dayOf(now, opts.tz);
  const firstDay = today - (ACTIVITY_DAYS - 1);
  // Start of the first bucket in UTC, widened by a day so no time zone loses events at the edge.
  const since = firstDay * DAY - opts.tz * 60_000 - DAY;

  const events = db
    .prepare(
      `SELECT e.session_id,
              json_extract(e.data, '$.type') AS type,
              json_extract(e.data, '$.message.role') AS role,
              json_extract(e.data, '$.toolName') AS tool,
              json_extract(e.data, '$.isError') AS is_error,
              json_extract(e.data, '$.message.stopReason') AS stop_reason,
              e.created_at,
              CASE WHEN e.created_at IS NULL
                   THEN json_extract(e.data, '$.message.timestamp') END AS message_ts
         FROM session_events e
        WHERE (e.created_at >= ?
               OR (e.created_at IS NULL AND json_extract(e.data, '$.type') = 'message_end'))`,
    )
    .all(since) as unknown as EventRow[];

  const days: ActivityDay[] = Array.from({ length: ACTIVITY_DAYS }, (_, i) => ({
    date: isoDay(firstDay + i),
    prompts: 0,
    toolCalls: 0,
    errors: 0,
  }));
  const tools = new Map<string, number>();
  const lastActivity = new Map<number, number>();
  const sessionPrompts = new Map<number, number>();

  for (const e of events) {
    const at =
      e.created_at ??
      (typeof e.message_ts === 'number' && e.message_ts > 1e12 ? e.message_ts : null);
    if (at === null || at > now) continue;
    const day = dayOf(at, opts.tz);
    if (day < firstDay || day > today) continue;
    const bucket = days[day - firstDay]!;
    lastActivity.set(e.session_id, Math.max(lastActivity.get(e.session_id) ?? 0, at));
    if (e.type === 'message_end' && e.role === 'user') {
      bucket.prompts++;
      sessionPrompts.set(e.session_id, (sessionPrompts.get(e.session_id) ?? 0) + 1);
    } else if (e.type === 'tool_execution_start') {
      bucket.toolCalls++;
      const name = typeof e.tool === 'string' && e.tool ? e.tool : 'unknown';
      tools.set(name, (tools.get(name) ?? 0) + 1);
    } else if ((e.type === 'tool_execution_end' && e.is_error) || e.type === 'panel_process_exit') {
      bucket.errors++;
    } else if (e.type === 'message_end' && e.stop_reason === 'error') {
      // A failed model call (rejected key, rate limit, server down) ends an assistant message.
      bucket.errors++;
    }
  }

  const sessionRows = db
    .prepare(
      `SELECT s.id, s.project_id, p.name AS project_name, s.name, s.status, s.model_id,
              pr.name AS provider_name, s.created_at
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN providers pr ON pr.id = s.provider_id
        ORDER BY s.id`,
    )
    .all() as unknown as SessionRow[];

  const sessionDto = (s: SessionRow) => ({
    id: s.id,
    projectId: s.project_id,
    projectName: s.project_name,
    name: s.name,
    status: s.status,
    modelId: s.model_id,
    providerName: s.provider_name,
    createdAt: s.created_at,
    lastActivityAt: lastActivity.get(s.id) ?? null,
    prompts: sessionPrompts.get(s.id) ?? 0,
  });
  const activityOf = (s: SessionRow) => lastActivity.get(s.id) ?? s.created_at;
  const recent = [...sessionRows]
    .sort((a, b) => activityOf(b) - activityOf(a) || b.id - a.id)
    .slice(0, RECENT_SESSIONS)
    .map(sessionDto);

  const models = new Map<string, number>();
  for (const s of sessionRows) {
    const key = s.model_id ?? 'pi default';
    models.set(key, (models.get(key) ?? 0) + 1);
  }

  const projectRows = db
    .prepare('SELECT id, name, status, repo, created_at FROM projects ORDER BY id')
    .all() as unknown as ProjectRow[];
  const projects = projectRows.map((p) => {
    const own = sessionRows.filter((s) => s.project_id === p.id);
    const last = Math.max(0, ...own.map((s) => lastActivity.get(s.id) ?? 0));
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      repo: p.repo,
      createdAt: p.created_at,
      sessions: own.length,
      runningSessions: own.filter((s) => s.status === 'running').length,
      prompts: own.reduce((n, s) => n + (sessionPrompts.get(s.id) ?? 0), 0),
      lastActivityAt: last || null,
    };
  });

  const providers = deps.providers.list();
  const servers = deps.mcp.list();
  const github = deps.github.account();
  const forgejo = deps.forgejo.account();
  const sandbox = await deps.runtime.hasSandboxImage().catch(() => false);

  let users: { total: number; pending: number } | null = null;
  if (opts.isAdmin) {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS n FROM users GROUP BY status')
      .all() as unknown as { status: string; n: number }[];
    users = {
      total: rows.reduce((n, r) => n + r.n, 0),
      pending: rows.find((r) => r.status === 'pending')?.n ?? 0,
    };
  }

  return {
    generatedAt: now,
    activity: { days },
    projects: {
      total: projects.length,
      running: projects.filter((p) => p.status === 'running').length,
      items: projects,
    },
    sessions: {
      total: sessionRows.length,
      running: sessionRows.filter((s) => s.status === 'running').length,
      errored: sessionRows.filter((s) => s.status === 'error').length,
      recent,
    },
    models: ranked(models, TOP_MODELS).map(([model, sessions]) => ({ model, sessions })),
    tools: ranked(tools, TOP_TOOLS).map(([name, calls]) => ({ name, calls })),
    providers: {
      total: providers.length,
      withKey: providers.filter((p) => p.hasKey).length,
      models: providers.reduce((n, p) => n + p.models.length, 0),
      warnings: providers.filter((p) => p.warning).length,
      failing: providers.filter((p) => p.health).length,
    },
    mcp: {
      total: servers.length,
      connected: servers.filter((s) => s.discovery?.state === 'connected').length,
      failing: servers.filter((s) => s.discovery && s.discovery.state !== 'connected').length,
      untested: servers.filter((s) => !s.discovery).length,
      // Tools shown to the model by default, across every server that has been tested.
      tools: servers.reduce(
        (n, s) =>
          n + (s.discovery?.tools.filter((t) => !s.defaultHidden.includes(t.name)).length ?? 0),
        0,
      ),
    },
    github: { connected: github.connected, login: github.login ?? null },
    forgejo: { connected: forgejo.connected, login: forgejo.login ?? null },
    sandbox: { available: sandbox },
    users,
  };
}

export type Dashboard = Awaited<ReturnType<typeof buildDashboard>>;

export function registerDashboard(app: FastifyInstance, deps: DashboardDeps) {
  app.get<{ Querystring: { tz?: string } }>('/api/dashboard', async (req) => {
    // Minutes the caller's time zone is ahead of UTC (UTC+14 to UTC-12 exist).
    const raw = Number(req.query.tz ?? 0);
    const tz = Number.isInteger(raw) && raw >= -12 * 60 && raw <= 14 * 60 ? raw : 0;
    const isAdmin = currentUser(deps.db, req)?.role === 'admin';
    return buildDashboard(deps, { isAdmin, tz });
  });
}
