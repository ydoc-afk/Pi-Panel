import { useEffect, useState } from 'react';
import { listProjectMcp, setProjectMcp, type McpApplied, type McpProjectServer } from './api.js';
import { McpToolList } from './McpToolList.js';

export function ProjectMcp({ projectId }: { projectId: number }) {
  const [servers, setServers] = useState<McpProjectServer[] | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listProjectMcp(projectId)
      .then(setServers)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  async function change(
    serverId: number,
    patch: { enabled?: boolean; hiddenTools?: string[] | null },
  ) {
    setBusy(true);
    setError('');
    const before = servers;
    // Optimistic: flip the control immediately and reconcile with the server's answer.
    setServers((cur) =>
      (cur ?? []).map((p) =>
        p.server.id !== serverId
          ? p
          : {
              ...p,
              ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
              ...(patch.hiddenTools === undefined
                ? {}
                : {
                    hiddenOverride: patch.hiddenTools,
                    hiddenTools: patch.hiddenTools ?? p.server.defaultHidden,
                  }),
            },
      ),
    );
    try {
      const result = await setProjectMcp(projectId, serverId, patch);
      setServers(result.servers);
      setNotice(applied(result));
    } catch (e) {
      setServers(before);
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const applied = (r: McpApplied) => {
    const parts: string[] = [];
    if (r.restartedSessions > 0)
      parts.push(`${r.restartedSessions} idle session(s) will reload on their next prompt.`);
    if (r.pendingSessions > 0)
      parts.push(`${r.pendingSessions} running session(s) reload when their current run finishes.`);
    return parts.join(' ');
  };

  return (
    <details style={{ margin: '12px 0' }} open>
      <summary>
        MCP servers{servers ? ` (${servers.filter((s) => s.enabled).length} on)` : ''}
      </summary>
      {servers && servers.length === 0 && (
        <p>No servers in the library yet. Add some in the MCP tab.</p>
      )}
      <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
        {(servers ?? []).map((p) => {
          const tools = p.server.discovery?.tools ?? [];
          return (
            <li key={p.server.id}>
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={p.enabled}
                  onChange={(e) => void change(p.server.id, { enabled: e.target.checked })}
                />{' '}
                <strong>{p.server.name}</strong>
                {p.server.description && <small> &mdash; {p.server.description}</small>}
              </label>
              {p.enabled && p.server.discovery?.state === 'failed' && (
                <div style={{ color: 'crimson' }}>
                  The last test failed: {p.server.discovery.error}
                </div>
              )}
              {p.enabled && !p.server.discovery && (
                <div>
                  <small>
                    Not tested yet. Use &ldquo;Test connection&rdquo; in the MCP tab to list its
                    tools.
                  </small>
                </div>
              )}
              {p.enabled && tools.length > 0 && (
                <details>
                  <summary>
                    Tools (
                    {tools.length - tools.filter((t) => p.hiddenTools.includes(t.name)).length} of{' '}
                    {tools.length} on
                    {p.hiddenOverride ? ', customised for this project' : ''})
                  </summary>
                  <McpToolList
                    tools={tools}
                    hidden={p.hiddenTools}
                    disabled={busy}
                    onChange={(hidden) => void change(p.server.id, { hiddenTools: hidden })}
                  />
                  {p.hiddenOverride && (
                    <button
                      disabled={busy}
                      onClick={() => void change(p.server.id, { hiddenTools: null })}
                    >
                      Reset to the server&apos;s defaults
                    </button>
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {notice && <p>{notice}</p>}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </details>
  );
}
