import { useEffect, useState } from 'react';
import { ActionIcon, Button, Group, Select, Stack, Title } from '@mantine/core';
import { IconArrowLeft, IconX } from '@tabler/icons-react';
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
import { ErrorText } from './ui.js';

export function ProjectView({ project, onBack }: { project: Project; onBack: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
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

  const modelOptions = providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.name} / ${m}` })),
  );

  return (
    <Stack>
      <Group>
        <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
          Projects
        </Button>
      </Group>
      <Title order={2}>{project.name}</Title>
      <GitHubPanel projectId={project.id} />
      <ProjectMcp projectId={project.id} />
      <Packages projectId={project.id} />
      <Lab projectId={project.id} />
      <ErrorText error={error} />

      <Group gap="xs" wrap="wrap" align="center">
        {sessions.map((s) => (
          <Group key={s.id} gap={4} wrap="nowrap">
            <Button
              variant={selected === s.id ? 'filled' : 'light'}
              aria-pressed={selected === s.id}
              onClick={() => setSelected(s.id)}
            >
              {s.name}
              {s.modelId ? ` (${s.modelId})` : ''}
            </Button>
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
        <Button onClick={() => void add()}>New session</Button>
      </Group>

      {selected !== null && <SessionView key={selected} sessionId={selected} />}
    </Stack>
  );
}
