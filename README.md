# Pi-Panel

A self-hosted web panel for running the [pi](https://pi.dev) coding agent in isolated, per-project Docker
containers. Create projects, talk to pi in live sessions, connect GitHub, manage providers, packages and
MCP servers, and build and test your own pi extensions, skills, prompts and themes, all from the browser.

> **Status: early, single-admin, never yet run against a Docker daemon.** Everything below was developed
> and tested against a fake container runtime and, where noted, against the real pi, real MCP servers and
> the real REA. The Docker integration (image builds, networks, bind mounts) is written but unverified.
> See [What has been verified](#what-has-been-verified) before relying on it.

## What it does

- **Projects and sessions.** One container per project with a bind-mounted workspace; pi runs inside it.
  Sessions stream live over WebSocket, persist their transcript, and resume.
- **Providers.** Anthropic, OpenAI, and any OpenAI-compatible server (llama.cpp, Unsloth Studio, ...).
  Keys are encrypted at rest; model lists are discovered from the provider.
- **GitHub.** Clone, commit, push and open pull requests with a personal access token. Git runs in the
  panel, never in the sandbox, and the token never enters a container.
- **Pi packages.** Install npm pi packages per project, with an enforced review step that pins the exact
  version you looked at and disables install scripts.
- **Package lab.** Scaffold and test extensions, skills, prompts and themes in a throwaway container with
  no network and no credentials, using the real pi SDK.
- **MCP servers.** A library of servers with a checkbox per server per project and per tool. Command and
  URL servers, plus **managed containers** for servers that speak HTTP (such as
  [REA](https://github.com/morluto/rea)): isolated, on a private network, with uploadable samples.

## Quick start (Docker)

Requires Docker with Compose, run from the repository root.

```bash
# 1. Build the sandbox image that project containers are created from
docker compose --profile build-only build sandbox-base

# 2. Build and start the panel
docker compose up -d --build

# 3. Open http://localhost:3000 and create the admin account
```

Data lives in `./data` (database, `secret.key`, workspaces, pi agent dirs, uploaded samples). **Back up
the database and `secret.key` together**: without the key the stored API keys cannot be decrypted.

The panel mounts the Docker socket so it can manage project containers. That is root-equivalent access to
the host: run it only on a machine and network you trust, and put it behind HTTPS (and add
`COOKIE_SECURE: 'true'` to the `pi-panel` service's `environment` in `docker-compose.yml`) if anyone
else can reach it.

Optional: build the REA reverse-engineering image, which needs a Ghidra download you choose and verify
(see [docs/rea.md](docs/rea.md)).

## Development

Requires Node 22.19 or newer.

```bash
npm install
npm run dev:server   # API on :3000 (PI_PANEL_RUNTIME=fake runs without Docker)
npm run dev:web      # UI on :5173, proxying /api to the server

npm run typecheck && npm run lint && npm test && npm run build
```

`PI_PANEL_RUNTIME=fake` swaps Docker for an in-memory runtime with a scripted fake pi, so the whole UI
works without containers.

### Tests against the real thing

Most tests use the fake runtime. A set of tests run the real pi SDK and CLI, a real MCP server and the
real REA, and are skipped unless you point them at installs (details in each doc):

| Tests                         | Needs                                       | Doc                                        |
| ----------------------------- | ------------------------------------------- | ------------------------------------------ |
| Package lab (`lab-real-pi`)   | `PI_SDK_ENTRY`                              | [docs/package-lab.md](docs/package-lab.md) |
| MCP discovery (`mcp-real-pi`) | `PI_SDK_ENTRY`, `PI_BIN`, `MCP_TEST_SERVER` | [docs/mcp.md](docs/mcp.md)                 |
| REA over HTTP (`rea-real`)    | the above plus `REA_NODE`, `REA_ENTRY`      | [docs/rea.md](docs/rea.md)                 |

## Layout

```
apps/server          Fastify + TypeScript API: auth, projects, sessions, providers, GitHub, packages, lab, MCP
apps/server/assets   scripts that run inside throwaway containers (package lab, MCP discovery)
apps/web             React + Vite UI (served by the server in the production image)
docker/base          sandbox image: Node 24 + pi (pinned)
docker/rea           optional REA image: Node, JDK 21, Ghidra
docs/                design notes and how-tos
```

## Security model, briefly

- One admin account, created on first run. Sessions use HttpOnly, SameSite=Strict cookies.
- Each project runs in its own container with dropped capabilities and resource limits. The agent runs
  with that container's permissions, so provider keys or command-server secrets passed to a session are
  visible to it. Prefer URL servers that hold their own credentials, or managed containers.
- Secrets (provider keys, GitHub token, MCP values) are AES-256-GCM encrypted at rest and never returned
  by the API. Generated pi config files contain `${VAR}` references, not values.
- Repository contents are treated as hostile: git runs with hooks disabled, a validated `.git`, an
  origin-scoped token and (as root) a dropped uid. A cloned repo's own `.pi` resources do not load.
- Throwaway runs (lab, MCP tests) copy files in as a tar archive and mount nothing from the host.
- Pi-Panel deliberately does not read secrets from environment variables or a `.env` file.

## What has been verified

| Area                                                                        | Verified how                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| API, sessions, providers, GitHub, packages, MCP, samples, sidecar lifecycle | Automated tests (fake runtime), including adversarial cases    |
| pi SDK harness, `pi mcp list --json`, generated `mcp.json`, hidden tools    | Real pi 1.4.0                                                  |
| MCP env passing, secret redaction, repo-local `.pi` not executing           | Real pi and a real MCP server                                  |
| REA catalog over HTTP (229 tools, 32 destructive hidden by default)         | Real REA 6.8.0 and real pi                                     |
| Web UI flows and serving the built UI                                       | Driven in a real browser (Playwright) and with the real server |
| **Docker: image builds, networks, mounts, `exec`, sidecars**                | **Not verified: no Docker daemon was available**               |
| **Ghidra / JDK analysis inside the REA image**                              | **Not verified**                                               |

Expect to fix things on the first real run, and please report what breaks.

## Not built yet

Promoting lab packages to a shared toolbox, a schema migrations table, a pi version and update page,
update checks for packages and MCP servers, per-call approval prompts for risky tools, multi-user
support, and a panel update notice. See [docs/updates.md](docs/updates.md).

## Documentation

- [docs/pi-integration.md](docs/pi-integration.md): how Pi-Panel uses pi (RPC, config files, providers)
- [docs/github-integration.md](docs/github-integration.md): the GitHub threat model and behaviour
- [docs/packages-integration.md](docs/packages-integration.md): reviewed, pinned package installs
- [docs/package-lab.md](docs/package-lab.md): the lab, its isolation, and what a pass means
- [docs/mcp.md](docs/mcp.md): MCP library, per-project checkboxes, managed containers
- [docs/rea.md](docs/rea.md): running REA, what is isolated, what is verified
- [docs/updates.md](docs/updates.md): pinning, upgrading pi, what is not built

## License

MIT, see [LICENSE](LICENSE).
