import { useState, type FormEvent } from 'react';
import {
  createMcpServer,
  updateMcpServer,
  type McpEntry,
  type McpEntryInput,
  type McpExposure,
  type McpServer,
  type McpServerInput,
} from './api.js';

interface Row {
  key: string;
  value: string;
  secret: boolean;
  /** A stored secret that stays unchanged while its value box is left empty. */
  stored: boolean;
}

const rowsFrom = (entries: McpEntry[] | undefined): Row[] =>
  (entries ?? []).map((e) => ({
    key: e.key,
    value: e.value ?? '',
    secret: e.secret,
    stored: e.secret && e.hasValue,
  }));

const toInputs = (rows: Row[]): McpEntryInput[] =>
  rows
    .filter((r) => r.key.trim())
    .map((r) => ({
      key: r.key.trim(),
      secret: r.secret,
      // Leaving a stored secret blank keeps it; anything else sends the typed value.
      ...(r.secret && r.stored && r.value === '' ? {} : { value: r.value }),
    }));

function Rows({
  label,
  rows,
  onChange,
  keyPlaceholder,
}: {
  label: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  keyPlaceholder: string;
}) {
  const update = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset style={{ border: '1px solid #8886', borderRadius: 6 }}>
      <legend>{label}</legend>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <input
            placeholder={keyPlaceholder}
            aria-label={`${label} name ${i + 1}`}
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            type={r.secret ? 'password' : 'text'}
            autoComplete="off"
            placeholder={r.stored ? '(stored: leave blank to keep)' : 'value'}
            aria-label={`${label} value ${i + 1}`}
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <label>
            <input
              type="checkbox"
              checked={r.secret}
              onChange={(e) => update(i, { secret: e.target.checked, stored: false })}
            />{' '}
            secret
          </label>
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '', secret: false, stored: false }])}
      >
        Add
      </button>
    </fieldset>
  );
}

export function McpServerForm({
  initial,
  preset,
  onSaved,
  onCancel,
}: {
  initial?: McpServer;
  preset?: McpServerInput & { name: string };
  onSaved: () => void;
  onCancel: () => void;
}) {
  const base = initial ?? preset;
  const [name, setName] = useState(base?.name ?? '');
  const [type, setType] = useState<'stdio' | 'http'>(initial?.type ?? preset?.type ?? 'stdio');
  const [description, setDescription] = useState(base?.description ?? '');
  const [command, setCommand] = useState(base?.command ?? '');
  const [args, setArgs] = useState((base?.args ?? []).join('\n'));
  const [cwd, setCwd] = useState(base?.cwd ?? '');
  const [url, setUrl] = useState(base?.url ?? '');
  const [exposure, setExposure] = useState<McpExposure | ''>(base?.exposure ?? '');
  const [timeout, setTimeoutSecs] = useState(base?.timeout ? String(base.timeout) : '');
  const [env, setEnv] = useState<Row[]>(
    initial
      ? rowsFrom(initial.env)
      : (preset?.env ?? []).map((e) => ({
          key: e.key,
          value: e.value ?? '',
          secret: e.secret,
          stored: false,
        })),
  );
  const [headers, setHeaders] = useState<Row[]>(
    initial
      ? rowsFrom(initial.headers)
      : (preset?.headers ?? []).map((e) => ({
          key: e.key,
          value: e.value ?? '',
          secret: e.secret,
          stored: false,
        })),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const input: McpServerInput = {
      description,
      exposure: exposure || null,
      timeout: timeout ? Number(timeout) : null,
      ...(type === 'stdio'
        ? { command, args: args.split('\n').filter((a) => a !== ''), cwd, env: toInputs(env) }
        : { url, headers: toInputs(headers) }),
    };
    try {
      if (initial) await updateMcpServer(initial.id, input);
      else await createMcpServer({ ...input, name: name.trim(), type });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 8, maxWidth: 560, margin: '12px 0' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          placeholder="Name (letters, digits, - and _)"
          value={name}
          disabled={!!initial}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="Server type"
          value={type}
          disabled={!!initial}
          onChange={(e) => setType(e.target.value as 'stdio' | 'http')}
        >
          <option value="stdio">Command (runs in the project container)</option>
          <option value="http">URL (streamable HTTP)</option>
        </select>
      </div>
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {type === 'stdio' ? (
        <>
          <input
            placeholder="Command, e.g. npx"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <textarea
            rows={3}
            placeholder={'Arguments, one per line\n-y\n@scope/server@1.2.3'}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            style={{ fontFamily: 'ui-monospace, monospace' }}
          />
          <input
            placeholder="Working directory (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <Rows label="Environment" rows={env} onChange={setEnv} keyPlaceholder="NAME" />
        </>
      ) : (
        <>
          <input
            placeholder="https://host/mcp  (a host service: http://host.docker.internal:PORT/mcp)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Rows
            label="Headers"
            rows={headers}
            onChange={setHeaders}
            keyPlaceholder="Authorization"
          />
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          Exposure{' '}
          <select
            value={exposure}
            onChange={(e) => setExposure(e.target.value as McpExposure | '')}
          >
            <option value="">pi default (codemode)</option>
            <option value="direct">direct: always shown to the model</option>
            <option value="deferred">deferred: found via tool search</option>
            <option value="codemode">codemode: called from scripts</option>
            <option value="hidden">hidden</option>
          </select>
        </label>
        <label>
          Timeout (s){' '}
          <input
            type="number"
            min={1}
            max={600}
            style={{ width: 80 }}
            value={timeout}
            onChange={(e) => setTimeoutSecs(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p role="alert" style={{ color: 'crimson', margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy || (!initial && !name.trim())}>
          {initial ? 'Save' : 'Add server'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
