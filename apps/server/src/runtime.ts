import { FakePiProcess, type FakePiOptions } from './fake-pi.js';
import type { TarEntry } from './tar.js';

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

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A one-shot run in a fresh, throwaway container; nothing from the host is mounted. */
export interface EphemeralSpec {
  /** Files copied into the container before it starts. */
  files: TarEntry[];
  cmd: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  /** No network at all inside the container. */
  networkDisabled: boolean;
  /** Join this existing network instead (used to test a managed server on its private network). */
  network?: string;
}

export interface SidecarMount {
  /** Path as the panel sees it; the Docker runtime translates it to the host path. */
  source: string;
  target: string;
  readOnly: boolean;
}

/** A long-lived, panel-managed container for an MCP server that speaks streamable HTTP. */
export interface SidecarSpec {
  name: string;
  image: string;
  cmd: string[];
  env: Record<string, string>;
  /** The private network it lives on; the only way to reach it is through that network. */
  network: string;
  alias: string;
  mounts: SidecarMount[];
  memoryMb: number;
  labels: Record<string, string>;
}

export interface SidecarState {
  state: 'running' | 'exited' | 'missing';
  exitCode: number | null;
}

/** Container operations Pi-Panel needs; the Docker implementation is the only one that talks to Docker. */
export interface ContainerRuntime {
  /** Creates and starts a sandbox container, returning its id. */
  createAndStart(spec: ContainerSpec): Promise<string>;
  /** Stops and removes the container. Must succeed if it is already gone. */
  remove(containerId: string): Promise<void>;
  /** Starts a process in a running container with stdin/stdout/stderr attached. */
  exec(containerId: string, spec: ExecSpec): Promise<RunningProcess>;
  /** Runs a command to completion in a new throwaway container, then removes it. */
  runEphemeral(spec: EphemeralSpec): Promise<ExecResult>;
  /** Creates a network if it does not exist. An internal network has no route to the outside. */
  ensureNetwork(name: string, opts: { internal: boolean }): Promise<void>;
  /** Removes a network; must succeed if it is already gone. */
  removeNetwork(name: string): Promise<void>;
  /** Attaches a container to a network; must succeed if it is already attached. */
  connectNetwork(containerId: string, network: string): Promise<void>;
  /** Creates and starts a sidecar (replacing any container with the same name) and returns its id. */
  startSidecar(spec: SidecarSpec): Promise<string>;
  /** Stops and removes a sidecar; must succeed if it is already gone. */
  removeSidecar(id: string): Promise<void>;
  sidecarState(id: string): Promise<SidecarState>;
  sidecarLogs(id: string, tail: number): Promise<string>;
  /** Whether the sandbox image that project containers are created from is present locally. */
  hasSandboxImage(): Promise<boolean>;
}

/** In-memory runtime for tests and for running the panel without Docker. */
export class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, ContainerSpec>();
  /** Every fake pi process started, in order; tests use this to kill or inspect them. */
  readonly processes: FakePiProcess[] = [];
  /** Every exec spec received, in order (env included), for tests to inspect. */
  readonly execs: ExecSpec[] = [];
  /** Every throwaway-container run received, in order. */
  readonly ephemerals: EphemeralSpec[] = [];
  /** Supplies the result of a throwaway run; by default it prints an empty passing lab report. */
  ephemeralHandler: (spec: EphemeralSpec) => ExecResult | Promise<ExecResult> = () => ({
    code: 0,
    stdout: '@@PI_LAB_REPORT_BEGIN@@\n{"ok":true}\n@@PI_LAB_REPORT_END@@\n',
    stderr: '',
    timedOut: false,
  });
  readonly networks = new Map<string, { internal: boolean; connected: Set<string> }>();
  readonly sidecars = new Map<
    string,
    { spec: SidecarSpec; state: SidecarState['state']; exitCode: number | null }
  >();
  /** Every sidecar start received, in order. */
  readonly sidecarStarts: SidecarSpec[] = [];
  failNextSidecar = false;
  /** The state new sidecars start in; 'exited' simulates a container that crashes on startup. */
  sidecarInitialState: SidecarState['state'] = 'running';
  /** What a sidecar's logs contain; the default announces readiness like REA does. */
  sidecarLog: (spec: SidecarSpec) => string = () =>
    '{"level":30,"msg":"MCP transport listening","transport":"streamable-http"}\n';
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
    for (const net of this.networks.values()) net.connected.delete(containerId);
  }

  async exec(containerId: string, spec: ExecSpec): Promise<RunningProcess> {
    if (!this.containers.has(containerId)) throw new Error('fake runtime: no such container');
    if (spec.cmd[0] !== 'pi') throw new Error(`fake runtime: unsupported command ${spec.cmd[0]}`);
    this.execs.push(spec);
    const proc = new FakePiProcess(spec.cmd.slice(1), {
      ...this.fakePi,
      agentDir: this.containers.get(containerId)!.agentDir,
    });
    this.processes.push(proc);
    return proc;
  }

  async runEphemeral(spec: EphemeralSpec): Promise<ExecResult> {
    this.ephemerals.push(spec);
    return this.ephemeralHandler(spec);
  }

  async ensureNetwork(name: string, opts: { internal: boolean }): Promise<void> {
    if (!this.networks.has(name))
      this.networks.set(name, { internal: opts.internal, connected: new Set() });
  }

  async removeNetwork(name: string): Promise<void> {
    const net = this.networks.get(name);
    if (!net) return;
    // Docker refuses to remove a network that still has containers attached; keep that behaviour.
    if (net.connected.size > 0)
      throw new Error(`fake runtime: network ${name} has active endpoints`);
    this.networks.delete(name);
  }

  async connectNetwork(containerId: string, network: string): Promise<void> {
    const net = this.networks.get(network);
    if (!net) throw new Error(`fake runtime: no such network ${network}`);
    if (!this.containers.has(containerId) && !this.sidecars.has(containerId)) {
      throw new Error('fake runtime: no such container');
    }
    net.connected.add(containerId);
  }

  async startSidecar(spec: SidecarSpec): Promise<string> {
    if (this.failNextSidecar) {
      this.failNextSidecar = false;
      throw new Error('fake runtime: sidecar start failed');
    }
    if (!this.networks.has(spec.network))
      throw new Error(`fake runtime: no such network ${spec.network}`);
    for (const [id, sc] of this.sidecars)
      if (sc.spec.name === spec.name) await this.removeSidecar(id);
    this.sidecarStarts.push(spec);
    const id = `sidecar-${this.next++}`;
    this.sidecars.set(id, {
      spec,
      state: this.sidecarInitialState,
      exitCode: this.sidecarInitialState === 'exited' ? 1 : null,
    });
    this.networks.get(spec.network)!.connected.add(id);
    return id;
  }

  async removeSidecar(id: string): Promise<void> {
    this.sidecars.delete(id);
    for (const net of this.networks.values()) net.connected.delete(id);
  }

  async sidecarState(id: string): Promise<SidecarState> {
    const sc = this.sidecars.get(id);
    return sc ? { state: sc.state, exitCode: sc.exitCode } : { state: 'missing', exitCode: null };
  }

  /** Set to false to simulate a missing sandbox image. */
  sandboxImageAvailable = true;

  async hasSandboxImage(): Promise<boolean> {
    return this.sandboxImageAvailable;
  }

  async sidecarLogs(id: string, tail: number): Promise<string> {
    const sc = this.sidecars.get(id);
    if (!sc) return '';
    return this.sidecarLog(sc.spec).split('\n').slice(-tail).join('\n');
  }
}
