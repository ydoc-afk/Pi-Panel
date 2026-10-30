import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { DatabaseSync } from 'node:sqlite';
import { registerAuth } from './auth.js';
import { openDefaultDb } from './db.js';
import { DockerRuntime } from './docker-runtime.js';
import { GitHubService, registerGitHub, type GitHubOptions } from './github.js';
import { McpService, registerMcp, type McpOptions } from './mcp.js';
import { McpStore } from './mcp-store.js';
import { LabService, registerLab, type LabOptions } from './lab.js';
import { PackageService, registerPackages, type PackageOptions } from './packages.js';
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
  /** Overrides for the GitHub service (tests point it at local repositories). */
  github?: GitHubOptions;
  /** Overrides for package review (tests). */
  packages?: PackageOptions;
  /** Overrides for the package lab (tests). */
  lab?: LabOptions;
  /** Overrides for MCP discovery (tests). */
  mcp?: McpOptions;
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
  const secrets = new Secrets(dataDir);
  const providers = new ProviderStore(db, secrets, opts.fetch);
  const github = new GitHubService(db, secrets, dataDir, { fetch: opts.fetch, ...opts.github });
  const mcpStore = new McpStore(db, secrets);
  const sessions = new SessionManager(db, runtime, providers, dataDir, mcpStore);
  const mcp = new McpService(db, mcpStore, runtime, sessions, opts.mcp);
  const lab = new LabService(db, runtime, dataDir, opts.lab);
  const packages = new PackageService(db, runtime, sessions, dataDir, {
    fetch: opts.fetch,
    ...opts.packages,
  });
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
    registerGitHub(app, github);
    registerPackages(app, packages);
    registerLab(app, lab);
    registerMcp(app, mcp);
    registerSessions(app, sessions);
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  return app;
}
