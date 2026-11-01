/**
 * The updater: moves a Pi-Panel checkout to a newer commit of its channel (a branch such as `main`
 * or `nightly`), rebuilds the panel image and restarts the panel, with a database backup and a way
 * back. It runs in its own small container beside the panel (see updater-main.ts), because a
 * container cannot rebuild and replace itself.
 *
 * It only imports Node built-ins, so the updater image can run it without the panel's packages.
 *
 * Safety rules, each checked before anything changes:
 * - Only configured channels, and only the commit that is the channel's tip right now.
 * - The checkout has no uncommitted changes, and the update is a fast-forward (no local commits
 *   are lost).
 * - The new code's database schema is not older than the running panel's (older code cannot read
 *   a newer schema).
 * - The panel's settings come from files compose reads (.env, docker-compose.yml), not from a shell
 *   that is gone: otherwise recreating the container would quietly drop them.
 * The new image is built while the old panel keeps running. If the new panel does not come up
 * healthy, the old image, commit and database are put back automatically.
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SERVICE = 'pi-panel';
/** The image tag that holds the previous build, for a quick roll back. */
export const PREVIOUS_TAG = 'pp-previous';
const DB_FILES = ['pi-panel.db', 'pi-panel.db-wal', 'pi-panel.db-shm', 'secret.key'];
const SHA_RE = /^[0-9a-f]{40}$/;
const LOG_LIMIT = 2000;
const COMMITS_SHOWN = 30;

export class UpdaterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Run as the owner of the checkout, so files git writes keep their owner. */
  asOwner?: boolean;
  /** Called with each line of output, for the job log. */
  onLine?: (line: string) => void;
}

/** Runs a command with arguments (never through a shell). */
export interface Runner {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

export interface UpdaterOptions {
  /** The checkout, at the same path as on the host, so compose resolves ./data the same way. */
  repo: string;
  /** The panel's data directory (holds the database, secret.key, backups and updater state). */
  dataDir: string;
  /** Branches a panel may follow, e.g. ['main', 'nightly']. */
  channels: string[];
  runner: Runner;
  /** The panel's health endpoint as seen from the updater. */
  healthUrl: string;
  fetch?: typeof fetch;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Backups kept in data/backups; older ones made by the updater are removed. */
  keepBackups?: number;
  now?: () => number;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface ChannelState {
  sha: string;
  /** Commits on the channel that the checkout does not have. */
  behind: number;
  /** Commits in the checkout that the channel does not have. */
  ahead: number;
  /** Newest first, at most 30. */
  commits: Commit[];
  /** Database schema the channel's code expects. */
  schema: number;
}

export type JobKind = 'update' | 'switch' | 'rollback';
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'rolled-back';

export interface Job {
  id: number;
  kind: JobKind;
  status: JobStatus;
  phase: string;
  from: { branch: string; sha: string; schema: number };
  to: { branch: string; sha: string; schema: number };
  /** Directory of the database backup taken before the restart, if one was taken. */
  backup: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  log: string[];
}

export interface UpdaterStatus {
  repo: string;
  remoteUrl: string | null;
  /** A browsable URL for the repository, when it is on GitHub. */
  webUrl: string | null;
  branch: string | null;
  /** The branch, when it is one of the configured channels. */
  channel: string | null;
  channels: string[];
  head: Commit;
  dirty: boolean;
  /** Schema the checkout's code expects. */
  schema: number;
  remotes: Record<string, ChannelState | null>;
  checkedAt: number | null;
  /** Why fetching a channel failed on the last check, by channel. */
  fetchErrors: Record<string, string>;
  job: Job | null;
}

/** Highest migration number in a version of db.ts; 0 for code from before numbered migrations. */
export function schemaFromSource(source: string): number {
  const start = source.indexOf('const MIGRATIONS');
  if (start < 0) return 0;
  let max = 0;
  for (const m of source.slice(start).matchAll(/\bversion:\s*(\d+)/g))
    max = Math.max(max, Number(m[1]));
  return max;
}

/** The remote URL without any credentials in it. */
export function cleanRemote(url: string): string {
  return redact(url.trim());
}

/** Removes credentials from any URL in a line of output (`https://user:token@host` → `https://host`). */
export function redact(text: string): string {
  return text.replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

/** https://github.com/owner/repo for GitHub remotes in https or scp form, otherwise null. */
export function githubWebUrl(remote: string): string | null {
  const m =
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** Keys whose value in compose's resolved config differs from the running container's. */
export function settingsDrift(
  composeEnv: Record<string, string | null>,
  containerEnv: string[],
): string[] {
  const running = new Map<string, string>();
  for (const kv of containerEnv) {
    const i = kv.indexOf('=');
    if (i > 0) running.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return Object.entries(composeEnv)
    .filter(([k, v]) => (v ?? '') !== (running.get(k) ?? ''))
    .map(([k]) => k)
    .sort();
}

const FORMAT = '%H%x1f%s%x1f%an%x1f%cI';
function parseCommits(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = '', author = '', date = ''] = line.split('\x1f');
      return { sha, subject, author, date };
    });
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);

export class Updater {
  private readonly o: Required<Omit<UpdaterOptions, 'fetch'>> & { fetch: typeof fetch };
  private job: Job | null = null;
  private checkedAt: number | null = null;
  private nextJobId = 1;
  private lastStatus: UpdaterStatus | null = null;
  private fetchErrors: Record<string, string> = {};

