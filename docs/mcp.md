# MCP servers

Pi has built-in MCP support. Pi-Panel adds a library of servers you configure once (MCP tab), a
checkbox per server per project, and a checkbox per tool, then writes the result into each project's
pi configuration.

## How it works

- **Library** (`apps/server/src/mcp-store.ts`): servers are either _Command_ (stdio: pi starts the
  process inside the project container) or _URL_ (streamable HTTP). Presets, paste-JSON import (Claude
  Desktop / Cursor format) and a custom form create them.
- **Per project**: a server is off until switched on for a project. Each tool can be switched off;
  that becomes `toolExposure: { "<tool>": "hidden" }`. A project can override the server's default tool
  selection and reset back to it.
- **Generated config**: when a session starts, the panel writes `mcp.json` into the project's agent dir
  (always, even when empty, so removed servers do not linger). It contains **no values**: every env var
  and header is a `${PP_MCP_<id>_...}` reference. The values are put into that pi process's
  environment, only for servers enabled in that project. Because values come from the environment, a
  value that starts with `!` is data and never run as a command (verified against real pi).
- **Test connection**: runs the real `pi mcp list --json` plus the pi SDK in a throwaway container
  (network on, nothing mounted, only that server's values) to get connection state, tool names,
  descriptions and the `readOnlyHint` / `destructiveHint` annotations. Tools a server marks destructive
  start unchecked. Output is scrubbed of the server's secret values before it is stored.
- **Applying changes**: pi has no reload over RPC, so idle sessions get a new process on their next
  prompt, and a session that is mid-run is replaced as soon as that run settles.

## Trust and what is isolated

- **Command servers run inside the project container**, spawned by pi with the agent's permissions.
  Any secret you give one is in pi's environment and visible to the agent. Prefer URL servers that hold
  their own credentials, or (planned) managed sidecar containers.
- **Cloned repositories cannot add servers.** A repo's own `.pi/mcp.json` and `.pi/extensions` need
  project trust, and in RPC mode they did not run: checked against pi 1.4.0 with a hostile repo.
- **Pins**: presets pin exact versions. `npx -y pkg` with no version fetches the newest release on every
  start, so treat an unpinned command as an automatic update channel.
- pi does not support the legacy SSE transport; a server must offer stdio or streamable HTTP.

## Developing against real pi

Most tests use a fake runtime. `apps/server/src/mcp-real-pi.test.ts` runs discovery against the real pi
CLI and SDK and a real stdio server. It is skipped unless these are set:

```bash
PI_SDK_ENTRY=/path/node_modules/@earendil-works/pi-coding-agent/dist/index.js
PI_BIN=/path/node_modules/.bin/pi
MCP_TEST_SERVER=/path/to/server.mjs   # needs @modelcontextprotocol/sdk and zod installed next to it
```

The test server puts `GREETING`, `SECRET_TOKEN` and `BANG` into a tool description so the test can see
what reached the process:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const s = new McpServer({ name: 'spike-env', version: '1.0.0' });
const e = process.env;
s.registerTool(
  'info',
  {
    description: `GREETING=${e.GREETING}|TOKEN=${e.SECRET_TOKEN}|BANG=${e.BANG}`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'text', text: 'ok' }] }),
);
s.registerTool(
  'echo',
  { description: 'Echo text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);
s.registerTool(
  'wipe',
  { description: 'Deletes everything', inputSchema: {}, annotations: { destructiveHint: true } },
  async () => ({ content: [{ type: 'text', text: 'wiped' }] }),
);
await s.connect(new StdioServerTransport());
```
