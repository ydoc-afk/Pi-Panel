import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerRuntime } from './runtime.js';
import { createTar } from './tar.js';

/** A profile a project can run in. 'base' is the plain sandbox image; the rest are layered on it. */
export interface RuntimeVariant {
  id: string;
  label: string;
  description: string;
  /** The profile this one is built on; the sandbox image when omitted. */
  parent?: string;
  /** What the agent is told it has; sandboxes are offline, so this says what cannot be installed. */
  note: string | null;
}

const OFFLINE =
  'The sandbox has no network, so packages cannot be downloaded: use the standard library and what is already installed.';

export const RUNTIME_VARIANTS: readonly RuntimeVariant[] = [
  {
    id: 'base',
    label: 'Minimal',
    description: 'The plain sandbox: Node 24, git and ripgrep.',
    note: null,
  },
  {
    id: 'python',
    label: 'Scripting',
    description: 'Python 3 with pip, venv and uv.',
    note: `Python 3, pip, venv and uv are installed. ${OFFLINE}`,
  },
  {
    id: 'native',
    label: 'Native / reverse engineering',
    description:
      'Scripting plus gcc, g++, make, cmake, pkg-config, gdb, nasm, file and xxd. Builds on Scripting.',
    parent: 'python',
    note: `Python 3 (pip, venv, uv), gcc, g++, make, cmake, pkg-config, gdb, nasm, binutils, file and xxd are installed. ${OFFLINE}`,
  },
  {
    id: 'full',
    label: 'Full',
    description:
      'Native plus Go, Rust (rustc, cargo) and a JDK 21 with Maven. Large. Builds on Native.',
    parent: 'native',
    note: `Python 3 (pip, venv, uv), gcc, g++, make, cmake, gdb, nasm, Go, Rust (rustc, cargo) and JDK 21 with Maven are installed. ${OFFLINE} Go modules, crates and Maven dependencies cannot be fetched.`,
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
    const infos = new Map(
      await Promise.all(
        RUNTIME_VARIANTS.map(
          async (v) =>
            [
              v.id,
              await this.runtime.imageInfo(imageFor(this.runtime, v.id)).catch(() => null),
            ] as const,
        ),
      ),
    );
    return Promise.all(
      RUNTIME_VARIANTS.map(async (v) => {
        const tag = imageFor(this.runtime, v.id);
        const info = infos.get(v.id) ?? null;
        const base = infos.get(v.parent ?? BASE_RUNTIME) ?? null;
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

  /**
   * Builds a profile in the background. Profiles it is layered on that are missing are built first,
   * in order, so one press on "Full" is enough.
   */
  async start(id: string): Promise<void> {
    const variant = findRuntime(id);
    if (!variant || id === BASE_RUNTIME) throw new RuntimeBuildError(404, 'Unknown runtime');
    if (this.running) {
      throw new RuntimeBuildError(409, `A build is already running (${this.running})`);
    }
    if (!(await this.runtime.imageInfo(this.runtime.baseImage()))) {
      throw new RuntimeBuildError(
        409,
        'The base sandbox image is not built yet. Build it first (docker compose --profile build-only build sandbox-base).',
      );
    }
    // Missing profiles this one is layered on, oldest first, then the profile itself.
    const chain = [variant];
    for (let v = variant; v.parent;) {
      const parent = findRuntime(v.parent)!;
      if (
        parent.id === BASE_RUNTIME ||
        (await this.runtime.imageInfo(imageFor(this.runtime, parent.id)))
      )
        break;
      chain.unshift(parent);
      v = parent;
    }
    const steps: { variant: RuntimeVariant; dockerfile: Buffer }[] = [];
    for (const v of chain) {
      try {
        steps.push({
          variant: v,
          dockerfile: readFileSync(new URL(`${v.id}/Dockerfile`, this.opts.dir ?? RUNTIMES_DIR)),
        });
      } catch {
        throw new RuntimeBuildError(500, `The Dockerfile for ${v.label} is missing`);
      }
    }
    // Set synchronously, so a second request sees the build as running.
    this.running = id;
    for (const step of steps) {
      this.begin(step.variant.id);
      if (step.variant.id !== id) {
        this.log(step.variant.id, `Building first, because ${variant.label} is layered on it`);
      }
    }
    void this.runChain(steps);
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

  private async runChain(steps: { variant: RuntimeVariant; dockerfile: Buffer }[]) {
    try {
      for (let i = 0; i < steps.length; i++) {
        const ok = await this.buildOne(steps[i]!.variant, steps[i]!.dockerfile);
        if (!ok) {
          // The profiles queued behind a failed one never started: say so instead of leaving them "building".
          for (const later of steps.slice(i + 1)) {
            this.log(later.variant.id, `Not built: ${steps[i]!.variant.label} failed first`);
            this.builds.set(later.variant.id, {
              ...this.buildOf(later.variant.id),
              status: 'failed',
              error: `${steps[i]!.variant.label} failed to build, so this was not attempted`,
              finishedAt: Date.now(),
            });
          }
          return;
        }
      }
    } finally {
      this.running = null;
    }
  }

  private async buildOne(variant: RuntimeVariant, dockerfile: Buffer): Promise<boolean> {
    const id = variant.id;
    const parentTag = imageFor(this.runtime, variant.parent ?? BASE_RUNTIME);
    try {
      const parent = await this.runtime.imageInfo(parentTag);
      if (!parent) throw new Error(`${parentTag} is not on this machine`);
      this.log(id, `Building ${imageFor(this.runtime, id)} on ${parentTag}`);
      await this.runtime.buildImage({
        tag: imageFor(this.runtime, id),
        context: createTar([{ path: 'Dockerfile', content: dockerfile }]),
        buildArgs: { BASE_IMAGE: parentTag, BASE_ID: parent.id },
        onLog: (line) => this.log(id, line),
      });
      this.log(id, 'Image built');
      this.builds.set(id, { ...this.buildOf(id), status: 'done', finishedAt: Date.now() });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Build failed';
      this.log(id, `Failed: ${error}`);
      this.builds.set(id, { ...this.buildOf(id), status: 'failed', error, finishedAt: Date.now() });
      return false;
    }
  }
}
