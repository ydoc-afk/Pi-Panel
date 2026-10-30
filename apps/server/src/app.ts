import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { DatabaseSync } from 'node:sqlite';
import { registerAuth } from './auth.js';
import { openDefaultDb } from './db.js';
import { DockerRuntime } from './docker-runtime.js';
import { GitHubService, registerGitHub, type GitHubOptions } from './github.js';
import multipart from '@fastify/multipart';
import { McpService, registerMcp, type McpOptions } from './mcp.js';
import { McpStore } from './mcp-store.js';
import { DEFAULT_LIMITS, SamplesService, registerSamples, type SampleLimits } from './samples.js';
import { SidecarManager, type SidecarOptions } from './sidecars.js';
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
  /** Overrides for managed MCP containers (tests). */
  sidecars?: SidecarOptions;
  /** Upload limits for samples (tests use small ones). */
  samples?: Partial<SampleLimits>;
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
  const limits = { ...DEFAULT_LIMITS, ...opts.samples };
  const samples = new SamplesService(db, dataDir, limits);
  const sidecars = new SidecarManager(db, mcpStore, runtime, dataDir, opts.sidecars);
  const sessions = new SessionManager(db, runtime, providers, dataDir, mcpStore, sidecars, samples);
  const mcp = new McpService(db, mcpStore, runtime, sessions, sidecars, opts.mcp);
  const lab = new LabService(db, runtime, dataDir, opts.lab);
  const packages = new PackageService(db, runtime, sessions, dataDir, {
    fetch: opts.fetch,
    ...opts.packages,
  });
  app.register(cookie);
  app.register(websocket);
  app.register(multipart, {
    limits: { fileSize: limits.maxFileBytes, files: 1, fields: 0, parts: 1 },
  });
  app.after(() => {
    registerAuth(app, db);
    registerProjects(app, {
      db,
      runtime,
      dataDir,
      beforeRemove: async (id) => {
        sessions.stopProject(id);
        await sidecars.removeProjectSidecars(id);
      },
      afterRemove: async (id) => {
        await sidecars.removeProjectNetwork(id);
        await samples.removeProject(id);
      },
    });
    registerProviders(app, providers);
    registerGitHub(app, github);
    registerPackages(app, packages);
    registerLab(app, lab);
    registerMcp(app, mcp);
    registerSamples(app, samples);
    registerSessions(app, sessions);
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  return app;
}
