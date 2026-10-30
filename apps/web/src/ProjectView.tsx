import { useEffect, useState } from 'react';
import { createSession, deleteSession, listSessions, type Project, type Session } from './api.js';
import { SessionView } from './SessionView.js';

export function ProjectView({ project, onBack }: { project: Project; onBack: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');

  const refresh = () =>
    listSessions(project.id)
      .then(setSessions)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, [project.id]);

  async function add() {
    try {
      const s = await createSession(project.id);
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
            </button>
            <button aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}>
              &times;
            </button>
          </span>
        ))}
        <button onClick={() => void add()}>New session</button>
      </div>
      {selected !== null && <SessionView key={selected} sessionId={selected} />}
    </section>
  );
}
