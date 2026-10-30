import { readFileSync } from 'node:fs';
import type { ContainerRuntime } from './runtime.js';
import { createTar } from './tar.js';

/** The REA image the MCP preset runs. Keep in step with docker/rea and REA_VERSION there. */
export const REA_IMAGE = 'pi-panel/rea:6.8.0';

/** docker/rea/Dockerfile, read at runtime so the panel can build the image itself. */
const REA_DOCKERFILE = new URL('../../../docker/rea/Dockerfile', import.meta.url);

const LOG_LINES = 400;

export type ReaBuildStatus = 'idle' | 'building' | 'done' | 'failed';

export interface ReaState {
  image: string;
  present: boolean;
  build: { status: ReaBuildStatus; log: string[]; error?: string; startedAt?: number };
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

/**
 * Builds the REA image on the Docker host in the background. One build at a time; the UI polls
 * status() for the log. The Ghidra download is verified against the checksum inside the build.
 */
export class ReaBuilder {
  private build: ReaState['build'] = { status: 'idle', log: [] };

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly dockerfile: URL = REA_DOCKERFILE,
  ) {}

  async status(): Promise<ReaState> {
    return {
      image: REA_IMAGE,
      present: await this.runtime.imageExists(REA_IMAGE),
      build: this.build,
    };
  }

  /** Starts a build and returns immediately. Rejects if one is already running. */
  start(input: { ghidraUrl?: unknown; ghidraSha256?: unknown }): void {
    if (this.build.status === 'building') {
      throw new ReaBuildError(409, 'A REA build is already running');
    }
    const { ghidraUrl, ghidraSha256 } = cleanReaInput(input);
    // Set synchronously, so a second request sees the build as running before the first yields.
    this.build = { status: 'building', log: [], startedAt: Date.now() };
    void this.run(ghidraUrl, ghidraSha256);
  }

  private async run(ghidraUrl: string, ghidraSha256: string): Promise<void> {
    const onLog = (line: string) => {
      for (const part of line.split('\n')) {
        if (part.trim() === '') continue;
        this.build.log.push(part);
        if (this.build.log.length > LOG_LINES) this.build.log.shift();
      }
    };
    try {
      const context = createTar([{ path: 'Dockerfile', content: readFileSync(this.dockerfile) }]);
      await this.runtime.buildImage({
        tag: REA_IMAGE,
        context,
        buildArgs: { GHIDRA_URL: ghidraUrl, GHIDRA_SHA256: ghidraSha256 },
        onLog,
      });
      this.build = { ...this.build, status: 'done' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'REA build failed';
      this.build = { ...this.build, status: 'failed', error: message };
    }
  }
}
