import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerRuntime } from './runtime.js';
import { createTar } from './tar.js';

/** The REA image the MCP preset runs. Keep in step with docker/rea and REA_VERSION there. */
export const REA_IMAGE = 'pi-panel/rea:6.8.0';

/** docker/rea/Dockerfile, read at runtime so the panel can build the image itself. */
const REA_DOCKERFILE = new URL('../../../docker/rea/Dockerfile', import.meta.url);

const LOG_LINES = 400;
const LINK_TIMEOUT_MS = 15_000;
const LOG_FILE = /^rea-build-.*\.log$/;

/** 'checking' covers the link test before the image build starts. */
export type ReaBuildStatus = 'idle' | 'checking' | 'building' | 'done' | 'failed';

export interface ReaState {
  image: string;
  present: boolean;
  build: {
    status: ReaBuildStatus;
    log: string[];
    error?: string;
    hint?: string;
    startedAt?: number;
    finishedAt?: number;
  };
}

export class ReaBuildError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Checks the two values the image build needs before anything is downloaded. */
export function cleanReaInput(input: { ghidraUrl?: unknown; ghidraSha256?: unknown }) {
  const url = typeof input.ghidraUrl === 'string' ? input.ghidraUrl.trim() : '';
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Reported below with the other input errors.
  }
  if (!parsed || parsed.protocol !== 'https:' || url.length > 2048) {
    throw new ReaBuildError(400, 'The Ghidra URL must be an https:// link to the release zip');
  }
  const sha = typeof input.ghidraSha256 === 'string' ? input.ghidraSha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new ReaBuildError(400, 'The SHA-256 must be 64 hexadecimal characters');
  }
  return { ghidraUrl: url, ghidraSha256: sha };
}

const stamp = () => new Date().toISOString().slice(11, 19);

/**
 * Builds the REA image on the Docker host in the background. One build at a time.
 *
 * A build runs in three stages: the link is checked before anything is downloaded, the image is
 * built (the Dockerfile verifies the checksum), and the result is recorded. Every line is timestamped
 * in memory and, when a data directory is given, in one log file per build for troubleshooting.
 */
export class ReaBuilder {
  private build: ReaState['build'] = { status: 'idle', log: [] };
  private logFile: string | undefined;

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly opts: {
      dockerfile?: URL;
      dataDir?: string;
      fetch?: typeof fetch;
    } = {},
  ) {}

  async status(): Promise<ReaState> {
    return {
      image: REA_IMAGE,
      present: await this.runtime.imageExists(REA_IMAGE),
      build: this.build,
    };
  }

  /**
   * Checks the link, then starts the build in the background. Rejects with 409 while a build is
   * running and with 400 when the link does not answer, so a bad link stops before the download.
   */
  async start(input: { ghidraUrl?: unknown; ghidraSha256?: unknown }): Promise<void> {
    if (this.build.status === 'checking' || this.build.status === 'building') {
      throw new ReaBuildError(409, 'A REA build is already running');
    }
    const { ghidraUrl, ghidraSha256 } = cleanReaInput(input);
    // Set synchronously, so a second request sees the build as running before the first yields.
    this.begin();
    this.log(`Checking the Ghidra link: ${ghidraUrl}`);
    let size: number | null;
    try {
      size = await this.checkLink(ghidraUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The Ghidra link failed the check';
      this.finish('failed', message);
      throw new ReaBuildError(400, message);
    }
    this.log(size ? `Link OK, the download is ${Math.round(size / 1e6)} MB` : 'Link OK');
    this.log('Building the image. The Dockerfile downloads Ghidra and checks its SHA-256.');
    this.build = { ...this.build, status: 'building' };
    void this.run(ghidraUrl, ghidraSha256);
  }

  /** The most recent build log, or null when no build has been logged yet. */
  latestLog(): string | null {
    if (!this.opts.dataDir) return null;
    const dir = join(this.opts.dataDir, 'logs');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => LOG_FILE.test(f));
    } catch {
      return null;
    }
    const newest = files.sort().at(-1);
    return newest ? readFileSync(join(dir, newest), 'utf8') : null;
  }

  private begin() {
    this.build = { status: 'checking', log: [], startedAt: Date.now() };
    this.logFile = undefined;
    if (this.opts.dataDir) {
      const dir = join(this.opts.dataDir, 'logs');
      mkdirSync(dir, { recursive: true });
      const name = `rea-build-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      this.logFile = join(dir, name);
    }
  }

  private log(line: string) {
    for (const part of line.split('\n')) {
      if (part.trim() === '') continue;
      const stamped = `[${stamp()}] ${part}`;
      this.build.log.push(stamped);
      if (this.build.log.length > LOG_LINES) this.build.log.shift();
      if (this.logFile) {
        // The in-memory log still works if the file cannot be written.
        try {
          appendFileSync(this.logFile, `${stamped}\n`);
        } catch {
          this.logFile = undefined;
        }
      }
    }
  }

  private finish(status: 'done' | 'failed', error?: string) {
    const hint = this.build.log.some((l) => l.includes('did NOT match'))
      ? 'The checksum does not match the file at this link. Recompute it from that exact URL: download the zip, then run sha256sum on it.'
      : undefined;
    if (error) this.log(`Failed: ${error}`);
    if (hint) this.log(`Hint: ${hint}`);
    this.build = {
      ...this.build,
      status,
      ...(error ? { error } : {}),
      ...(hint ? { hint } : {}),
      finishedAt: Date.now(),
    };
  }

  /** Confirms the link answers and reports the download size when the server sends one. */
  private async checkLink(url: string): Promise<number | null> {
    const fetchFn = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Could not reach the Ghidra link. Check that it is a direct download link.');
    }
    if (!res.ok) {
      throw new Error(
        `The Ghidra link answered HTTP ${res.status}. Use the download link of the zip itself, not the release page.`,
      );
    }
    const length = Number(res.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : null;
  }

  private async run(ghidraUrl: string, ghidraSha256: string): Promise<void> {
    try {
      const dockerfile = this.opts.dockerfile ?? REA_DOCKERFILE;
      const context = createTar([{ path: 'Dockerfile', content: readFileSync(dockerfile) }]);
      await this.runtime.buildImage({
        tag: REA_IMAGE,
        context,
        buildArgs: { GHIDRA_URL: ghidraUrl, GHIDRA_SHA256: ghidraSha256 },
        onLog: (line) => this.log(line),
      });
      this.log('Image built');
      this.finish('done');
    } catch (err) {
      this.finish('failed', err instanceof Error ? err.message : 'REA build failed');
    }
  }
}
