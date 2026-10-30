import Docker from 'dockerode';
import type { ContainerRuntime, ContainerSpec } from './runtime.js';

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
        Binds: [`${spec.workspacePath}:/workspace`],
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
}
