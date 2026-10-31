import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Loader, Select, Stack, Title } from '@mantine/core';
import { IconArrowLeft, IconPencil, IconX } from '@tabler/icons-react';
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
import { PROJECT_STATUS } from './projectStatus.js';
import { navigate } from './router.js';
import { SessionView } from './SessionView.js';
import { ErrorText, Tip } from './ui.js';

/** How often the session list refreshes, so running/idle badges stay current. */
const POLL_MS = 3000;

const SESSION_COLOR: Record<Session['status'], string> = {
  idle: 'gray',
  running: 'teal',
  error: 'red',
};

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

  if (!project) {
    return (
      <Stack>
        <Group>
          <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
            Projects
          </Button>
        </Group>
        {error ? <ErrorText error={error} /> : <Loader size="sm" />}
      </Stack>
    );
  }

  const modelOptions = providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.name} / ${m}` })),
  );
  const status = PROJECT_STATUS[project.status];
  const current = sessions.find((s) => s.id === sessionId);

  return (
    <Stack>
      <Group>
        <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
          Projects
        </Button>
      </Group>
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <Title order={2}>{project.name}</Title>
          <Tip label={status?.hint ?? project.status}>
            <Badge variant="light" color={status?.color ?? 'gray'}>
              {project.status}
            </Badge>
          </Tip>
        </Group>
        <Group gap="xs">
          {project.status !== 'running' && (
            <Button size="xs" loading={busy} onClick={() => void containerAction('restart')}>
              Start container
            </Button>
          )}
          <Tip label="Fresh container from the current sandbox image, e.g. after upgrading pi. Files and history are kept.">
            <Button
              size="xs"
              variant="default"
              disabled={busy}
              onClick={() => void containerAction('recreate')}
            >
              Recreate container
            </Button>
          </Tip>
        </Group>
      </Group>
      <GitHubPanel projectId={projectId} />
      <ProjectMcp projectId={projectId} />
      <Packages projectId={projectId} />
      <Lab projectId={projectId} />
      <ErrorText error={error} />

      <Group gap="xs" wrap="wrap" align="center">
        {sessions.map((s) => (
          <Group key={s.id} gap={4} wrap="nowrap">
            <Button
              variant={sessionId === s.id ? 'filled' : 'light'}
              aria-pressed={sessionId === s.id}
              onClick={() => select(s.id)}
              rightSection={
                s.status !== 'idle' ? (
                  <Badge size="xs" variant="filled" color={SESSION_COLOR[s.status]}>
                    {s.status}
                  </Badge>
                ) : undefined
              }
            >
              {s.name}
              {s.modelId ? ` (${s.modelId})` : ''}
            </Button>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={`Rename ${s.name}`}
              onClick={() => void rename(s)}
            >
              <IconPencil size={15} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={`Delete ${s.name}`}
              onClick={() => void remove(s)}
            >
              <IconX size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Select
          aria-label="Model"
          placeholder="No model (pi default)"
          w={260}
          value={choice || null}
          data={modelOptions}
          onChange={(v) => setChoice(v ?? '')}
        />
        <Button onClick={() => void add()} disabled={project.status !== 'running'}>
          New session
        </Button>
      </Group>

      {sessionId !== undefined && (
        <SessionView key={sessionId} sessionId={sessionId} name={current?.name} />
      )}
    </Stack>
  );
}
