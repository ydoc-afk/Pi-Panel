import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerRuntime } from './runtime.js';
import { createTar } from './tar.js';

/** A runtime a project can run in. 'base' is the plain sandbox image; the rest are built from it. */
export interface RuntimeVariant {
  id: string;
  label: string;
  description: string;
  /** What the agent is told it has; sandboxes are offline, so this says what cannot be installed. */
  note: string | null;
}

const OFFLINE =
  'The sandbox has no network, so packages cannot be downloaded: use the standard library and what is already installed.';

export const RUNTIME_VARIANTS: readonly RuntimeVariant[] = [
  {
    id: 'base',
    label: 'Node only',
    description: 'The plain sandbox: Node 24, git and ripgrep.',
    note: null,
  },
  {
    id: 'python',
    label: 'Python',
    description: 'Python 3 with pip, venv and uv.',
    note: `Python 3, pip, venv and uv are installed. ${OFFLINE}`,
  },
  {
    id: 'build',
    label: 'C/C++ build tools',
    description: 'gcc, g++, make, cmake and pkg-config.',
    note: `gcc, g++, make, cmake and pkg-config are installed. ${OFFLINE}`,
  },
  {
    id: 'go',
    label: 'Go',
    description: 'The Go toolchain, with the module cache in /workspace/.go.',
    note: `Go is installed (its module cache is /workspace/.go). ${OFFLINE}`,
  },
  {
    id: 'rust',
    label: 'Rust',
    description:
      'rustc and cargo (stable, minimal profile), with the cargo cache in /workspace/.cargo.',
    note: `Rust (rustc and cargo) is installed. ${OFFLINE} Crates cannot be fetched.`,
  },
  {
    id: 'jvm',
    label: 'Java',
    description: 'A JDK 21 and Maven, with the repository in /workspace/.m2.',
    note: `JDK 21 and Maven are installed. ${OFFLINE} Maven cannot resolve dependencies.`,
  },
];

export const BASE_RUNTIME = 'base';

export const findRuntime = (id: unknown): RuntimeVariant | undefined =>
  typeof id === 'string' ? RUNTIME_VARIANTS.find((v) => v.id === id) : undefined;

/** The image tag a runtime id resolves to. */
export function imageFor(runtime: ContainerRuntime, id: string): string {
  return id === BASE_RUNTIME ? runtime.baseImage() : `pi-panel/sandbox-${id}:latest`;
}

/** What to tell the agent about its runtime, or null for the plain sandbox. */
export const runtimeNote = (id: string): string | null => findRuntime(id)?.note ?? null;

/** Variant Dockerfiles, read at runtime so the panel can build them itself. */
const RUNTIMES_DIR = new URL('../../../docker/runtimes/', import.meta.url);

const LOG_LINES = 400;
const LOG_FILE = /^runtime-build-([a-z]+)-.*\.log$/;

export type RuntimeBuildStatus = 'idle' | 'building' | 'done' | 'failed';

export interface RuntimeBuild {
  status: RuntimeBuildStatus;
  log: string[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface RuntimeState {
  id: string;
  label: string;
  description: string;
  tag: string;
  present: boolean;
  /** Built on a base image that has since been rebuilt: rebuild to pick up the new base. */
  stale: boolean;
  sizeBytes: number | null;
  build: RuntimeBuild;
}

export class RuntimeBuildError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);

/** Builds runtime variants on the Docker host, one at a time, in the background. */
export class RuntimeBuilder {
  private readonly builds = new Map<string, RuntimeBuild>();
  private readonly logFiles = new Map<string, string>();
  private running: string | null = null;

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly opts: { dir?: URL; dataDir?: string } = {},
  ) {}

  private buildOf(id: string): RuntimeBuild {
    return this.builds.get(id) ?? { status: 'idle', log: [] };
  }

