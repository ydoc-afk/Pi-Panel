import { useEffect, useState } from 'react';
import {
  deleteMcpServer,
  discoverMcp,
  importMcp,
  listMcpPresets,
  listMcpServers,
  setMcpDefaultHidden,
  type McpPreset,
  type McpServer,
  type McpServerInput,
} from './api.js';
import { McpServerForm } from './McpServerForm.js';
import { McpToolList } from './McpToolList.js';

type Mode =
  | { kind: 'none' }
  | { kind: 'form'; preset?: McpServerInput & { name: string } }
  | { kind: 'import' }
  | { kind: 'edit'; id: number };

function StateBadge({ server, testing }: { server: McpServer; testing: boolean }) {
  if (testing) return <span>testing&hellip;</span>;
  const d = server.discovery;
  if (!d) return <span style={{ opacity: 0.7 }}>not tested</span>;
  if (d.state === 'connected')
    return (
      <span style={{ color: 'seagreen' }}>
        connected, {d.tools.length} tool{d.tools.length === 1 ? '' : 's'}
      </span>
    );
  return <span style={{ color: 'crimson' }}>{d.state}</span>;
}

export function McpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [testing, setTesting] = useState<number | null>(null);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = () =>
    listMcpServers()
      .then(setServers)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
    listMcpPresets()
      .then(setPresets)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function act(action: () => Promise<void>) {
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  const saved = () => {
    setMode({ kind: 'none' });
    void refresh();
  };

  const doImport = () =>
    act(async () => {
      let json: unknown;
      try {
        json = JSON.parse(importText);
      } catch {
        throw new Error('That is not valid JSON');
      }
      const result = await importMcp(json, importName.trim() || undefined);
      setWarnings(result.warnings);
      setNotice(
        `Imported ${result.servers.length} server${result.servers.length === 1 ? '' : 's'}.`,
      );
      setImportText('');
      setMode({ kind: 'none' });
      await refresh();
    });

  return (
    <section>
      <h2>MCP servers</h2>
      <p style={{ maxWidth: 640 }}>
        Add servers here once, then switch them on per project. Command servers run inside the
        project container with the agent&apos;s permissions, and any secrets you give them are
        visible to the agent. Remote URL servers keep their own credentials.
      </p>

      {mode.kind === 'none' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          <strong>Add:</strong>
          {presets.map((p) => (
            <button
              key={p.id}
              title={p.description}
              onClick={() => setMode({ kind: 'form', preset: p.server })}
            >
              {p.title}
            </button>
          ))}
          <button onClick={() => setMode({ kind: 'form' })}>Custom&hellip;</button>
          <button onClick={() => setMode({ kind: 'import' })}>Paste JSON&hellip;</button>
        </div>
      )}

      {mode.kind === 'form' && (
        <>
          {mode.preset && presets.find((p) => p.server === mode.preset) && (
            <ul style={{ color: 'darkorange', maxWidth: 560 }}>
              {presets
                .find((p) => p.server === mode.preset)!
                .notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
            </ul>
          )}
          <McpServerForm
            preset={mode.preset}
            onSaved={saved}
            onCancel={() => setMode({ kind: 'none' })}
          />
        </>
      )}

      {mode.kind === 'import' && (
        <div style={{ display: 'grid', gap: 8, maxWidth: 560, margin: '12px 0' }}>
          <p style={{ margin: 0 }}>
            Paste an <code>mcpServers</code> config from Claude Desktop, Cursor and similar, or a
            single server. Values that look like secrets, or that reference environment variables,
            are added as empty secrets for you to fill in.
          </p>
          <textarea
            rows={8}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder='{ "mcpServers": { ... } }'
            style={{ fontFamily: 'ui-monospace, monospace' }}
          />
          <input
            placeholder="Name (only needed when pasting a single server)"
            value={importName}
            onChange={(e) => setImportName(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={!importText.trim()} onClick={() => void doImport()}>
              Import
            </button>
            <button onClick={() => setMode({ kind: 'none' })}>Cancel</button>
          </div>
        </div>
      )}

      {notice && <p>{notice}</p>}
      {warnings.length > 0 && (
        <ul style={{ color: 'darkorange' }}>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}

      <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 14 }}>
        {servers.map((s) => (
          <li key={s.id}>
            {mode.kind === 'edit' && mode.id === s.id ? (
              <McpServerForm
                initial={s}
                onSaved={saved}
                onCancel={() => setMode({ kind: 'none' })}
              />
            ) : (
              <div>
                <strong>{s.name}</strong> <small>({s.type === 'stdio' ? 'command' : 'URL'})</small>{' '}
                &middot; <StateBadge server={s} testing={testing === s.id} />
                {s.description && <div>{s.description}</div>}
                <div>
                  <code>{s.type === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</code>
                </div>
                {s.discovery?.error && (
                  <div style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>
                    {s.discovery.error}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, margin: '4px 0' }}>
                  <button
                    disabled={testing !== null}
                    onClick={() =>
                      void act(async () => {
                        setTesting(s.id);
                        try {
                          await discoverMcp(s.id);
                        } finally {
                          setTesting(null);
                          await refresh();
                        }
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button onClick={() => setMode({ kind: 'edit', id: s.id })}>Edit</button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${s.name}" from the library and from every project?`)) {
                        void act(async () => {
                          await deleteMcpServer(s.id);
                          await refresh();
                        });
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
                {s.discovery && s.discovery.tools.length > 0 && (
                  <details>
                    <summary>
                      Tools shown to the model by default (
                      {s.discovery.tools.length - s.defaultHidden.length} of{' '}
                      {s.discovery.tools.length})
                    </summary>
                    <McpToolList
                      tools={s.discovery.tools}
                      hidden={s.defaultHidden}
                      onChange={(hidden) => {
                        // Optimistic: show the new state at once, then reconcile with the server.
                        setServers((cur) =>
                          cur.map((x) => (x.id === s.id ? { ...x, defaultHidden: hidden } : x)),
                        );
                        void act(async () => {
                          await setMcpDefaultHidden(s.id, hidden);
                          await refresh();
                        });
                      }}
                    />
                  </details>
                )}
              </div>
            )}
          </li>
        ))}
        {servers.length === 0 && mode.kind === 'none' && (
          <li>No servers yet. Pick a starter above, or add your own.</li>
        )}
      </ul>
    </section>
  );
}
