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
  repo: string | null;
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
  providerId: number | null;
  modelId: string | null;
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
export const createSession = async (
  projectId: number,
  model?: { providerId: number; modelId: string },
) =>
  (await request<{ session: Session }>(`/api/projects/${projectId}/sessions`, json(model ?? {})))
    .session;
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

export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible';

export interface Provider {
  id: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  hasKey: boolean;
  models: string[];
  warning?: string;
}

export interface ProviderInput {
  kind?: ProviderKind;
  name: string;
  baseUrl?: string;
  /** undefined keeps the stored key, null clears it. */
  apiKey?: string | null;
  models?: string[];
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const listProviders = async () =>
  (await request<{ providers: Provider[] }>('/api/providers')).providers;
export const createProvider = async (input: ProviderInput) =>
  (await request<{ provider: Provider }>('/api/providers', send('POST', input))).provider;
export const updateProvider = async (id: number, input: ProviderInput) =>
  (await request<{ provider: Provider }>(`/api/providers/${id}`, send('PUT', input))).provider;
export const deleteProvider = (id: number) =>
  request<void>(`/api/providers/${id}`, { method: 'DELETE' });
export const discoverModels = async (id: number) =>
  (await request<{ provider: Provider }>(`/api/providers/${id}/discover`, send('POST', {})))
    .provider;

export interface GitHubAccount {
  connected: boolean;
  login?: string;
}

export interface RepoStatus {
  repo: string | null;
  branch: string | null;
  changes: number;
}

export const getGitHub = () => request<GitHubAccount>('/api/github');
export const connectGitHub = (token: string) =>
  request<GitHubAccount>('/api/github', send('PUT', { token }));
export const disconnectGitHub = () => request<void>('/api/github', { method: 'DELETE' });
export const getRepoStatus = (projectId: number) =>
  request<RepoStatus>(`/api/projects/${projectId}/github`);
export const cloneRepo = (projectId: number, repo: string, branch?: string) =>
  request<{ repo: string; branch: string }>(
    `/api/projects/${projectId}/github/clone`,
    send('POST', { repo, ...(branch ? { branch } : {}) }),
  );
export const pushBranch = (projectId: number, branch: string, message?: string) =>
  request<{ branch: string; commit: string; committed: boolean }>(
    `/api/projects/${projectId}/github/push`,
    send('POST', { branch, ...(message ? { message } : {}) }),
  );
export const openPullRequest = (
  projectId: number,
  input: { head: string; title: string; body?: string },
) =>
  request<{ url: string; number: number | null; base: string }>(
    `/api/projects/${projectId}/github/pr`,
    send('POST', input),
  );
