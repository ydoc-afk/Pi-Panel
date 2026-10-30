import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { KINDS, scaffoldFiles, toolNameFor, type Kind } from './lab-templates.js';
import { SANDBOX_UID, workspaceDir } from './paths.js';
import type { ContainerRuntime } from './runtime.js';
import type { TarEntry } from './tar.js';

export class LabError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LabOptions {
  /** Path to the harness script run inside the throwaway container. */
  harnessPath?: string;
  runTimeoutMs?: number;
  maxConcurrent?: number;
}

export interface LabTest {
  tool: string;
  input: Record<string, unknown>;
  expectContains?: string;
  expectError?: boolean;
}

export interface LabPackage {
  path: string;
  name: string | null;
  kinds: Kind[];
}

const BEGIN = '@@PI_LAB_REPORT_BEGIN@@';
const END = '@@PI_LAB_REPORT_END@@';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KIND_DIRS: Record<Kind, string> = {
  extension: 'extensions',
  skill: 'skills',
  prompt: 'prompts',
  theme: 'themes',
};
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILES = 2000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_SCAN_DIRS = 2000;
const MAX_DEPTH = 4;
const MAX_PACKAGES = 50;
const MAX_TESTS = 20;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_HARNESS = new URL('../assets/lab-harness.mjs', import.meta.url);

/** A workspace-relative path with no traversal, absolute, or empty segments. */
export function cleanRelPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 200 ||
    value.includes('\0') ||
    value.includes('\\')
  ) {
    throw new LabError(400, 'path must be a relative path inside the workspace');
  }
  const norm = posix.normalize(value.replace(/\/+$/, ''));
  if (
    norm === '.' ||
    norm === '..' ||
    norm.startsWith('../') ||
    norm.startsWith('/') ||
    norm.split('/').includes('..')
  ) {
    throw new LabError(400, 'path must be a relative path inside the workspace');
  }
  return norm;
}

function cleanTests(value: unknown): LabTest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TESTS)
    throw new LabError(400, `tests must be an array of up to ${MAX_TESTS} items`);
  return value.map((t, i) => {
    const test = t as Partial<LabTest> | null;
    if (!test || typeof test.tool !== 'string' || !test.tool || test.tool.length > 100) {
      throw new LabError(400, `tests[${i}].tool must be a tool name`);
    }
    if (!test.input || typeof test.input !== 'object' || Array.isArray(test.input)) {
      throw new LabError(400, `tests[${i}].input must be an object`);
    }
    if (JSON.stringify(test.input).length > MAX_INPUT_BYTES)
      throw new LabError(400, `tests[${i}].input is too large`);
    if (
      test.expectContains !== undefined &&
      (typeof test.expectContains !== 'string' || test.expectContains.length > 1000)
    ) {
      throw new LabError(400, `tests[${i}].expectContains must be a string up to 1000 characters`);
    }
    if (test.expectError !== undefined && typeof test.expectError !== 'boolean') {
      throw new LabError(400, `tests[${i}].expectError must be a boolean`);
    }
    return {
      tool: test.tool,
      input: test.input,
      ...(test.expectContains === undefined ? {} : { expectContains: test.expectContains }),
      ...(test.expectError === undefined ? {} : { expectError: test.expectError }),
    };
  });
}

