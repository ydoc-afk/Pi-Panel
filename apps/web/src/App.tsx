import { useEffect, useState } from 'react';
import { AuthForm } from './AuthForm.js';
import { GitHubAccount } from './GitHubAccount.js';
import { McpServers } from './McpServers.js';
import { Projects } from './Projects.js';
import { Providers } from './Providers.js';
import { getStatus, logout, type AuthStatus, type User } from './api.js';

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<'projects' | 'providers' | 'mcp' | 'github'>('projects');

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus({ setupRequired: false, user: null }));
  }, []);

  const authed = (user: User) => setStatus({ setupRequired: false, user });

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Pi-Panel</h1>
      {!status ? (
        <p>Loading...</p>
      ) : status.user ? (
        <>
          <p>Signed in as {status.user.username}</p>
          <button
            onClick={() => logout().then(() => setStatus({ setupRequired: false, user: null }))}
          >
            Sign out
          </button>
          <nav style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
            <button aria-pressed={tab === 'projects'} onClick={() => setTab('projects')}>
              Projects
            </button>
            <button aria-pressed={tab === 'providers'} onClick={() => setTab('providers')}>
              Providers
            </button>
            <button aria-pressed={tab === 'mcp'} onClick={() => setTab('mcp')}>
              MCP
            </button>
            <button aria-pressed={tab === 'github'} onClick={() => setTab('github')}>
              GitHub
            </button>
          </nav>
          {tab === 'projects' && <Projects />}
          {tab === 'providers' && <Providers />}
          {tab === 'mcp' && <McpServers />}
          {tab === 'github' && <GitHubAccount />}
        </>
      ) : (
        <AuthForm setup={status.setupRequired} onAuthed={authed} />
      )}
    </main>
  );
}
