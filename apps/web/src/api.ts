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

export interface Project {
  id: number;
  name: string;
  status: string;
  createdAt: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const listProjects = async () =>
  (await request<{ projects: Project[] }>('/api/projects')).projects;
export const createProject = async (name: string) =>
  (
    await request<{ project: Project }>('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).project;
export const deleteProject = (id: number) =>
  request<void>(`/api/projects/${id}`, { method: 'DELETE' });

export interface Session {
  id: number;
  projectId: number;
  name: string;
  status: 'idle' | 'running' | 'error';
  createdAt: number;
}

export interface StreamMessage {
  seq: number;
  event: { type: string } & Record<string, unknown>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const listSessions = async (projectId: number) =>
  (await request<{ sessions: Session[] }>(`/api/projects/${projectId}/sessions`)).sessions;
export const createSession = async (projectId: number) =>
  (await request<{ session: Session }>(`/api/projects/${projectId}/sessions`, json({}))).session;
export const deleteSession = (id: number) =>
  request<void>(`/api/sessions/${id}`, { method: 'DELETE' });
export const getSession = async (id: number) =>
  (await request<{ session: Session }>(`/api/sessions/${id}`)).session;
export const sendPrompt = (id: number, message: string, streamingBehavior?: 'steer') =>
  request<{ disposition?: string }>(
    `/api/sessions/${id}/prompt`,
    json({ message, streamingBehavior }),
  );
export const abortSession = (id: number) =>
  request<{ ok: true }>(`/api/sessions/${id}/abort`, json({}));
export const fetchEvents = async (id: number, after: number) =>
  (await request<{ events: StreamMessage[] }>(`/api/sessions/${id}/events?after=${after}`)).events;

export function openStream(id: number, after: number): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${location.host}/api/sessions/${id}/stream?after=${after}`);
}
