import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { ProjectView } from './ProjectView.js';
import {
  createProject,
  deleteProject,
  getSandbox,
  listProjects,
  restartProject,
  type Project,
} from './api.js';
import { PROJECT_STATUS } from './projectStatus.js';
import { navigate } from './router.js';
import { ErrorText, PageHeader, Tip } from './ui.js';

export function Projects({ projectId, sessionId }: { projectId?: number; sessionId?: number }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sandboxReady, setSandboxReady] = useState(true);

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    if (projectId !== undefined) return;
    void refresh();
    getSandbox()
      .then((s) => setSandboxReady(s.available))
      .catch(() => setSandboxReady(true));
  }, [projectId]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await createProject(name);
      setName('');
    });
  }

  if (projectId !== undefined) {
    return (
      <ProjectView
        projectId={projectId}
        sessionId={sessionId}
        onBack={() => navigate({ tab: 'projects' })}
      />
    );
  }

  return (
    <Stack>
      <PageHeader
        title="Projects"
        description="Each project is its own sandboxed container with a workspace. Open one to start an agent session."
      />
      {!sandboxReady && (
        <Alert color="orange" variant="light" title="Sandbox image not built">
          Project containers are created from the sandbox image, which is not on this machine yet.
          Build it with <code>docker build -t pi-panel/sandbox-base:latest docker/base</code> from
          the Pi-Panel source directory, then reload this page.
        </Alert>
      )}
      <form onSubmit={add}>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Tip label="Creates a sandbox container for this project">
            <Button type="submit" disabled={busy || !name.trim()}>
              Create
            </Button>
          </Tip>
        </Group>
      </form>
      <ErrorText error={error} />
      {projects.length === 0 ? (
        <Text c="dimmed">No projects yet.</Text>
      ) : (
        <Stack gap="xs">
          {projects.map((p) => (
            <Paper key={p.id} withBorder p="sm" radius="md">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <Tip label="Open this project">
                    <Button
                      variant="subtle"
                      onClick={() => navigate({ tab: 'projects', projectId: p.id })}
                    >
                      {p.name}
                    </Button>
                  </Tip>
                  <Tip label={PROJECT_STATUS[p.status]?.hint ?? p.status}>
                    <Badge variant="light" color={PROJECT_STATUS[p.status]?.color ?? 'gray'}>
                      {p.status}
                    </Badge>
                  </Tip>
                  {(p.status === 'stopped' || p.status === 'missing') && (
                    <Button
                      size="xs"
                      variant="light"
                      disabled={busy}
                      onClick={() => void run(() => restartProject(p.id))}
                    >
                      Start
                    </Button>
                  )}
                </Group>
                <Tip label="Removes the container and its workspace files">
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Delete "${p.name}" and its workspace?`))
                        void run(() => deleteProject(p.id));
                    }}
                  >
                    Delete
                  </Button>
                </Tip>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