/** The lab report comes from code that ran in the container, so shape it defensively. */
function parseReport(stdout: string): Record<string, unknown> | null {
  const end = stdout.lastIndexOf(END);
  const begin = end < 0 ? -1 : stdout.lastIndexOf(BEGIN, end);
  if (begin < 0 || end < 0) return null;
  const body = stdout.slice(begin + BEGIN.length, end).trim();
  if (body.length > MAX_REPORT_BYTES) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class LabService {
  private readonly harnessPath: URL | string;
  private readonly runTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly runningProjects = new Set<number>();
  private active = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtime: ContainerRuntime,
    private readonly dataDir: string,
    opts: LabOptions = {},
  ) {
    this.harnessPath = opts.harnessPath ?? DEFAULT_HARNESS;
    this.runTimeoutMs = opts.runTimeoutMs ?? 90_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
  }

  private workspace(projectId: number): string {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      throw new LabError(404, 'Project not found');
    }
    return workspaceDir(this.dataDir, projectId);
  }

  /** Finds package-like directories in the workspace. Everything there is agent-controlled, so symlinks are never followed. */
  async list(projectId: number): Promise<LabPackage[]> {
    const root = this.workspace(projectId);
    const found: LabPackage[] = [];
    let visited = 0;
    const walk = async (dir: string, relDir: string, depth: number) => {
      if (found.length >= MAX_PACKAGES || visited++ >= MAX_SCAN_DIRS) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
      const kinds = KINDS.filter((k) => dirs.has(KIND_DIRS[k]));
      let name: string | null = null;
      let isPackage = kinds.length > 0;
      if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
        try {
          const path = join(dir, 'package.json');
          if ((await lstat(path)).size <= 100 * 1024) {
            const manifest = JSON.parse(await readFile(path, 'utf8')) as {
              name?: unknown;
              keywords?: unknown;
              pi?: unknown;
            };
            if (typeof manifest.name === 'string') name = manifest.name.slice(0, 100);
            const piKeyword =
              Array.isArray(manifest.keywords) && manifest.keywords.includes('pi-package');
            if (piKeyword || (manifest.pi && typeof manifest.pi === 'object')) isPackage = true;
          }
        } catch {
          /* unreadable package.json: fall back to directory layout */
        }
      }
      if (isPackage && relDir) {
        found.push({ path: relDir, name, kinds: [...kinds] });
        return; // do not look for packages inside a package
      }
      if (depth >= MAX_DEPTH) return;
      for (const e of entries
        .filter((x) => x.isDirectory() && !SKIP_DIRS.has(x.name) && !x.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        await walk(join(dir, e.name), relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
      }
    };
    await walk(root, '', 0);
    return found;
  }

  /** Writes a starter package to <workspace>/lab/<name>. */
  async scaffold(projectId: number, input: { name?: unknown; kinds?: unknown }) {
    const root = this.workspace(projectId);
    if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
      throw new LabError(
        400,
        'name must be 1-40 characters: lowercase letters, digits and hyphens, starting with a letter or digit',
      );
    }
    const kinds = input.kinds;
    if (
      !Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.some((k) => !KINDS.includes(k as Kind))
    ) {
      throw new LabError(400, `kinds must be a non-empty list of: ${KINDS.join(', ')}`);
    }
    const name = input.name;
    const unique = [...new Set(kinds as Kind[])];
    const relDir = `lab/${name}`;
    const target = resolve(root, relDir);
    const labDir = resolve(root, 'lab');
    // Refuse to write through a symlinked "lab" directory planted in the workspace.
    const labInfo = await lstat(labDir).catch(() => null);
    if (labInfo && !labInfo.isDirectory())
      throw new LabError(409, 'The workspace "lab" path is not a regular directory');
    if (
      await lstat(target).then(
        () => true,
        () => false,
      )
    )
      throw new LabError(409, `lab/${name} already exists`);

    const owned = async (path: string, dir: boolean) => {
      await chown(path, SANDBOX_UID, SANDBOX_UID).catch(() => chmod(path, dir ? 0o777 : 0o666));
    };
    await mkdir(labDir, { recursive: true });
    await owned(labDir, true);
    const files = scaffoldFiles(name, unique);
    for (const file of files) {
      const full = join(target, file.path);
      let dir = full.slice(0, full.lastIndexOf(sep));
      const created: string[] = [];
      while (
        dir.length > labDir.length &&
        !(await lstat(dir).then(
          () => true,
          () => false,
        ))
      ) {
        created.unshift(dir);
        dir = dir.slice(0, dir.lastIndexOf(sep));
      }
      await mkdir(full.slice(0, full.lastIndexOf(sep)), { recursive: true });
      for (const d of created) await owned(d, true);
      await writeFile(full, file.content, { flag: 'wx' });
      await owned(full, false);
    }
    return {
      package: { path: relDir, name, kinds: unique } satisfies LabPackage,
      files: files.map((f) => f.path),
      sampleTests: unique.includes('extension')
        ? [{ tool: toolNameFor(name), input: { name: 'World' }, expectContains: 'Hello, World!' }]
        : [],
    };
  }

  /** Copies a package out of the workspace without following symlinks or leaving the workspace. */
  private async collect(projectId: number, relPath: string) {
    const root = await realpath(this.workspace(projectId)).catch(() => {
      throw new LabError(404, 'Workspace not found');
    });
    const full = await realpath(resolve(root, relPath)).catch(() => {
      throw new LabError(404, 'Package directory not found');
    });
    if (!full.startsWith(root + sep))
      throw new LabError(400, 'path must be a relative path inside the workspace');
    if (!(await lstat(full)).isDirectory()) throw new LabError(400, 'path is not a directory');

    const entries: TarEntry[] = [];
    const skipped: string[] = [];
    let bytes = 0;
    let count = 0;
    const walk = async (dir: string, rel: string) => {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) {
          skipped.push(`${relPath} (symlink)`);
        } else if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) {
            skipped.push(`${relPath}/ (${e.name})`);
            continue;
          }
          entries.push({ path: `lab/pkg/${relPath}/`, uid: SANDBOX_UID, gid: SANDBOX_UID });
          await walk(join(dir, e.name), relPath);
        } else if (e.isFile()) {
          const path = join(dir, e.name);
          const info = await lstat(path);
          if (info.size > MAX_FILE_BYTES) {
            skipped.push(`${relPath} (over ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
            continue;
          }
          bytes += info.size;
          count++;
          if (count > MAX_FILES || bytes > MAX_BYTES) {
            throw new LabError(
              413,
              `Package is too large to test (limit ${MAX_FILES} files / ${MAX_BYTES / 1024 / 1024} MB). Remove build output and dependencies.`,
            );
          }
          entries.push({
            path: `lab/pkg/${relPath}`,
            content: await readFile(path),
            mode: info.mode & 0o111 ? 0o755 : 0o644,
            uid: SANDBOX_UID,
            gid: SANDBOX_UID,
          });
        } else {
          skipped.push(`${relPath} (special file)`);
        }
      }
    };
    await walk(full, '');
    return { entries, skipped, count, bytes };
  }

  async run(projectId: number, input: { path?: unknown; tests?: unknown }) {
    const relPath = cleanRelPath(input.path);
    const tests = cleanTests(input.tests);
    this.workspace(projectId);
    if (this.runningProjects.has(projectId) || this.active >= this.maxConcurrent) {
      throw new LabError(429, 'A lab run is already in progress; try again in a moment');
    }
    this.runningProjects.add(projectId);
    this.active++;
    const started = Date.now();
    try {
      const pkg = await this.collect(projectId, relPath);
      const harness = await readFile(this.harnessPath);
      const owner = { uid: SANDBOX_UID, gid: SANDBOX_UID };
      const files: TarEntry[] = [
        { path: 'lab/', ...owner },
        ...['home', 'work', 'agent', 'pkg'].map((d) => ({ path: `lab/${d}/`, ...owner })),
        { path: 'lab/harness.mjs', content: harness, mode: 0o644, ...owner },
        {
          path: 'lab/job.json',
          content: Buffer.from(JSON.stringify({ tests, testTimeoutMs: 30_000 })),
          mode: 0o644,
          ...owner,
        },
        ...pkg.entries,
      ];
      let result;
      try {
        result = await this.runtime.runEphemeral({
          files,
          cmd: ['node', '/lab/harness.mjs'],
          // No credentials of any kind, and no network: the package only sees what was copied in.
          env: {
            HOME: '/lab/home',
            NPM_CONFIG_UPDATE_NOTIFIER: 'false',
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            PI_TELEMETRY: '0',
          },
          timeoutMs: this.runTimeoutMs,
          networkDisabled: true,
        });
      } catch {
        throw new LabError(502, 'Failed to run the lab container. Is the sandbox image built?');
      }
      const report = result.timedOut ? null : parseReport(result.stdout);
      const status = result.timedOut ? 'timeout' : report ? 'completed' : 'no-report';
      return {
        status,
        report,
        run: {
          durationMs: Date.now() - started,
          files: pkg.count,
          bytes: pkg.bytes,
          skipped: pkg.skipped.slice(0, 50),
          exitCode: result.code,
          stderr: result.stderr.slice(-2000),
        },
      };
    } finally {
      this.runningProjects.delete(projectId);
      this.active--;
    }
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LabError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerLab(app: FastifyInstance, lab: LabService) {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };

  app.get<P>('/api/projects/:id/lab/packages', (req, reply) =>
    handle(reply, async () => ({ packages: await lab.list(id(req.params.id)) })),
  );
  app.post<P>('/api/projects/:id/lab/scaffold', (req, reply) =>
    handle(reply, async () =>
      reply.code(201).send(await lab.scaffold(id(req.params.id), (req.body ?? {}) as object)),
    ),
  );
  app.post<P>('/api/projects/:id/lab/run', (req, reply) =>
    handle(reply, () => lab.run(id(req.params.id), (req.body ?? {}) as object)),
  );
}
