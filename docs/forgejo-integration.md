# Forgejo integration

Forgejo works like the [GitHub integration](github-integration.md): one admin-connected account,
and projects clone, commit, push and open pull requests from the panel, never inside the sandbox.
It uses the same hardened git runner, so every protection in that document applies here too
(token only as command-scope config, workspace `.git` validation, hooks disabled, privilege drop,
per-project lock, redaction of errors).

## Differences from GitHub

- **Instance address.** The account stores the instance URL (`http://localhost:3001`, or your
  domain) next to the encrypted token. Only `http(s)` URLs without credentials, query or fragment
  are accepted. The token is scoped to that origin and git is allowed to use only that scheme.
- **Docker networking.** The panel runs in a container, so `localhost` is the container itself. For
  the local stack in `compose/forgejo`, use `http://host.docker.internal:3001`
  (the panel's compose file already maps it).
- **Cloning needs an account**, since the instance address lives with the account.
- **Auth.** The API gets `Authorization: token <PAT>`; git gets Basic auth as `<login>:<PAT>`.
- **Commit identity.** `<id>+<login>@noreply.<instance host>`, Forgejo's default no-reply format.
- **One forge per project.** A project is linked to either GitHub or Forgejo (`projects.repo_host`,
  NULL meaning GitHub). The other forge's tab reports the link and refuses to push.

## Token permissions

Create the token under *Settings → Applications* with `read:user`, `write:repository`
(and `write:issue` if you want PR comments later). The panel validates it with `GET /api/v1/user`.

## Endpoints

Same shape as GitHub's, under `/api/forgejo` (`GET|PUT|DELETE`, `POST /test`, body
`{ token, baseUrl }`) and `/api/projects/:id/forgejo` (`GET`, `POST clone|push|pr`). All are
admin-only for members, like GitHub's.
