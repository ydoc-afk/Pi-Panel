import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SANDBOX_AGENT_DIR, agentDir } from './paths.js';
import type { ContainerRuntime } from './runtime.js';
import { runToCompletion } from './runtime-util.js';
import type { SessionManager } from './sessions.js';

export class PackageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PackageOptions {
  registry?: string;
  fetch?: typeof fetch;
  /** Clock for review expiry (tests). */
  now?: () => number;
}

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TAG_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const REVIEW_TTL_MS = 15 * 60_000;
const SETTINGS_MAX_BYTES = 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const REMOVE_TIMEOUT_MS = 2 * 60_000;
/** Matches ANSI colour codes in CLI output (built without a literal control character). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

interface NpmSource {
  name: string;
  /** exact version, dist-tag, or undefined for latest */
  spec?: string;
}

/** Only `npm:` sources are supported; anything else (git, URLs, paths, flags) is rejected up front. */
export function parseNpmSource(input: unknown): NpmSource {
  if (typeof input !== 'string') throw new PackageError(400, 'source must be a string');
  const value = input.trim();
  if (!value.startsWith('npm:')) {
    throw new PackageError(
      400,
      'Only npm: package sources are supported (for example npm:@scope/name)',
    );
  }
  const rest = value.slice(4);
  const at = rest.lastIndexOf('@');
  const name = at > 0 ? rest.slice(0, at) : rest;
  const spec = at > 0 ? rest.slice(at + 1) : undefined;
  if (!name || name.length > 214 || !NAME_RE.test(name))
    throw new PackageError(400, 'Invalid npm package name');
  if (spec !== undefined && !SEMVER_RE.test(spec) && !TAG_RE.test(spec)) {
    throw new PackageError(
      400,
      'Use an exact version (1.2.3) or a dist-tag (latest); version ranges are not supported',
    );
  }
  return { name, spec };
}

export interface InstalledPackage {
  source: string;
  name: string | null;
  version: string | null;
  /** True when settings use the object form, which narrows which resources load. */
  filtered: boolean;
}

export interface PackageReview {
  source: string;
  name: string;
  version: string;
  description: string | null;
  license: string | null;
  repository: string | null;
  homepage: string | null;
  author: string | null;
  publisher: string | null;
  deprecated: string | null;
  dependencies: string[];
  installScripts: string[];
  resources: { extensions: number; skills: number; prompts: number; themes: number } | null;
  unpackedBytes: number | null;
  fileCount: number | null;
  links: { npm: string; files: string };
  warnings: string[];
}

const str = (v: unknown, max = 500): string | null =>
  typeof v === 'string' && v ? v.slice(0, max) : null;
const count = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'string' ? 1 : 0);

interface Manifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  license?: unknown;
  homepage?: unknown;
  repository?: unknown;
  author?: unknown;
  keywords?: unknown;
  dependencies?: unknown;
  scripts?: unknown;
  deprecated?: unknown;
  dist?: { unpackedSize?: unknown; fileCount?: unknown };
  pi?: Record<string, unknown>;
  _npmUser?: { name?: unknown };
}

