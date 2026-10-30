import { useEffect, useState, type FormEvent } from 'react';
import {
  connectGitHub,
  disconnectGitHub,
  getGitHub,
  type GitHubAccount as Account,
} from './api.js';

export function GitHubAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getGitHub()
      .then(setAccount)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setAccount(await connectGitHub(token));
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>GitHub</h2>
      {account?.connected ? (
        <p>
          Connected as <strong>{account.login}</strong>{' '}
          <button
            onClick={() => {
              if (confirm('Disconnect GitHub? Stored token will be deleted.')) {
                void disconnectGitHub().then(() => setAccount({ connected: false }));
              }
            }}
          >
            Disconnect
          </button>
        </p>
      ) : (
        <form onSubmit={connect} style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
          <p style={{ margin: 0 }}>
            Add a personal access token. It needs read/write access to repository contents and pull
            requests for the repositories you want to push to. It is encrypted at rest and never
            enters a project container.
          </p>
          <input
            type="password"
            autoComplete="off"
            placeholder="Personal access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button disabled={busy || !token.trim()}>Connect</button>
        </form>
      )}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </section>
  );
}
