// Runs in a throwaway container WITH network access. It connects to the single MCP server configured in
// $PI_CODING_AGENT_DIR/mcp.json using the real pi: `pi mcp list --json` reports the connection state and
// tool names, and the SDK's MCP extension adds each tool's description and annotations. The report is
// printed between sentinel lines. Server code runs in this container, so treat the report as untrusted.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BEGIN = '@@PI_MCP_REPORT_BEGIN@@';
const END = '@@PI_MCP_REPORT_END@@';
const ROOT = process.env.LAB_ROOT ?? '/lab';
const report = { sdkVersion: null, state: 'error', error: null, tools: [] };

const clip = (text, max = 500) => String(text ?? '').slice(0, max);
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');

function finish() {
  process.stdout.write(`\n${BEGIN}\n${JSON.stringify(report)}\n${END}\n`, () => process.exit(0));
}

function sdkEntry() {
  if (process.env.PI_SDK_ENTRY) return process.env.PI_SDK_ENTRY;
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const dir = join(root, '@earendil-works', 'pi-coding-agent');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const exp = pkg.exports?.['.'];
  return join(dir, typeof exp === 'string' ? exp : (exp?.import ?? pkg.main));
}

try {
  const list = spawnSync(process.env.PI_BIN ?? 'pi', ['mcp', 'list', '--json'], {
    encoding: 'utf8',
    timeout: 80_000,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (list.error) throw new Error(`could not run pi: ${list.error.message}`);
  const text = list.stdout ?? '';
  const parsed = JSON.parse(text.slice(Math.max(0, text.indexOf('{'))));
  const server = parsed.servers?.[0];
  if (!server) {
    report.error = clip(
      (parsed.errors ?? []).map((e) => e.message ?? JSON.stringify(e)).join('; ') ||
        'pi reported no servers',
    );
    finish();
  } else {
    report.state = ['connected', 'failed', 'disabled'].includes(server.state)
      ? server.state
      : 'error';
    report.error = server.error ? clip(server.error, 1000) : null;
    const names = Array.isArray(server.tools)
      ? server.tools.filter((n) => typeof n === 'string').slice(0, 500)
      : [];
    report.tools = names.map((name) => ({ name, description: '', annotations: {} }));

    if (report.state === 'connected' && names.length > 0) {
      try {
        const entry = sdkEntry();
        try {
          report.sdkVersion =
            JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version ??
            null;
        } catch {
          /* version is optional */
        }
        const sdk = await import(pathToFileURL(entry).href);
        const cwd = join(ROOT, 'work');
        mkdirSync(cwd, { recursive: true });
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir,
          extensionFactories: [sdk.createMcpExtension()],
        });
        await loader.reload();
        const { session } = await sdk.createAgentSession({
          cwd,
          agentDir,
          resourceLoader: loader,
          sessionManager: sdk.SessionManager.inMemory(),
        });
        try {
          await session.bindExtensions({});
          const prefix = `mcp__${sanitize(server.name)}__`;
          const want = new Map(names.map((n) => [prefix + sanitize(n), n]));
          const found = new Map();
          const started = Date.now();
          while (Date.now() - started < 20_000 && found.size < want.size) {
            for (const t of session.getAllTools()) if (want.has(t.name)) found.set(t.name, t);
            if (found.size < want.size) await new Promise((r) => setTimeout(r, 250));
          }
          report.tools = names.map((name) => {
            const t = found.get(prefix + sanitize(name));
            const a = t?.annotations ?? {};
            const annotations = {};
            for (const k of [
              'readOnlyHint',
              'destructiveHint',
              'idempotentHint',
              'openWorldHint',
            ]) {
              if (typeof a[k] === 'boolean') annotations[k] = a[k];
            }
            return { name, description: clip(t?.description, 300), annotations };
          });
        } finally {
          try {
            session.dispose();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* the tool names from the CLI are still useful without details */
      }
    }
    finish();
  }
} catch (err) {
  report.error = clip(err?.message ?? err, 1000);
  finish();
}
