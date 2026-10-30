# GitHub integration

A single personal access token (PAT) is stored encrypted, like provider keys. Clone, commit,
push and pull-request creation run from the panel, never inside the sandbox container.

## Threat model

The sandboxed agent controls everything in a project's workspace, including `.git/config` and
hooks. Git runs in the panel process, so those files must not be able to run code or steal the
token. Mitigations, all covered by tests in `apps/server/src/github.test.ts`:

- **Token delivery:** passed only as command-scope config in the git child's environment
  (`GIT_CONFIG_KEY_0=http.<origin>/.extraHeader`). It is scoped to the GitHub origin, never put on
  the command line, never written to `.git/config`, and redacted from error text.
- **Remote URL:** push and clone use an explicit URL built from the repo recorded in the database,
  not whatever `.git/config` says.
- **Workspace validation:** before any git command, `.git` must be a real directory (not a
  symlink or gitfile), have no object alternates, and its config may contain only an allow-list
  of keys (`core.*` basics, `remote.*.url/fetch`, `branch.*.remote/merge`, `user.name/email`).
- **Hardening flags:** `core.hooksPath=/dev/null`, `core.fsmonitor=false`, empty credential
  helper, `protocol.allow=never` with only https allowed, no system or global git config.
- **Privilege drop:** when the panel runs as root, git runs as uid 1000 (the sandbox user), so a
  hostile repository cannot read `secret.key` or other panel files.
- **Per-project lock:** git operations on one project never interleave.

## Behaviour

- Cloning requires an empty workspace and works without a token for public repositories.
- "Commit & push" runs `git switch -C <branch>`, `git add -A`, commits if there are changes, then
  pushes `refs/heads/<branch>` (never forced). Commits are authored as the connected user using
  their GitHub noreply address.
- Pull requests target the repository's default branch unless a base is given.

## Token permissions

Use a fine-grained token limited to the repositories you want, with read/write access to
**Contents** and **Pull requests**. The panel only validates it by calling `GET /user`.
