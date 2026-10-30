import { useEffect, useState } from 'react';

export function App() {
  const [status, setStatus] = useState('checking...');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d: { status: string }) => setStatus(d.status))
      .catch(() => setStatus('unreachable'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Pi-Panel</h1>
      <p>Server: {status}</p>
    </main>
  );
}
