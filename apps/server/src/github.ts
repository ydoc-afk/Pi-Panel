import { spawn } from 'node:child_process';
import { lstat, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SANDBOX_UID, workspaceDir } from './paths.js';
import type { Secrets } from './secrets.js';

export type ForgeKind = 'github' | 'forgejo';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubOptions {
  /** Which forge this service talks to. Forgejo's base URL is stored with the account. */
  kind?: ForgeKind;
  /** Base for repository URLs; tests point this at a local directory of bare repos. */
  webBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Git transports allowed for network operations. Production allows https only. */
  allowProtocols?: string[];
  /**
   * Run git as the sandbox user (uid 1000) when the panel runs as root, so a hostile repository
   * cannot read the panel's own files. Disable only in tests.
   */
  dropPrivileges?: boolean;
}

const MAX_OUTPUT = 1024 * 1024;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
// Forgejo allows underscores and dots in owner names and longer ones.
const FORGEJO_REPO_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9._-]{1,100})$/;

/** Config keys a workspace's .git/config may contain; anything else could run code or redirect traffic. */
const SAFE_CONFIG_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^remote\..+\.(url|fetch)$/,
  /^branch\..+\.(remote|merge)$/,
  /^user\.(name|email)$/,
];

interface Account {
  login: string;
  userId: number;
  token: string;
  /** Origin (plus any path prefix) that repositories are cloned from and tokens are sent to. */
  webBase: string;
  /** Git protocols this account's remote may use. */
  protocols: string[];
  /** Username for git's Basic auth: GitHub ignores it, Forgejo needs the real login. */
  gitUser: string;
  authorEmail: string;
}

interface ProjectRow {
  id: number;
  repo: string | null;
  repo_host: string | null;
}

/** Parses owner/name, or a full repository URL on `webBase`. */
export function parseRepo(input: unknown, kind: ForgeKind = 'github', webBase?: string): string {
  const label = kind === 'github' ? 'GitHub' : 'Forgejo';
  if (typeof input !== 'string') throw new GitHubError(400, 'repo must be a string');
  let value = input.trim();
  const prefix = (kind === 'github' ? 'https://github.com' : (webBase ?? '')).replace(/\/+$/, '');
  if (prefix && value.startsWith(`${prefix}/`)) value = value.slice(prefix.length + 1);
  value = value.replace(/\/+$/, '').replace(/\.git$/, '');
  const m = (kind === 'github' ? REPO_RE : FORGEJO_REPO_RE).exec(value);
  if (!m || m[2] === '.' || m[2] === '..') {
    throw new GitHubError(
      400,
      `repo must look like owner/name or a ${label} repository URL (${prefix || 'https://github.com'}/owner/name)`,
    );
  }
  return value;
}

export function redact(text: string, token: string | undefined, user = 'x-access-token'): string {
  if (!token) return text;
  const b64 = Buffer.from(`${user}:${token}`).toString('base64');
  return text.split(b64).join('***').split(token).join('***');
}