  constructor(opts: UpdaterOptions) {
    this.o = {
      fetch: opts.fetch ?? fetch,
      healthTimeoutMs: 180_000,
      healthIntervalMs: 2_000,
      keepBackups: 5,
      now: () => Date.now(),
      ...opts,
    };
  }

  private get stateFile() {
    return join(this.o.dataDir, 'updater', 'state.json');
  }

  /** Loads the last job from disk, so its outcome survives the updater restarting. */
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as { job?: Job };
      if (saved.job) {
        // A job that was running when the updater stopped did not finish.
        if (saved.job.status === 'running') {
          saved.job.status = 'failed';
          saved.job.error = 'The updater stopped while this job was running.';
          saved.job.finishedAt = saved.job.finishedAt ?? this.o.now();
        }
        this.job = saved.job;
        this.nextJobId = saved.job.id + 1;
      }
    } catch {
      // No state yet.
    }
  }

  private async save() {
    await mkdir(join(this.o.dataDir, 'updater'), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ job: this.job }, null, 2));
    await rename(tmp, this.stateFile);
  }

  get running() {
    return this.job?.status === 'running';
  }

  currentJob(): Job | null {
    return this.job;
  }

  // ---- git -------------------------------------------------------------------------------------

  private async git(args: string[], onLine?: (l: string) => void) {
    const r = await this.o.runner.run('git', ['-C', this.o.repo, ...args], {
      asOwner: true,
      onLine,
    });
    if (r.code !== 0) {
      throw new UpdaterError(500, `git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout.trim();
  }

  private async gitOk(args: string[]) {
    const r = await this.o.runner.run('git', ['-C', this.o.repo, ...args], { asOwner: true });
    return r.code === 0;
  }

  private async schemaAt(ref: string) {
    const r = await this.o.runner.run(
      'git',
      ['-C', this.o.repo, 'show', `${ref}:apps/server/src/db.ts`],
      { asOwner: true },
    );
    return r.code === 0 ? schemaFromSource(r.stdout) : 0;
  }

  private async isDirty() {
    return (await this.git(['status', '--porcelain', '--untracked-files=no'])).length > 0;
  }

  private async branch(): Promise<string | null> {
    const b = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return b === 'HEAD' ? null : b;
  }

  /** Fetches every configured channel, remembering why any fetch failed. */
  private async fetchChannels() {
    for (const ch of this.o.channels) {
      const refspec = `+refs/heads/${ch}:refs/remotes/origin/${ch}`;
      const r = await this.o.runner.run(
        'git',
        ['-C', this.o.repo, 'fetch', '--quiet', 'origin', refspec],
        { asOwner: true },
      );
      if (r.code === 0) delete this.fetchErrors[ch];
      else this.fetchErrors[ch] = redact((r.stderr || r.stdout).trim()).slice(0, 600);
    }
    this.checkedAt = this.o.now();
  }

  private async channelState(ch: string): Promise<ChannelState | null> {
    const ref = `refs/remotes/origin/${ch}`;
    if (!(await this.gitOk(['rev-parse', '--verify', '--quiet', ref]))) return null;
    const sha = await this.git(['rev-parse', ref]);
    const [behind, ahead, log, schema] = await Promise.all([
      this.git(['rev-list', '--count', `HEAD..${ref}`]),
      this.git(['rev-list', '--count', `${ref}..HEAD`]),
      this.git(['log', `--format=${FORMAT}`, '-n', String(COMMITS_SHOWN), `HEAD..${ref}`]),
      this.schemaAt(ref),
    ]);
    return {
      sha,
      behind: Number(behind),
      ahead: Number(ahead),
      commits: parseCommits(log),
      schema,
    };
  }

  async status(): Promise<UpdaterStatus> {
    // While a job is moving the checkout, git commands here could race it for the index lock, so
    // the last report is reused with the job's progress.
    if (this.running && this.lastStatus) return { ...this.lastStatus, job: this.job };
    const [branch, headLine, porcelain, remoteRaw] = await Promise.all([
      this.branch(),
      this.git(['log', '-1', `--format=${FORMAT}`]),
      this.git(['status', '--porcelain', '--untracked-files=no']),
      this.o.runner
        .run('git', ['-C', this.o.repo, 'remote', 'get-url', 'origin'], { asOwner: true })
        .then((r) => (r.code === 0 ? r.stdout : '')),
    ]);
    const remotes: Record<string, ChannelState | null> = {};
    for (const ch of this.o.channels) remotes[ch] = await this.channelState(ch);
    const remoteUrl = remoteRaw.trim() ? cleanRemote(remoteRaw) : null;
    this.lastStatus = {
      repo: this.o.repo,
      remoteUrl,
      webUrl: remoteUrl ? githubWebUrl(remoteUrl) : null,
      branch,
      channel: branch && this.o.channels.includes(branch) ? branch : null,
      channels: this.o.channels,
      head: parseCommits(headLine)[0]!,
      dirty: porcelain.length > 0,
      schema: await this.schemaAt('HEAD'),
      remotes,
      checkedAt: this.checkedAt,
      fetchErrors: { ...this.fetchErrors },
      job: this.job,
    };
    return this.lastStatus;
  }

  /** Fetches the channels, then reports. While a job runs, only reports. */
  async check(): Promise<UpdaterStatus> {
    if (!this.running) await this.fetchChannels();
    return this.status();
  }

  // ---- docker compose --------------------------------------------------------------------------

  private async compose(args: string[], onLine?: (l: string) => void) {
    const r = await this.o.runner.run('docker', ['compose', ...args], { onLine });
    if (r.code !== 0) {
      throw new UpdaterError(
        500,
        `docker compose ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`,
      );
    }
    return r.stdout.trim();
  }

  private async docker(args: string[]) {
    const r = await this.o.runner.run('docker', args);
    if (r.code !== 0) {
      throw new UpdaterError(500, `docker ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout.trim();
  }

  /** The image compose builds the panel into, e.g. pi-panel-pi-panel. */
  private async panelImage() {
    const config = JSON.parse(await this.compose(['config', '--format', 'json'])) as {
      name?: string;
      services?: Record<string, { image?: string; environment?: Record<string, string | null> }>;
    };
    const svc = config.services?.[SERVICE];
    if (!svc) throw new UpdaterError(500, `docker-compose.yml has no ${SERVICE} service`);
    return { image: svc.image ?? `${config.name}-${SERVICE}`, env: svc.environment ?? {} };
  }

  private async panelContainer() {
    const id = (await this.compose(['ps', '-q', SERVICE])).split('\n')[0]?.trim();
    if (!id) {
      throw new UpdaterError(
        409,
        `No running ${SERVICE} container in this compose project. Start the panel with ` +
          '`docker compose up -d` from the repository root, and keep any COMPOSE_PROJECT_NAME in .env.',
      );
    }
    return id;
  }

  /** The schema of the running panel's database, from its health endpoint. */
  private async runningSchema(): Promise<number | null> {
    try {
      const res = await this.o.fetch(this.o.healthUrl, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { schema?: unknown };
      return typeof body.schema === 'number' ? body.schema : null;
    } catch {
      return null;
    }
  }

  private async waitHealthy(): Promise<boolean> {
    const deadline = this.o.now() + this.o.healthTimeoutMs;
    while (this.o.now() < deadline) {
      try {
        const res = await this.o.fetch(this.o.healthUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return true;
      } catch {
        // Not up yet.
      }
      await new Promise((r) => setTimeout(r, this.o.healthIntervalMs));
    }
    return false;
  }

  // ---- backups ---------------------------------------------------------------------------------

  private async backup(label: string): Promise<string> {
    const dir = join(this.o.dataDir, 'backups', `${stamp(this.o.now())}-${label}`);
    await mkdir(dir, { recursive: true });
    for (const f of DB_FILES) {
      await copyFile(join(this.o.dataDir, f), join(dir, f)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    return dir;
  }

  private async restore(dir: string) {
    for (const f of DB_FILES) {
      const target = join(this.o.dataDir, f);
      await rm(target, { force: true });
      await copyFile(join(dir, f), target).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }

  /** Keeps the newest backups the updater made (named <timestamp>-<label>). */
  private async pruneBackups(keep: string) {
    const root = join(this.o.dataDir, 'backups');
    const names = (await readdir(root).catch(() => [] as string[]))
      .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort()
      .reverse();
    for (const n of names.slice(this.o.keepBackups)) {
      if (join(root, n) !== keep) await rm(join(root, n), { recursive: true, force: true });
    }
  }

  // ---- jobs ------------------------------------------------------------------------------------

  private log(line: string) {
    if (!this.job) return;
    this.job.log.push(redact(line));
    if (this.job.log.length > LOG_LIMIT) this.job.log.splice(0, this.job.log.length - LOG_LIMIT);
  }

  private phase(name: string, message: string) {
    if (!this.job) return;
    this.job.phase = name;
    this.log(`==> ${message}`);
  }

  /**
   * Checks an update to `branch` at `sha` (the same branch, or another channel) and starts it.
   * Returns once the checks pass and the job has started; the job runs on in the background.
   */
  async start(branch: string, sha: string): Promise<Job> {
    if (this.running) throw new UpdaterError(409, 'An update is already running');
    if (!this.o.channels.includes(branch)) {
      throw new UpdaterError(400, `Channel must be one of: ${this.o.channels.join(', ')}`);
    }
    if (!SHA_RE.test(sha)) throw new UpdaterError(400, 'sha must be a full commit hash');

    await this.fetchChannels();
    const tip = await this.channelState(branch);
    if (!tip) {
      const why = this.fetchErrors[branch];
      throw new UpdaterError(
        404,
        `origin/${branch} was not found${why ? `. Fetching it failed: ${why}` : ''}`,
      );
    }
    if (tip.sha !== sha) {
      throw new UpdaterError(409, `${branch} has moved on since you checked. Check again first.`);
    }
    const current = await this.branch();
    if (!current) throw new UpdaterError(409, 'The checkout is not on a branch (detached HEAD)');
    if (await this.isDirty()) {
      throw new UpdaterError(
        409,
        'The checkout has uncommitted changes. Commit or stash them on the host first.',
      );
    }
    const headSha = await this.git(['rev-parse', 'HEAD']);
    if (headSha === sha) throw new UpdaterError(409, 'Already on that commit');
    const kind: JobKind = current === branch ? 'update' : 'switch';
    if (kind === 'update') {
      if (!(await this.gitOk(['merge-base', '--is-ancestor', 'HEAD', sha]))) {
        throw new UpdaterError(
          409,
          `The checkout has commits that ${branch} does not, so this is not a fast-forward. ` +
            'Resolve it on the host.',
        );
      }
    } else if (
      (await this.gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) &&
      !(await this.gitOk(['merge-base', '--is-ancestor', `refs/heads/${branch}`, sha]))
    ) {
      throw new UpdaterError(
        409,
        `The local ${branch} branch has commits that origin/${branch} does not. Resolve it on the host.`,
      );
    }

    const fromSchema = (await this.runningSchema()) ?? (await this.schemaAt('HEAD'));
    if (tip.schema < fromSchema) {
      throw new UpdaterError(
        409,
        `The database is at schema ${fromSchema}, but ${branch} expects schema ${tip.schema}. ` +
          'Older code cannot read a newer database. Restore a backup from before the newer ' +
          'version, or run that channel as a separate instance.',
      );
    }

    const { env } = await this.panelImage();
    const container = await this.panelContainer();
    const containerEnv = JSON.parse(
      await this.docker(['inspect', '--format', '{{json .Config.Env}}', container]),
    ) as string[];
    const drift = settingsDrift(env, containerEnv);
    if (drift.length > 0) {
      throw new UpdaterError(
        409,
        `The running panel has settings that docker compose would not reproduce: ${drift.join(', ')}. ` +
          'They were probably set in the shell. Put them in .env next to docker-compose.yml, then ' +
          'run `docker compose up -d` once on the host.',
      );
    }

    this.job = {
      id: this.nextJobId++,
      kind,
      status: 'running',
      phase: 'starting',
      from: { branch: current, sha: headSha, schema: fromSchema },
      to: { branch, sha, schema: tip.schema },
      backup: null,
      startedAt: this.o.now(),
      finishedAt: null,
      error: null,
      log: [],
    };
    await this.save();
    void this.runUpdate(this.job);
    return this.job;
  }

  private async runUpdate(job: Job) {
    const out = (l: string) => this.log(l);
    let checkedOut = false;
    let restarted = false;
    try {
      const { image } = await this.panelImage();

      this.phase('checkout', `Moving the checkout to ${job.to.branch} ${job.to.sha.slice(0, 7)}`);
      // From here on, a failure puts the checkout back where it was.
      checkedOut = true;
      if (job.kind === 'switch') {
        if (await this.gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${job.to.branch}`])) {
          await this.git(['checkout', '--quiet', job.to.branch], out);
        } else {
          await this.git(['checkout', '--quiet', '-b', job.to.branch, job.to.sha], out);
          await this.git(['branch', `--set-upstream-to=origin/${job.to.branch}`], out);
        }
      }
      await this.git(['merge', '--ff-only', '--quiet', job.to.sha], out);

      // The old image stays tagged so a failed start can go straight back to it.
      this.phase('build', 'Building the new panel image (the current panel keeps running)');
      await this.docker(['image', 'tag', image, `${image}:${PREVIOUS_TAG}`]).catch(() => {
        this.log('(no existing image to keep; roll back would need a rebuild)');
      });
      await this.compose(['build', '--build-arg', `PI_PANEL_COMMIT=${job.to.sha}`, SERVICE], out);

      this.phase('backup', 'Stopping the panel and backing up the database and secret.key');
      await this.compose(['stop', SERVICE], out);
      job.backup = await this.backup(job.from.sha.slice(0, 7));
      this.log(`Backup: ${job.backup}`);
      await this.save();

      this.phase('restart', 'Starting the new panel');
      restarted = true;
      await this.compose(['up', '-d', '--no-deps', '--no-build', SERVICE], out);

      this.phase('health', 'Waiting for the panel to answer');
      if (!(await this.waitHealthy())) {
        throw new UpdaterError(500, 'The new panel did not become healthy in time');
      }
      // Pruning is housekeeping: a failure here must not undo a good update.
      await this.pruneBackups(job.backup).catch((e: unknown) =>
        this.log(`(could not prune old backups: ${e instanceof Error ? e.message : String(e)})`),
      );
      this.phase('done', 'Update complete');
      job.status = 'succeeded';
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      this.log(`!! ${job.error}`);
      // The job reads as running until the roll back has finished, so nobody acts on a half state.
      let outcome: JobStatus = 'failed';
      if (checkedOut) {
        try {
          await this.revert(job, restarted);
          outcome = 'rolled-back';
        } catch (re) {
          this.log(`!! Roll back failed: ${re instanceof Error ? re.message : String(re)}`);
        }
      }
      job.status = outcome;
    } finally {
      job.finishedAt = this.o.now();
      await this.save().catch(() => {});
    }
  }

  /** Puts back the previous commit, and if the panel was restarted, its image and database. */
  private async revert(job: Job, restarted: boolean) {
    this.phase('rollback', `Going back to ${job.from.branch} ${job.from.sha.slice(0, 7)}`);
    if (restarted) {
      const { image } = await this.panelImage();
      await this.compose(['stop', SERVICE], (l) => this.log(l));
      await this.docker(['image', 'tag', `${image}:${PREVIOUS_TAG}`, image]);
      if (job.backup && job.to.schema !== job.from.schema) {
        this.log('Restoring the database backup (the schema changed)');
        await this.restore(job.backup);
      }
    }
    if (job.kind === 'switch') await this.git(['checkout', '--quiet', job.from.branch]);
    await this.git(['reset', '--hard', '--quiet', job.from.sha]);
    if (restarted) {
      await this.compose(['up', '-d', '--no-deps', '--no-build', SERVICE], (l) => this.log(l));
      if (!(await this.waitHealthy()))
        throw new UpdaterError(500, 'The previous panel did not come back');
    }
    this.log('Back on the previous version');
  }

  /** Undoes the last successful update: previous image, commit and, if the schema changed, data. */
  async rollback(): Promise<Job> {
    if (this.running) throw new UpdaterError(409, 'An update is already running');
    const last = this.job;
    if (!last || last.kind === 'rollback' || last.status !== 'succeeded') {
      throw new UpdaterError(409, 'There is no completed update to roll back');
    }
    if (await this.isDirty()) {
      throw new UpdaterError(
        409,
        'The checkout has uncommitted changes. Resolve them on the host first.',
      );
    }
    const head = await this.git(['rev-parse', 'HEAD']);
    if (head !== last.to.sha) {
      throw new UpdaterError(
        409,
        'The checkout has moved since that update, so it cannot be rolled back here.',
      );
    }
    const { image } = await this.panelImage();
    const r = await this.o.runner.run('docker', ['image', 'inspect', `${image}:${PREVIOUS_TAG}`]);
    if (r.code !== 0)
      throw new UpdaterError(
        409,
        'The previous image is gone, so roll back needs a rebuild on the host',
      );
    if (last.to.schema !== last.from.schema) {
      if (!last.backup)
        throw new UpdaterError(409, 'The schema changed but there is no backup to restore');
      await stat(last.backup).catch(() => {
        throw new UpdaterError(409, `The backup ${last.backup} is missing`);
      });
    }

    const job: Job = {
      id: this.nextJobId++,
      kind: 'rollback',
      status: 'running',
      phase: 'starting',
      from: last.to,
      to: last.from,
      backup: last.backup,
      startedAt: this.o.now(),
      finishedAt: null,
      error: null,
      log: [],
    };
    this.job = job;
    await this.save();
    void (async () => {
      try {
        await this.revert(last, true);
        job.status = 'succeeded';
        job.phase = 'done';
      } catch (e) {
        job.status = 'failed';
        job.error = e instanceof Error ? e.message : String(e);
        this.log(`!! ${job.error}`);
      } finally {
        job.finishedAt = this.o.now();
        await this.save().catch(() => {});
      }
    })();
    return job;
  }
}
