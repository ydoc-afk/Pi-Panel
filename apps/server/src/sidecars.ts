import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { McpError, networkName, sidecarAlias, sidecarName, type McpStore } from './mcp-store.js';
import { samplesDir } from './paths.js';
import type { ContainerRuntime, SidecarSpec } from './runtime.js';

export interface SidecarOptions {
  /** How long to wait for a new container to announce it is ready. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

export interface SidecarStatus {
  state: 'stopped' | 'running' | 'exited' | 'missing';
  exitCode: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function redact(text: string, values: string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join('***');
  return out;
}

/**
 * Runs MCP servers that speak streamable HTTP in their own containers. Each project gets a private
 * internal network (no route to the internet); the session container and the servers join it, so the
 * agent can call the server's tools but never sees its credentials or its files.
 */
export class SidecarManager {
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly store: McpStore,
    private readonly runtime: ContainerRuntime,
    private readonly dataDir: string,
    opts: SidecarOptions = {},
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
    this.pollMs = opts.pollMs ?? 500;
  }

  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(key, run);
    return run.finally(() => {
      if (this.locks.get(key) === run) this.locks.delete(key);
    });
  }

  private sessionContainer(projectId: number): string {
    const row = this.db.prepare('SELECT container_id FROM projects WHERE id = ?').get(projectId) as
      { container_id: string | null } | undefined;
    if (!row) throw new McpError(404, 'Project not found');
    if (!row.container_id) throw new McpError(409, 'The project container is not running');
    return row.container_id;
  }

  private spec(
    serverId: number,
    projectId: number | null,
    names: { name: string; network: string },
    withSamples: boolean,
  ): SidecarSpec {
    const s = this.store.sidecarSpecFor(serverId);
    return {
      name: names.name,
      image: s.image,
      cmd: s.cmd,
      env: s.env,
      network: names.network,
      alias: sidecarAlias(serverId),
      mounts:
        s.mountSamples && withSamples && projectId !== null
          ? [{ source: samplesDir(this.dataDir, projectId), target: '/samples', readOnly: true }]
          : [],
      memoryMb: s.memoryMb,
      labels: {
        'pi-panel.sidecar': '1',
        ...(projectId === null ? {} : { 'pi-panel.project': String(projectId) }),
      },
    };
  }

  /** Waits until the container says it is listening (or, with no marker, has stayed up briefly). */
  private async waitReady(id: string, readyLog: string | null, secrets: string[]) {
    const started = Date.now();
    for (;;) {
      const state = await this.runtime.sidecarState(id);
      const logs = redact(await this.runtime.sidecarLogs(id, 200), secrets);
      if (state.state !== 'running') {
        throw new McpError(
          502,
          `The container stopped${state.exitCode === null ? '' : ` (exit code ${state.exitCode})`}. ${logs.trim().slice(-800)}`,
        );
      }
      if (readyLog ? logs.includes(readyLog) : Date.now() - started >= 2000) return;
      if (Date.now() - started > this.readyTimeoutMs) {
        throw new McpError(
          504,
          `Not ready after ${Math.round(this.readyTimeoutMs / 1000)} s. ${logs.trim().slice(-800)}`,
        );
      }
      await sleep(this.pollMs);
    }
  }

  private async startInner(projectId: number, serverId: number): Promise<SidecarStatus> {
    const server = this.store.get(serverId);
    if (server.type !== 'managed')
      throw new McpError(400, 'That server is not a managed container');
    const sessionContainer = this.sessionContainer(projectId);
    const net = networkName(projectId);
    const spec = this.spec(
      serverId,
      projectId,
      { name: sidecarName(projectId, serverId), network: net },
      true,
    );
    const secrets = this.store.sidecarSpecFor(serverId).secretValues;
    await this.runtime.ensureNetwork(net, { internal: true });
    await this.runtime.connectNetwork(sessionContainer, net);
    if (spec.mounts.length > 0)
      await mkdir(samplesDir(this.dataDir, projectId), { recursive: true, mode: 0o755 });
    let id: string;
    try {
      id = await this.runtime.startSidecar(spec);
    } catch {
      throw new McpError(
        502,
        `Failed to start the container. Is the image "${spec.image}" built on this machine?`,
      );
    }
    this.store.setContainerId(projectId, serverId, id);
    try {
      await this.waitReady(id, this.store.sidecarSpecFor(serverId).readyLog, secrets);
    } catch (err) {
      // Do not leave a container that never became ready (and may be restarting) running.
      await this.runtime.removeSidecar(id).catch(() => undefined);
      this.store.setContainerId(projectId, serverId, null);
      throw err;
    }
    return { state: 'running', exitCode: null };
  }

  start(projectId: number, serverId: number): Promise<SidecarStatus> {
    return this.exclusive(`${projectId}:${serverId}`, () => this.startInner(projectId, serverId));
  }

  async stop(projectId: number, serverId: number): Promise<void> {
    return this.exclusive(`${projectId}:${serverId}`, async () => {
      const id = this.store.containerId(projectId, serverId);
      if (!id) return;
      await this.runtime.removeSidecar(id);
      this.store.setContainerId(projectId, serverId, null);
    });
  }

  async status(projectId: number, serverId: number): Promise<SidecarStatus> {
    const id = this.store.containerId(projectId, serverId);
    if (!id) return { state: 'stopped', exitCode: null };
    const st = await this.runtime.sidecarState(id);
    if (st.state === 'missing') {
      this.store.setContainerId(projectId, serverId, null);
      return { state: 'missing', exitCode: null };
    }
    return st;
  }

  async logs(projectId: number, serverId: number, tail: number): Promise<string> {
    const id = this.store.containerId(projectId, serverId);
    if (!id) return '';
    const secrets = this.store.sidecarSpecFor(serverId).secretValues;
    return redact(await this.runtime.sidecarLogs(id, Math.max(1, Math.min(tail, 500))), secrets);
  }

  /**
   * Called before a session starts: makes sure the project network exists, the session container is on
   * it, and every enabled managed server is running. A server that cannot start is reported, not fatal.
   */
  async ensureForProject(
    projectId: number,
  ): Promise<{ failed: { server: string; error: string }[] }> {
    const failed: { server: string; error: string }[] = [];
    for (const { server, containerId } of this.store.managedFor(projectId)) {
      try {
        await this.exclusive(`${projectId}:${server.id}`, async () => {
          const sessionContainer = this.sessionContainer(projectId);
          const net = networkName(projectId);
          await this.runtime.ensureNetwork(net, { internal: true });
          await this.runtime.connectNetwork(sessionContainer, net);
          const state = containerId
            ? await this.runtime.sidecarState(containerId)
            : { state: 'missing' as const };
          if (state.state !== 'running') await this.startInner(projectId, server.id);
        });
      } catch (err) {
        failed.push({
          server: server.name,
          error: err instanceof Error ? err.message : 'failed to start',
        });
      }
    }
    return { failed };
  }

  /** Stops every managed server a project runs. Call before removing the project container. */
  async removeProjectSidecars(projectId: number): Promise<void> {
    for (const r of this.store.recordedContainers({ projectId })) {
      await this.stop(r.projectId, r.serverId);
    }
  }

  /** Removes the project's private network. Call after the project container is gone. */
  async removeProjectNetwork(projectId: number): Promise<void> {
    await this.runtime.removeNetwork(networkName(projectId)).catch(() => undefined);
  }

  /** Stops a server's containers in every project (it is being deleted or changed). */
  async removeServer(serverId: number): Promise<void> {
    for (const r of this.store.recordedContainers({ serverId })) {
      await this.stop(r.projectId, r.serverId);
    }
  }

  /**
   * Runs `fn` while a throwaway copy of the server is up on its own private network, then removes
   * everything. Used to test a library entry without involving a project.
   */
  async withTestSidecar<T>(
    serverId: number,
    fn: (ctx: { network: string }) => Promise<T>,
  ): Promise<T> {
    const tag = randomBytes(4).toString('hex');
    const names = { name: `pp-mcp-test-${tag}`, network: `pp-net-test-${tag}` };
    const spec = this.spec(serverId, null, names, false);
    const info = this.store.sidecarSpecFor(serverId);
    await this.runtime.ensureNetwork(names.network, { internal: true });
    let id: string | undefined;
    try {
      try {
        id = await this.runtime.startSidecar(spec);
      } catch {
        throw new McpError(
          502,
          `Failed to start the container. Is the image "${spec.image}" built on this machine?`,
        );
      }
      await this.waitReady(id, info.readyLog, info.secretValues);
      return await fn({ network: names.network });
    } finally {
      if (id) await this.runtime.removeSidecar(id).catch(() => undefined);
      await this.runtime.removeNetwork(names.network).catch(() => undefined);
    }
  }
}
