import type { DatabaseSync } from 'node:sqlite';
import type { Secrets } from './secrets.js';

export class McpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** stdio and http run as part of pi; managed is a panel-run container reached over HTTP on a private network. */
export type McpType = 'stdio' | 'http' | 'managed';
export const EXPOSURES = ['direct', 'codemode', 'deferred', 'hidden'] as const;
export type Exposure = (typeof EXPOSURES)[number];

export interface ToolInfo {
  name: string;
  description: string;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface Discovery {
  state: 'connected' | 'failed' | 'disabled' | 'timeout' | 'error';
  error: string | null;
  tools: ToolInfo[];
  discoveredAt: number;
  piVersion: string | null;
}

/** How an env var or header is stored: secrets are encrypted, everything else is plain. */
interface StoredEntry {
  key: string;
  secret: boolean;
  value?: string;
  enc?: string;
}

export interface EntryInput {
  key?: unknown;
  value?: unknown;
  secret?: unknown;
}

export interface EntryDto {
  key: string;
  secret: boolean;
  /** Only present for non-secret entries. */
  value?: string;
  hasValue: boolean;
}

export interface ServerInput {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  url?: unknown;
  env?: unknown;
  headers?: unknown;
  exposure?: unknown;
  timeout?: unknown;
  image?: unknown;
  port?: unknown;
  readyLog?: unknown;
  mountSamples?: unknown;
  memoryMb?: unknown;
}

export interface ServerDto {
  id: number;
  name: string;
  description: string | null;
  type: McpType;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  env: EntryDto[];
  headers: EntryDto[];
  exposure: Exposure | null;
  timeout: number | null;
  defaultHidden: string[];
  /** Managed servers only. */
  image: string | null;
  port: number | null;
  readyLog: string | null;
  mountSamples: boolean;
  memoryMb: number | null;
  discovery: Discovery | null;
  createdAt: number;
}

interface ServerRow {
  id: number;
  name: string;
  norm_name: string;
  description: string | null;
  type: McpType;
  command: string | null;
  args: string;
  cwd: string | null;
  url: string | null;
  env: string;
  headers: string;
  exposure: Exposure | null;
  timeout: number | null;
  default_hidden: string;
  image: string | null;
  port: number | null;
  ready_log: string | null;
  mount_samples: number;
  memory_mb: number | null;
  discovery: string | null;
  created_at: number;
}

interface ProjectRow {
  project_id: number;
  server_id: number;
  enabled: number;
  hidden_tools: string | null;
  container_id: string | null;
}

export interface ProjectServerDto {
  server: ServerDto;
  enabled: boolean;
  /** null means the project follows the server's defaults. */
  hiddenOverride: string[] | null;
  hiddenTools: string[];
}

export const DEFAULT_MANAGED_PORT = 8765;
export const DEFAULT_MEMORY_MB = 4096;
/** Container image references: lowercase, no spaces; a tag or digest is optional. */
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/;

export const sidecarName = (projectId: number, serverId: number) =>
  `pp-mcp-${projectId}-${serverId}`;
export const networkName = (projectId: number) => `pp-net-${projectId}`;
export const sidecarAlias = (serverId: number) => `mcp-${serverId}`;

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_ENTRIES = 50;
const MAX_TOOLS = 500;

const normName = (name: string) => name.toLowerCase().replace(/-/g, '_');
const bad = (message: string) => new McpError(400, message);

function cleanText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw bad(`${field} must be a string up to ${max} characters`);
  }
  return value;
}

function cleanArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50)
    throw bad('args must be an array of up to 50 strings');
  return value.map((a) => {
    if (typeof a !== 'string' || a.length > 500 || a.includes('\0'))
      throw bad('each arg must be a string up to 500 characters');
    return a;
  });
}

