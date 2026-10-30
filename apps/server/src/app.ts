import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { DatabaseSync } from 'node:sqlite';
import { registerAuth } from './auth.js';
import { openDefaultDb } from './db.js';

export function buildApp(opts: { db?: DatabaseSync } = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const db = opts.db ?? openDefaultDb();
  app.register(cookie);
  app.after(() => registerAuth(app, db));
  app.get('/api/health', async () => ({ status: 'ok' }));
  return app;
}
