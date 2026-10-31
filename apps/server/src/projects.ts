import { chmod, chown, mkdir, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { SANDBOX_UID, agentDir, workspaceDir } from './paths.js';
import type { ContainerRuntime } from './runtime.js';

interface ProjectRow {
  id: number;
  name: string;
  container_id: string | null;
  status: string;
  repo: string | null;
  created_at: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const toDto = (r: ProjectRow) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  repo: r.repo,
  createdAt: r.created_at,
});

export function registerProjects(
  app: FastifyInstance,
  deps: {
    db: DatabaseSync;
    runtime: ContainerRuntime;
    dataDir: string;
    /** Called before a project's container is removed, e.g. to stop its running sessions. */
    beforeRemove?: (projectId: number) => void | Promise<void>;
    /** Called after the project container is gone, e.g. to remove its private network. */
    afterRemove?: (projectId: number) => void | Promise<void>;
    /** Called before a container is restarted or replaced; running pi processes die with it. */
    beforeRestart?: (projectId: number) => void | Promise<void>;
  },
) {
  const { db, runtime } = deps;
  const workspaceFor = (id: number) => workspaceDir(deps.dataDir, id);
  const agentFor = (id: number) => agentDir(deps.dataDir, id);
  const find = (id: number) =>
    db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;

  /**
   * Brings a project's status in line with its container: Docker may have stopped it (host reboot,
   * OOM) or someone may have removed it by hand, and the stored status would otherwise still say
   * "running" while every session failed to start.
   */
  async function reconcile(row: ProjectRow): Promise<ProjectRow> {
    if (!row.container_id || row.status === 'creating') return row;
    let status: string;
    try {
      const state = await runtime.containerState(row.container_id);
      status = state === 'running' ? 'running' : state === 'exited' ? 'stopped' : 'missing';
    } catch {
      return row; // Docker unreachable: keep what we know
    }
    if (status !== row.status) {
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, row.id);
      return { ...row, status };
    }
    return row;
  }

  app.get('/api/projects', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as ProjectRow[];
    return { projects: (await Promise.all(rows.map(reconcile))).map(toDto) };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const row = find(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    return { project: toDto(await reconcile(row)) };
  });

  async function createContainer(id: number): Promise<string> {
    return runtime.createAndStart({
      projectId: id,
      workspacePath: workspaceFor(id),
      agentDir: agentFor(id),
    });
  }

  // Starts a stopped container, or makes a new one if it has gone missing.
  app.post<{ Params: { id: string } }>('/api/projects/:id/restart', async (req, reply) => {
    const id = Number(req.params.id);
    const row = find(id);
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    const current = await reconcile(row);
    if (current.status === 'running') return { project: toDto(current) };
    await deps.beforeRestart?.(id);
    try {
      if (current.container_id && current.status === 'stopped') {
        await runtime.start(current.container_id);
      } else {
        const containerId = await createContainer(id);
        db.prepare('UPDATE projects SET container_id = ? WHERE id = ?').run(containerId, id);
      }
    } catch (err) {
      req.log.error({ err }, 'project restart failed');
      return reply.code(502).send({ error: 'Failed to start the project container' });
    }
    db.prepare("UPDATE projects SET status = 'running' WHERE id = ?").run(id);
    return { project: toDto(find(id)!) };
  });

  /**
   * Replaces the container with a fresh one from the current sandbox image (e.g. after upgrading
   * pi). The workspace and pi's agent dir are bind mounts, so files and session history are kept;
   * anything installed inside the old container outside those is not.
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/recreate', async (req, reply) => {
    const id = Number(req.params.id);
    const row = find(id);
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    await deps.beforeRestart?.(id);
    try {
      if (row.container_id) await runtime.remove(row.container_id);
    } catch (err) {
      req.log.error({ err }, 'container removal failed');
      return reply.code(502).send({ error: 'Failed to remove the old container' });
    }
    db.prepare("UPDATE projects SET container_id = NULL, status = 'missing' WHERE id = ?").run(id);
    try {
      const containerId = await createContainer(id);
      db.prepare("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
        containerId,
        id,
      );
    } catch (err) {
      req.log.error({ err }, 'project recreate failed');
      return reply.code(502).send({ error: 'Failed to create the new container' });
    }
    return { project: toDto(find(id)!) };
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
      const containerId = await createContainer(id);
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
    await deps.beforeRemove?.(id);
    try {
      if (row.container_id) await runtime.remove(row.container_id);
    } catch (err) {
      // Keep the row so the user can retry; do not orphan a running container.
      req.log.error({ err }, 'container removal failed');
      return reply.code(502).send({ error: 'Failed to remove project container' });
    }
    await deps.afterRemove?.(id);
    await rm(workspaceFor(id), { recursive: true, force: true });
    await rm(agentFor(id), { recursive: true, force: true });
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return reply.code(204).send();
  });
}