/** Normalizes a Forgejo instance address: http(s) only, no credentials, query or fragment. */
export function parseForgejoUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new GitHubError(400, 'Forgejo URL must be a string');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new GitHubError(400, 'Forgejo URL must look like http://localhost:3001');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GitHubError(400, 'Forgejo URL must start with http:// or https://');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GitHubError(400, 'Forgejo URL must not contain credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class GitHubService {
  private readonly kind: ForgeKind;
  private readonly table: string;
  private readonly label: string;
  private readonly webBase: string;
  private readonly apiBase: string;
  private readonly testWebBase: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly allowProtocols: string[];
  private readonly dropPrivileges: boolean;
  private readonly locks = new Map<number, Promise<unknown>>();
  private globalConfig: string | undefined;

  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: Secrets,
    private readonly dataDir: string,
    opts: GitHubOptions = {},
  ) {
    this.kind = opts.kind ?? 'github';
    this.table = this.kind === 'github' ? 'github_account' : 'forgejo_account';
    this.label = this.kind === 'github' ? 'GitHub' : 'Forgejo';
    this.testWebBase = this.kind === 'forgejo' ? opts.webBase?.replace(/\/+$/, '') : undefined;
    this.webBase = (opts.webBase ?? 'https://github.com').replace(/\/+$/, '');
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.allowProtocols = opts.allowProtocols ?? ['https'];
    this.dropPrivileges = opts.dropPrivileges ?? true;
  }

  // ---- account -----------------------------------------------------------------------------

  account(): { connected: boolean; login?: string; baseUrl?: string } {
    const row = this.db
      .prepare(
        `SELECT login${this.kind === 'forgejo' ? ', base_url' : ''} FROM ${this.table} WHERE id = 1`,
      )
      .get() as { login: string; base_url?: string } | undefined;
    if (!row) return { connected: false };
    return {
      connected: true,
      login: row.login,
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
    };
  }

  private requireAccount(): Account {
    const row = this.db
      .prepare(
        `SELECT login, user_id, token_enc${this.kind === 'forgejo' ? ', base_url' : ''} FROM ${this.table} WHERE id = 1`,
      )
      .get() as
      { login: string; user_id: number; token_enc: string; base_url?: string } | undefined;
    if (!row) {
      throw new GitHubError(
        409,
        `${this.label} is not connected. Add a personal access token first.`,
      );
    }
    return this.makeAccount(
      row.login,
      row.user_id,
      this.secrets.decrypt(row.token_enc),
      row.base_url,
    );
  }

  private makeAccount(login: string, userId: number, token: string, baseUrl?: string): Account {
    if (this.kind === 'github') {
      return {
        login,
        userId,
        token,
        webBase: this.webBase,
        protocols: this.allowProtocols,
        gitUser: 'x-access-token',
        authorEmail: `${userId}+${login}@users.noreply.github.com`,
      };
    }
    const base = baseUrl ?? '';
    const host = base ? new URL(base).hostname : 'localhost';
    return {
      login,
      userId,
      token,
      webBase: this.testWebBase ?? base,
      protocols:
        this.allowProtocols.length === 1 && this.allowProtocols[0] === 'https'
          ? [new URL(base).protocol.replace(':', '')]
          : this.allowProtocols,
      gitUser: login,
      authorEmail: `${userId}+${login}@noreply.${host}`,
    };
  }

  private optionalAccount(): Account | undefined {
    return this.account().connected ? this.requireAccount() : undefined;
  }

  private cleanToken(token: unknown): string {
    if (typeof token !== 'string' || !/^\S{8,4096}$/.test(token.trim())) {
      throw new GitHubError(400, 'token must be a non-empty string without whitespace');
    }
    return token.trim();
  }

  /** Forgejo accounts carry their instance address; GitHub's is fixed. */
  private baseFor(baseUrlInput: unknown): string | undefined {
    return this.kind === 'forgejo' ? parseForgejoUrl(baseUrlInput) : undefined;
  }

  async connect(
    tokenInput: unknown,
    baseUrlInput?: unknown,
  ): Promise<{ login: string; baseUrl?: string }> {
    const clean = this.cleanToken(tokenInput);
    const baseUrl = this.baseFor(baseUrlInput);
    const user =
      (await this.api<{ login?: string; id?: number }>(
        'GET',
        '/user',
        clean,
        undefined,
        baseUrl,
      )) ?? {};
    if (typeof user.login !== 'string' || typeof user.id !== 'number') {
      throw new GitHubError(502, `Unexpected response from ${this.label}`);
    }
    if (this.kind === 'forgejo') {
      this.db
        .prepare(
          `INSERT INTO forgejo_account (id, base_url, login, user_id, token_enc, created_at) VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, login = excluded.login,
             user_id = excluded.user_id, token_enc = excluded.token_enc, created_at = excluded.created_at`,
        )
        .run(baseUrl!, user.login, user.id, this.secrets.encrypt(clean), Date.now());
      return { login: user.login, baseUrl: baseUrl! };
    }
    this.db
      .prepare(
        `INSERT INTO github_account (id, login, user_id, token_enc, created_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET login = excluded.login, user_id = excluded.user_id,
           token_enc = excluded.token_enc, created_at = excluded.created_at`,
      )
      .run(user.login, user.id, this.secrets.encrypt(clean), Date.now());
    return { login: user.login };
  }

  /**
   * Checks a token against the forge and reports which account it belongs to. Nothing is stored.
   * A blank token tests the stored one, when there is one.
   */
  async testToken(
    tokenInput: unknown,
    baseUrlInput?: unknown,
  ): Promise<{ login: string; id: number }> {
    let token: string;
    let baseUrl: string | undefined;
    if (typeof tokenInput === 'string' && tokenInput.trim() !== '') {
      token = this.cleanToken(tokenInput);
      baseUrl = this.baseFor(baseUrlInput);
    } else {
      const stored = this.optionalAccount();
      if (!stored) throw new GitHubError(400, 'Paste a token to test, or connect one first');
      token = stored.token;
      baseUrl = this.kind === 'forgejo' ? this.account().baseUrl : undefined;
    }
    const user =
      (await this.api<{ login?: string; id?: number }>(
        'GET',
        '/user',
        token,
        undefined,
        baseUrl,
      )) ?? {};
    if (typeof user.login !== 'string' || typeof user.id !== 'number') {
      throw new GitHubError(502, `Unexpected response from ${this.label}`);
    }
    return { login: user.login, id: user.id };
  }

  disconnect() {
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = 1`).run();
  }

  // ---- project operations ------------------------------------------------------------------

  async status(projectId: number) {
    const project = this.project(projectId);
    if (!project.repo) return { repo: null, branch: null, changes: 0 };
    if (this.otherHost(project)) {
      return { repo: null, branch: null, changes: 0, linkedTo: project.repo_host ?? 'github' };
    }
    return this.exclusive(projectId, async () => {
      const dir = await this.safeRepoDir(projectId);
      const branch = (await this.git(dir, ['symbolic-ref', '--short', 'HEAD'])).trim() || null;
      const changes = await this.changeCount(dir);
      return { repo: project.repo, branch, changes };
    });
  }

  async clone(projectId: number, repoInput: unknown, branchInput?: unknown) {
    const project = this.project(projectId);
    if (project.repo) throw new GitHubError(409, 'Project is already linked to a repository');
    const account = this.kind === 'forgejo' ? this.requireAccount() : this.optionalAccount();
    const repo = parseRepo(repoInput, this.kind, account?.webBase);
    const branch =
      branchInput === undefined || branchInput === ''
        ? undefined
        : await this.branchName(branchInput);
    return this.exclusive(projectId, async () => {
      const dir = workspaceDir(this.dataDir, projectId);
      if ((await readdir(dir)).length > 0) throw new GitHubError(409, 'Workspace is not empty');
      try {
        await this.git(
          dir,
          [
            'clone',
            ...(branch ? ['--branch', branch] : []),
            '--',
            `${account?.webBase ?? this.webBase}/${repo}.git`,
            '.',
          ],
          { account, timeoutMs: 10 * 60_000 },
        );
      } catch (err) {
        // Leave the workspace empty so the clone can be retried.
        for (const entry of await readdir(dir))
          await rm(join(dir, entry), { recursive: true, force: true });
        throw err;
      }
      this.db
        .prepare('UPDATE projects SET repo = ?, repo_host = ? WHERE id = ?')
        .run(repo, this.kind === 'github' ? null : this.kind, projectId);
      return { repo, branch: (await this.git(dir, ['symbolic-ref', '--short', 'HEAD'])).trim() };
    });
  }

  async push(projectId: number, branchInput: unknown, messageInput?: unknown) {
    const project = this.project(projectId);
    if (!project.repo) throw new GitHubError(409, 'Project has no linked repository');
    this.assertHost(project);
    const account = this.requireAccount();
    const branch = await this.branchName(branchInput);
    const message =
      messageInput === undefined || messageInput === '' ? 'Update from Pi-Panel' : messageInput;
    if (typeof message !== 'string' || message.length > 5000) {
      throw new GitHubError(400, 'message must be a string up to 5000 characters');
    }
    return this.exclusive(projectId, async () => {
      const dir = await this.safeRepoDir(projectId);
      await this.git(dir, ['switch', '-C', branch], { account });
      await this.git(dir, ['add', '-A'], { account });
      let committed = false;
      if ((await this.changeCount(dir)) > 0) {
        await this.git(dir, ['commit', '-m', message], { account });
        committed = true;
      }
      await this.git(
        dir,
        [
          'push',
          '--porcelain',
          `${account.webBase}/${project.repo}.git`,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        { account, timeoutMs: 5 * 60_000, failStatus: 409, failPrefix: 'Push failed' },
      );
      const sha = (await this.git(dir, ['rev-parse', 'HEAD'])).trim();
      return { repo: project.repo, branch, commit: sha, committed };
    });
  }

  async pullRequest(
    projectId: number,
    input: { head?: unknown; title?: unknown; body?: unknown; base?: unknown },
  ) {
    const project = this.project(projectId);
    if (!project.repo) throw new GitHubError(409, 'Project has no linked repository');
    this.assertHost(project);
    const account = this.requireAccount();
    const head = await this.branchName(input.head);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256) {
      throw new GitHubError(400, 'title must be 1-256 characters');
    }
    if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 65536)) {
      throw new GitHubError(400, 'body must be a string up to 65536 characters');
    }
    let base: string;
    if (input.base === undefined || input.base === '') {
      const info = await this.api<{ default_branch?: string }>(
        'GET',
        `/repos/${project.repo}`,
        account.token,
        undefined,
        this.kind === 'forgejo' ? this.account().baseUrl : undefined,
      );
      if (!info?.default_branch)
        throw new GitHubError(502, 'Could not determine the default branch');
      base = info.default_branch;
    } else {
      base = await this.branchName(input.base);
    }
    const pr = await this.api<{ html_url?: string; number?: number }>(
      'POST',
      `/repos/${project.repo}/pulls`,
      account.token,
      { title: input.title.trim(), head, base, body: input.body ?? '' },
      this.kind === 'forgejo' ? this.account().baseUrl : undefined,
    );
    if (!pr?.html_url) throw new GitHubError(502, `Unexpected response from ${this.label}`);
    return { url: pr.html_url, number: pr.number ?? null, base, head };
  }

  // ---- internals ---------------------------------------------------------------------------

  private project(id: number): ProjectRow {
    const row = this.db.prepare('SELECT id, repo, repo_host FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined;
    if (!row) throw new GitHubError(404, 'Project not found');
    return row;
  }

  /** True when the project's repository lives on the other forge. */
  private otherHost(project: ProjectRow): boolean {
    return !!project.repo && (project.repo_host ?? 'github') !== this.kind;
  }

  private assertHost(project: ProjectRow) {
    if (this.otherHost(project)) {
      throw new GitHubError(
        409,
        `Project is linked to a ${project.repo_host === 'forgejo' ? 'Forgejo' : 'GitHub'} repository, not ${this.label}`,
      );
    }
  }

  /** Serializes git operations per project so they cannot interleave. */
  private exclusive<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(projectId, run);
    return run.finally(() => {
      if (this.locks.get(projectId) === run) this.locks.delete(projectId);
    });
  }

  private async branchName(value: unknown): Promise<string> {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 200 ||
      value.startsWith('-') ||
      value.includes('@{')
    ) {
      throw new GitHubError(400, 'Invalid branch name');
    }
    try {
      await this.git(tmpdir(), ['check-ref-format', '--branch', value]);
    } catch {
      throw new GitHubError(400, 'Invalid branch name');
    }
    return value;
  }

  private async changeCount(dir: string): Promise<number> {
    const out = await this.git(dir, ['status', '--porcelain=v1', '-z']);
    return out.split('\0').filter(Boolean).length;
  }

  /**
   * The sandbox agent controls everything inside the workspace, including .git. Before running git
   * there, require a real .git directory with no alternates and only allow-listed config keys.
   */
  private async safeRepoDir(projectId: number): Promise<string> {
    const dir = workspaceDir(this.dataDir, projectId);
    const gitDir = join(dir, '.git');
    const info = await lstat(gitDir).catch(() => null);
    if (!info?.isDirectory()) {
      throw new GitHubError(409, 'Workspace .git is missing or is not a regular directory');
    }
    if (
      await stat(join(gitDir, 'objects', 'info', 'alternates')).then(
        () => true,
        () => false,
      )
    ) {
      throw new GitHubError(409, 'Workspace repository uses alternates, which is not allowed');
    }
    const raw = await this.git(tmpdir(), [
      'config',
      '--file',
      join(gitDir, 'config'),
      '--list',
      '-z',
    ]);
    for (const entry of raw.split('\0').filter(Boolean)) {
      const key = entry.split('\n')[0]!.toLowerCase();
      if (!SAFE_CONFIG_KEYS.some((re) => re.test(key))) {
        throw new GitHubError(409, `Workspace git config contains a disallowed setting: ${key}`);
      }
    }
    return dir;
  }

  private async globalConfigPath(): Promise<string> {
    if (!this.dropPrivileges) {
      // Ownership checks would reject workspaces chowned to the sandbox user when running as root.
      this.globalConfig ??= join(this.dataDir, 'git-global.conf');
      await writeFile(this.globalConfig, '[safe]\n\tdirectory = *\n');
      return this.globalConfig;
    }
    return '/dev/null';
  }

  private async git(
    cwd: string,
    args: string[],
    opts: { account?: Account; timeoutMs?: number; failStatus?: number; failPrefix?: string } = {},
  ): Promise<string> {
    const { account } = opts;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: tmpdir(),
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: await this.globalConfigPath(),
      GIT_AUTHOR_NAME: account?.login ?? 'Pi-Panel',
      GIT_AUTHOR_EMAIL: account?.authorEmail ?? 'pi-panel@localhost',
    };
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME!;
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL!;
    if (account) {
      // Command-scope config: never written to disk, and only sent to the configured GitHub origin.
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = `http.${account.webBase}/.extraHeader`;
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${account.gitUser}:${account.token}`).toString('base64')}`;
    }
    const hardening = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'credential.helper=',
      '-c',
      'protocol.allow=never',
      ...(account?.protocols ?? this.allowProtocols).flatMap((p) => [
        '-c',
        `protocol.${p}.allow=always`,
      ]),
    ];
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const result = await runProcess('git', [...hardening, ...args], {
      cwd,
      env,
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...(this.dropPrivileges && root ? { uid: SANDBOX_UID, gid: SANDBOX_UID } : {}),
    });
    if (result.code !== 0) {
      const detail = redact(
        result.stderr.trim() || result.stdout.trim() || 'no output',
        account?.token,
        account?.gitUser,
      );
      const what = opts.failPrefix ?? `git ${args[0]} failed`;
      throw new GitHubError(opts.failStatus ?? 409, `${what}: ${detail.slice(0, 1000)}`);
    }
    return result.stdout;
  }

  private async api<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    forgejoBase?: string,
  ): Promise<T | undefined> {
    let res: Response;
    const github = this.kind === 'github';
    const apiBase = github ? this.apiBase : `${forgejoBase ?? ''}/api/v1`;
    try {
      res = await this.fetchFn(`${apiBase}${path}`, {
        method,
        headers: {
          accept: github ? 'application/vnd.github+json' : 'application/json',
          authorization: github ? `Bearer ${token}` : `token ${token}`,
          ...(github ? { 'x-github-api-version': '2022-11-28' } : {}),
          'user-agent': 'pi-panel',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubError(502, `Could not reach the ${this.label} API`);
    }
    const data = (await res.json().catch(() => undefined)) as
      (T & { message?: string; errors?: { message?: string }[] }) | undefined;
    if (!res.ok) {
      const detail = [data?.message, ...(data?.errors?.map((e) => e.message) ?? [])]
        .filter(Boolean)
        .join('; ');
      throw new GitHubError(
        502,
        redact(`${this.label} API ${res.status}${detail ? `: ${detail}` : ''}`, token),
      );
    }
    return data;
  }
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; uid?: number; gid?: number },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs,
      ...(opts.uid === undefined ? {} : { uid: opts.uid, gid: opts.gid }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += c.toString();
    });
    child.on('error', (err) =>
      reject(
        new GitHubError(
          500,
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'git is not installed on the panel host'
            : `Failed to run git: ${err.message}`,
        ),
      ),
    );
    child.on('close', (code) =>
      resolve({ code, stdout, stderr: code === null ? `${stderr}timed out` : stderr }),
    );
  });
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitHubError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerGitHub(
  app: FastifyInstance,
  gh: GitHubService,
  kind: ForgeKind = 'github',
) {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };
  const root = `/api/${kind}`;
  type AccountBody = { token?: unknown; baseUrl?: unknown };

  app.get(root, async () => gh.account());
  app.put(root, (req, reply) =>
    handle(reply, async () => {
      const b = (req.body ?? {}) as AccountBody;
      return { connected: true, ...(await gh.connect(b.token, b.baseUrl)) };
    }),
  );
  // Checks a token without saving it. Nothing is stored, and errors never echo the token.
  app.post(`${root}/test`, (req, reply) =>
    handle(reply, async () => {
      const b = (req.body ?? {}) as AccountBody;
      return gh.testToken(b.token, b.baseUrl);
    }),
  );
  app.delete(root, async (_req, reply) => {
    gh.disconnect();
    return reply.code(204).send();
  });

  app.get<P>(`/api/projects/:id/${kind}`, (req, reply) =>
    handle(reply, () => gh.status(id(req.params.id))),
  );
  app.post<P>(`/api/projects/:id/${kind}/clone`, (req, reply) =>
    handle(reply, () => {
      const { repo, branch } = (req.body ?? {}) as { repo?: unknown; branch?: unknown };
      return gh.clone(id(req.params.id), repo, branch);
    }),
  );
  app.post<P>(`/api/projects/:id/${kind}/push`, (req, reply) =>
    handle(reply, () => {
      const { branch, message } = (req.body ?? {}) as { branch?: unknown; message?: unknown };
      return gh.push(id(req.params.id), branch, message);
    }),
  );
  app.post<P>(`/api/projects/:id/${kind}/pr`, (req, reply) =>
    handle(reply, async () =>
      reply.code(201).send(await gh.pullRequest(id(req.params.id), (req.body ?? {}) as object)),
    ),
  );
}
