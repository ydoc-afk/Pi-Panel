import { useEffect, useState, type FormEvent } from 'react';
import {
  listLabPackages,
  runLab,
  scaffoldLabPackage,
  type LabDiagnostic,
  type LabKind,
  type LabPackage,
  type LabRun,
  type LabTest,
} from './api.js';

const KINDS: LabKind[] = ['extension', 'skill', 'prompt', 'theme'];

interface TestRow {
  tool: string;
  input: string;
  expectContains: string;
  expectError: boolean;
}

const emptyRow = (): TestRow => ({ tool: '', input: '{}', expectContains: '', expectError: false });
const rowFrom = (t: LabTest): TestRow => ({
  tool: t.tool,
  input: JSON.stringify(t.input),
  expectContains: t.expectContains ?? '',
  expectError: t.expectError ?? false,
});

/** Turns editor rows into API tests, or returns the first problem. */
function toTests(rows: TestRow[]): { tests: LabTest[] } | { error: string } {
  const tests: LabTest[] = [];
  for (const [i, r] of rows.entries()) {
    if (!r.tool.trim()) continue;
    let input: unknown;
    try {
      input = JSON.parse(r.input || '{}');
    } catch {
      return { error: `Test ${i + 1}: input is not valid JSON` };
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { error: `Test ${i + 1}: input must be a JSON object` };
    }
    tests.push({
      tool: r.tool.trim(),
      input: input as Record<string, unknown>,
      ...(r.expectContains ? { expectContains: r.expectContains } : {}),
      ...(r.expectError ? { expectError: true } : {}),
    });
  }
  return { tests };
}

const mono = { fontFamily: 'ui-monospace, monospace', fontSize: 13 } as const;

function Diagnostics({ items }: { items: LabDiagnostic[] }) {
  if (items.length === 0) return null;
  return (
    <ul style={{ paddingLeft: 18 }}>
      {items.map((d, i) => (
        <li key={i} style={{ color: d.type === 'error' ? 'crimson' : 'darkorange' }}>
          <strong>{d.kind}</strong> {d.path}: {d.message}
        </li>
      ))}
    </ul>
  );
}

