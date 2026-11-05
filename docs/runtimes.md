# Runtime images

A project's container is made from one image. By default that is the sandbox image (Node 24, git,
ripgrep, pi). Runtime images add a toolchain on top of it so the agent can run and test code:

| Runtime | Adds                                               |
| ------- | -------------------------------------------------- |
| Python  | Python 3, pip, venv, uv                            |
| C/C++   | gcc, g++, make, cmake, pkg-config                  |
| Go      | Go (pinned, checksum verified)                     |
| Rust    | rustc and cargo, stable, minimal profile           |
| Java    | JDK 21 (from `eclipse-temurin`) and Maven (pinned) |

Each is a Dockerfile in `docker/runtimes/<id>/` that starts `FROM` the sandbox image, so the pi
version, the unprivileged `sandbox` user and the limits are the same everywhere. A project uses one
runtime; there are no combinations.

## Using one

1. Build the sandbox image first (`docker compose --profile build-only build sandbox-base`).
2. Open the project's **Runtime** tab and press **Build** on the runtime. The panel builds it on this
   machine and streams the log. One build runs at a time; sizes are shown (Rust and Java are the large ones).
3. Select it. The container keeps running its old image until you press **Recreate container**
   (the tab offers it). Workspace files and session history are kept.

By hand: `docker compose --profile build-only build sandbox-python` (or `-build`, `-go`, `-rust`, `-jvm`).

## Offline

Sandboxes have no network, so nothing is downloaded inside them: no `pip install`, `cargo fetch`,
`go get` or Maven resolution. Agents can use the standard library and what the image ships. The
agent is told this (and which tools exist) through `AGENTS.md` in its agent dir. Caches that tools
write (`/workspace/.go`, `/workspace/.cargo`, `/workspace/.m2`) live in the workspace, so files you
place there are kept. Toolchains live outside `/workspace` and cannot be replaced by a project.

## Stale images

Each runtime image records the id of the base image it was built on. After you rebuild the base
(for example to move to a newer pi) the Runtime tab marks runtimes built on the old one; rebuild
them, then recreate the projects that use them. Pi-Panel never pulls images, and does not accept
custom Dockerfiles from the UI. To go beyond this list, build your own image `FROM` the sandbox image
and set `SANDBOX_IMAGE` (it then replaces the base for projects on "Node only").

## Adding a runtime

Add `docker/runtimes/<id>/Dockerfile` (copy an existing one: `ARG BASE_IMAGE`, `ARG BASE_ID`,
install as root, `LABEL org.pi-panel.base-id=${BASE_ID}`, back to `USER sandbox`), then an entry in
`RUNTIME_VARIANTS` in `apps/server/src/runtimes.ts` with the note the agent is given, and a service in
`docker-compose.yml`. A test checks that every variant has a Dockerfile of this shape.
