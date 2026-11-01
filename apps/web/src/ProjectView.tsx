import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Breadcrumbs,
  Button,
  Grid,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBrandGithub,
  IconFlask,
  IconFolder,
  IconPackage,
  IconPencil,
  IconPlayerPlay,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconX,
} from '@tabler/icons-react';
import {
  createSession,
  deleteSession,
  getProject,
  listProviders,
  listSessions,
  recreateProject,
  renameSession,
  restartProject,
  type Project,
  type Provider,
  type Session,
} from './api.js';
import { GitHubPanel } from './GitHubPanel.js';
import { Lab } from './Lab.js';
import { Packages } from './Packages.js';
import { ProjectMcp } from './ProjectMcp.js';
import { ProjectStatusBadge } from './ProjectStatusBadge.js';
import { navigate } from './router.js';
import { SessionView } from './SessionView.js';
import { EmptyState, ErrorText, FlatSection, StatusBadge, Tip } from './ui.js';

/** How often the session list refreshes, so running/idle badges stay current. */
const POLL_MS = 3000;

function SessionItem({
  session: s,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Paper
      withBorder
      shadow="none"
      radius="md"
      px="sm"
      py={8}
      style={{
        position: 'relative',
        borderColor: active ? 'var(--mantine-primary-color-filled)' : undefined,
        background: active ? 'var(--mantine-primary-color-light)' : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <UnstyledButton
          className="pp-stretched"
          onClick={onSelect}
          aria-pressed={active}
          style={{ minWidth: 0, flex: 1 }}
        >
          <Group gap={8} wrap="nowrap">
            <IconTerminal2 size={16} stroke={1.6} style={{ flexShrink: 0 }} />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} truncate>
                {s.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {s.modelId ?? 'pi default model'}
              </Text>
            </Stack>
          </Group>
        </UnstyledButton>
        <Group gap={2} wrap="nowrap" className="pp-above">
          {s.status !== 'idle' && <StatusBadge status={s.status} />}
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Rename ${s.name}`}
            onClick={onRename}
          >
            <IconPencil size={14} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label={`Delete ${s.name}`}
            onClick={onDelete}
          >
            <IconX size={14} />
          </ActionIcon>
        </Group>
      </Group>
    </Paper>
  );
}

export function ProjectView({
  projectId,
  sessionId,
  onBack,
}: {
  projectId: number;
  sessionId?: number;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);

  const select = (id?: number) => navigate({ tab: 'projects', projectId, sessionId: id });

  const refresh = () =>
    listSessions(projectId)
      .then(setSessions)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    setProject(null);
    getProject(projectId)
      .then(setProject)
      .catch((e: Error) => setError(e.message));
    void refresh();
    listProviders()
      .then(setProviders)
      .catch((e: Error) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden) void listSessions(projectId).then(setSessions, () => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId]);

  async function containerAction(action: 'restart' | 'recreate') {
    if (
      action === 'recreate' &&
      !confirm(
        'Replace the container with a fresh one from the current sandbox image? Running sessions stop. ' +
          'Workspace files and session history are kept; anything installed elsewhere in the container is not.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      setProject(await (action === 'restart' ? restartProject : recreateProject)(projectId));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Container action failed');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    try {
      const [providerId, ...rest] = choice.split(':');
      const s = await createSession(
        projectId,
        choice ? { providerId: Number(providerId), modelId: rest.join(':') } : undefined,
      );
      await refresh();
      select(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
    }
  }

  async function rename(s: Session) {
    const name = prompt('Session name', s.name)?.trim();
    if (!name || name === s.name) return;
    try {
      await renameSession(s.id, name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename session');
    }
  }

  async function remove(s: Session) {
    if (!confirm(`Delete "${s.name}" and its transcript?`)) return;
    try {
      await deleteSession(s.id);
      if (sessionId === s.id) select(undefined);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete session');
    }
  }

  const crumbs = (
    <Breadcrumbs separator="/" fz="sm">
      <Anchor component="button" type="button" onClick={onBack} size="sm">
        Projects
      </Anchor>
      <Text size="sm" c="dimmed">
        {project?.name ?? '…'}
      </Text>
    </Breadcrumbs>
  );

  if (!project) {
    return (
      <Stack gap="lg">
        {crumbs}
        {error ? <ErrorText error={error} /> : <Loader size="sm" />}
      </Stack>
    );
  }

  const modelOptions = providers
    .filter((p) => p.models.length > 0)
    .map((p) => ({
      group: p.name,
      items: p.models.map((m) => ({ value: `${p.id}:${m}`, label: m })),
    }));
  const current = sessions.find((s) => s.id === sessionId);
  const running = project.status === 'running';

  return (
    <Stack gap="lg">
      <Stack gap={6}>
        {crumbs}
        <Group justify="space-between" wrap="wrap" gap="md">
          <Group gap="md" wrap="nowrap">
            <ThemeIcon variant="light" size={44} radius="md">
              <IconFolder size={24} stroke={1.6} />
            </ThemeIcon>
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Group gap="sm">
                <Title order={2} style={{ letterSpacing: '-0.015em' }}>
                  {project.name}
                </Title>
                <ProjectStatusBadge status={project.status} />
              </Group>
              <Text size="sm" c="dimmed">
                {sessions.length} session{sessions.length === 1 ? '' : 's'}
                {project.repo ? ` · ${project.repo}` : ''}
              </Text>
            </Stack>
          </Group>
          <Group gap="xs">
            {!running && (
              <Button
                size="xs"
                leftSection={<IconPlayerPlay size={14} />}
                loading={busy}
                onClick={() => void containerAction('restart')}
              >
                Start container
              </Button>
            )}
            <Tip label="Fresh container from the current sandbox image, e.g. after upgrading pi. Files and history are kept.">
              <Button
                size="xs"
                variant="default"
                leftSection={<IconRefresh size={14} />}
                disabled={busy}
                onClick={() => void containerAction('recreate')}
              >
                Recreate container
              </Button>
            </Tip>
          </Group>
        </Group>
      </Stack>

      <ErrorText error={error} />

      <Tabs defaultValue="sessions" variant="pills" radius="md">
        <Tabs.List mb="md">
          <Tabs.Tab value="sessions" leftSection={<IconTerminal2 size={16} />}>
            Sessions
          </Tabs.Tab>
          <Tabs.Tab value="github" leftSection={<IconBrandGithub size={16} />}>
            GitHub
          </Tabs.Tab>
          <Tabs.Tab value="mcp" leftSection={<IconPlug size={16} />}>
            MCP
          </Tabs.Tab>
          <Tabs.Tab value="packages" leftSection={<IconPackage size={16} />}>
            Packages
          </Tabs.Tab>
          <Tabs.Tab value="lab" leftSection={<IconFlask size={16} />}>
            Lab
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="sessions">
          <Grid gap="md">
            <Grid.Col span={{ base: 12, md: 4, lg: 3 }}>
              <Stack gap="sm">
                <Paper withBorder radius="lg" p="sm">
                  <Stack gap="xs">
                    <Select
                      aria-label="Model"
                      placeholder="No model (pi default)"
                      size="sm"
                      clearable
                      value={choice || null}
                      data={modelOptions}
                      onChange={(v) => setChoice(v ?? '')}
                    />
                    <Tip
                      label={
                        running
                          ? "Starts pi in this project's container with the chosen model"
                          : 'Start the container first'
                      }
                    >
                      <Button
                        fullWidth
                        leftSection={<IconPlus size={16} />}
                        disabled={!running}
                        onClick={() => void add()}
                      >
                        New session
                      </Button>
                    </Tip>
                  </Stack>
                </Paper>
                {sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={sessionId === s.id}
                    onSelect={() => select(s.id)}
                    onRename={() => void rename(s)}
                    onDelete={() => void remove(s)}
                  />
                ))}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
              {sessionId !== undefined ? (
                <SessionView key={sessionId} sessionId={sessionId} name={current?.name} />
              ) : (
                <EmptyState icon={IconTerminal2} title="No session open">
                  {sessions.length > 0
                    ? 'Pick a session on the left to see its transcript, or start a new one.'
                    : 'Start a session to talk to pi in this project. Its transcript is kept, so you can come back to it.'}
                </EmptyState>
              )}
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <FlatSection>
          <Tabs.Panel value="github">
            <GitHubPanel projectId={projectId} />
          </Tabs.Panel>
          <Tabs.Panel value="mcp">
            <ProjectMcp projectId={projectId} />
          </Tabs.Panel>
          <Tabs.Panel value="packages">
            <Packages projectId={projectId} />
          </Tabs.Panel>
          <Tabs.Panel value="lab">
            <Lab projectId={projectId} />
          </Tabs.Panel>
        </FlatSection>
      </Tabs>
    </Stack>
  );
}
