import { chmod, chown, mkdir, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { agentDir, workspaceDir } from './paths.js';
import type { ContainerRuntime } from './runtime.js';

interface ProjectRow {
  id: number;
  name: string;
  container_id: string | null;
  status: string;
  created_at: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SANDBOX_UID = 1000;

const toDto = (r: ProjectRow) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
});

export function registerProjects(
  app: FastifyInstance,
  deps: {
    db: DatabaseSync;
    runtime: ContainerRuntime;
    dataDir: string;
    /** Called before a project's container is removed, e.g. to stop its running sessions. */
    beforeRemove?: (projectId: number) => void;
  },
) {
  const { db, runtime } = deps;
  const workspaceFor = (id: number) => workspaceDir(deps.dataDir, id);
  const agentFor = (id: number) => agentDir(deps.dataDir, id);
  const find = (id: number) =>
    db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;

  app.get('/api/projects', async () => ({
    projects: (
      db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as ProjectRow[]
    ).map(toDto),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const row = find(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    return { project: toDto(row) };
  });

  app.post('/api/projects', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: unknown };
    if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
      return reply.code(400).send({
        error: 'Name must be 1-64 characters: letters, digits, spaces, dots, dashes, underscores',
      });
    }
    const clean = name.trim();
    if (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(clean)) {
      return reply.code(409).send({ error: 'A project with that name already exists' });
    }

    const id = Number(
      db
        .prepare('INSERT INTO projects (name, status, created_at) VALUES (?, ?, ?)')
        .run(clean, 'creating', Date.now()).lastInsertRowid,
    );
    const workspacePath = workspaceFor(id);
    try {
      for (const dir of [workspacePath, agentFor(id)]) {
        await mkdir(dir, { recursive: true });
        // The sandbox user needs write access; fall back to open permissions when we cannot chown.
        await chown(dir, SANDBOX_UID, SANDBOX_UID).catch(() => chmod(dir, 0o777));
      }
      const containerId = await runtime.createAndStart({
        projectId: id,
        workspacePath,
        agentDir: agentFor(id),
      });
      db.prepare('UPDATE projects SET container_id = ?, status = ? WHERE id = ?').run(
        containerId,
        'running',
        id,
      );
    } catch (err) {
      req.log.error({ err }, 'project creation failed');
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      await rm(workspacePath, { recursive: true, force: true });
      await rm(agentFor(id), { recursive: true, force: true });
      return reply.code(500).send({ error: 'Failed to create project container' });
    }
    return reply.code(201).send({ project: toDto(find(id)!) });
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = find(id);
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    deps.beforeRemove?.(id);
    try {
      if (row.container_id) await runtime.remove(row.container_id);
    } catch (err) {
      // Keep the row so the user can retry; do not orphan a running container.
      req.log.error({ err }, 'container removal failed');
      return reply.code(502).send({ error: 'Failed to remove project container' });
    }
    await rm(workspaceFor(id), { recursive: true, force: true });
    await rm(agentFor(id), { recursive: true, force: true });
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return reply.code(204).send();
  });
}
