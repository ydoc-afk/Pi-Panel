import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Code, Group, Stack, Text } from '@mantine/core';
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
import { Collapsible, ErrorText } from './ui.js';

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
    <Collapsible
      title={`MCP servers${state ? ` (${servers.filter((s) => s.enabled).length} on)` : ''}`}
    >
      <Stack gap="sm">
        {state && servers.length === 0 && (
          <Text size="sm" c="dimmed">
            No servers in the library yet. Add some in the MCP tab.
          </Text>
        )}
        {servers.map((p) => {
          const tools = p.server.discovery?.tools ?? [];
          const managed = p.server.type === 'managed';
          const side = state?.sidecars[p.server.id];
          const running = side?.state === 'running';
          return (
            <Stack key={p.server.id} gap={4}>
              <Checkbox
                checked={p.enabled}
                onChange={(e) => void change(p.server.id, { enabled: e.currentTarget.checked })}
                label={
                  <>
                    <Text span fw={600} size="sm">
                      {p.server.name}
                    </Text>
                    {managed && (
                      <Text span size="xs" c="dimmed">
                        {' '}
                        (managed container)
                      </Text>
                    )}
                    {p.server.description && (
                      <Text span size="xs" c="dimmed">
                        {' '}
                        &mdash; {p.server.description}
                      </Text>
                    )}
                  </>
                }
              />
              {managed && p.enabled && (
                <Stack gap={4} ml={28}>
                  {working === p.server.id ? (
                    <Text size="sm" c="dimmed">
                      Working&hellip; a container can take a minute to start.
                    </Text>
                  ) : (
                    <Group gap="xs">
                      <Text size="sm">Container:</Text>
                      <Badge variant="light" color={running ? 'green' : 'orange'}>
                        {describeState(side)}
                      </Badge>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => void control(p.server.id, running ? 'restart' : 'start')}
                      >
                        {running ? 'Restart' : 'Start'}
                      </Button>
                      {running && (
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          onClick={() => void control(p.server.id, 'stop')}
                        >
                          Stop
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() =>
                          void sidecarLogs(projectId, p.server.id)
                            .then((l) =>
                              setLogs((cur) => ({ ...cur, [p.server.id]: l || '(no output)' })),
                            )
                            .catch((e: Error) => setError(e.message))
                        }
                      >
                        Logs
                      </Button>
                    </Group>
                  )}
                  {logs[p.server.id] !== undefined && (
                    <Code
                      block
                      style={{
                        fontSize: 12,
                        maxHeight: 200,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {logs[p.server.id]}
                    </Code>
                  )}
                </Stack>
              )}
              {p.enabled && p.server.discovery?.state === 'failed' && (
                <Text size="sm" c="red" ml={28}>
                  The last test failed: {p.server.discovery.error}
                </Text>
              )}
              {p.enabled && !p.server.discovery && (
                <Text size="xs" c="dimmed" ml={28}>
                  Not tested yet. Use &ldquo;Test connection&rdquo; in the MCP tab to list its
                  tools.
                </Text>
              )}
              {p.enabled && tools.length > 0 && (
                <Stack gap={4} ml={28}>
                  <Collapsible
                    defaultOpen={false}
                    title={`Tools (${tools.length - tools.filter((t) => p.hiddenTools.includes(t.name)).length} of ${tools.length} on${p.hiddenOverride ? ', customised for this project' : ''})`}
                  >
                    <McpToolList
                      tools={tools}
                      hidden={p.hiddenTools}
                      onChange={(hidden) => void change(p.server.id, { hiddenTools: hidden })}
                    />
                    {p.hiddenOverride && (
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => void change(p.server.id, { hiddenTools: null })}
                      >
                        Reset to the server&apos;s defaults
                      </Button>
                    )}
                  </Collapsible>
                </Stack>
              )}
            </Stack>
          );
        })}
        {usesSamples && <Samples projectId={projectId} />}
        {notice && <Text size="sm">{notice}</Text>}
        <ErrorText error={error} />
      </Stack>
    </Collapsible>
  );
}
