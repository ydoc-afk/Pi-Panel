# Runtime profiles

A project's container is made from one image. By default that is the sandbox image (Node 24, git,
ripgrep, pi). Profiles add toolchains on top of it so the agent can run and test code:

| Profile                      | Adds                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| Minimal                      | nothing (the default)                                               |
| Scripting                    | Python 3, pip, venv, uv                                             |
| Native / reverse engineering | Scripting + gcc, g++, make, cmake, pkg-config, gdb, nasm, file, xxd |
| Full                         | Native + Go, Rust (rustc, cargo), JDK 21 and Maven (all pinned)     |

Each profile is a Dockerfile in `docker/runtimes/<id>/` layered on the one before it (Scripting on the
sandbox image, Native on Scripting, Full on Native), so the pi version, the unprivileged `sandbox` user
and the limits are the same everywhere. A project uses one profile. For decompilation work, pick
**Native**: Ghidra itself runs in the REA sidecar, so the sandbox only needs to compile and check code
and run helper scripts.

## Using one

1. Build the sandbox image first (`docker compose --profile build-only build sandbox-base`).
2. Open the project's **Runtime** tab and press **Build** on a profile. The panel builds it on this
   machine and streams the log. Profiles it is layered on are built first if they are missing, so one
   press on Full builds Scripting, Native, then Full. One build runs at a time; sizes are shown.
3. Select it. The container keeps running its old image until you press **Recreate container**
   (the tab offers it). Workspace files and session history are kept.

By hand: `docker compose --profile build-only build sandbox-python sandbox-native sandbox-full`.

## Offline

Sandboxes have no network, so nothing is downloaded inside them: no `pip install`, `cargo fetch`,
`go get` or Maven resolution. Agents can use the standard library and what the image ships. The
agent is told this (and which tools exist) through `AGENTS.md` in its agent dir. Caches that tools
write (`/workspace/.go`, `/workspace/.cargo`, `/workspace/.m2`) live in the workspace. Toolchains
live outside `/workspace` and cannot be replaced by a project.

## Stale images

Each profile image records the id of the image it was built on. After you rebuild the sandbox image
(for example to move to a newer pi), or a profile below it, the Runtime tab marks the profiles built
on the old one; rebuild them from the bottom up (Scripting, then Native, then Full), then recreate the
projects that use them. Pi-Panel never pulls images, and does not accept custom Dockerfiles from the
UI. To go beyond this list, build your own image `FROM` the sandbox image and set `SANDBOX_IMAGE`
(it then replaces the base for projects on Minimal).

A project left on a profile that no longer exists (the earlier single-toolchain profiles) falls back
to Minimal the next time its container is created.

## Adding a profile

Add `docker/runtimes/<id>/Dockerfile` (`ARG BASE_IMAGE`, `ARG BASE_ID`, install as root,
`LABEL org.pi-panel.base-id=${BASE_ID}`, back to `USER sandbox`), an entry in `RUNTIME_VARIANTS` in
`apps/server/src/runtimes.ts` (with its `parent` and the note the agent is given), and a service in
`docker-compose.yml`. A test checks that every profile has a Dockerfile of this shape.