function review(manifest: Manifest): PackageReview {
  const name = str(manifest.name, 214);
  const version = str(manifest.version, 100);
  if (!name || !version || !NAME_RE.test(name) || !SEMVER_RE.test(version)) {
    throw new PackageError(502, 'Unexpected package metadata from the registry');
  }
  const license =
    typeof manifest.license === 'string'
      ? str(manifest.license, 100)
      : str((manifest.license as { type?: unknown } | undefined)?.type, 100);
  const repo =
    typeof manifest.repository === 'string'
      ? str(manifest.repository)
      : str((manifest.repository as { url?: unknown } | undefined)?.url);
  const author =
    typeof manifest.author === 'string'
      ? str(manifest.author, 200)
      : str((manifest.author as { name?: unknown } | undefined)?.name, 200);
  const scripts =
    manifest.scripts && typeof manifest.scripts === 'object' ? Object.keys(manifest.scripts) : [];
  const installScripts = INSTALL_SCRIPTS.filter((s) => scripts.includes(s));
  const deps =
    manifest.dependencies && typeof manifest.dependencies === 'object'
      ? Object.entries(manifest.dependencies as Record<string, unknown>)
          .slice(0, 200)
          .map(([n, v]) => `${n}@${String(v)}`.slice(0, 200))
      : [];
  const pi = manifest.pi && typeof manifest.pi === 'object' ? manifest.pi : null;
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
  const resources = pi
    ? {
        extensions: count(pi.extensions),
        skills: count(pi.skills),
        prompts: count(pi.prompts),
        themes: count(pi.themes),
      }
    : null;
  const deprecated = str(manifest.deprecated);

  const warnings: string[] = [];
  if (deprecated) warnings.push(`Deprecated: ${deprecated}`);
  if (installScripts.length > 0) {
    warnings.push(
      `Declares install-time scripts (${installScripts.join(', ')}). They are disabled during installation here, so the package may not work fully.`,
    );
  }
  if (!pi && !keywords.includes('pi-package')) {
    warnings.push('Not marked as a pi package (no "pi" manifest and no "pi-package" keyword).');
  }
  if (resources && resources.extensions > 0) {
    warnings.push(
      "Includes extensions: executable code that runs with the agent's permissions inside the project container.",
    );
  }
  if (!repo) warnings.push('No repository is listed, so the source cannot be cross-checked.');
  if (!license) warnings.push('No license is listed.');

  const path = name.replace('/', '%2F');
  return {
    source: `npm:${name}@${version}`,
    name,
    version,
    description: str(manifest.description),
    license,
    repository: repo,
    homepage: str(manifest.homepage),
    author,
    publisher: str(manifest._npmUser?.name, 100),
    deprecated,
    dependencies: deps,
    installScripts,
    resources,
    unpackedBytes:
      typeof manifest.dist?.unpackedSize === 'number' ? manifest.dist.unpackedSize : null,
    fileCount: typeof manifest.dist?.fileCount === 'number' ? manifest.dist.fileCount : null,
    links: {
      npm: `https://www.npmjs.com/package/${name}/v/${version}`,
      files: `https://unpkg.com/browse/${path.replace('%2F', '/')}@${version}/`,
    },
    warnings,
  };
}

interface ProjectRow {
  container_id: string | null;
  status: string;
}

