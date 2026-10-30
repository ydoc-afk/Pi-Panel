# Pi packages

Pi packages (extensions, skills, prompts, themes) are installed per project with `pi install`,
run inside the project's container, and persisted in the project's bind-mounted agent dir
(`settings.json`). Pi-Panel lists them by reading that file and installs or removes them by
running `pi install` / `pi remove` in the container.

## Review before install

Installing is two steps, enforced by the server (`apps/server/src/packages.ts`):

1. **Preview** resolves `npm:name[@tag|@version]` against the registry to an _exact_ version and
   returns what an admin should check: publisher, license, repository, dependencies, resources the
   package declares, install-time scripts, deprecation, size, and links to browse the files.
2. **Install** only accepts the exact `npm:name@x.y.z` that was just reviewed (single-use,
   15 minutes). Unreviewed, unpinned, or different versions are refused.

Safeguards: only `npm:` sources are accepted (strict name and version syntax, so nothing that
looks like a flag or a path reaches the CLI); `NPM_CONFIG_IGNORE_SCRIPTS=true` disables dependency
install scripts; `remove` only accepts sources that are currently installed.

## What this does and does not protect

The review step protects the _admin_ from installing something they did not look at. It is not a
security boundary against the agent: the agent can run `pi install` itself through its bash tool.
The real boundary is the container, so packages can only affect that project's workspace, agent
dir, and whatever credentials were passed into the session.

## Applying changes

pi has no reload command over RPC, so after an install or removal Pi-Panel stops the pi process of
each idle session; the next prompt starts a fresh process with `--session` and loads the new
packages. Sessions that are mid-run keep their old process until they finish and are restarted.

## Not yet supported

Git and local-path sources, per-package resource filtering from the UI, and update checks.
