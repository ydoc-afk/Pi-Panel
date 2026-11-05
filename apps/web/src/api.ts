export interface User {
  id: number;
  username: string;
  role: 'admin' | 'member';
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
export const register = (username: string, password: string) =>
  post<{ pending: true }>('/api/auth/register', { username, password });
export const logout = () => post<{ ok: true }>('/api/auth/logout');
export const changePassword = (current: string, next: string) =>
  post<{ ok: true; signedOutOthers: number }>('/api/auth/password', { current, next });

export interface SystemInfo {
  panelVersion: string;
  schema: number;
  docker: boolean;
  sandbox: { present: boolean; piVersion: string | null };
}
export const getSystem = async (): Promise<SystemInfo> =>
  (await fetch('/api/system')).json() as Promise<SystemInfo>;

export interface Project {
  id: number;
  name: string;
  status: string;
  repo: string | null;
  runtime: string;
  /** The running container was made from a different runtime image; Recreate applies the change. */
  runtimePending: boolean;
  /** Used by every session that did not choose a model; null leaves it to pi's own default. */
  defaultModel: { providerId: number; modelId: string } | null;
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
export const getProject = async (id: number) =>
  (await request<{ project: Project }>(`/api/projects/${id}`)).project;
export const setProjectRuntime = async (id: number, runtime: string) =>
  (await request<{ project: Project }>(`/api/projects/${id}`, send('PATCH', { runtime }))).project;
export const setProjectDefaultModel = async (
  id: number,
  defaultModel: { providerId: number; modelId: string } | null,
) =>
  (await request<{ project: Project }>(`/api/projects/${id}`, send('PATCH', { defaultModel })))
    .project;
export const restartProject = async (id: number) =>
  (await request<{ project: Project }>(`/api/projects/${id}/restart`, json({}))).project;
export const recreateProject = async (id: number) =>
  (await request<{ project: Project }>(`/api/projects/${id}/recreate`, json({}))).project;

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
export const renameSession = async (id: number, name: string) =>
  (
    await request<{ session: Session }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).session;
export const getSession = async (id: number) =>
  (await request<{ session: Session }>(`/api/sessions/${id}`)).session;
export const sendPrompt = (id: number, message: string, streamingBehavior?: 'steer' | 'followUp') =>
  request<{ disposition?: string }>(
    `/api/sessions/${id}/prompt`,
    json({ message, streamingBehavior }),
  );
/** Answers a question an extension asked: exactly one of value, confirmed or cancelled. */
export const respondUi = (
  id: number,
  answer: { id: string } & ({ value: string } | { confirmed: boolean } | { cancelled: true }),
) => request<{ ok: true }>(`/api/sessions/${id}/ui-response`, json(answer));
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
  /** The newest failed model call through this provider, until one succeeds. */
  health?: { message: string; status: number | null; at: number };
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
/** Lists the models a provider would expose, from the settings in the form. Nothing is saved. */
export const testProvider = async (input: Omit<ProviderInput, 'name'> & { providerId?: number }) =>
  (await request<{ models: string[] }>('/api/providers/test', send('POST', input))).models;
export const updateProvider = async (id: number, input: ProviderInput) =>
  (await request<{ provider: Provider }>(`/api/providers/${id}`, send('PUT', input))).provider;
export const deleteProvider = (id: number) =>
  request<void>(`/api/providers/${id}`, { method: 'DELETE' });
export const discoverModels = async (id: number) =>
  (await request<{ provider: Provider }>(`/api/providers/${id}/discover`, send('POST', {})))
    .provider;

export type Forge = 'github' | 'forgejo';

export interface GitHubAccount {
  connected: boolean;
  login?: string;
  /** Forgejo only: the instance address the token belongs to. */
  baseUrl?: string;
}

export const getGitHub = (forge: Forge = 'github') => request<GitHubAccount>(`/api/${forge}`);
export const connectGitHub = (token: string, forge: Forge = 'github', baseUrl?: string) =>
  request<GitHubAccount>(`/api/${forge}`, send('PUT', { token, ...(baseUrl ? { baseUrl } : {}) }));
export const disconnectGitHub = (forge: Forge = 'github') =>
  request<void>(`/api/${forge}`, { method: 'DELETE' });
/** Checks a token against the forge without storing it. Omit the token to test the stored one. */
export const testGitHub = (token?: string, forge: Forge = 'github', baseUrl?: string) =>
  request<{ login: string; id: number }>(
    `/api/${forge}/test`,
    send('POST', token ? { token, ...(baseUrl ? { baseUrl } : {}) } : {}),
  );

/** Whether the sandbox image that project containers are created from has been built. */
export const getSandbox = () => request<{ available: boolean }>('/api/sandbox');

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  default?: string;
}
export type RegistryInstall =
  | { kind: 'npm'; identifier: string; version: string; env: RegistryEnvVar[] }
  | { kind: 'remote'; url: string };
export interface RegistryItem {
  name: string;
  title: string;
  description: string;
  version: string;
  repository: string | null;
  install: RegistryInstall | null;
}
/** Searches the official MCP registry through the panel. */
export const searchRegistry = (q: string, cursor?: string) => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return request<{ items: RegistryItem[]; nextCursor: string | null }>(
    `/api/mcp/registry${query ? `?${query}` : ''}`,
  );
};

