import { FakePiProcess, type FakePiOptions } from './fake-pi.js';

export interface ContainerSpec {
  projectId: number;
  workspacePath: string;
  /** Host dir mounted as pi's agent dir inside the container. */
  agentDir: string;
}

/** A process running inside a container, with piped stdio. */
export interface RunningProcess {
  write(data: string): void;
  onStdout(cb: (chunk: string | Buffer) => void): void;
  onStderr(cb: (chunk: string | Buffer) => void): void;
  /** Called once when the process ends; code is null if it was killed or could not be determined. */
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface ExecSpec {
  cmd: string[];
  workdir?: string;
  env?: Record<string, string>;
}

/** Container operations Pi-Panel needs; the Docker implementation is the only one that talks to Docker. */
export interface ContainerRuntime {
  /** Creates and starts a sandbox container, returning its id. */
  createAndStart(spec: ContainerSpec): Promise<string>;
  /** Stops and removes the container. Must succeed if it is already gone. */
  remove(containerId: string): Promise<void>;
  /** Starts a process in a running container with stdin/stdout/stderr attached. */
  exec(containerId: string, spec: ExecSpec): Promise<RunningProcess>;
}

/** In-memory runtime for tests and for running the panel without Docker. */
export class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, ContainerSpec>();
  /** Every fake pi process started, in order; tests use this to kill or inspect them. */
  readonly processes: FakePiProcess[] = [];
  /** Every exec spec received, in order (env included), for tests to inspect. */
  readonly execs: ExecSpec[] = [];
  failNextCreate = false;
  fakePi: FakePiOptions = {};
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

  async exec(containerId: string, spec: ExecSpec): Promise<RunningProcess> {
    if (!this.containers.has(containerId)) throw new Error('fake runtime: no such container');
    if (spec.cmd[0] !== 'pi') throw new Error(`fake runtime: unsupported command ${spec.cmd[0]}`);
    this.execs.push(spec);
    const proc = new FakePiProcess(spec.cmd.slice(1), this.fakePi);
    this.processes.push(proc);
    return proc;
  }
}
