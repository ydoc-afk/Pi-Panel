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

export interface InstalledPackage {
  source: string;
  name: string | null;
  version: string | null;
  filtered: boolean;
}

export interface PackageReview {
  source: string;
  name: string;
  version: string;
  description: string | null;
  license: string | null;
  repository: string | null;
  homepage: string | null;
  author: string | null;
  publisher: string | null;
  deprecated: string | null;
  dependencies: string[];
  installScripts: string[];
  resources: { extensions: number; skills: number; prompts: number; themes: number } | null;
  unpackedBytes: number | null;
  fileCount: number | null;
  links: { npm: string; files: string };
  warnings: string[];
}

export interface PackageChange {
  packages: InstalledPackage[];
  restartedSessions: number;
  pendingSessions: number;
}

export const listPackages = async (projectId: number) =>
  (await request<{ packages: InstalledPackage[] }>(`/api/projects/${projectId}/packages`)).packages;
export const previewPackage = async (projectId: number, source: string) =>
  (
    await request<{ review: PackageReview }>(
      `/api/projects/${projectId}/packages/preview`,
      send('POST', { source }),
    )
  ).review;
export const installPackage = (projectId: number, source: string) =>
  request<PackageChange>(`/api/projects/${projectId}/packages`, send('POST', { source }));
export const removePackage = (projectId: number, source: string) =>
  request<PackageChange>(`/api/projects/${projectId}/packages/remove`, send('POST', { source }));

export type LabKind = 'extension' | 'skill' | 'prompt' | 'theme';

export interface LabPackage {
  path: string;
  name: string | null;
  kinds: LabKind[];
}

export interface LabTest {
  tool: string;
  input: Record<string, unknown>;
  expectContains?: string;
  expectError?: boolean;
}

export interface LabDiagnostic {
  kind: string;
  type: string;
  message: string;
  path: string;
}

export interface LabTestResult {
  tool: string;
  input: unknown;
  status: 'passed' | 'tool-error' | 'threw' | 'invalid-input' | 'not-found' | 'timeout';
  ok: boolean;
  output: string;
  error: string | null;
  schemaErrors: string[];
  durationMs: number;
}

/** Produced by code that ran inside the lab container, so every field is optional here. */
export interface LabReport {
  ok?: boolean;
  sdkVersion?: string | null;
  package?: {
    name: string | null;
    version: string | null;
    piPackage: boolean;
    hasManifest: boolean;
  } | null;
  extensions?: string[];
  extensionErrors?: { path: string; error: string }[];
  commands?: { name: string; description: string }[];
  tools?: { name: string; description: string; parameters: unknown; path: string }[];
  skills?: { name: string; description: string; path: string }[];
  prompts?: { name: string; description: string; path: string }[];
  themes?: { name: string; path: string }[];
  diagnostics?: LabDiagnostic[];
  sessionError?: string | null;
  harnessError?: string | null;
  tests?: LabTestResult[];
}

export interface LabRun {
  status: 'completed' | 'timeout' | 'no-report';
  report: LabReport | null;
  run: {
    durationMs: number;
    files: number;
    bytes: number;
    skipped: string[];
    exitCode: number | null;
    stderr: string;
  };
}

export const listLabPackages = async (projectId: number) =>
  (await request<{ packages: LabPackage[] }>(`/api/projects/${projectId}/lab/packages`)).packages;
export const scaffoldLabPackage = (projectId: number, name: string, kinds: LabKind[]) =>
  request<{ package: LabPackage; files: string[]; sampleTests: LabTest[] }>(
    `/api/projects/${projectId}/lab/scaffold`,
    send('POST', { name, kinds }),
  );
export const runLab = (projectId: number, path: string, tests: LabTest[]) =>
  request<LabRun>(`/api/projects/${projectId}/lab/run`, send('POST', { path, tests }));

