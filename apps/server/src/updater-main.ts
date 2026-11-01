/**
 * Entry point of the updater container. It listens on the compose network only (no published
 * port) and answers the panel, which authenticates with a random token both share through the
 * data directory. See updater.ts for what an update does.
 *
 * Environment:
 *   PI_PANEL_REPO               the checkout (mounted at the same path as on the host)
 *   PI_PANEL_DATA_DIR           default <repo>/data
 *   PI_PANEL_CHANNELS           branches a panel may follow, default "main,nightly"
 *   PI_PANEL_HEALTH_URL         default http://pi-panel:3000/api/health
 *   PI_PANEL_UPDATE_CHECK_HOURS how often to look for new commits, default 6 (0 turns it off)
 *   PI_PANEL_HEALTH_TIMEOUT     seconds to wait for a new panel to answer before rolling back,
 *                               default 180
 *   PORT                        default 8080
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Updater, UpdaterError, type Runner } from './updater.js';

/** Where the panel and the updater find the shared token, under the data directory. */
export const TOKEN_FILE = join('updater', 'token');

/** Loads the shared token, creating it (readable by root only) the first time. */
export async function ensureToken(dataDir: string): Promise<string> {
  const file = join(dataDir, TOKEN_FILE);
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (token.length >= 32) return token;
  } catch {
    // Not created yet.
  }
  await mkdir(join(dataDir, 'updater'), { recursive: true });
  const token = randomBytes(32).toString('hex');
  await writeFile(file, token, { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

/**
 * Runs commands without a shell. Git runs as the checkout's owner (via setpriv) when the updater
 * runs as root, so the files it writes stay editable from the host.
 */
export function processRunner(repo: string): Runner {
  let owner: { uid: number; gid: number } | null | undefined;
  return {
    async run(cmd, args, opts = {}) {
      if (owner === undefined) {
        const st = await stat(repo).catch(() => null);
        owner =
          st && process.getuid?.() === 0 && st.uid !== 0 ? { uid: st.uid, gid: st.gid } : null;
      }
      let file = cmd;
      let argv = args;
      const env: NodeJS.ProcessEnv = { ...process.env, PWD: repo };
      if (opts.asOwner && owner) {
        file = 'setpriv';
        argv = [`--reuid=${owner.uid}`, `--regid=${owner.gid}`, '--clear-groups', cmd, ...args];
        env.HOME = '/tmp';
      }
      return new Promise((resolve) => {
        const child = spawn(file, argv, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let partial = '';
        const lines = (chunk: string) => {
          if (!opts.onLine) return;
          partial += chunk;
          const parts = partial.split(/\r?\n|\r/);
          partial = parts.pop() ?? '';
          for (const l of parts) if (l.trim()) opts.onLine(l);
        };
        child.stdout.setEncoding('utf8').on('data', (c: string) => {
          stdout += c;
          lines(c);
        });
        child.stderr.setEncoding('utf8').on('data', (c: string) => {
          stderr += c;
          lines(c);
        });
        child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
        child.on('close', (code) => {
          if (partial.trim()) opts.onLine?.(partial);
          resolve({ code, stdout, stderr });
        });
      });
    },
  };
}

const MAX_BODY = 16 * 1024;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new UpdaterError(413, 'Request too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new UpdaterError(400, 'Body must be JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function authorized(req: IncomingMessage, token: string) {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The updater's HTTP API. Exported for tests. */
export function updaterServer(updater: Updater, token: string) {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req, token)) return send(res, 401, { error: 'Unauthorized' });
        const url = new URL(req.url ?? '/', 'http://updater');
        const route = `${req.method} ${url.pathname}`;
        switch (route) {
          case 'GET /status':
            return send(res, 200, await updater.status());
          case 'POST /check':
            return send(res, 200, await updater.check());
          case 'POST /update': {
            const { branch, sha } = await body(req);
            if (typeof branch !== 'string' || typeof sha !== 'string') {
              return send(res, 400, { error: 'branch and sha are required' });
            }
            return send(res, 202, { job: await updater.start(branch, sha) });
          }
          case 'POST /rollback':
            return send(res, 202, { job: await updater.rollback() });
          case 'GET /job': {
            const job = updater.currentJob();
            const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
            return send(res, 200, {
              job: job && { ...job, log: job.log.slice(after), logLength: job.log.length },
            });
          }
          default:
            return send(res, 404, { error: 'Not found' });
        }
      } catch (e) {
        if (e instanceof UpdaterError) return send(res, e.status, { error: e.message });
        console.error(e);
        return send(res, 500, { error: 'Updater error' });
      }
    })();
  });
}

async function main() {
  const repo = process.env.PI_PANEL_REPO || process.cwd();
  const dataDir = process.env.PI_PANEL_DATA_DIR || join(repo, 'data');
  const channels = (process.env.PI_PANEL_CHANNELS || 'main,nightly')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^[\w./-]+$/.test(c));
  const updater = new Updater({
    repo,
    dataDir,
    channels,
    runner: processRunner(repo),
    healthUrl: process.env.PI_PANEL_HEALTH_URL || 'http://pi-panel:3000/api/health',
    healthTimeoutMs: (Number(process.env.PI_PANEL_HEALTH_TIMEOUT) || 180) * 1000,
  });
  await updater.load();
  const token = await ensureToken(dataDir);
  const port = Number(process.env.PORT || 8080);
  updaterServer(updater, token).listen(port, () => {
    console.log(`Pi-Panel updater on :${port} for ${repo} (channels: ${channels.join(', ')})`);
  });

  const hours = Number(process.env.PI_PANEL_UPDATE_CHECK_HOURS ?? 6);
  if (hours > 0) {
    const check = () =>
      updater.check().catch((e: unknown) => console.error('update check failed:', e));
    setTimeout(check, 30_000);
    setInterval(check, hours * 3_600_000);
  }
}

// Started directly (node updater-main.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
