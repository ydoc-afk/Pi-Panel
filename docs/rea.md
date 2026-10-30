# REA in Pi-Panel

[REA](https://github.com/morluto/rea) ("Reverse Engineer Anything", npm `rea-agents`) is an MCP server
for reverse engineering. Pi-Panel runs it as a **managed container**: its own container, on a private
network with no internet access, with a project's uploaded samples mounted read-only. The agent can
call REA's tools but cannot see the container's environment, its files, or the samples.

## What has and has not been verified

Verified against the real thing (see `apps/server/src/rea-real.test.ts`): REA 6.8.0 on Node 24 serves
streamable HTTP with `rea mcp --http`, announces `"MCP transport listening"`, real pi 1.4.0 connects to
it, and the full catalog loads: **229 tools, all with descriptions and annotations, 32 marked
destructive** (hidden by default after a test).

**Not verified**, because there was no Docker daemon: building `docker/rea`, running it as a sidecar,
the private network and mounts, and any analysis that needs Ghidra or a JDK. Treat the first real run as
a test.

## Setup

1. Pick a Ghidra release from <https://github.com/NationalSecurityAgency/ghidra/releases>, copy the
   zip's download URL, and compute its checksum with `sha256sum`. The image build requires both and
   refuses to build without them, so nothing is downloaded unverified.
2. Build the image on the Docker host. The easiest route is the **Build REA** card at the top of the MCP
   tab: paste the Ghidra download link and the checksum, then press **Build REA image**. The panel builds
   the image in the background and streams the log. The build downloads Ghidra and a JDK, so it can take
   a while. When it finishes, the card offers **Add REA**. The panel first checks that the link answers,
   so a wrong link fails at once. If a build fails, the card shows the reason and any hint, and
   **Download the build log** saves the timestamped log for troubleshooting.

   To build it by hand instead:

   ```bash
   GHIDRA_URL=https://... GHIDRA_SHA256=... docker compose --profile build-only build rea
   ```

   The image is tagged `pi-panel/rea:6.8.0`. To use a different REA, change `REA_VERSION`, the tag, and
   the preset or library entry together. Pi-Panel never pulls images; the MCP tab shows whether the REA
   image is present.

3. In the MCP tab add the **REA** preset (or press **Add REA** on the build card), and press **Test
   connection** to list its tools.
4. In a project, switch **rea** on. Pi-Panel creates the project's private network, starts the container
   and waits for it to announce it is ready. Upload files in the **Samples** panel and start a new
   session so the agent learns their names.

## How it is isolated

- **Network:** a per-project Docker network created with `Internal: true` (no route out). Only that
  project's session container and its managed servers are on it. Other projects have their own.
- **Process:** unprivileged user 1000, all capabilities dropped, `no-new-privileges`, memory limit
  (default 4 GB, 6 GB for the REA preset), 2 CPUs, 1024 processes. Dropping capabilities also blocks
  ptrace-style debugging, so dynamic analysis that needs it will not work: that is intended.
- **Files:** samples are mounted read-only at `/samples`. They are not mounted into the session
  container, so the agent can only reach them through the server's tools. Nothing else from the host is
  mounted and the Docker socket is never exposed.
- **Secrets:** a managed server's environment variables are set on its container only. They never enter
  pi's environment or `mcp.json` (tested). A server that needs credentials is the main reason to use a
  managed container instead of a command server.
- **REA's own policy says it is not a sandbox.** Opening an untrusted binary runs Ghidra's parsing with
  the container user's permissions. The container is the sandbox; keep it that way.

## Limits to know about

- REA serves **one client at a time**. Use it from one session per project at a time.
- Its HTTP endpoint has no authentication and no TLS. That is acceptable only because it is reachable
  from nothing but the project's private network.
- Ghidra's heap needs memory. Raise `memoryMb` for large binaries (and see REA's
  `REA_GHIDRA_STARTUP_TIMEOUT_MS` for slow starts).
- Sample uploads are limited to 512 MB per file, 2 GB and 200 files per project.

## Running the real test

```bash
REA_NODE=/path/to/node24 \
REA_ENTRY=/path/to/node_modules/rea-agents/scripts/rea.mjs \
PI_BIN=/path/to/node_modules/.bin/pi \
PI_SDK_ENTRY=/path/to/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
npm test -w @pi-panel/server -- rea-real
```
