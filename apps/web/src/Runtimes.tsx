import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Radio,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  buildRuntime,
  listRuntimes,
  setProjectRuntime,
  type Project,
  type RuntimeState,
} from './api.js';
import { ErrorText } from './ui.js';

const mb = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

/**
 * Which toolchains a project's container has. The runtime images are built on this machine from the
 * sandbox image (the sandbox itself has no network), and a project switches by recreating its
 * container, which keeps the workspace and session history.
 */
export function Runtimes({
  project,
  busy,
  onChange,
  onRecreate,
}: {
  project: Project;
  busy: boolean;
  onChange: (p: Project) => void;
  onRecreate: () => void;
}) {
  const [runtimes, setRuntimes] = useState<RuntimeState[] | null>(null);
  const [error, setError] = useState('');

  const refresh = () =>
    listRuntimes()
      .then(setRuntimes)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, []);

  const building = runtimes?.some((r) => r.build.status === 'building') ?? false;
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [building]);

  async function choose(id: string) {
    setError('');
    try {
      onChange(await setProjectRuntime(project.id, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the runtime');
    }
  }

  async function build(id: string) {
    setError('');
    try {
      setRuntimes(await buildRuntime(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the build');
    }
  }

  if (!runtimes) return error ? <ErrorText error={error} /> : <Loader size="sm" />;

  return (
    <Stack gap="md">
      <Stack gap={2}>
        <Title order={4}>Runtime</Title>
        <Text size="sm" c="dimmed">
          Pick the tools this project's container has. The agent is told what is installed, so it
          can run tests with it. The sandbox has no network: nothing can be downloaded inside it.
        </Text>
      </Stack>
      {project.runtimePending && (
        <Alert color="blue" variant="light" title="Waiting for a new container">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              The container still runs the previous runtime. Recreate it to switch. Files and
              session history are kept; running sessions stop.
            </Text>
            <Button size="xs" loading={busy} onClick={onRecreate}>
              Recreate container
            </Button>
          </Group>
        </Alert>
      )}
      <ErrorText error={error} />
      <Radio.Group value={project.runtime} onChange={(v) => void choose(v)}>
        <Stack gap="sm">
          {runtimes.map((r) => {
            const log = r.build.log.slice(-60);
            return (
              <Card key={r.id} padding="md" withBorder>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Radio
                    value={r.id}
                    disabled={!r.present}
                    label={
                      <Group gap="xs">
                        <Text fw={600}>{r.label}</Text>
                        {r.sizeBytes ? (
                          <Text size="xs" c="dimmed">
                            {mb(r.sizeBytes)}
                          </Text>
                        ) : null}
                        {r.stale && (
                          <Badge color="orange" variant="light">
                            base was rebuilt
                          </Badge>
                        )}
                      </Group>
                    }
                    description={r.description}
                  />
                  {r.id !== 'base' && (
                    <Button
                      size="xs"
                      variant={r.present ? 'default' : 'filled'}
                      loading={r.build.status === 'building'}
                      disabled={building && r.build.status !== 'building'}
                      onClick={() => void build(r.id)}
                    >
                      {r.present ? 'Rebuild' : 'Build'}
                    </Button>
                  )}
                </Group>
                {r.build.status !== 'idle' && (
                  <Stack gap={4} mt="sm">
                    {r.build.status === 'failed' && r.build.error && (
                      <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                        {r.build.error}
                      </Text>
                    )}
                    <Code
                      block
                      style={{
                        fontSize: 12,
                        maxHeight: 180,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {log.join('\n') || '(waiting for output)'}
                    </Code>
                    <Anchor
                      href={`/api/runtimes/${r.id}/log`}
                      download={`${r.id}-build.log`}
                      size="sm"
                    >
                      Download the build log
                    </Anchor>
                  </Stack>
                )}
              </Card>
            );
          })}
        </Stack>
      </Radio.Group>
      <Text size="xs" c="dimmed">
        Images are built from <Code>docker/runtimes</Code> on top of the sandbox image, so build the
        sandbox image first. After rebuilding it, rebuild the runtimes marked above.
      </Text>
    </Stack>
  );
}
