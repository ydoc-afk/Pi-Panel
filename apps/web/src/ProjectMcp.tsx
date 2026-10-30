import { useEffect, useState } from 'react';
import {
  listProjectMcp,
  setProjectMcp,
  sidecarAction,
  sidecarLogs,
  type McpApplied,
  type McpProjectState,
  type SidecarStatus,
} from './api.js';
import { McpToolList } from './McpToolList.js';
import { Samples } from './Samples.js';

const describeState = (s: SidecarStatus | undefined) =>
  !s
    ? 'unknown'
    : s.state === 'exited'
      ? `exited${s.exitCode === null ? '' : ` (code ${s.exitCode})`}`
      : s.state;

export function ProjectMcp({ projectId }: { projectId: number }) {
  const [state, setState] = useState<McpProjectState | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState<number | null>(null);
  const [logs, setLogs] = useState<Record<number, string>>({});

  useEffect(() => {
    listProjectMcp(projectId)
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  const applied = (r: McpApplied) => {
    const parts: string[] = [];
    if (r.restartedSessions > 0)
      parts.push(`${r.restartedSessions} idle session(s) will reload on their next prompt.`);
    if (r.pendingSessions > 0)
      parts.push(`${r.pendingSessions} running session(s) reload when their current run finishes.`);
    return parts.join(' ');
  };

  async function change(
    serverId: number,
    patch: { enabled?: boolean; hiddenTools?: string[] | null },
  ) {
    setError('');
    setNotice('');
    const before = state;
    const managed =
      before?.servers.find((p) => p.server.id === serverId)?.server.type === 'managed';
    // Optimistic: flip the control immediately and reconcile with the server's answer.
    setState((cur) =>
      cur
        ? {
            ...cur,
            servers: cur.servers.map((p) =>
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
          }
        : cur,
    );
    if (managed && patch.enabled) setWorking(serverId); // starting a container can take a while
    try {
      const result = await setProjectMcp(projectId, serverId, patch);
      setState({ servers: result.servers, sidecars: result.sidecars });
      setNotice(
        [
          result.sidecarError ? `The container could not start: ${result.sidecarError}` : '',
          applied(result),
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e) {
      setState(before);
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setWorking(null);
    }
  }

  async function control(serverId: number, action: 'start' | 'stop' | 'restart') {
    setError('');
    setWorking(serverId);
    try {
      const sidecar = await sidecarAction(projectId, serverId, action);
      setState((cur) =>
        cur ? { ...cur, sidecars: { ...cur.sidecars, [serverId]: sidecar } } : cur,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setState(await listProjectMcp(projectId).catch(() => null));
    } finally {
      setWorking(null);
    }
  }

  const servers = state?.servers ?? [];
  const usesSamples = servers.some(
    (p) => p.enabled && p.server.type === 'managed' && p.server.mountSamples,
  );

  return (
    <details style={{ margin: '12px 0' }} open>
      <summary>
        MCP servers{state ? ` (${servers.filter((s) => s.enabled).length} on)` : ''}
      </summary>
      {state && servers.length === 0 && (
        <p>No servers in the library yet. Add some in the MCP tab.</p>
      )}
      <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
        {servers.map((p) => {
          const tools = p.server.discovery?.tools ?? [];
          const managed = p.server.type === 'managed';
          const side = state?.sidecars[p.server.id];
          return (
            <li key={p.server.id}>
              <label>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => void change(p.server.id, { enabled: e.target.checked })}
                />{' '}
                <strong>{p.server.name}</strong>
                {managed && <small> (managed container)</small>}
                {p.server.description && <small> &mdash; {p.server.description}</small>}
              </label>
              {managed && p.enabled && (
                <div style={{ margin: '4px 0 4px 24px' }}>
                  {working === p.server.id ? (
                    <span>Working&hellip; a container can take a minute to start.</span>
                  ) : (
                    <>
                      Container:{' '}
                      <strong
                        style={{ color: side?.state === 'running' ? 'seagreen' : 'darkorange' }}
                      >
                        {describeState(side)}
                      </strong>{' '}
                      <button
                        onClick={() =>
                          void control(p.server.id, side?.state === 'running' ? 'restart' : 'start')
                        }
                      >
                        {side?.state === 'running' ? 'Restart' : 'Start'}
                      </button>{' '}
                      {side?.state === 'running' && (
                        <button onClick={() => void control(p.server.id, 'stop')}>Stop</button>
                      )}{' '}
                      <button
                        onClick={() =>
                          void sidecarLogs(projectId, p.server.id)
                            .then((l) =>
                              setLogs((cur) => ({ ...cur, [p.server.id]: l || '(no output)' })),
                            )
                            .catch((e: Error) => setError(e.message))
                        }
                      >
                        Logs
                      </button>
                    </>
                  )}
                  {logs[p.server.id] !== undefined && (
                    <pre
                      style={{
                        fontSize: 12,
                        maxHeight: 200,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {logs[p.server.id]}
                    </pre>
                  )}
                </div>
              )}
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
                    onChange={(hidden) => void change(p.server.id, { hiddenTools: hidden })}
                  />
                  {p.hiddenOverride && (
                    <button onClick={() => void change(p.server.id, { hiddenTools: null })}>
                      Reset to the server&apos;s defaults
                    </button>
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {usesSamples && <Samples projectId={projectId} />}
      {notice && <p>{notice}</p>}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </details>
  );
}
