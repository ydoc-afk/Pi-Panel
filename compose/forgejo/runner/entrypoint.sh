#!/bin/sh
# Registers the runner with Forgejo using the shared secret (once), then starts the daemon.
set -eu
cd /data
if [ ! -f .runner ]; then
  forgejo-runner create-runner-file \
    --instance "$FORGEJO_INSTANCE" \
    --secret "$RUNNER_SECRET" \
    --name local-runner
fi
if [ ! -f config.yml ]; then
  forgejo-runner generate-config > config.yml
  sed -i 's#^  labels: \[\]#  labels: ["ubuntu-latest:docker://node:22-bookworm", "ubuntu-24.04:docker://node:22-bookworm", "docker:docker://node:22-bookworm"]#' config.yml
  # Job containers join the compose network so they can reach http://forgejo:3000.
  sed -i 's#^  network: .*#  network: forgejo_default#' config.yml
fi
exec forgejo-runner daemon --config config.yml
