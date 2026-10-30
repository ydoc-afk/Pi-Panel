import { useEffect, useState } from 'react';
import { AuthForm } from './AuthForm.js';
import { getStatus, logout, type AuthStatus, type User } from './api.js';

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);

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
        </>
      ) : (
        <AuthForm setup={status.setupRequired} onAuthed={authed} />
      )}
    </main>
  );
}
