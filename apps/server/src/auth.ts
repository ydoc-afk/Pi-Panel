import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';

const COOKIE = 'pp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;

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

  function currentUser(req: FastifyRequest): { id: number; username: string } | null {
    const token = req.cookies[COOKIE];
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT u.id, u.username, s.expires_at FROM auth_sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as { id: number; username: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, username: row.username };
  }

  app.get('/api/auth/status', async (req) => ({
    setupRequired: userCount() === 0,
    user: currentUser(req),
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already completed' });
    const creds = parseCredentials(req.body);
    if (!creds || creds.username.length < 3 || creds.username.length > 64) {
      return reply.code(400).send({ error: 'Username must be 3-64 characters' });
    }
    if (creds.password.length < MIN_PASSWORD) {
      return reply
        .code(400)
        .send({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
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
    return reply
      .code(201)
      .send({ user: { id: Number(result.lastInsertRowid), username: creds.username } });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const creds = parseCredentials(req.body);
    if (!creds) return reply.code(400).send({ error: 'Username and password required' });
    const row = db
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(creds.username) as { id: number; username: string; password_hash: string } | undefined;
    const ok = row ? await verify(row.password_hash, creds.password) : false;
    if (!row || !ok) return reply.code(401).send({ error: 'Invalid username or password' });
    startSession(reply, row.id);
    return { user: { id: row.id, username: row.username } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Guard for all other /api routes (health and auth endpoints stay public).
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || path === '/api/health' || path.startsWith('/api/auth/'))
      return;
    if (!currentUser(req)) return reply.code(401).send({ error: 'Authentication required' });
  });
}