function Results({ result }: { result: LabRun }) {
  const r = result.report;
  const failed = result.status !== 'completed' || !r?.ok;
  return (
    <div style={{ border: '1px solid #8886', borderRadius: 6, padding: 12, margin: '12px 0' }}>
      <strong style={{ color: failed ? 'crimson' : 'seagreen' }}>
        {result.status === 'timeout'
          ? 'Timed out'
          : result.status === 'no-report'
            ? 'No report produced'
            : r?.ok
              ? 'Passed'
              : 'Failed'}
      </strong>{' '}
      <small>
        {result.run.files} files copied, {(result.run.durationMs / 1000).toFixed(1)} s
        {r?.sdkVersion ? `, pi ${r.sdkVersion}` : ''}
      </small>
      {result.run.skipped.length > 0 && (
        <details>
          <summary>{result.run.skipped.length} item(s) not copied</summary>
          <ul>
            {result.run.skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      )}
      {r && (
        <>
          {r.harnessError && (
            <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{r.harnessError}</pre>
          )}
          {r.sessionError && <p style={{ color: 'crimson' }}>Session error: {r.sessionError}</p>}
          {(r.extensionErrors ?? []).map((e) => (
            <p key={e.path} style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>
              <strong>{e.path}</strong> failed to load: {e.error}
            </p>
          ))}
          <Diagnostics items={r.diagnostics ?? []} />
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px' }}>
            <dt>Extensions</dt>
            <dd>{(r.extensions ?? []).join(', ') || 'none'}</dd>
            <dt>Tools</dt>
            <dd>
              {(r.tools ?? []).length === 0
                ? 'none'
                : (r.tools ?? []).map((t) => (
                    <details key={t.name}>
                      <summary>
                        <code>{t.name}</code> &mdash; {t.description}
                      </summary>
                      <pre style={mono}>{JSON.stringify(t.parameters, null, 2)}</pre>
                    </details>
                  ))}
            </dd>
            <dt>Commands</dt>
            <dd>{(r.commands ?? []).map((c) => `/${c.name}`).join(', ') || 'none'}</dd>
            <dt>Skills</dt>
            <dd>{(r.skills ?? []).map((s) => s.name).join(', ') || 'none'}</dd>
            <dt>Prompts</dt>
            <dd>{(r.prompts ?? []).map((p) => `/${p.name}`).join(', ') || 'none'}</dd>
            <dt>Themes</dt>
            <dd>{(r.themes ?? []).map((t) => t.name).join(', ') || 'none'}</dd>
          </dl>
          {(r.tests ?? []).length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th align="left">Test</th>
                  <th align="left">Result</th>
                  <th align="left">Detail</th>
                </tr>
              </thead>
              <tbody>
                {(r.tests ?? []).map((t, i) => (
                  <tr key={i}>
                    <td>
                      {t.ok ? '✓' : '✗'} <code>{t.tool}</code>
                    </td>
                    <td>{t.status}</td>
                    <td style={{ whiteSpace: 'pre-wrap', ...mono }}>
                      {t.schemaErrors.length > 0
                        ? t.schemaErrors.join('\n')
                        : (t.error ?? t.output)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {result.run.stderr && (
        <details>
          <summary>stderr</summary>
          <pre style={{ ...mono, whiteSpace: 'pre-wrap' }}>{result.run.stderr}</pre>
        </details>
      )}
    </div>
  );
}

export function Lab({ projectId }: { projectId: number }) {
  const [packages, setPackages] = useState<LabPackage[]>([]);
  const [selected, setSelected] = useState('');
  const [rows, setRows] = useState<TestRow[]>([]);
  const [name, setName] = useState('');
  const [kinds, setKinds] = useState<Set<LabKind>>(new Set(['extension']));
  const [result, setResult] = useState<LabRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const refresh = async (select?: string) => {
    const list = await listLabPackages(projectId);
    setPackages(list);
    setSelected(
      (cur) => select ?? (list.some((p) => p.path === cur) ? cur : (list[0]?.path ?? '')),
    );
  };

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [projectId]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const created = await scaffoldLabPackage(projectId, name.trim(), [...kinds]);
      setName('');
      setResult(null);
      setRows(created.sampleTests.map(rowFrom));
      await refresh(created.package.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  async function run() {
    const parsed = toTests(rows);
    if ('error' in parsed) return setError(parsed.error);
    setError('');
    setRunning(true);
    setResult(null);
    try {
      setResult(await runLab(projectId, selected, parsed.tests));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRunning(false);
    }
  }

  const update = (i: number, patch: Partial<TestRow>) =>
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toolNames = (result?.report?.tools ?? []).map((t) => t.name);

  return (
    <details style={{ margin: '12px 0' }} open>
      <summary>Package lab</summary>
      <p style={{ margin: '8px 0' }}>
        Build and test extensions, skills, prompts and themes. Runs use a throwaway container with
        no network and no credentials. Results are advisory: the package&apos;s own code runs there
        and could influence the report.
      </p>
      <form
        onSubmit={create}
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
      >
        <input
          placeholder="new-package-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {KINDS.map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={(e) => {
                const next = new Set(kinds);
                if (e.target.checked) next.add(k);
                else next.delete(k);
                setKinds(next);
              }}
            />{' '}
            {k}
          </label>
        ))}
        <button disabled={!name.trim() || kinds.size === 0}>Create starter package</button>
      </form>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <select aria-label="Package" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {packages.length === 0 && <option value="">No packages found</option>}
          {packages.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path}
              {p.name ? ` (${p.name})` : ''}
            </option>
          ))}
        </select>
        <button onClick={() => void refresh().catch((e: Error) => setError(e.message))}>
          Rescan
        </button>
      </div>

      {selected && (
        <>
          <datalist id="lab-tools">
            {toolNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map((r, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}
              >
                <input
                  list="lab-tools"
                  placeholder="tool name"
                  aria-label={`Test ${i + 1} tool`}
                  value={r.tool}
                  onChange={(e) => update(i, { tool: e.target.value })}
                />
                <textarea
                  rows={2}
                  aria-label={`Test ${i + 1} input`}
                  value={r.input}
                  onChange={(e) => update(i, { input: e.target.value })}
                  style={{ ...mono, minWidth: 240 }}
                />
                <input
                  placeholder="output contains (optional)"
                  aria-label={`Test ${i + 1} expected output`}
                  value={r.expectContains}
                  onChange={(e) => update(i, { expectContains: e.target.value })}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={r.expectError}
                    onChange={(e) => update(i, { expectError: e.target.checked })}
                  />{' '}
                  expect error
                </label>
                <button onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
            <button onClick={() => setRows((cur) => [...cur, emptyRow()])}>Add tool test</button>
            <button disabled={running} onClick={() => void run()}>
              {running ? 'Running in a throwaway container...' : 'Run in lab'}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      {result && <Results result={result} />}
    </details>
  );
}
