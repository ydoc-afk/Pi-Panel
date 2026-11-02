#!/usr/bin/env bash
# Creates .env with fresh secrets, then brings the stack up, creates the admin user, and registers the CI runner.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
set_var() { grep -q "^$1=.\+" .env || { sed -i "/^$1=/d" .env; echo "$1=$2" >> .env; }; }
set_var DB_PASSWORD "$(openssl rand -hex 16)"
set_var SECRET_KEY "$(openssl rand -hex 32)"
set_var RUNNER_SECRET "$(openssl rand -hex 20)"
set_var PUID "$(id -u)"
set_var PGID "$(id -g)"
DATA_DIR=$(grep -s "^DATA_DIR=" .env | cut -d= -f2-); DATA_DIR=${DATA_DIR:-./data}
mkdir -p "$DATA_DIR"/postgres "$DATA_DIR"/forgejo "$DATA_DIR"/runner
set -a; . ./.env; set +a

docker compose up -d db forgejo
echo "Waiting for Forgejo..."
until [ "$(docker compose ps forgejo --format '{{.Health}}')" = healthy ]; do sleep 3; done

FJ="docker compose exec -T -u git forgejo forgejo"
if ! $FJ admin user list 2>/dev/null | grep -q " forgejo_admin "; then
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=')}"
  $FJ admin user create --admin --username forgejo_admin --email admin@example.com \
    --password "$ADMIN_PASSWORD" --must-change-password=false
  echo "Admin login -> forgejo_admin / $ADMIN_PASSWORD   (save this)"
fi

# Pre-register the global runner with the shared secret, then start it.
$FJ forgejo-cli actions register --secret "$RUNNER_SECRET" --scope "" --name local-runner \
  || echo "(runner already registered)"
docker compose --profile ci up -d runner
echo "Forgejo ready at http://${FORGEJO_DOMAIN:-localhost}:${HTTP_PORT:-3001}/  (SSH port ${SSH_PORT:-2222})"
