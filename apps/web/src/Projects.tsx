import { useEffect, useState, type FormEvent } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCalendar,
  IconFolder,
  IconFolderPlus,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { ProjectView } from './ProjectView.js';
import { createProject, deleteProject, getSandbox, listProjects, type Project } from './api.js';
import { EmptyState, ErrorText, PageHeader, StatusBadge, Tip } from './ui.js';

const created = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function ProjectCard({
  project: p,
  busy,
  onOpen,
  onDelete,
}: {
  project: Project;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="pp-lift" padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon variant="light" size={40} radius="md">
              <IconFolder size={22} stroke={1.6} />
            </ThemeIcon>
            <Stack gap={2} style={{ minWidth: 0 }}>
              {/* The button's click area stretches over the whole card. */}
              <UnstyledButton
                className="pp-stretched"
                onClick={onOpen}
                aria-label={`Open ${p.name}`}
              >
                <Text fw={650} truncate>
                  {p.name}
                </Text>
              </UnstyledButton>
              <StatusBadge status={p.status} />
            </Stack>
          </Group>
          <Tip label="Removes the container and its workspace files">
            <ActionIcon
              className="pp-above"
              variant="subtle"
              color="red"
              aria-label={`Delete ${p.name}`}
              disabled={busy}
              onClick={onDelete}
            >
              <IconTrash size={16} stroke={1.6} />
            </ActionIcon>
          </Tip>
        </Group>
        <Stack gap={6}>
          <Group gap={6} wrap="nowrap" c="dimmed">
            <IconBrandGithub size={15} stroke={1.6} />
            <Text size="sm" c={p.repo ? undefined : 'dimmed'} truncate>
              {p.repo ?? 'No repository yet'}
            </Text>
          </Group>
          <Group gap={6} wrap="nowrap" c="dimmed">
            <IconCalendar size={15} stroke={1.6} />
            <Text size="sm" c="dimmed">
              Created {created(p.createdAt)}
            </Text>
          </Group>
        </Stack>
      </Stack>
    </Card>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
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
    <Stack gap="lg">
      <PageHeader
        icon={IconFolder}
        title="Projects"
        description="Each project is its own sandboxed container with a workspace. Open one to start an agent session."
        action={
          <form onSubmit={add}>
            <Group gap="xs" wrap="nowrap">
              <TextInput
                aria-label="New project name"
                placeholder="New project name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                w={{ base: '100%', xs: 240 }}
              />
              <Tip label="Creates a sandbox container for this project">
                <Button
                  type="submit"
                  leftSection={<IconPlus size={16} />}
                  loading={busy && !!name.trim()}
                  disabled={busy || !name.trim()}
                >
                  Create
                </Button>
              </Tip>
            </Group>
          </form>
        }
      />
      {!sandboxReady && (
        <Alert
          color="orange"
          variant="light"
          radius="lg"
          icon={<IconAlertTriangle size={18} />}
          title="Sandbox image not built"
        >
          Project containers are created from the sandbox image, which is not on this machine yet.
          Build it with <code>docker build -t pi-panel/sandbox-base:latest docker/base</code> from
          the Pi-Panel source directory, then reload this page.
        </Alert>
      )}
      <ErrorText error={error} />
      {projects?.length === 0 ? (
        <EmptyState icon={IconFolderPlus} title="No projects yet">
          Name your first project above. Pi-Panel creates a container and a workspace for it.
        </EmptyState>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {(projects ?? []).map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              busy={busy}
              onOpen={() => setOpen(p)}
              onDelete={() => {
                if (confirm(`Delete "${p.name}" and its workspace?`))
                  void run(() => deleteProject(p.id));
              }}
            />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
