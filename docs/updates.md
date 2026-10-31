# Updates

Pi-Panel depends on pi, so updates are mostly about keeping the two in step.

## What is in place

- **pi is pinned** in the sandbox image (`ARG PI_VERSION` in `docker/base/Dockerfile`, currently 1.4.0)
  and runs with `PI_SKIP_VERSION_CHECK=1`. Do not run `pi update` inside a container: the image owns
  the version, so every project on an image behaves the same and an update is a deliberate rebuild.
- **Package, MCP and lab reports record the pi version** they ran against (`sdkVersion` / `piVersion`).
- **Real-pi tests** (`lab-real-pi.test.ts`, `mcp-real-pi.test.ts`) check the parts of pi we depend on
  that a fake cannot: the SDK harness, `pi mcp list --json`, and the generated `mcp.json`.
- **Presets pin versions**, and package installs and reviews are pinned to an exact version.
- **Managed containers are pinned by image tag** (`pi-panel/rea:6.8.0`); REA's version is a build arg
  of `docker/rea`. Pi-Panel never pulls images, so updating one is a deliberate rebuild plus a new
  tag, then a restart from the project's MCP section.
- The sandbox base image is Node 24: current reference MCP servers require it, pi needs 22.19+, and
  REA needs 22.23.4+.

## Schema changes

The database schema is changed only by numbered migrations in `apps/server/src/db.ts`. Each runs once,
in a transaction, and is recorded in `schema_migrations`; `/api/health` and the About box show the
current number. Append new migrations; never edit or reorder ones that have shipped. Older code cannot
read a newer schema, so rolling back across a migration means restoring the data backup as well.

## How to move to a newer pi

1. Run the real-pi tests against the new version (see `docs/mcp.md` and `docs/package-lab.md`).
2. Bump `PI_VERSION`, rebuild the image (`docker compose --profile build-only build sandbox-base`).
3. Press **Recreate container** on each project so it uses the new image. The workspace and pi's agent
   dir are bind-mounted, so files and pi session history are kept. The About box (account menu) shows
   the pi version the sandbox image was built with.

## What pi-facing surface we use

| Surface                                                                                                | Used for                           | How stable                                                        |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------- |
| `pi --mode rpc` JSONL protocol                                                                         | sessions                           | documented                                                        |
| `models.json`, `mcp.json`, `settings.json` formats                                                     | providers, MCP, packages           | documented                                                        |
| `pi install` / `pi remove` / `pi mcp list --json`                                                      | packages, MCP test                 | documented CLI                                                    |
| SDK (`DefaultResourceLoader`, `createAgentSession`, `session.agent.state.tools`, `createMcpExtension`) | package lab and MCP test harnesses | not a stable contract: the likeliest thing to break on an upgrade |

## Not built yet

- A one-click pi rebuild. The About box shows the installed version, but not the latest.
- Update checks and a diff-aware review (publisher change, new install scripts, new dependencies) for
  packages and MCP servers.
- A panel update notice. Updating the panel itself is a rebuild from source (images are not published):
  see [Updating](../README.md#updating) in the README. Keep the data directory and `secret.key` backed
  up together.