export class PackageService {
  private readonly registry: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly reviews = new Map<string, number>();
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtime: ContainerRuntime,
    private readonly sessions: SessionManager,
    private readonly dataDir: string,
    opts: PackageOptions = {},
  ) {
    this.registry = (opts.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Reads the project's pi settings. The file is writable by the agent, so treat it as untrusted. */
  async list(projectId: number): Promise<InstalledPackage[]> {
    this.project(projectId);
    const path = join(agentDir(this.dataDir, projectId), 'settings.json');
    let parsed: unknown;
    try {
      if ((await stat(path)).size > SETTINGS_MAX_BYTES) return [];
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return [];
    }
    const entries = (parsed as { packages?: unknown } | null)?.packages;
    if (!Array.isArray(entries)) return [];
    const out: InstalledPackage[] = [];
    for (const entry of entries) {
      const source =
        typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
      if (typeof source !== 'string' || !source || source.length > 300) continue;
      let name: string | null = null;
      let version: string | null = null;
      try {
        const p = parseNpmSource(source);
        name = p.name;
        version = p.spec && SEMVER_RE.test(p.spec) ? p.spec : null;
      } catch {
        /* non-npm source: listed as-is */
      }
      out.push({ source, name, version, filtered: typeof entry !== 'string' });
    }
    return out;
  }

  /** Resolves a package to an exact version and returns what the admin should review. */
  async preview(projectId: number, sourceInput: unknown): Promise<PackageReview> {
    this.project(projectId);
    const { name, spec } = parseNpmSource(sourceInput);
    const url = `${this.registry}/${name.replace('/', '%2F')}/${spec ?? 'latest'}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PackageError(502, 'Could not reach the npm registry');
    }
    if (res.status === 404)
      throw new PackageError(404, 'Package or version not found on the registry');
    if (!res.ok) throw new PackageError(502, `The npm registry returned HTTP ${res.status}`);
    const manifest = (await res.json().catch(() => null)) as Manifest | null;
    if (!manifest || typeof manifest !== 'object')
      throw new PackageError(502, 'Unexpected response from the registry');
    const result = review(manifest);
    if (result.name !== name)
      throw new PackageError(502, 'The registry returned a different package than requested');
    this.reviews.set(`${projectId}:${result.source}`, this.now() + REVIEW_TTL_MS);
    return result;
  }

  async install(projectId: number, sourceInput: unknown) {
    const project = this.runningProject(projectId);
    const { name, spec } = parseNpmSource(sourceInput);
    if (!spec || !SEMVER_RE.test(spec)) {
      throw new PackageError(
        400,
        'Install requires the exact reviewed version, for example npm:name@1.2.3',
      );
    }
    const source = `npm:${name}@${spec}`;
    const key = `${projectId}:${source}`;
    const expires = this.reviews.get(key);
    if (expires === undefined || expires < this.now()) {
      this.reviews.delete(key);
      throw new PackageError(409, 'Review this exact version before installing it');
    }
    return this.exclusive(projectId, async () => {
      await this.run(project, ['install', source], INSTALL_TIMEOUT_MS, 'pi install failed');
      this.reviews.delete(key);
      return this.afterChange(projectId);
    });
  }

  async remove(projectId: number, sourceInput: unknown) {
    const project = this.runningProject(projectId);
    if (typeof sourceInput !== 'string') throw new PackageError(400, 'source must be a string');
    // Only sources already configured can be removed, so no arbitrary argument reaches the CLI.
    if (!(await this.list(projectId)).some((p) => p.source === sourceInput)) {
      throw new PackageError(404, 'That package is not installed in this project');
    }
    return this.exclusive(projectId, async () => {
      await this.run(project, ['remove', sourceInput], REMOVE_TIMEOUT_MS, 'pi remove failed');
      return this.afterChange(projectId);
    });
  }

  private async afterChange(projectId: number) {
    // pi has no reload command over RPC, so idle sessions get a fresh process on their next prompt.
    const { stopped, running } = this.sessions.stopIdleForProject(projectId);
    return {
      packages: await this.list(projectId),
      restartedSessions: stopped,
      pendingSessions: running,
    };
  }

  private async run(
    project: { containerId: string },
    args: string[],
    timeoutMs: number,
    prefix: string,
  ) {
    const result = await runToCompletion(
      this.runtime,
      project.containerId,
      {
        cmd: ['pi', ...args],
        workdir: '/workspace',
        env: {
          PI_CODING_AGENT_DIR: SANDBOX_AGENT_DIR,
          // Dependencies' install scripts would run arbitrary code at install time.
          NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        },
      },
      timeoutMs,
    ).catch(() => {
      throw new PackageError(502, 'Failed to run pi in the project container');
    });
    if (result.timedOut) throw new PackageError(504, `${prefix}: timed out`);
    if (result.code !== 0) {
      const text = (result.stderr.trim() || result.stdout.trim() || 'no output').replace(ANSI, '');
      throw new PackageError(502, `${prefix}: ${text.slice(-1000)}`);
    }
  }

  private project(id: number): ProjectRow {
    const row = this.db
      .prepare('SELECT container_id, status FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    if (!row) throw new PackageError(404, 'Project not found');
    return row;
  }

  private runningProject(id: number): { containerId: string } {
    const row = this.project(id);
    if (!row.container_id || row.status !== 'running')
      throw new PackageError(409, 'Project container is not running');
    return { containerId: row.container_id };
  }

  private exclusive<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(projectId, run);
    return run.finally(() => {
      if (this.locks.get(projectId) === run) this.locks.delete(projectId);
    });
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PackageError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerPackages(app: FastifyInstance, svc: PackageService) {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };
  const source = (body: unknown) => ((body ?? {}) as { source?: unknown }).source;

  app.get<P>('/api/projects/:id/packages', (req, reply) =>
    handle(reply, async () => ({ packages: await svc.list(id(req.params.id)) })),
  );
  app.post<P>('/api/projects/:id/packages/preview', (req, reply) =>
    handle(reply, async () => ({ review: await svc.preview(id(req.params.id), source(req.body)) })),
  );
  app.post<P>('/api/projects/:id/packages', (req, reply) =>
    handle(reply, async () => svc.install(id(req.params.id), source(req.body))),
  );
  app.post<P>('/api/projects/:id/packages/remove', (req, reply) =>
    handle(reply, async () => svc.remove(id(req.params.id), source(req.body))),
  );
}
