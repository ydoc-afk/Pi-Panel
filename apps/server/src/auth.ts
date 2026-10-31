import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';

const COOKIE = 'pp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;
/** Caps open registrations so the public form cannot be used to fill the database. */
const MAX_PENDING = 50;

export type Role = 'admin' | 'member';
export type AccountStatus = 'pending' | 'approved' | 'rejected';
export interface SessionUser {
  id: number;
  username: string;
  role: Role;
}

/**
 * What an approved member may not do: anything that changes or spends the admin's credentials and
 * shared configuration (providers, the GitHub account, the MCP library, the REA image build) or
 * pushes under the admin's GitHub identity. Members work in projects and sessions.
 *
 * `path` should be the matched route pattern (`/api/projects/:id/github/push`), not the raw URL:
 * the router decodes percent-escapes, so `/api/%70roviders` reaches the providers routes while a
 * raw-string comparison would not recognise it.
 */
export function memberBlocked(method: string, path: string): boolean {
  if (path.startsWith('/api/admin/')) return true;
  if (/^\/api\/projects\/[^/]+\/github\/(clone|push|pr)$/.test(path)) return true;
  if (method === 'GET' || method === 'HEAD') {
    return path === '/api/mcp/registry' || path === '/api/rea/log';
  }
  return (
    path === '/api/github' ||
    path.startsWith('/api/github/') ||
    path.startsWith('/api/providers') ||
    path.startsWith('/api/mcp/servers') ||
    path === '/api/mcp/import' ||
    path === '/api/rea/build'
  );
}

interface Credentials {
  username?: unknown;
  password?: unknown;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function parseCredentials(body: unknown): { username: string; password: string } | null {
  const { username, password } = (body ?? {}) as Credentials;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  return { username: username.trim(), password };
}

function credentialsError(creds: { username: string; password: string } | null): string {
  if (!creds || creds.username.length < 3 || creds.username.length > 64) {
    return 'Username must be 3-64 characters';
  }
  if (creds.password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }
  return '';
}

/**
 * The path used for access decisions: the route pattern when a route matched, otherwise the decoded
 * URL path (an unmatched request still needs a signed-in user, then gets a 404).
 */
export function routePath(req: FastifyRequest): string {
  // The not-found handler matches as "*"; only real API route patterns are used.
  const pattern = req.routeOptions?.url;
  if (pattern?.startsWith('/api/')) return pattern;
  const raw = req.url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function registerAuth(app: FastifyInstance, db: DatabaseSync) {
  const secure = process.env.COOKIE_SECURE === 'true';

  const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

  function startSession(reply: FastifyReply, userId: number) {
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + SESSION_TTL_MS;
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      sha256(token),
      userId,
      expires,
    );
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      expires: new Date(expires),
    });
  }

  function currentUser(req: FastifyRequest): SessionUser | null {
    const token = req.cookies[COOKIE];
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.status, s.expires_at FROM auth_sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as
      | { id: number; username: string; role: Role; status: AccountStatus; expires_at: number }
      | undefined;
    // A session stops working the moment its account is no longer approved.
    if (!row || row.expires_at < Date.now() || row.status !== 'approved') return null;
    return { id: row.id, username: row.username, role: row.role };
  }

  app.get('/api/auth/status', async (req) => ({
    setupRequired: userCount() === 0,
    user: currentUser(req),
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already completed' });
    const creds = parseCredentials(req.body);
    const invalid = credentialsError(creds);
    if (!creds || invalid) return reply.code(400).send({ error: invalid });
    const passwordHash = await hash(creds.password);
    // Insert only while the table is empty so concurrent setup requests cannot create two admins.
    const result = db
      .prepare(
        `INSERT INTO users (username, password_hash, created_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .run(creds.username, passwordHash, Date.now());
    if (result.changes === 0) return reply.code(409).send({ error: 'Setup already completed' });
    startSession(reply, Number(result.lastInsertRowid));
    return reply.code(201).send({
      user: { id: Number(result.lastInsertRowid), username: creds.username, role: 'admin' },
    });
  });

  // Anyone can ask for an account; it cannot be used until the admin approves it.
  app.post('/api/auth/register', async (req, reply) => {
    if (userCount() === 0) return reply.code(409).send({ error: 'Create the admin account first' });
    const creds = parseCredentials(req.body);
    const invalid = credentialsError(creds);
    if (!creds || invalid) return reply.code(400).send({ error: invalid });
    const pending = (
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").get() as { n: number }
    ).n;
    if (pending >= MAX_PENDING) {
      return reply
        .code(429)
        .send({ error: 'Too many registrations are waiting. Ask the admin to review them.' });
    }
    const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(creds.username);
    if (taken) return reply.code(409).send({ error: 'That username is taken' });
    const passwordHash = await hash(creds.password);
    try {
      db.prepare(
        `INSERT INTO users (username, password_hash, created_at, role, status)
         VALUES (?, ?, ?, 'member', 'pending')`,
      ).run(creds.username, passwordHash, Date.now());
    } catch {
      return reply.code(409).send({ error: 'That username is taken' });
    }
    return reply.code(202).send({ pending: true });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const creds = parseCredentials(req.body);
    if (!creds) return reply.code(400).send({ error: 'Username and password required' });
    const row = db
      .prepare('SELECT id, username, password_hash, role, status FROM users WHERE username = ?')
      .get(creds.username) as
      | { id: number; username: string; password_hash: string; role: Role; status: AccountStatus }
      | undefined;
    const ok = row ? await verify(row.password_hash, creds.password) : false;
    if (!row || !ok) return reply.code(401).send({ error: 'Invalid username or password' });
    // The status is only revealed to someone who knows the password.
    if (row.status === 'pending') {
      return reply.code(403).send({ error: 'Your account is waiting for the admin to approve it' });
    }
    if (row.status === 'rejected') {
      return reply.code(403).send({ error: 'Your registration was declined by the admin' });
    }
    startSession(reply, row.id);
    return { user: { id: row.id, username: row.username, role: row.role } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  const adminOnly = (req: FastifyRequest, reply: FastifyReply) => {
    if (currentUser(req)?.role !== 'admin') {
      reply.code(403).send({ error: 'Admin only' });
      return false;
    }
    return true;
  };

  app.get('/api/admin/users', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    return db
      .prepare(
        `SELECT id, username, role, status, created_at AS createdAt FROM users
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
      )
      .all();
  });

  for (const [action, status] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/admin/users/:id/${action}`, async (req, reply) => {
      if (!adminOnly(req, reply)) return;
      const id = Number(req.params.id);
      const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as
        { role: Role } | undefined;
      if (!target) return reply.code(404).send({ error: 'No such user' });
      if (target.role === 'admin') {
        return reply.code(400).send({ error: 'The admin account cannot be changed here' });
      }
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
      // Rejecting someone who was already approved also ends any sign-in they have open.
      if (status === 'rejected') db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
      return { ok: true };
    });
  }

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const id = Number(req.params.id);
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as
      { role: Role } | undefined;
    if (!target) return reply.code(404).send({ error: 'No such user' });
    if (target.role === 'admin') {
      return reply.code(400).send({ error: 'The admin account cannot be removed' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  // Guard for all other /api routes (health and auth endpoints stay public).
  app.addHook('onRequest', async (req, reply) => {
    const path = routePath(req);
    if (!path.startsWith('/api/') || path === '/api/health' || path.startsWith('/api/auth/'))
      return;
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });
    if (user.role !== 'admin' && memberBlocked(req.method, path)) {
      return reply.code(403).send({ error: 'Only the admin can do that' });
    }
  });
}
