import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { SANDBOX_AGENT_DIR } from './paths.js';
import type { ContainerRuntime, ContainerSpec, ExecSpec, RunningProcess } from './runtime.js';

const DEFAULT_IMAGE = 'pi-panel/sandbox-base:latest';

/** NOTE: not yet exercised against a real daemon (no Docker in the dev session that wrote it). */
export class DockerRuntime implements ContainerRuntime {
  private readonly docker: Docker;
  private readonly image: string;

  constructor(opts: { image?: string; docker?: Docker } = {}) {
    this.docker = opts.docker ?? new Docker();
    this.image = opts.image ?? process.env.SANDBOX_IMAGE ?? DEFAULT_IMAGE;
  }

  async createAndStart(spec: ContainerSpec): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.image,
      Labels: { 'pi-panel.project': String(spec.projectId) },
      HostConfig: {
        Binds: [`${spec.workspacePath}:/workspace`, `${spec.agentDir}:${SANDBOX_AGENT_DIR}`],
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
}