export interface McpEntry {
  key: string;
  secret: boolean;
  /** Only present for non-secret entries. */
  value?: string;
  hasValue: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpDiscovery {
  state: 'connected' | 'failed' | 'disabled' | 'timeout' | 'error';
  error: string | null;
  tools: McpTool[];
  discoveredAt: number;
  piVersion: string | null;
}

export type McpExposure = 'direct' | 'codemode' | 'deferred' | 'hidden';

export interface McpServer {
  id: number;
  name: string;
  description: string | null;
  type: 'stdio' | 'http' | 'managed';
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  env: McpEntry[];
  headers: McpEntry[];
  exposure: McpExposure | null;
  timeout: number | null;
  defaultHidden: string[];
  /** Managed servers only. */
  image: string | null;
  port: number | null;
  readyLog: string | null;
  mountSamples: boolean;
  memoryMb: number | null;
  discovery: McpDiscovery | null;
  createdAt: number;
}

export interface McpEntryInput {
  key: string;
  value?: string;
  secret: boolean;
}

export interface McpServerInput {
  name?: string;
  type?: 'stdio' | 'http' | 'managed';
  description?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: McpEntryInput[];
  headers?: McpEntryInput[];
  exposure?: McpExposure | null;
  timeout?: number | null;
  image?: string;
  port?: number;
  readyLog?: string;
  mountSamples?: boolean;
  memoryMb?: number;
}

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  notes: string[];
  server: McpServerInput & { name: string };
}

export interface McpProjectServer {
  server: McpServer;
  enabled: boolean;
  hiddenOverride: string[] | null;
  hiddenTools: string[];
}

export interface McpApplied {
  restartedSessions: number;
  pendingSessions: number;
}

export const listMcpServers = async () =>
  (await request<{ servers: McpServer[] }>('/api/mcp/servers')).servers;
export const listMcpPresets = async () =>
  (await request<{ presets: McpPreset[] }>('/api/mcp/presets')).presets;
export const createMcpServer = async (input: McpServerInput) =>
  (await request<{ server: McpServer }>('/api/mcp/servers', send('POST', input))).server;
export const updateMcpServer = (id: number, input: McpServerInput) =>
  request<{ server: McpServer } & McpApplied>(`/api/mcp/servers/${id}`, send('PUT', input));
export const deleteMcpServer = (id: number) =>
  request<McpApplied>(`/api/mcp/servers/${id}`, { method: 'DELETE' });
export const setMcpDefaultHidden = (id: number, hidden: string[]) =>
  request<{ server: McpServer } & McpApplied>(
    `/api/mcp/servers/${id}/hidden`,
    send('PUT', { hidden }),
  );
export const discoverMcp = async (id: number) =>
  (await request<{ server: McpServer }>(`/api/mcp/servers/${id}/discover`, send('POST', {})))
    .server;
export const importMcp = (json: unknown, name?: string) =>
  request<{ servers: McpServer[]; warnings: string[] }>(
    '/api/mcp/import',
    send('POST', { json, ...(name ? { name } : {}) }),
  );
export interface SidecarStatus {
  state: 'stopped' | 'running' | 'exited' | 'missing';
  exitCode: number | null;
}

export interface McpProjectState {
  servers: McpProjectServer[];
  /** Container state for each managed server, by server id. */
  sidecars: Record<number, SidecarStatus>;
}

export const listProjectMcp = (projectId: number) =>
  request<McpProjectState>(`/api/projects/${projectId}/mcp`);
export const setProjectMcp = (
  projectId: number,
  serverId: number,
  change: { enabled?: boolean; hiddenTools?: string[] | null },
) =>
  request<McpProjectState & McpApplied & { sidecarError?: string }>(
    `/api/projects/${projectId}/mcp/${serverId}`,
    send('PUT', change),
  );

export const sidecarAction = async (
  projectId: number,
  serverId: number,
  action: 'start' | 'stop' | 'restart',
) =>
  (
    await request<{ sidecar: SidecarStatus }>(
      `/api/projects/${projectId}/mcp/${serverId}/sidecar`,
      send('POST', { action }),
    )
  ).sidecar;
export const sidecarLogs = async (projectId: number, serverId: number) =>
  (
    await request<{ logs: string }>(
      `/api/projects/${projectId}/mcp/${serverId}/sidecar/logs?tail=100`,
    )
  ).logs;

export interface SampleFile {
  name: string;
  size: number;
  modifiedAt: number;
}

export const listSamples = async (projectId: number) =>
  (await request<{ files: SampleFile[] }>(`/api/projects/${projectId}/samples`)).files;
export const uploadSample = async (projectId: number, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return (
    await request<{ file: SampleFile }>(`/api/projects/${projectId}/samples`, {
      method: 'POST',
      body: form,
    })
  ).file;
};
export const deleteSample = (projectId: number, name: string) =>
  request<void>(`/api/projects/${projectId}/samples/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
