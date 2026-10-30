import { useEffect, useState, type FormEvent } from 'react';
import { createProject, deleteProject, listProjects, type Project } from './api.js';

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
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

  return (
    <section>
      <h2>Projects</h2>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          placeholder="New project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={busy || !name.trim()}>Create</button>
      </form>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
          {projects.map((p) => (
            <li key={p.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <strong>{p.name}</strong>
              <span>{p.status}</span>
              <button
                disabled={busy}
                onClick={() => {
                  if (confirm(`Delete "${p.name}" and its workspace?`))
                    void run(() => deleteProject(p.id));
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
