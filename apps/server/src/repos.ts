import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { GitHubError, type GitHubService } from './github.js';
import { listRepos, removeRepo, setIncluded, type RepoHost, type RepoRow } from './repo-store.js';

export interface RepoView {
  id: number;
  host: RepoHost;
  repo: string;
  /** Where it is inside the sandbox. */
  path: string;
  included: boolean;
  branch: string | null;
  changes: number;
  /** Commits the remote does not have; null when it could not be asked. */
  ahead: number | null;
  error?: string;
}

export interface BulkResult {
  id: number;
  repo: string;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

const sandboxPath = (folder: string) => (folder === '' ? '/workspace' : `/workspace/${folder}`);

/**
 * The project's repositories across both forges. Each repository belongs to one forge's service; this
 * picks the right one, and decides which repositories "pull all", "push all" and the agent's push
 * and pull request tools may touch: the ones that are included.
 */
export class RepoService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly services: Record<RepoHost, GitHubService>,
  ) {}

  private svc(host: RepoHost) {
    return this.services[host];
  }

  private requireProject(projectId: number) {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      throw new GitHubError(404, 'Project not found');
    }
  }

  private find(projectId: number, repoId: number): RepoRow {
    this.requireProject(projectId);
    const row = listRepos(this.db, projectId).find((r) => r.id === repoId);
    if (!row) throw new GitHubError(404, 'Repository not found in this project');
    return row;
  }

  async list(projectId: number) {
    this.requireProject(projectId);
    const rows = listRepos(this.db, projectId);
    const repos: RepoView[] = [];
    for (const row of rows) {
      const view: RepoView = {
        id: row.id,
        host: row.host,
        repo: row.repo,
        path: sandboxPath(row.folder),
        included: row.included,
        branch: null,
        changes: 0,
        ahead: null,
      };
      try {
        Object.assign(view, await this.svc(row.host).statusOf(projectId, row));
      } catch (err) {
        view.error = err instanceof Error ? err.message : 'Could not read this repository';
      }
      repos.push(view);
    }
    return {
      repos,
      accounts: {
        github: this.svc('github').account().connected,
        forgejo: this.svc('forgejo').account().connected,
      },
    };
  }

  async add(projectId: number, host: unknown, repo: unknown, branch?: unknown) {
    if (host !== 'github' && host !== 'forgejo') {
      throw new GitHubError(400, 'host must be github or forgejo');
    }
    const row = await this.svc(host).cloneRepo(projectId, repo, branch);
    return { id: row.id, host, repo: row.repo, path: sandboxPath(row.folder), branch: row.branch };
  }

  setIncluded(projectId: number, repoId: number, included: unknown) {
    this.find(projectId, repoId);
    if (typeof included !== 'boolean') throw new GitHubError(400, 'included must be true or false');
    setIncluded(this.db, projectId, repoId, included);
    return { id: repoId, included };
  }

  /** Forgets the repository; its files stay in the workspace. */
  remove(projectId: number, repoId: number) {
    this.find(projectId, repoId);
    removeRepo(this.db, projectId, repoId);
  }

  push(projectId: number, repoId: number, branch: unknown, message?: unknown) {
    const row = this.find(projectId, repoId);
    return this.svc(row.host).pushRepo(projectId, row, branch, message);
  }

  pullRequest(projectId: number, repoId: number, input: object) {
    const row = this.find(projectId, repoId);
    return this.svc(row.host).pullRequestFor(projectId, row, input);
  }

  pull(projectId: number, repoId: number) {
    const row = this.find(projectId, repoId);
    return this.svc(row.host).pullRepo(projectId, row);
  }

  /** Pulls every included repository. One failing does not stop the others. */
  async pullAll(projectId: number): Promise<BulkResult[]> {
    return this.eachIncluded(projectId, (row) => this.svc(row.host).pullRepo(projectId, row));
  }

  /** Commits and pushes the current branch of every included repository. */
  async pushAll(projectId: number, message?: unknown): Promise<BulkResult[]> {
    return this.eachIncluded(projectId, async (row) => {
      const { branch } = await this.svc(row.host).statusOf(projectId, row);
      if (!branch) throw new GitHubError(409, 'The repository is not on a branch');
      return this.svc(row.host).pushRepo(projectId, row, branch, message);
    });
  }

  private async eachIncluded(projectId: number, fn: (row: RepoRow) => Promise<object>) {
    this.requireProject(projectId);
    const out: BulkResult[] = [];
    for (const row of listRepos(this.db, projectId).filter((r) => r.included)) {
      try {
        out.push({ id: row.id, repo: row.repo, ok: true, ...(await fn(row)) });
      } catch (err) {
        out.push({
          id: row.id,
          repo: row.repo,
          ok: false,
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }
    return out;
  }

  /**
   * The repository an agent's push or pull request request means: the one it names, or the only
   * included one. Throws a message the agent can act on.
   */
  resolveForAgent(projectId: number, name?: string): RepoRow {
    const rows = listRepos(this.db, projectId);
    if (rows.length === 0) {
      throw new GitHubError(409, 'This project is not linked to a GitHub or Forgejo repository.');
    }
    const list = (rs: RepoRow[]) => rs.map((r) => r.repo).join(', ');
    if (name) {
      const row = rows.find((r) => r.repo.toLowerCase() === name.toLowerCase());
      if (!row) {
        throw new GitHubError(409, `No repository named ${name} in this project (${list(rows)}).`);
      }
      if (!row.included) {
        throw new GitHubError(
          409,
          `${row.repo} is not included in pushes. Ask the user to tick it in the Repository tab.`,
        );
      }
      return row;
    }
    const included = rows.filter((r) => r.included);
    if (included.length === 0) {
      throw new GitHubError(
        409,
        'No repository in this project is included in pushes. Ask the user to tick one in the Repository tab.',
      );
    }
    if (included.length > 1) {
      throw new GitHubError(
        409,
        `Several repositories are included (${list(included)}). Name one with the repo argument.`,
      );
    }
    return included[0]!;
  }

  /** What the agent is told about, and what its push tools see. */
  forgeLink(projectId: number, name?: string) {
    const row = this.resolveForAgent(projectId, name);
    return {
      forge: row.host === 'forgejo' ? ('Forgejo' as const) : ('GitHub' as const),
      repo: row.repo,
    };
  }

  agentPush(projectId: number, request: { repo?: string; branch: string; message?: string }) {
    const row = this.resolveForAgent(projectId, request.repo);
    return this.svc(row.host).pushRepo(projectId, row, request.branch, request.message);
  }

  agentPullRequest(
    projectId: number,
    request: { repo?: string; head: string; title: string; body?: string; base?: string },
  ) {
    const row = this.resolveForAgent(projectId, request.repo);
    return this.svc(row.host).pullRequestFor(projectId, row, request);
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitHubError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerRepos(app: FastifyInstance, repos: RepoService) {
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };
  type R = { Params: { id: string; rid: string } };
  const base = '/api/projects/:id/repos';

  app.get<P>(base, (req, reply) => handle(reply, () => repos.list(num(req.params.id))));
  app.post<P>(base, (req, reply) =>
    handle(reply, async () => {
      const b = (req.body ?? {}) as { host?: unknown; repo?: unknown; branch?: unknown };
      return reply.code(201).send(await repos.add(num(req.params.id), b.host, b.repo, b.branch));
    }),
  );
  // Pull or push every included repository; results are per repository.
  app.post<P>(`${base}/pull`, (req, reply) =>
    handle(reply, async () => ({ results: await repos.pullAll(num(req.params.id)) })),
  );
  app.post<P>(`${base}/push`, (req, reply) =>
    handle(reply, async () => {
      const { message } = (req.body ?? {}) as { message?: unknown };
      return { results: await repos.pushAll(num(req.params.id), message) };
    }),
  );
  app.patch<R>(`${base}/:rid`, (req, reply) =>
    handle(reply, () => {
      const { included } = (req.body ?? {}) as { included?: unknown };
      return repos.setIncluded(num(req.params.id), num(req.params.rid), included);
    }),
  );
  app.delete<R>(`${base}/:rid`, (req, reply) =>
    handle(reply, () => {
      repos.remove(num(req.params.id), num(req.params.rid));
      return reply.code(204).send();
    }),
  );
  app.post<R>(`${base}/:rid/pull`, (req, reply) =>
    handle(reply, () => repos.pull(num(req.params.id), num(req.params.rid))),
  );
  app.post<R>(`${base}/:rid/push`, (req, reply) =>
    handle(reply, () => {
      const { branch, message } = (req.body ?? {}) as { branch?: unknown; message?: unknown };
      return repos.push(num(req.params.id), num(req.params.rid), branch, message);
    }),
  );
  app.post<R>(`${base}/:rid/pr`, (req, reply) =>
    handle(reply, async () =>
      reply
        .code(201)
        .send(
          await repos.pullRequest(
            num(req.params.id),
            num(req.params.rid),
            (req.body ?? {}) as object,
          ),
        ),
    ),
  );
}
