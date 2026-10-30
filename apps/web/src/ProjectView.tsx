import { useEffect, useState } from 'react';
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
import { SessionView } from './SessionView.js';

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

  return (
    <section>
      <button onClick={onBack}>&larr; Projects</button>
      <h2>{project.name}</h2>
      <GitHubPanel projectId={project.id} />
      <Packages projectId={project.id} />
      <Lab projectId={project.id} />
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {sessions.map((s) => (
          <span key={s.id}>
            <button
              onClick={() => setSelected(s.id)}
              aria-pressed={selected === s.id}
              style={{ fontWeight: selected === s.id ? 700 : 400 }}
            >
              {s.name}
              {s.modelId ? ` (${s.modelId})` : ''}
            </button>
            <button aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}>
              &times;
            </button>
          </span>
        ))}
        <select aria-label="Model" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">No model (pi default)</option>
          {providers.flatMap((p) =>
            p.models.map((m) => (
              <option key={`${p.id}:${m}`} value={`${p.id}:${m}`}>
                {p.name} / {m}
              </option>
            )),
          )}
        </select>
        <button onClick={() => void add()}>New session</button>
      </div>
      {selected !== null && <SessionView key={selected} sessionId={selected} />}
    </section>
  );
}
