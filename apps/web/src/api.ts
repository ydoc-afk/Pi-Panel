export interface User {
  id: number;
  username: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  user: User | null;
}

async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const getStatus = async (): Promise<AuthStatus> =>
  (await fetch('/api/auth/status')).json() as Promise<AuthStatus>;
export const setupAdmin = (username: string, password: string) =>
  post<{ user: User }>('/api/auth/setup', { username, password });
export const login = (username: string, password: string) =>
  post<{ user: User }>('/api/auth/login', { username, password });
export const logout = () => post<{ ok: true }>('/api/auth/logout');
