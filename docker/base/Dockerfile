# Base image for per-project sandboxes: Node 22 with the pi coding agent preinstalled.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# TODO(spike): confirm the pi package name and non-interactive invocation against pi.dev docs.
ARG PI_PACKAGE=@mariozechner/pi-coding-agent
RUN npm install -g ${PI_PACKAGE}

RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
