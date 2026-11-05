import type { DatabaseSync } from 'node:sqlite';

export type RepoHost = 'github' | 'forgejo';

export interface RepoRow {
  id: number;
  projectId: number;
  host: RepoHost;
  repo: string;
  /** Relative to the workspace; '' is the workspace root. */
  folder: string;
  included: boolean;
}

interface Raw {
  id: number;
  project_id: number;
  host: string;
  repo: string;
  folder: string;
  included: number;
}

const toRow = (r: Raw): RepoRow => ({
  id: r.id,
  projectId: r.project_id,
  host: r.host === 'forgejo' ? 'forgejo' : 'github',
  repo: r.repo,
  folder: r.folder,
  included: r.included !== 0,
});

export function listRepos(db: DatabaseSync, projectId: number): RepoRow[] {
  return (
    db
      .prepare('SELECT * FROM project_repos WHERE project_id = ? ORDER BY id')
      .all(projectId) as unknown as Raw[]
  ).map(toRow);
}

/** projects.repo / repo_host mirror the first repository, so lists and the dashboard need no join. */
export function syncPrimary(db: DatabaseSync, projectId: number) {
  const first = listRepos(db, projectId)[0];
  db.prepare('UPDATE projects SET repo = ?, repo_host = ? WHERE id = ?').run(
    first?.repo ?? null,
    first && first.host === 'forgejo' ? 'forgejo' : null,
    projectId,
  );
}

export function addRepo(
  db: DatabaseSync,
  projectId: number,
  host: RepoHost,
  repo: string,
  folder: string,
): RepoRow {
  const info = db
    .prepare(
      'INSERT INTO project_repos (project_id, host, repo, folder, included, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .run(projectId, host, repo, folder, Date.now());
  syncPrimary(db, projectId);
  return listRepos(db, projectId).find((r) => r.id === Number(info.lastInsertRowid))!;
}

export function removeRepo(db: DatabaseSync, projectId: number, repoId: number): boolean {
  const info = db
    .prepare('DELETE FROM project_repos WHERE id = ? AND project_id = ?')
    .run(repoId, projectId);
  syncPrimary(db, projectId);
  return Number(info.changes) > 0;
}

export function setIncluded(
  db: DatabaseSync,
  projectId: number,
  repoId: number,
  included: boolean,
): boolean {
  const info = db
    .prepare('UPDATE project_repos SET included = ? WHERE id = ? AND project_id = ?')
    .run(included ? 1 : 0, repoId, projectId);
  return Number(info.changes) > 0;
}

/**
 * The folder a new repository is cloned into: its own name, made safe and unique among the
 * project's folders and whatever already sits at the top of the workspace.
 */
export function pickFolder(repo: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((f) => f.toLowerCase()));
  const name = repo.split('/').pop() ?? 'repo';
  let base = name
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '');
  if (!base || base.length > 80) base = base ? base.slice(0, 80) : 'repo';
  let folder = base;
  for (let n = 2; used.has(folder.toLowerCase()) || folder.toLowerCase() === '.git'; n++) {
    folder = `${base}-${n}`;
  }
  return folder;
}
