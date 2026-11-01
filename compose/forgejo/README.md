# Local Forgejo

Self-hosted git forge (repos, PRs, issues, wiki, projects, packages/registry, Actions CI) running in Docker.

- Stack: Forgejo 14 + PostgreSQL 17 + Forgejo Actions runner (`ci` profile)
- Web: http://localhost:3001  ·  SSH: `ssh://git@localhost:2222/<user>/<repo>.git`
- Ports are 3001/2222 because Pi-Panel uses 3000. Change in `.env`.

## Start
    ./setup.sh          # creates .env + secrets, starts everything, makes `forgejo_admin`, registers the runner
    docker compose --profile ci up -d    # later restarts (include the runner)

Admin password is printed once by `setup.sh` (set `ADMIN_PASSWORD=...` to choose it). Public sign-up is disabled;
create users in Site Administration.

## CI
Workflows in `.forgejo/workflows/*.yml` (GitHub Actions syntax) run on labels `ubuntu-latest`, `ubuntu-24.04`, `docker`.
The runner uses the host Docker socket: trusted local use only.

## Backup / reset
Everything lives in `./data`. Back up with `docker compose down && tar czf forgejo-backup.tgz data .env`.
Reset: `docker compose --profile ci down && sudo rm -rf data .env`.
