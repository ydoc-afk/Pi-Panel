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

## Updating the panel

The panel updates itself from the **Updates** page through the `updater` container
(`apps/server/src/updater.ts`, entry point `updater-main.ts`). See [Updating](../README.md#updating) for
what it checks and does. Points worth knowing:

- **The checkout is the source of truth.** The updater moves the host's git checkout with `git merge
--ff-only` (or checks out the other channel) and builds with `docker compose`, so a later manual
  `git pull && docker compose up -d --build` carries on from the same place. Git runs as the owner of
  the checkout, so it stays editable from the host.
- **Only a channel's tip is installed**, and only the one the admin was shown: if the branch moved in
  between, the update is refused.
- **The image of the previous build is kept** as `<image>:pp-previous`, so going back does not need a
  rebuild. Backups in `data/backups/` keep the newest five the updater made.
- **The running commit** is baked into the image as `PI_PANEL_COMMIT` and shown on the Updates page.
  Images built by hand show it as unknown.

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
- An update for the updater itself. The panel image is rebuilt on each update, but the `updater` image
  only when you run `docker compose up -d --build` on the host; its code changes rarely.