function cleanUrl(value: unknown): string {
  if (typeof value !== 'string') throw bad('url is required for http servers');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw bad('url must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw bad('url must be a valid http(s) URL');
  return url.toString();
}

export class McpStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: Secrets,
  ) {}

  // ---- entries (env vars and headers) --------------------------------------------------------

  /** `apiKey`-style semantics: a secret entry without a value keeps the stored one with the same key. */
  private cleanEntries(
    value: unknown,
    kind: 'env' | 'header',
    existing: StoredEntry[],
  ): StoredEntry[] {
    if (value === undefined) return existing;
    if (!Array.isArray(value) || value.length > MAX_ENTRIES)
      throw bad(
        `${kind === 'env' ? 'env' : 'headers'} must be an array of up to ${MAX_ENTRIES} entries`,
      );
    const seen = new Set<string>();
    return value.map((raw) => {
      const e = (raw ?? {}) as EntryInput;
      const key = typeof e.key === 'string' ? e.key.trim() : '';
      if (!(kind === 'env' ? ENV_KEY_RE : HEADER_RE).test(key)) {
        throw bad(
          kind === 'env'
            ? `Invalid environment variable name: ${key || '(empty)'}`
            : `Invalid header name: ${key || '(empty)'}`,
        );
      }
      const id = kind === 'header' ? key.toLowerCase() : key;
      if (seen.has(id)) throw bad(`Duplicate ${kind === 'env' ? 'variable' : 'header'}: ${key}`);
      seen.add(id);
      const secret = e.secret === true;
      if (
        e.value !== undefined &&
        (typeof e.value !== 'string' || e.value.length > 4096 || e.value.includes('\0'))
      ) {
        throw bad(`${key}: value must be a string up to 4096 characters`);
      }
      if (secret) {
        if (e.value === undefined) {
          const prev = existing.find((p) => p.secret && p.key === key);
          if (!prev) throw bad(`${key}: a value is required for a new secret`);
          return prev;
        }
        return { key, secret: true, enc: this.secrets.encrypt(e.value as string) };
      }
      return { key, secret: false, value: (e.value as string | undefined) ?? '' };
    });
  }

  private plain(entry: StoredEntry): string {
    return entry.secret ? this.secrets.decrypt(entry.enc ?? '') : (entry.value ?? '');
  }

  private entryDto(entry: StoredEntry): EntryDto {
    const value = this.plain(entry);
    return entry.secret
      ? { key: entry.key, secret: true, hasValue: value.length > 0 }
      : { key: entry.key, secret: false, value, hasValue: value.length > 0 };
  }

  // ---- servers -------------------------------------------------------------------------------

  private row(id: number): ServerRow {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      ServerRow | undefined;
    if (!row) throw new McpError(404, 'MCP server not found');
    return row;
  }

  private toDto(r: ServerRow): ServerDto {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      type: r.type,
      command: r.command,
      args: JSON.parse(r.args) as string[],
      cwd: r.cwd,
      url: r.url,
      env: (JSON.parse(r.env) as StoredEntry[]).map((e) => this.entryDto(e)),
      headers: (JSON.parse(r.headers) as StoredEntry[]).map((e) => this.entryDto(e)),
      exposure: r.exposure,
      timeout: r.timeout,
      defaultHidden: JSON.parse(r.default_hidden) as string[],
      image: r.image,
      port: r.port,
      readyLog: r.ready_log,
      mountSamples: r.mount_samples === 1,
      memoryMb: r.memory_mb,
      discovery: r.discovery ? (JSON.parse(r.discovery) as Discovery) : null,
      createdAt: r.created_at,
    };
  }

  list(): ServerDto[] {
    return (
      this.db.prepare('SELECT * FROM mcp_servers ORDER BY id').all() as unknown as ServerRow[]
    ).map((r) => this.toDto(r));
  }

  get(id: number): ServerDto {
    return this.toDto(this.row(id));
  }

  /** Validates input into the column values shared by create and update. */
  private fields(input: ServerInput, prev?: ServerRow) {
    const type = (input.type ?? prev?.type) as McpType;
    if (type !== 'stdio' && type !== 'http' && type !== 'managed') {
      throw bad('type must be stdio, http or managed');
    }
    if (prev && input.type !== undefined && input.type !== prev.type)
      throw bad('type cannot be changed; create a new server instead');
    const description =
      input.description === undefined
        ? (prev?.description ?? null)
        : cleanText(input.description, 'description', 300);
    let timeout = prev?.timeout ?? null;
    if (input.timeout !== undefined) {
      if (input.timeout === null || input.timeout === '') timeout = null;
      else if (
        typeof input.timeout !== 'number' ||
        !Number.isInteger(input.timeout) ||
        input.timeout < 1 ||
        input.timeout > 600
      ) {
        throw bad('timeout must be a whole number of seconds from 1 to 600');
      } else timeout = input.timeout;
    }
    let exposure = prev?.exposure ?? null;
    if (input.exposure !== undefined) {
      if (input.exposure === null || input.exposure === '') exposure = null;
      else if (!EXPOSURES.includes(input.exposure as Exposure))
        throw bad(`exposure must be one of: ${EXPOSURES.join(', ')}`);
      else exposure = input.exposure as Exposure;
    }
    const prevEnv = prev ? (JSON.parse(prev.env) as StoredEntry[]) : [];
    const prevHeaders = prev ? (JSON.parse(prev.headers) as StoredEntry[]) : [];
    let command: string | null = null;
    let args: string[] = [];
    let cwd: string | null = null;
    let url: string | null = null;
    let env: StoredEntry[] = [];
    let headers: StoredEntry[] = [];
    let image: string | null = null;
    let port: number | null = null;
    let readyLog: string | null = null;
    let mountSamples = false;
    let memoryMb: number | null = null;
    if (type === 'managed') {
      image =
        input.image === undefined ? (prev?.image ?? null) : cleanText(input.image, 'image', 200);
      if (!image || !IMAGE_RE.test(image)) {
        throw bad(
          'image must be a container image name such as pi-panel/rea:6.8.0 (lowercase, no spaces)',
        );
      }
      command =
        input.command === undefined
          ? (prev?.command ?? null)
          : cleanText(input.command, 'command', 200);
      if (!command?.trim()) throw bad('command is required for managed servers');
      args =
        input.args === undefined
          ? prev
            ? (JSON.parse(prev.args) as string[])
            : []
          : cleanArgs(input.args);
      for (const field of ['url', 'cwd', 'headers'] as const) {
        const v = input[field];
        if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
          throw bad(`${field} does not apply to managed servers`);
        }
      }
      const rawPort = input.port === undefined ? (prev?.port ?? DEFAULT_MANAGED_PORT) : input.port;
      if (
        typeof rawPort !== 'number' ||
        !Number.isInteger(rawPort) ||
        rawPort < 1 ||
        rawPort > 65535
      ) {
        throw bad('port must be a whole number from 1 to 65535');
      }
      port = rawPort;
      readyLog =
        input.readyLog === undefined
          ? (prev?.ready_log ?? null)
          : cleanText(input.readyLog, 'readyLog', 200);
      if (input.mountSamples !== undefined && typeof input.mountSamples !== 'boolean') {
        throw bad('mountSamples must be a boolean');
      }
      mountSamples = (input.mountSamples as boolean | undefined) ?? prev?.mount_samples === 1;
      const rawMem =
        input.memoryMb === undefined ? (prev?.memory_mb ?? DEFAULT_MEMORY_MB) : input.memoryMb;
      if (
        typeof rawMem !== 'number' ||
        !Number.isInteger(rawMem) ||
        rawMem < 256 ||
        rawMem > 32768
      ) {
        throw bad('memoryMb must be a whole number from 256 to 32768');
      }
      memoryMb = rawMem;
      // The server's own environment (including secrets) goes to its container, never to pi.
      env = this.cleanEntries(input.env, 'env', prevEnv);
    } else if (type === 'stdio') {
      command =
        input.command === undefined
          ? (prev?.command ?? null)
          : cleanText(input.command, 'command', 200);
      if (!command?.trim()) throw bad('command is required for stdio servers');
      if (input.url !== undefined && input.url !== null && input.url !== '')
        throw bad('url is only for http servers');
      args =
        input.args === undefined
          ? prev
            ? (JSON.parse(prev.args) as string[])
            : []
          : cleanArgs(input.args);
      cwd = input.cwd === undefined ? (prev?.cwd ?? null) : cleanText(input.cwd, 'cwd', 200);
      env = this.cleanEntries(input.env, 'env', prevEnv);
    } else {
      url = input.url === undefined && prev?.url ? prev.url : cleanUrl(input.url);
      if (input.command !== undefined && input.command !== null && input.command !== '')
        throw bad('command is only for stdio servers');
      headers = this.cleanEntries(input.headers, 'header', prevHeaders);
    }
    return {
      type,
      description,
      timeout,
      exposure,
      command,
      args,
      cwd,
      url,
      env,
      headers,
      image,
      port,
      readyLog,
      mountSamples,
      memoryMb,
    };
  }

  create(input: ServerInput): ServerDto {
    if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
      throw bad('name must be 1-40 characters: letters, digits, "_" and "-"');
    }
    if (
      this.db.prepare('SELECT 1 FROM mcp_servers WHERE norm_name = ?').get(normName(input.name))
    ) {
      throw new McpError(
        409,
        'A server with that name already exists (names that differ only in "-" and "_" count as the same)',
      );
    }
    const f = this.fields(input);
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO mcp_servers (name, norm_name, description, type, command, args, cwd, url, env, headers,
             exposure, timeout, default_hidden, image, port, ready_log, mount_samples, memory_mb,
             discovery, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          input.name,
          normName(input.name),
          f.description,
          f.type,
          f.command,
          JSON.stringify(f.args),
          f.cwd,
          f.url,
          JSON.stringify(f.env),
          JSON.stringify(f.headers),
          f.exposure,
          f.timeout,
          f.image,
          f.port,
          f.readyLog,
          f.mountSamples ? 1 : 0,
          f.memoryMb,
          Date.now(),
        ).lastInsertRowid,
    );
    return this.get(id);
  }

  /** Returns the updated server. The name is fixed because projects reference tools by it. */
  update(id: number, input: ServerInput): ServerDto {
    const prev = this.row(id);
    if (input.name !== undefined && input.name !== prev.name) throw bad('name cannot be changed');
    const f = this.fields(input, prev);
    const changedLaunch =
      f.command !== prev.command ||
      f.url !== prev.url ||
      f.image !== prev.image ||
      f.port !== prev.port ||
      JSON.stringify(f.args) !== prev.args;
    this.db
      .prepare(
        `UPDATE mcp_servers SET description = ?, command = ?, args = ?, cwd = ?, url = ?, env = ?, headers = ?,
           exposure = ?, timeout = ?, ready_log = ?, mount_samples = ?, memory_mb = ?, image = ?, port = ?,
           discovery = ? WHERE id = ?`,
      )
      // A changed launch target invalidates what we learned about the old one.
      .run(
        f.description,
        f.command,
        JSON.stringify(f.args),
        f.cwd,
        f.url,
        JSON.stringify(f.env),
        JSON.stringify(f.headers),
        f.exposure,
        f.timeout,
        f.readyLog,
        f.mountSamples ? 1 : 0,
        f.memoryMb,
        f.image,
        f.port,
        changedLaunch ? null : prev.discovery,
        id,
      );
    return this.get(id);
  }

  /** Deletes a server and returns the projects that had it enabled. */
  delete(id: number): number[] {
    this.row(id);
    const projects = (
      this.db
        .prepare('SELECT project_id FROM project_mcp WHERE server_id = ? AND enabled = 1')
        .all(id) as unknown as { project_id: number }[]
    ).map((r) => r.project_id);
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return projects;
  }

  setDefaultHidden(id: number, tools: unknown): ServerDto {
    this.row(id);
    this.db
      .prepare('UPDATE mcp_servers SET default_hidden = ? WHERE id = ?')
      .run(JSON.stringify(this.cleanToolNames(tools)), id);
    return this.get(id);
  }

  private cleanToolNames(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_TOOLS)
      throw bad(`hidden must be an array of up to ${MAX_TOOLS} tool names`);
    return [
      ...new Set(
        value.map((n) => {
          if (typeof n !== 'string' || !n || n.length > 200 || n.includes('\0'))
            throw bad('tool names must be non-empty strings up to 200 characters');
          return n;
        }),
      ),
    ];
  }

  /**
   * Stores a discovery result. Tools seen for the first time are hidden by default when the server
   * marks them destructive; tools the admin already decided about keep their setting.
   */
  saveDiscovery(id: number, discovery: Discovery) {
    const row = this.row(id);
    const known = new Set(
      (row.discovery ? (JSON.parse(row.discovery) as Discovery).tools : []).map((t) => t.name),
    );
    const hidden = new Set(JSON.parse(row.default_hidden) as string[]);
    for (const tool of discovery.tools) {
      if (!known.has(tool.name) && tool.annotations.destructiveHint === true) hidden.add(tool.name);
    }
    this.db
      .prepare('UPDATE mcp_servers SET discovery = ?, default_hidden = ? WHERE id = ?')
      .run(JSON.stringify(discovery), JSON.stringify([...hidden]), id);
  }

  // ---- per project -----------------------------------------------------------------------------

  private projectRow(projectId: number, serverId: number): ProjectRow | undefined {
    return this.db
      .prepare('SELECT * FROM project_mcp WHERE project_id = ? AND server_id = ?')
      .get(projectId, serverId) as ProjectRow | undefined;
  }

  private effectiveHidden(
    server: ServerDto,
    row: ProjectRow | undefined,
  ): { hidden: string[]; override: string[] | null } {
    const override = row?.hidden_tools ? (JSON.parse(row.hidden_tools) as string[]) : null;
    return { hidden: override ?? server.defaultHidden, override };
  }

  projectServers(projectId: number): ProjectServerDto[] {
    return this.list().map((server) => {
      const row = this.projectRow(projectId, server.id);
      const { hidden, override } = this.effectiveHidden(server, row);
      return { server, enabled: row?.enabled === 1, hiddenOverride: override, hiddenTools: hidden };
    });
  }

  setProject(
    projectId: number,
    serverId: number,
    change: { enabled?: unknown; hiddenTools?: unknown },
  ) {
    this.get(serverId);
    if (change.enabled !== undefined && typeof change.enabled !== 'boolean')
      throw bad('enabled must be a boolean');
    const prev = this.projectRow(projectId, serverId);
    const enabled = change.enabled === undefined ? prev?.enabled === 1 : change.enabled;
    let hidden: string | null = prev?.hidden_tools ?? null;
    if (change.hiddenTools !== undefined)
      hidden =
        change.hiddenTools === null
          ? null
          : JSON.stringify(this.cleanToolNames(change.hiddenTools));
    this.db
      .prepare(
        `INSERT INTO project_mcp (project_id, server_id, enabled, hidden_tools) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, server_id) DO UPDATE SET enabled = excluded.enabled, hidden_tools = excluded.hidden_tools`,
      )
      .run(projectId, serverId, enabled ? 1 : 0, hidden);
  }

  // ---- generating pi's configuration ---------------------------------------------------------------

  private envVar(serverId: number, kind: 'E' | 'H', key: string | number) {
    return `PP_MCP_${serverId}_${kind}_${key}`;
  }

  /**
   * The mcp.json entry for one server plus the environment variables it needs. Values never appear in
   * the file: every env var and header is a ${VAR} reference resolved from the pi process environment,
   * which also means a value that starts with "!" is never run as a command.
   */
  private build(
    row: ServerRow,
    hidden: string[],
    samples: string[] = [],
  ): { config: Record<string, unknown>; env: Record<string, string>; secretValues: string[] } {
    const env: Record<string, string> = {};
    const secretValues: string[] = [];
    const put = (name: string, e: StoredEntry) => {
      env[name] = this.plain(e);
      if (e.secret) secretValues.push(env[name]);
    };
    const config: Record<string, unknown> = {};
    if (row.description) config.description = row.description;
    if (row.timeout) config.timeout = row.timeout;
    if (row.exposure) config.exposure = row.exposure;
    if (row.type === 'managed') {
      // pi reaches the container by its alias on the project's private network. The container's own
      // environment (secrets included) is set when the panel starts it and never passes through pi.
      config.url = `http://${sidecarAlias(row.id)}:${row.port ?? DEFAULT_MANAGED_PORT}/mcp`;
      if (row.mount_samples === 1) {
        // The agent cannot see /samples itself, so tell it which files exist for the server to open.
        const listed = samples.slice(0, 20).map((n) => `/samples/${n}`);
        const more = samples.length > 20 ? ` and ${samples.length - 20} more` : '';
        const hint =
          samples.length === 0
            ? 'Files uploaded to this project appear under /samples inside the server; none are uploaded yet.'
            : `Files available inside the server: ${listed.join(', ')}${more}.`;
        config.description = [row.description, hint].filter(Boolean).join(' ');
      }
    } else if (row.type === 'stdio') {
      config.command = row.command;
      const args = JSON.parse(row.args) as string[];
      if (args.length > 0) config.args = args;
      if (row.cwd) config.cwd = row.cwd;
      const entries = JSON.parse(row.env) as StoredEntry[];
      if (entries.length > 0) {
        config.env = Object.fromEntries(
          entries.map((e) => {
            const name = this.envVar(row.id, 'E', e.key);
            put(name, e);
            return [e.key, `\${${name}}`];
          }),
        );
      }
    } else {
      config.url = row.url;
      const entries = JSON.parse(row.headers) as StoredEntry[];
      if (entries.length > 0) {
        config.headers = Object.fromEntries(
          entries.map((e, i) => {
            const name = this.envVar(row.id, 'H', i);
            put(name, e);
            return [e.key, `\${${name}}`];
          }),
        );
      }
    }
    // "*" is a pattern in toolExposure keys, so a tool literally named with one cannot be addressed.
    const names = hidden.filter((n) => !n.includes('*'));
    if (names.length > 0) config.toolExposure = Object.fromEntries(names.map((n) => [n, 'hidden']));
    return { config, env, secretValues };
  }

  /** The complete mcp.json content and environment for a project's enabled servers. */
  projectConfig(
    projectId: number,
    opts: { samples?: string[] } = {},
  ): {
    config: { mcpServers: Record<string, unknown> };
    env: Record<string, string>;
  } {
    const mcpServers: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    for (const p of this.projectServers(projectId)) {
      if (!p.enabled) continue;
      const built = this.build(this.row(p.server.id), p.hiddenTools, opts.samples);
      mcpServers[p.server.name] = built.config;
      Object.assign(env, built.env);
    }
    return { config: { mcpServers }, env };
  }

  /** A one-server config used to test a library entry in a throwaway container. */
  testConfig(id: number): {
    name: string;
    config: Record<string, unknown>;
    env: Record<string, string>;
    /** The decrypted secret values, so output from the test can be scrubbed. */
    secretValues: string[];
  } {
    const row = this.row(id);
    return { name: row.name, ...this.build(row, []) };
  }

  // ---- managed servers (sidecar containers) ---------------------------------------------------------

  /** What the panel needs to start a managed server's container. */
  sidecarSpecFor(id: number): {
    name: string;
    image: string;
    cmd: string[];
    port: number;
    readyLog: string | null;
    mountSamples: boolean;
    memoryMb: number;
    env: Record<string, string>;
    secretValues: string[];
  } {
    const row = this.row(id);
    if (row.type !== 'managed' || !row.image || !row.command) {
      throw new McpError(400, 'That server is not a managed container');
    }
    const env: Record<string, string> = {};
    const secretValues: string[] = [];
    for (const e of JSON.parse(row.env) as StoredEntry[]) {
      env[e.key] = this.plain(e);
      if (e.secret) secretValues.push(env[e.key]!);
    }
    return {
      name: row.name,
      image: row.image,
      cmd: [row.command, ...(JSON.parse(row.args) as string[])],
      port: row.port ?? DEFAULT_MANAGED_PORT,
      readyLog: row.ready_log,
      mountSamples: row.mount_samples === 1,
      memoryMb: row.memory_mb ?? DEFAULT_MEMORY_MB,
      env,
      secretValues,
    };
  }

  /** Managed servers enabled for a project, with the id of their running container if any. */
  managedFor(projectId: number): { server: ServerDto; containerId: string | null }[] {
    return this.projectServers(projectId)
      .filter((p) => p.enabled && p.server.type === 'managed')
      .map((p) => ({
        server: p.server,
        containerId: this.projectRow(projectId, p.server.id)?.container_id ?? null,
      }));
  }

  containerId(projectId: number, serverId: number): string | null {
    return this.projectRow(projectId, serverId)?.container_id ?? null;
  }

  /** Records the container a project's managed server runs in (null once it is gone). */
  setContainerId(projectId: number, serverId: number, containerId: string | null) {
    this.db
      .prepare(
        `INSERT INTO project_mcp (project_id, server_id, enabled, container_id) VALUES (?, ?, 0, ?)
         ON CONFLICT(project_id, server_id) DO UPDATE SET container_id = excluded.container_id`,
      )
      .run(projectId, serverId, containerId);
  }

  /** Every container recorded for a project, or for a server across all projects. */
  recordedContainers(filter: { projectId: number } | { serverId: number }): {
    projectId: number;
    serverId: number;
    containerId: string;
  }[] {
    const [where, value] =
      'projectId' in filter ? ['project_id', filter.projectId] : ['server_id', filter.serverId];
    return (
      this.db
        .prepare(
          `SELECT project_id, server_id, container_id FROM project_mcp WHERE ${where} = ? AND container_id IS NOT NULL`,
        )
        .all(value) as unknown as { project_id: number; server_id: number; container_id: string }[]
    ).map((r) => ({ projectId: r.project_id, serverId: r.server_id, containerId: r.container_id }));
  }
}
