import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Breadcrumbs,
  Button,
  Grid,
  Group,
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
  IconPlug,
  IconPlus,
  IconTerminal2,
  IconX,
} from '@tabler/icons-react';
import {
  createSession,
  deleteSession,
  listProviders,
  listSessions,
  type Project,
  type Provider,
  type Session,
} from './api.js';
import { GitHubPanel } from './GitHubPanel.js';
import { Lab } from './Lab.js';
import { Packages } from './Packages.js';
import { ProjectMcp } from './ProjectMcp.js';
import { SessionView } from './SessionView.js';
import { EmptyState, ErrorText, FlatSection, StatusBadge, Tip } from './ui.js';

function SessionItem({
  session: s,
  active,
  onSelect,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
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
        <Group gap={4} wrap="nowrap" className="pp-above">
          {s.status !== 'idle' && <StatusBadge status={s.status} />}
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
  project,
  initialSession,
  onBack,
}: {
  project: Project;
  /** A session to open straight away. */
  initialSession?: number;
  onBack: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<number | null>(initialSession ?? null);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [choice, setChoice] = useState('');

  const refresh = () =>
    listSessions(project.id)
      .then(setSessions)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
    listProviders()
      .then(setProviders)
      .catch((e: Error) => setError(e.message));
  }, [project.id]);

  async function add() {
    try {
      const [providerId, ...rest] = choice.split(':');
      const s = await createSession(
        project.id,
        choice ? { providerId: Number(providerId), modelId: rest.join(':') } : undefined,
      );
      await refresh();
      setSelected(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
    }
  }

  async function remove(s: Session) {
    if (!confirm(`Delete "${s.name}" and its transcript?`)) return;
    try {
      await deleteSession(s.id);
      if (selected === s.id) setSelected(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete session');
    }
  }

  const modelOptions = providers
    .filter((p) => p.models.length > 0)
    .map((p) => ({
      group: p.name,
      items: p.models.map((m) => ({ value: `${p.id}:${m}`, label: m })),
    }));

  return (
    <Stack gap="lg">
      <Stack gap={6}>
        <Breadcrumbs separator="/" fz="sm">
          <Anchor component="button" type="button" onClick={onBack} size="sm">
            Projects
          </Anchor>
          <Text size="sm" c="dimmed">
            {project.name}
          </Text>
        </Breadcrumbs>
        <Group gap="md" wrap="nowrap">
          <ThemeIcon variant="light" size={44} radius="md">
            <IconFolder size={24} stroke={1.6} />
          </ThemeIcon>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap="sm">
              <Title order={2} style={{ letterSpacing: '-0.015em' }}>
                {project.name}
              </Title>
              <StatusBadge status={project.status} />
            </Group>
            <Text size="sm" c="dimmed">
              {sessions.length} session{sessions.length === 1 ? '' : 's'}
              {project.repo ? ` · ${project.repo}` : ''}
            </Text>
          </Stack>
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
                    <Tip label="Starts pi in this project's container with the chosen model">
                      <Button
                        fullWidth
                        leftSection={<IconPlus size={16} />}
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
                    active={selected === s.id}
                    onSelect={() => setSelected(s.id)}
                    onDelete={() => void remove(s)}
                  />
                ))}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
              {selected !== null ? (
                <SessionView key={selected} sessionId={selected} />
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
            <GitHubPanel projectId={project.id} />
          </Tabs.Panel>
          <Tabs.Panel value="mcp">
            <ProjectMcp projectId={project.id} />
          </Tabs.Panel>
          <Tabs.Panel value="packages">
            <Packages projectId={project.id} />
          </Tabs.Panel>
          <Tabs.Panel value="lab">
            <Lab projectId={project.id} />
          </Tabs.Panel>
        </FlatSection>
      </Tabs>
    </Stack>
  );
}
