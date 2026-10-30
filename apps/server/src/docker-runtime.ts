import Docker from 'dockerode';
import { resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { SANDBOX_AGENT_DIR } from './paths.js';
import { createTar } from './tar.js';
import type {
  ContainerRuntime,
  ContainerSpec,
  EphemeralSpec,
  ExecResult,
  ExecSpec,
  RunningProcess,
  SidecarSpec,
  SidecarState,
} from './runtime.js';

const DEFAULT_IMAGE = 'pi-panel/sandbox-base:latest';

const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Bind-mount sources are resolved by the Docker daemon on the host, but the panel normally runs in a
 * container where the data directory is mounted at another path. Translate a path under the panel's
 * data dir to the matching host path (PI_PANEL_HOST_DATA_DIR); outside Docker no translation is needed.
 */
export function toHostPath(path: string, dataDir: string, hostDataDir: string | undefined): string {
  if (!hostDataDir) return path;
  const root = resolve(dataDir);
  const abs = resolve(path);
  if (abs === root) return hostDataDir;
  if (!abs.startsWith(root + sep)) return path;
  return hostDataDir.replace(/\/+$/, '') + abs.slice(root.length);
}

/** Splits Docker's multiplexed log stream (8-byte frame headers) into stdout and stderr text. */
export function demuxDockerLogs(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    const length = buf.readUInt32BE(offset + 4);
    const end = Math.min(offset + 8 + length, buf.length);
    (stream === 2 ? err : out).push(buf.subarray(offset + 8, end));
    offset = end;
  }
  const text = (parts: Buffer[]) =>
    Buffer.concat(parts).subarray(0, MAX_LOG_BYTES).toString('utf8');
  return { stdout: text(out), stderr: text(err) };
}

/** NOTE: not yet exercised against a real daemon (no Docker in the dev session that wrote it). */
export class DockerRuntime implements ContainerRuntime {
  private readonly docker: Docker;
  private readonly image: string;

  constructor(opts: { image?: string; docker?: Docker } = {}) {
    this.docker = opts.docker ?? new Docker();
    this.image = opts.image ?? process.env.SANDBOX_IMAGE ?? DEFAULT_IMAGE;
  }

  private hostPath(path: string): string {
    return toHostPath(path, process.env.DATA_DIR ?? './data', process.env.PI_PANEL_HOST_DATA_DIR);
  }

  async createAndStart(spec: ContainerSpec): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.image,
      Labels: { 'pi-panel.project': String(spec.projectId) },
      HostConfig: {
        Binds: [
          `${this.hostPath(spec.workspacePath)}:/workspace`,
          `${this.hostPath(spec.agentDir)}:${SANDBOX_AGENT_DIR}`,
        ],
        // Lets sandboxes reach model servers on the Docker host (llama.cpp, Unsloth) on Linux too.
        ExtraHosts: ['host.docker.internal:host-gateway'],
        Memory: 2 * 1024 * 1024 * 1024,
        PidsLimit: 512,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    try {
      await container.start();
    } catch (err) {
      await container.remove({ force: true }).catch(() => undefined);
      throw err;
    }
    return container.id;
  }

  async remove(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw err;
    }
  }

  async exec(containerId: string, spec: ExecSpec): Promise<RunningProcess> {
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: spec.cmd,
      WorkingDir: spec.workdir,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    const out = new PassThrough();
    const err = new PassThrough();
    this.docker.modem.demuxStream(stream, out, err);
    const exitCbs: ((code: number | null) => void)[] = [];
    let exited = false;
    stream.on('close', () => {
      if (exited) return;
      exited = true;
      exec
        .inspect()
        .then((info) => info.ExitCode ?? null)
        .catch(() => null)
        .then((code) => exitCbs.forEach((cb) => cb(code)));
    });
    return {
      write: (data) => void stream.write(data),
      onStdout: (cb) => void out.on('data', cb),
      onStderr: (cb) => void err.on('data', cb),
      onExit: (cb) => void exitCbs.push(cb),
      // Closing stdin makes `pi --mode rpc` exit; destroying the stream drops the attachment.
      kill: () => {
        stream.end();
        stream.destroy();
      },
    };
  }

  async runEphemeral(spec: EphemeralSpec): Promise<ExecResult> {
    const container = await this.docker.createContainer({
      Image: this.image,
      Cmd: spec.cmd,
      WorkingDir: '/lab',
      User: '1000:1000',
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      NetworkDisabled: spec.network ? false : spec.networkDisabled,
      Labels: { 'pi-panel.ephemeral': '1' },
      HostConfig: {
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256,
        ...(spec.network ? { NetworkMode: spec.network } : {}),
        // Servers that run on the Docker host (Ghidra, llama.cpp) are reached by this name.
        ...(spec.networkDisabled || spec.network
          ? {}
          : { ExtraHosts: ['host.docker.internal:host-gateway'] }),
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    });
    try {
      await container.putArchive(createTar(spec.files), { path: '/' });
      await container.start();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        container.wait().then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), spec.timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) await container.kill().catch(() => undefined);
      const info = await container.inspect().catch(() => null);
      const logs = (await container.logs({
        stdout: true,
        stderr: true,
        follow: false,
      })) as unknown as Buffer;
      const { stdout, stderr } = demuxDockerLogs(Buffer.from(logs));
      return { code: timedOut ? null : (info?.State?.ExitCode ?? null), stdout, stderr, timedOut };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async ensureNetwork(name: string, opts: { internal: boolean }): Promise<void> {
    try {
      await this.docker.getNetwork(name).inspect();
      return;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Internal: opts.internal,
      Labels: { 'pi-panel': '1' },
    });
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).remove();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw err;
    }
  }

  async connectNetwork(containerId: string, network: string): Promise<void> {
    try {
      await this.docker.getNetwork(network).connect({ Container: containerId });
    } catch (err) {
      // Docker answers 403 "endpoint ... already exists" when the container is already attached.
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 403 && /already exists/i.test(e.message ?? '')) return;
      throw err;
    }
  }

  async startSidecar(spec: SidecarSpec): Promise<string> {
    await this.docker
      .getContainer(spec.name)
      .remove({ force: true })
      .catch((err: { statusCode?: number }) => {
        if (err.statusCode !== 404) throw err;
      });
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Cmd: spec.cmd,
      User: '1000:1000',
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      HostConfig: {
        NetworkMode: spec.network,
        Binds: spec.mounts.map(
          (m) => `${this.hostPath(m.source)}:${m.target}${m.readOnly ? ':ro' : ''}`,
        ),
        Memory: spec.memoryMb * 1024 * 1024,
        MemorySwap: spec.memoryMb * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 1024,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      NetworkingConfig: { EndpointsConfig: { [spec.network]: { Aliases: [spec.alias] } } },
    });
    try {
      await container.start();
    } catch (err) {
      await container.remove({ force: true }).catch(() => undefined);
      throw err;
    }
    return container.id;
  }

  async removeSidecar(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw err;
    }
  }

  async sidecarState(id: string): Promise<SidecarState> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return info.State?.Running
        ? { state: 'running', exitCode: null }
        : { state: 'exited', exitCode: info.State?.ExitCode ?? null };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404)
        return { state: 'missing', exitCode: null };
      throw err;
    }
  }

  async sidecarLogs(id: string, tail: number): Promise<string> {
    const logs = (await this.docker
      .getContainer(id)
      .logs({ stdout: true, stderr: true, tail, follow: false })) as unknown as Buffer;
    const { stdout, stderr } = demuxDockerLogs(Buffer.from(logs));
    return `${stdout}${stderr}`;
  }
}
