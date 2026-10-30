import { createWriteStream, readdirSync, lstatSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { samplesDir } from './paths.js';

export class SamplesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SampleLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export const DEFAULT_LIMITS: SampleLimits = {
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 200,
};

export interface SampleInfo {
  name: string;
  size: number;
  modifiedAt: number;
}

/** Keeps a plain file name: no directories, no leading dots, no unusual characters. */
export function cleanSampleName(raw: unknown): string {
  if (typeof raw !== 'string') throw new SamplesError(400, 'A file name is required');
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = base
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._() +-]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!name) throw new SamplesError(400, 'A file name is required');
  return name;
}

/**
 * Files for analysis. They are stored per project and mounted read-only into managed MCP containers,
 * never into the session container, so the agent can only reach them through those tools.
 */
export class SamplesService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly limits: SampleLimits = DEFAULT_LIMITS,
  ) {}

  private dir(projectId: number): string {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      throw new SamplesError(404, 'Project not found');
    }
    return samplesDir(this.dataDir, projectId);
  }

  /** Synchronous so it can be used while writing configuration at session start. */
  names(projectId: number): string[] {
    try {
      return readdirSync(samplesDir(this.dataDir, projectId))
        .filter(
          (n) =>
            !n.startsWith('.') && lstatSync(join(samplesDir(this.dataDir, projectId), n)).isFile(),
        )
        .sort();
    } catch {
      return [];
    }
  }

  async list(projectId: number): Promise<SampleInfo[]> {
    const dir = this.dir(projectId);
    const out: SampleInfo[] = [];
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.startsWith('.')) continue;
      const info = await lstat(join(dir, name));
      if (info.isFile()) out.push({ name, size: info.size, modifiedAt: info.mtimeMs });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(projectId: number, rawName: unknown, stream: Readable): Promise<SampleInfo> {
    const dir = this.dir(projectId);
    const name = cleanSampleName(rawName);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const existing = await this.list(projectId);
    if (existing.some((f) => f.name === name))
      throw new SamplesError(409, `${name} already exists`);
    if (existing.length >= this.limits.maxFiles)
      throw new SamplesError(413, `A project can hold at most ${this.limits.maxFiles} files`);
    const room = Math.min(
      this.limits.maxFileBytes,
      this.limits.maxTotalBytes - existing.reduce((n, f) => n + f.size, 0),
    );
    if (room <= 0) throw new SamplesError(413, 'This project has reached its storage limit');

    const tmp = join(dir, `.upload-${randomBytes(6).toString('hex')}`);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > room)
          cb(
            new SamplesError(
              413,
              `File is too large (limit ${Math.floor(room / 1024 / 1024)} MB for this upload)`,
            ),
          );
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, counter, createWriteStream(tmp, { mode: 0o644 }));
      if ((stream as Readable & { truncated?: boolean }).truncated) {
        throw new SamplesError(
          413,
          `File is too large (limit ${Math.floor(room / 1024 / 1024)} MB for this upload)`,
        );
      }
      // link() fails if the name appeared meanwhile, so two uploads cannot overwrite each other.
      await link(tmp, join(dir, name)).catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'EEXIST' ? new SamplesError(409, `${name} already exists`) : err;
      });
      await chmod(join(dir, name), 0o644);
    } catch (err) {
      stream.resume();
      throw err;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return { name, size, modifiedAt: Date.now() };
  }

  async remove(projectId: number, rawName: string) {
    const dir = this.dir(projectId);
    const name = cleanSampleName(rawName);
    if (name !== rawName) throw new SamplesError(400, 'Invalid file name');
    const info = await lstat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) throw new SamplesError(404, 'File not found');
    await unlink(join(dir, name));
  }

  async removeProject(projectId: number) {
    await rm(samplesDir(this.dataDir, projectId), { recursive: true, force: true });
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SamplesError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerSamples(app: FastifyInstance, samples: SamplesService) {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };

  app.get<P>('/api/projects/:id/samples', (req, reply) =>
    handle(reply, async () => ({ files: await samples.list(id(req.params.id)) })),
  );
  app.post<P>('/api/projects/:id/samples', (req, reply) =>
    handle(reply, async () => {
      if (!req.isMultipart()) throw new SamplesError(400, 'Send the file as multipart/form-data');
      const file = await req.file();
      if (!file) throw new SamplesError(400, 'No file was sent');
      return reply
        .code(201)
        .send({ file: await samples.save(id(req.params.id), file.filename, file.file) });
    }),
  );
  app.delete<{ Params: { id: string; name: string } }>(
    '/api/projects/:id/samples/:name',
    (req, reply) =>
      handle(reply, async () => {
        await samples.remove(id(req.params.id), req.params.name);
        return reply.code(204).send();
      }),
  );
}
