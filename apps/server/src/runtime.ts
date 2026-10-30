export interface ContainerSpec {
  projectId: number;
  workspacePath: string;
}

/** Container operations Pi-Panel needs; the Docker implementation is the only one that talks to Docker. */
export interface ContainerRuntime {
  /** Creates and starts a sandbox container, returning its id. */
  createAndStart(spec: ContainerSpec): Promise<string>;
  /** Stops and removes the container. Must succeed if it is already gone. */
  remove(containerId: string): Promise<void>;
}

/** In-memory runtime for tests and for running the panel without Docker. */
export class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, ContainerSpec>();
  failNextCreate = false;
  private next = 1;

  async createAndStart(spec: ContainerSpec): Promise<string> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('fake runtime: create failed');
    }
    const id = `fake-${this.next++}`;
    this.containers.set(id, spec);
    return id;
  }

  async remove(containerId: string): Promise<void> {
    this.containers.delete(containerId);
  }
}