export type ReaBuildStatus = 'idle' | 'checking' | 'building' | 'done' | 'failed';
export interface ReaState {
  image: string;
  present: boolean;
  build: {
    status: ReaBuildStatus;
    log: string[];
    error?: string;
    hint?: string;
    startedAt?: number;
    finishedAt?: number;
  };
}
export const getRea = () => request<ReaState>('/api/rea');
export const buildRea = (ghidraUrl: string, ghidraSha256: string) =>
  request<ReaState>('/api/rea/build', send('POST', { ghidraUrl, ghidraSha256 }));
export interface ProjectRepo {
  id: number;
  host: Forge;
  repo: string;
  /** Where it is inside the sandbox. */
  path: string;
  included: boolean;
  branch: string | null;
  changes: number;
  ahead: number | null;
  error?: string;
}
export interface RepoList {
  repos: ProjectRepo[];
  accounts: Record<Forge, boolean>;
}
export interface BulkRepoResult {
  id: number;
  repo: string;
  ok: boolean;
  error?: string;
  branch?: string;
  committed?: boolean;
  updated?: boolean;
}
const repos = (projectId: number) => `/api/projects/${projectId}/repos`;
export const listRepos = (projectId: number) => request<RepoList>(repos(projectId));
export const addRepo = (projectId: number, host: Forge, repo: string, branch?: string) =>
  request<{ id: number; path: string; branch: string }>(
    repos(projectId),
    send('POST', { host, repo, ...(branch ? { branch } : {}) }),
  );
export const setRepoIncluded = (projectId: number, repoId: number, included: boolean) =>
  request<{ id: number; included: boolean }>(
    `${repos(projectId)}/${repoId}`,
    send('PATCH', { included }),
  );
export const removeRepo = (projectId: number, repoId: number) =>
  request<void>(`${repos(projectId)}/${repoId}`, { method: 'DELETE' });
export const pullRepo = (projectId: number, repoId: number) =>
  request<{ branch: string; updated: boolean }>(
    `${repos(projectId)}/${repoId}/pull`,
    send('POST', {}),
  );
export const pushRepo = (projectId: number, repoId: number, branch: string, message?: string) =>
  request<{ branch: string; commit: string; committed: boolean }>(
    `${repos(projectId)}/${repoId}/push`,
    send('POST', { branch, ...(message ? { message } : {}) }),
  );
export const openRepoPullRequest = (
  projectId: number,
  repoId: number,
  input: { head: string; title: string; body?: string },
) =>
  request<{ url: string; number: number | null; base: string }>(
    `${repos(projectId)}/${repoId}/pr`,
    send('POST', input),
  );
export const pullAllRepos = async (projectId: number) =>
  (await request<{ results: BulkRepoResult[] }>(`${repos(projectId)}/pull`, send('POST', {})))
    .results;
export const pushAllRepos = async (projectId: number, message?: string) =>
  (
    await request<{ results: BulkRepoResult[] }>(
      `${repos(projectId)}/push`,
      send('POST', message ? { message } : {}),
    )
  ).results;

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

export interface PackageSetStatus {
  id: number;
  name: string;
  sources: { source: string; name: string; version: string }[];
  createdAt: number;
  installed: string[];
  missing: string[];
  different: { source: string; installed: string }[];
}
export const listPackageSets = async (projectId: number) =>
  (await request<{ sets: PackageSetStatus[] }>(`/api/projects/${projectId}/package-sets`)).sets;
