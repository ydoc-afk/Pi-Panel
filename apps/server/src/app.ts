import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { DatabaseSync } from 'node:sqlite';
import { registerAuth } from './auth.js';
import { openDefaultDb } from './db.js';
import { DockerRuntime } from './docker-runtime.js';
import { ProviderStore, registerProviders } from './providers.js';
import { registerProjects } from './projects.js';
import { Secrets } from './secrets.js';
import { SessionManager, registerSessions } from './sessions.js';
import { FakeRuntime, type ContainerRuntime } from './runtime.js';

export interface AppOptions {
  db?: DatabaseSync;
  runtime?: ContainerRuntime;
  dataDir?: string;
  /** Overrides fetch for provider model discovery (tests). */
  fetch?: typeof fetch;
}

/** PI_PANEL_RUNTIME=fake runs without Docker (UI development, demos). */
function defaultRuntime(): ContainerRuntime {
  return process.env.PI_PANEL_RUNTIME === 'fake' ? new FakeRuntime() : new DockerRuntime();
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const db = opts.db ?? openDefaultDb();
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? './data';
  const runtime = opts.runtime ?? defaultRuntime();
  const providers = new ProviderStore(db, new Secrets(dataDir), opts.fetch);
  const sessions = new SessionManager(db, runtime, providers, dataDir);
  app.register(cookie);
  app.register(websocket);
  app.after(() => {
    registerAuth(app, db);
    registerProjects(app, {
      db,
      runtime,
      dataDir,
      beforeRemove: (id) => sessions.stopProject(id),
    });
    registerProviders(app, providers);
    registerSessions(app, sessions);
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  return app;
}
