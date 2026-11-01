import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { schemaVersion } from './db.js';
import type { DatabaseSync } from 'node:sqlite';

/** The token file the updater creates in the shared data directory (see updater-main.ts). */
const TOKEN_FILE = join('updater', 'token');

export interface UpdatesOptions {
  db: DatabaseSync;
  dataDir: string;
  /** Where the updater listens on the compose network. */
  updaterUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Admin routes for the Updates page. The panel never changes itself: it forwards requests to the
 * updater container, which can rebuild and restart it. All of these live under /api/admin, so
 * members are refused before they get here.
 */
export function registerUpdates(app: FastifyInstance, opts: UpdatesOptions) {
  const base = (
    opts.updaterUrl ??
    process.env.PI_PANEL_UPDATER_URL ??
    'http://updater:8080'
  ).replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;

  async function token(): Promise<string | null> {
    try {
      return (await readFile(join(opts.dataDir, TOKEN_FILE), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }

  /** Calls the updater; answers 503 with a reason when it is not set up or not reachable. */
  async function forward(
    reply: FastifyReply,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ) {
    const t = await token();
    if (!t) return reply.code(503).send({ error: 'The updater is not set up', configured: false });
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${t}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return reply.code(503).send({ error: 'The updater did not answer', configured: true });
    }
    const data = (await res
      .json()
      .catch(() => ({ error: 'Bad answer from the updater' }))) as unknown;
    return reply.code(res.status).send(data);
  }

  /** What this panel is running: the commit its image was built from, and the database schema. */
  app.get('/api/admin/updates/running', async () => ({
    commit: process.env.PI_PANEL_COMMIT || null,
    schema: schemaVersion(opts.db),
    configured: (await token()) !== null,
  }));

  app.get('/api/admin/updates/status', (_req, reply) => forward(reply, 'GET', '/status'));
  // Fetching from the remote can take a while on a slow link.
  app.post('/api/admin/updates/check', (_req, reply) =>
    forward(reply, 'POST', '/check', {}, 60_000),
  );
  app.post('/api/admin/updates/apply', (req, reply) => {
    const { branch, sha } = (req.body ?? {}) as { branch?: unknown; sha?: unknown };
    if (typeof branch !== 'string' || typeof sha !== 'string') {
      return reply.code(400).send({ error: 'branch and sha are required' });
    }
    return forward(reply, 'POST', '/update', { branch, sha }, 60_000);
  });
  app.post('/api/admin/updates/rollback', (_req, reply) =>
    forward(reply, 'POST', '/rollback', {}, 30_000),
  );
  app.get<{ Querystring: { after?: string } }>('/api/admin/updates/job', (req, reply) => {
    const after = /^\d+$/.test(req.query.after ?? '') ? req.query.after : '0';
    return forward(reply, 'GET', `/job?after=${after}`);
  });
}