export const savePackageSet = (name: string, fromProjectId: number) =>
  request<{ set: PackageSetStatus; skipped: number }>(
    '/api/package-sets',
    send('POST', { name, fromProjectId }),
  );
export const deletePackageSet = (id: number) =>
  request<void>(`/api/package-sets/${id}`, { method: 'DELETE' });

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

export interface AccountRow {
  id: number;
  username: string;
  role: 'admin' | 'member';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

export const listAccounts = async (): Promise<AccountRow[]> => {
  const res = await fetch('/api/admin/users');
  const data = (await res.json()) as AccountRow[] & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
};
export const approveAccount = (id: number) => post<{ ok: true }>(`/api/admin/users/${id}/approve`);
export const rejectAccount = (id: number) => post<{ ok: true }>(`/api/admin/users/${id}/reject`);
export const removeAccount = async (id: number) => {
  const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
};

export interface ActivityDay {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  prompts: number;
  toolCalls: number;
  errors: number;
}

export interface DashboardSession {
  id: number;
  projectId: number;
  projectName: string;
  name: string;
  status: Session['status'];
  modelId: string | null;
  providerName: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  prompts: number;
}

export interface DashboardProject {
  id: number;
  name: string;
  status: string;
  repo: string | null;
  createdAt: number;
  sessions: number;
  runningSessions: number;
  prompts: number;
  lastActivityAt: number | null;
}

export interface DashboardData {
  generatedAt: number;
  activity: { days: ActivityDay[] };
  projects: { total: number; running: number; items: DashboardProject[] };
  sessions: { total: number; running: number; errored: number; recent: DashboardSession[] };
  models: { model: string; sessions: number }[];
  tools: { name: string; calls: number }[];
  providers: {
    total: number;
    withKey: number;
    models: number;
    warnings: number;
    failing: number;
  };
  mcp: { total: number; connected: number; failing: number; untested: number; tools: number };
  github: { connected: boolean; login: string | null };
  forgejo: { connected: boolean; login: string | null };
  sandbox: { available: boolean };
  /** Admin only. */
  users: { total: number; pending: number } | null;
}

/** Everything the home dashboard shows. Days are bucketed in this browser's time zone. */
export const getDashboard = () =>
  request<DashboardData>(`/api/dashboard?tz=${-new Date().getTimezoneOffset()}`);

export interface RuntimeState {
  id: string;
  label: string;
  description: string;
  tag: string;
  present: boolean;
  /** Built on a base image that has since been rebuilt. */
  stale: boolean;
  sizeBytes: number | null;
  build: {
    status: 'idle' | 'building' | 'done' | 'failed';
    log: string[];
    error?: string;
  };
}
export const listRuntimes = async () =>
  (await request<{ runtimes: RuntimeState[] }>('/api/runtimes')).runtimes;
export const buildRuntime = async (id: string) =>
  (await request<{ runtimes: RuntimeState[] }>(`/api/runtimes/${id}/build`, send('POST'))).runtimes;

export interface PiState {
  running: boolean;
  thinkingLevel: string | null;
  availableThinkingLevels: string[];
  autoCompaction: boolean | null;
  isCompacting: boolean;
  model: { id: string; provider: string | null; contextWindow: number | null } | null;
  stats: {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    toolCalls: number;
    messages: number;
    context: { tokens: number | null; window: number | null; percent: number | null } | null;
  } | null;
}
export const getPiState = (sessionId: number) => request<PiState>(`/api/sessions/${sessionId}/pi`);
export const setThinkingLevel = (sessionId: number, level: string) =>
  request<PiState>(`/api/sessions/${sessionId}/thinking`, send('POST', { level }));
export const setAutoCompaction = (sessionId: number, enabled: boolean) =>
  request<PiState>(`/api/sessions/${sessionId}/auto-compaction`, send('POST', { enabled }));
export const compactSession = (sessionId: number, instructions?: string) =>
  request<{ summary: string; tokensBefore: number | null; tokensAfter: number | null }>(
    `/api/sessions/${sessionId}/compact`,
    send('POST', instructions ? { instructions } : {}),
  );
