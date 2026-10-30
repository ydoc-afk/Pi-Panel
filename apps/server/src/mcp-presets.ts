import type { ServerInput } from './mcp-store.js';

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  /** Things to know before enabling it. */
  notes: string[];
  server: ServerInput & { name: string };
}

/**
 * Starter entries. Versions are pinned on purpose: an unpinned `npx -y pkg` fetches whatever is newest
 * on every start, so updates should be a deliberate edit here or in the library.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'memory',
    title: 'Memory',
    description: 'A small knowledge graph the agent can store facts in and query later.',
    notes: ['Reference server from the MCP project; keeps its data inside the project container.'],
    server: {
      name: 'memory',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory@2.0.1'],
      description: 'Persistent knowledge graph memory',
    },
  },
  {
    id: 'sequential-thinking',
    title: 'Sequential thinking',
    description: 'A tool that helps the model work through problems in explicit steps.',
    notes: ['Reference server from the MCP project.'],
    server: {
      name: 'sequential-thinking',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2.0.0'],
      description: 'Step-by-step problem solving',
    },
  },
  {
    id: 'filesystem',
    title: 'Filesystem',
    description: 'File tools scoped to /workspace.',
    notes: ["pi already has built-in file tools; this adds the reference server's own set."],
    server: {
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.1.0', '/workspace'],
      description: 'Read and write files under /workspace',
    },
  },
  {
    id: 'rea',
    title: 'REA (Reverse Engineer Anything)',
    description:
      'Reverse engineering across binaries, Electron and JavaScript apps, APKs and more.',
    notes: [
      'Native binary analysis needs Ghidra and a JDK, which the default sandbox image does not include.',
      'It can run targets for runtime capture, and its own security policy says it is not a sandbox. Hide the tools you do not want (the destructive ones start hidden after a test).',
      'Not yet verified inside Pi-Panel. A managed container for it is planned.',
    ],
    server: {
      name: 'rea',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'rea-agents@6.8.0', 'mcp'],
      description: 'Reverse engineering toolkit',
      exposure: 'deferred',
      timeout: 120,
    },
  },
];
