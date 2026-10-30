import { resolve } from 'node:path';

/** Host directory bind-mounted at /workspace in the project container. */
export const workspaceDir = (dataDir: string, projectId: number) =>
  resolve(dataDir, 'workspaces', String(projectId));

/** Host directory bind-mounted as pi's agent dir (models.json, pi session files). */
export const agentDir = (dataDir: string, projectId: number) =>
  resolve(dataDir, 'agents', String(projectId));

/** Where the agent dir appears inside the sandbox container. */
export const SANDBOX_AGENT_DIR = '/home/sandbox/.pi/agent';

/** uid/gid of the unprivileged user inside sandbox containers. */
export const SANDBOX_UID = 1000;
