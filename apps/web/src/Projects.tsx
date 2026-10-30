import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { ProjectView } from './ProjectView.js';
import { createProject, deleteProject, getSandbox, listProjects, type Project } from './api.js';
import { ErrorText } from './ui.js';

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Project | null>(null);
  const [sandboxReady, setSandboxReady] = useState(true);

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
    getSandbox()
      .then((s) => setSandboxReady(s.available))
      .catch(() => setSandboxReady(true));
  }, []);

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

  if (open) return <ProjectView project={open} onBack={() => setOpen(null)} />;

  return (
    <Stack>
      <Title order={2}>Projects</Title>
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
          <Button type="submit" disabled={busy || !name.trim()}>
            Create
          </Button>
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
                  <Button variant="subtle" onClick={() => setOpen(p)}>
                    {p.name}
                  </Button>
                  <Badge variant="light" color="gray">
                    {p.status}
                  </Badge>
                </Group>
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
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
