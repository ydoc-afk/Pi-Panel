// Runs inside a throwaway container with no network and no secrets. It loads the package copied to
// <root>/pkg with the real pi SDK, optionally runs tool tests, and prints one JSON report between
// sentinel lines. Extension code runs in this same process, so a report is a functional result for a
// human to read, not a security attestation.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BEGIN = '@@PI_LAB_REPORT_BEGIN@@';
const END = '@@PI_LAB_REPORT_END@@';
const ROOT = process.env.LAB_ROOT ?? '/lab';
const PKG = join(ROOT, 'pkg');
const MAX_TEXT = 8000;

const report = {
  ok: false,
  sdkVersion: null,
  package: null,
  extensions: [],
  extensionErrors: [],
  commands: [],
  tools: [],
  skills: [],
  prompts: [],
  themes: [],
  diagnostics: [],
  sessionError: null,
  tests: [],
  harnessError: null,
};

const clip = (text) => {
  const s = String(text ?? '');
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[truncated]` : s;
};
const clean = (text) =>
  clip(
    String(text ?? '')
      .split(`${PKG}/`)
      .join('')
      .split(PKG)
      .join('.'),
  );
const rel = (path) => {
  if (path === PKG) return './';
  return typeof path === 'string' && path.startsWith(`${PKG}/`)
    ? `./${path.slice(PKG.length + 1)}`
    : String(path ?? '');
};

function finish(code) {
  process.stdout.write(`\n${BEGIN}\n${JSON.stringify(report)}\n${END}\n`, () => process.exit(code));
}

function sdkEntry() {
  if (process.env.PI_SDK_ENTRY) return process.env.PI_SDK_ENTRY;
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const dir = join(root, '@earendil-works', 'pi-coding-agent');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const exp = pkg.exports?.['.'];
  return join(dir, typeof exp === 'string' ? exp : (exp?.import ?? pkg.main));
}

const collect = (diags, kind) => {
  for (const d of diags ?? []) {
    report.diagnostics.push({
      kind,
      type: d.type ?? 'warning',
      message: clean(d.message),
      path: rel(d.path),
    });
  }
};

async function runTest(session, Value, test, index) {
  const result = {
    tool: test.tool,
    input: test.input,
    status: 'passed',
    output: '',
    error: null,
    schemaErrors: [],
    durationMs: 0,
    ok: false,
  };
  const expectError = test.expectError === true;
  const def = session.getToolDefinition(test.tool);
  let wrapped = session.agent.state.tools.find((t) => t.name === test.tool);
  if (def && !wrapped) {
    // Registered but not active by default (for example defaultActive: false): activate it for the test.
    session.setActiveToolsByName([...session.getActiveToolNames(), test.tool]);
    wrapped = session.agent.state.tools.find((t) => t.name === test.tool);
  }
  if (!def || !wrapped) {
    result.status = 'not-found';
    result.error = `No tool named "${test.tool}" was registered by this package`;
  } else {
    const errors = [...Value.Errors(def.parameters, test.input)].map(
      (e) => `${e.instancePath || '/'} ${e.message}`,
    );
    if (errors.length > 0) {
      // pi's wrapper does not validate arguments, but the agent loop does for model calls, so do the same.
      result.status = 'invalid-input';
      result.schemaErrors = errors.slice(0, 20).map(clean);
    } else {
      const controller = new AbortController();
      const timeoutMs = test.timeoutMs ?? 30000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const timeout = new Promise((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`timed out after ${timeoutMs} ms`)),
          ),
        );
        const out = await Promise.race([
          wrapped.execute(`lab-${index}`, test.input, controller.signal),
          timeout,
        ]);
        result.output = clip(
          (out?.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        );
        if (out?.isError) result.status = 'tool-error';
      } catch (err) {
        result.status = controller.signal.aborted ? 'timeout' : 'threw';
        result.error = clean(err?.message ?? err);
      } finally {
        clearTimeout(timer);
        result.durationMs = Date.now() - started;
      }
    }
  }
  const failed = result.status !== 'passed';
  let ok = expectError ? failed && result.status !== 'not-found' : !failed;
  if (
    ok &&
    typeof test.expectContains === 'string' &&
    !result.output.includes(test.expectContains)
  ) {
    ok = false;
    result.error = `Output did not contain "${clip(test.expectContains).slice(0, 200)}"`;
  }
  result.ok = ok;
  return result;
}

try {
  const job = JSON.parse(readFileSync(join(ROOT, 'job.json'), 'utf8'));
  const entry = sdkEntry();
  report.sdkVersion = (() => {
    try {
      return (
        JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version ?? null
      );
    } catch {
      return null;
    }
  })();
  const sdk = await import(pathToFileURL(entry).href);
  const { Value } = await import(pathToFileURL(createRequire(entry).resolve('typebox/value')).href);

  try {
    const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
    report.package = {
      name: typeof manifest.name === 'string' ? manifest.name : null,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      piPackage: Array.isArray(manifest.keywords) && manifest.keywords.includes('pi-package'),
      hasManifest: manifest.pi !== undefined,
    };
  } catch {
    report.package = null;
  }

  const agentDir = join(ROOT, 'agent');
  const cwd = join(ROOT, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [PKG] }));

  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const ext = loader.getExtensions();
  report.extensions = ext.extensions.map((e) => rel(e.path));
  report.extensionErrors = ext.errors.map((e) => ({ path: rel(e.path), error: clean(e.error) }));
  const skills = loader.getSkills();
  report.skills = skills.skills.map((s) => ({
    name: s.name,
    description: clip(s.description).slice(0, 300),
    path: rel(s.filePath ?? s.path),
  }));
  collect(skills.diagnostics, 'skill');
  const prompts = loader.getPrompts();
  report.prompts = prompts.prompts.map((p) => ({
    name: p.name,
    description: clip(p.description).slice(0, 300),
    path: rel(p.filePath ?? p.path),
  }));
  collect(prompts.diagnostics, 'prompt');
  const themes = loader.getThemes();
  report.themes = themes.themes.map((t) => ({ name: t.name, path: rel(t.sourcePath ?? t.path) }));
  collect(themes.diagnostics, 'theme');

  let session;
  try {
    ({ session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(),
    }));
    await session.bindExtensions({});
    report.commands = session.extensionRunner
      .getRegisteredCommands()
      .map((c) => ({ name: c.name, description: clip(c.description ?? '').slice(0, 300) }));
    report.tools = session
      .getAllTools()
      .filter((t) => String(t.sourceInfo?.path ?? '').startsWith(`${PKG}/`))
      .map((t) => ({
        name: t.name,
        description: clip(t.description).slice(0, 500),
        parameters: t.parameters,
        path: rel(t.sourceInfo?.path),
      }));
    for (const [i, test] of (job.tests ?? []).entries())
      report.tests.push(await runTest(session, Value, test, i));
  } catch (err) {
    report.sessionError = clean(err?.stack?.split('\n')[0] ?? err?.message ?? err);
  } finally {
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
  }

  const found =
    report.extensions.length + report.skills.length + report.prompts.length + report.themes.length;
  // With nothing recognisable inside, pi tries to load the package directory itself as an extension and
  // fails with "Cannot find module '.'". Replace that artifact with a clear message.
  if (found === 0 && report.extensionErrors.every((e) => e.path === './')) {
    report.extensionErrors = [];
    report.diagnostics.push({
      kind: 'package',
      type: 'error',
      message:
        'No pi resources were discovered in this package. Add extensions/, skills/, prompts/ or themes/ directories, or declare them under "pi" in package.json.',
      path: './',
    });
  }
  report.ok =
    report.extensionErrors.length === 0 &&
    report.sessionError === null &&
    report.diagnostics.every((d) => d.type !== 'error') &&
    report.tests.every((t) => t.ok);
  finish(0);
} catch (err) {
  report.harnessError = clean(err?.stack ?? err?.message ?? err);
  finish(0);
}
