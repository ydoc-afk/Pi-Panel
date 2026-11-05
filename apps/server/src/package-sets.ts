import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PackageError, parseNpmSource, type PackageService } from './packages.js';

const MAX_SOURCES = 50;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PackageSetEntry {
  source: string;
  name: string;
  version: string;
}

export interface PackageSet {
  id: number;
  name: string;
  sources: PackageSetEntry[];
  createdAt: number;
}

/** A set as it stands in one project: what is already installed, and what applying it would add. */
export interface PackageSetStatus extends PackageSet {
  installed: string[];
  missing: string[];
  /** Installed in the project at a different version than the set records. */
  different: { source: string; installed: string }[];
}

interface Row {
  id: number;
  name: string;
  sources: string;
  created_at: number;
}

/** Only exact versions are saved: a set is a record of packages that were reviewed, not of ranges. */
function cleanSources(input: unknown): PackageSetEntry[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SOURCES) {
    throw new PackageError(400, `sources must be a list of 1 to ${MAX_SOURCES} npm packages`);
  }
  const byName = new Map<string, PackageSetEntry>();
  for (const raw of input) {
    const { name, spec } = parseNpmSource(raw);
    if (!spec || !SEMVER.test(spec)) {
      throw new PackageError(
        400,
        `${String(raw)} needs an exact version, for example npm:${name}@1.2.3`,
      );
    }
    if (byName.has(name)) throw new PackageError(400, `${name} is listed more than once`);
    byName.set(name, { source: `npm:${name}@${spec}`, name, version: spec });
  }
  return [...byName.values()];
}

function cleanName(input: unknown): string {
  if (typeof input !== 'string') throw new PackageError(400, 'name must be a string');
  const name = input.trim();
  if (!name || name.length > 60 || /[\r\n]/.test(name)) {
    throw new PackageError(400, 'name must be 1 to 60 characters on one line');
  }
  return name;
}

const toSet = (r: Row): PackageSet => ({
  id: r.id,
  name: r.name,
  sources: JSON.parse(r.sources) as PackageSetEntry[],
  createdAt: r.created_at,
});

/**
 * Named groups of reviewed packages that can be applied to any project. A set only records what to
 * install: applying it goes through the same review-then-install steps as adding one package, so a
 * set never installs anything unreviewed.
 */
export class PackageSetService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly packages: PackageService,
  ) {}

  list(): PackageSet[] {
    return (
      this.db
        .prepare('SELECT * FROM package_sets ORDER BY name COLLATE NOCASE')
        .all() as unknown as Row[]
    ).map(toSet);
  }

  private find(id: number): PackageSet {
    const row = this.db.prepare('SELECT * FROM package_sets WHERE id = ?').get(id) as
      Row | undefined;
    if (!row) throw new PackageError(404, 'Package set not found');
    return toSet(row);
  }

  /**
   * Saves a set from explicit sources, or from the npm packages a project has installed
   * (those pinned to an exact version; the rest are counted in `skipped`).
   */
  async create(input: { name?: unknown; sources?: unknown; fromProjectId?: unknown }) {
    const name = cleanName(input.name);
    let skipped = 0;
    let sources: PackageSetEntry[];
    if (input.fromProjectId !== undefined) {
      if (!Number.isInteger(input.fromProjectId)) {
        throw new PackageError(400, 'fromProjectId must be a project id');
      }
      const installed = await this.packages.list(input.fromProjectId as number);
      const exact: string[] = [];
      for (const p of installed) {
        try {
          const { spec } = parseNpmSource(p.source);
          if (spec && SEMVER.test(spec)) exact.push(p.source);
          else skipped++;
        } catch {
          skipped++;
        }
      }
      if (exact.length === 0) {
        throw new PackageError(
          400,
          'This project has no npm packages installed at an exact version to save',
        );
      }
      sources = cleanSources(exact);
    } else {
      sources = cleanSources(input.sources);
    }
    try {
      const info = this.db
        .prepare('INSERT INTO package_sets (name, sources, created_at) VALUES (?, ?, ?)')
        .run(name, JSON.stringify(sources), Date.now());
      return { set: this.find(Number(info.lastInsertRowid)), skipped };
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new PackageError(409, `A package set named "${name}" already exists`);
      }
      throw err;
    }
  }

  update(id: number, input: { name?: unknown; sources?: unknown }) {
    const current = this.find(id);
    const name = input.name === undefined ? current.name : cleanName(input.name);
    const sources = input.sources === undefined ? current.sources : cleanSources(input.sources);
    try {
      this.db
        .prepare('UPDATE package_sets SET name = ?, sources = ? WHERE id = ?')
        .run(name, JSON.stringify(sources), id);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new PackageError(409, `A package set named "${name}" already exists`);
      }
      throw err;
    }
    return this.find(id);
  }

  remove(id: number) {
    this.find(id);
    this.db.prepare('DELETE FROM package_sets WHERE id = ?').run(id);
  }

  /** Every set, with what applying it to this project would add. */
  async forProject(projectId: number): Promise<PackageSetStatus[]> {
    const installed = new Map<string, string>();
    for (const p of await this.packages.list(projectId)) {
      if (p.name) installed.set(p.name, p.source);
    }
    return this.list().map((set) => {
      const status: PackageSetStatus = { ...set, installed: [], missing: [], different: [] };
      for (const entry of set.sources) {
        const have = installed.get(entry.name);
        if (have === entry.source) status.installed.push(entry.source);
        else if (have) status.different.push({ source: entry.source, installed: have });
        else status.missing.push(entry.source);
      }
      return status;
    });
  }
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PackageError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerPackageSets(app: FastifyInstance, svc: PackageSetService) {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : -1);
  type P = { Params: { id: string } };

  app.get('/api/package-sets', async () => ({ sets: svc.list() }));
  app.post('/api/package-sets', (req, reply) =>
    handle(reply, async () =>
      reply.code(201).send(await svc.create((req.body ?? {}) as Record<string, unknown>)),
    ),
  );
  app.put<P>('/api/package-sets/:id', (req, reply) =>
    handle(reply, () => ({
      set: svc.update(id(req.params.id), (req.body ?? {}) as Record<string, unknown>),
    })),
  );
  app.delete<P>('/api/package-sets/:id', (req, reply) =>
    handle(reply, () => {
      svc.remove(id(req.params.id));
      return reply.code(204).send();
    }),
  );
  // Each set with what it would add to this project.
  app.get<P>('/api/projects/:id/package-sets', (req, reply) =>
    handle(reply, async () => ({ sets: await svc.forProject(id(req.params.id)) })),
  );
}