  async list(): Promise<RuntimeState[]> {
    const base = await this.runtime.imageInfo(this.runtime.baseImage()).catch(() => null);
    return Promise.all(
      RUNTIME_VARIANTS.map(async (v) => {
        const tag = imageFor(this.runtime, v.id);
        const info = await this.runtime.imageInfo(tag).catch(() => null);
        const builtOn = info?.labels['org.pi-panel.base-id'];
        return {
          id: v.id,
          label: v.label,
          description: v.description,
          tag,
          present: info !== null,
          stale:
            v.id !== BASE_RUNTIME &&
            !!info &&
            !!base &&
            !!builtOn &&
            builtOn !== 'unknown' &&
            builtOn !== base.id,
          sizeBytes: info?.sizeBytes ?? null,
          build: this.buildOf(v.id),
        };
      }),
    );
  }

  async start(id: string): Promise<void> {
    const variant = findRuntime(id);
    if (!variant || id === BASE_RUNTIME) throw new RuntimeBuildError(404, 'Unknown runtime');
    if (this.running) {
      throw new RuntimeBuildError(409, `A build is already running (${this.running})`);
    }
    const base = await this.runtime.imageInfo(this.runtime.baseImage());
    if (!base) {
      throw new RuntimeBuildError(
        409,
        'The base sandbox image is not built yet. Build it first (docker compose --profile build-only build sandbox-base).',
      );
    }
    let dockerfile: Buffer;
    try {
      dockerfile = readFileSync(new URL(`${id}/Dockerfile`, this.opts.dir ?? RUNTIMES_DIR));
    } catch {
      throw new RuntimeBuildError(500, `The Dockerfile for ${variant.label} is missing`);
    }
    // Set synchronously, so a second request sees the build as running.
    this.running = id;
    this.begin(id);
    this.log(id, `Building ${imageFor(this.runtime, id)} on ${this.runtime.baseImage()}`);
    void this.run(id, dockerfile, base.id);
  }

  /** The most recent logged build of this runtime, or null. */
  latestLog(id: string): string | null {
    if (!this.opts.dataDir || !findRuntime(id)) return null;
    const dir = join(this.opts.dataDir, 'logs');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => LOG_FILE.exec(f)?.[1] === id);
    } catch {
      return null;
    }
    const newest = files.sort().at(-1);
    return newest ? readFileSync(join(dir, newest), 'utf8') : null;
  }

  private begin(id: string) {
    this.builds.set(id, { status: 'building', log: [], startedAt: Date.now() });
    this.logFiles.delete(id);
    if (this.opts.dataDir) {
      const dir = join(this.opts.dataDir, 'logs');
      mkdirSync(dir, { recursive: true });
      const name = `runtime-build-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      this.logFiles.set(id, join(dir, name));
    }
  }

  private log(id: string, line: string) {
    const build = this.buildOf(id);
    for (const part of line.split('\n')) {
      if (part.trim() === '') continue;
      const stamped = `[${stamp()}] ${part}`;
      build.log.push(stamped);
      if (build.log.length > LOG_LINES) build.log.shift();
      const file = this.logFiles.get(id);
      if (file) {
        try {
          appendFileSync(file, `${stamped}\n`);
        } catch {
          this.logFiles.delete(id);
        }
      }
    }
  }

  private async run(id: string, dockerfile: Buffer, baseId: string) {
    try {
      await this.runtime.buildImage({
        tag: imageFor(this.runtime, id),
        context: createTar([{ path: 'Dockerfile', content: dockerfile }]),
        buildArgs: { BASE_IMAGE: this.runtime.baseImage(), BASE_ID: baseId },
        onLog: (line) => this.log(id, line),
      });
      this.log(id, 'Image built');
      this.builds.set(id, { ...this.buildOf(id), status: 'done', finishedAt: Date.now() });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Build failed';
      this.log(id, `Failed: ${error}`);
      this.builds.set(id, {
        ...this.buildOf(id),
        status: 'failed',
        error,
        finishedAt: Date.now(),
      });
    } finally {
      this.running = null;
    }
  }
}
