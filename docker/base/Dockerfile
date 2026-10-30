# Base image for per-project sandboxes: Node 22 with the pi coding agent preinstalled.
# Mirrors the "plain Docker" recipe in pi's docs/containerization.md.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*

ARG PI_PACKAGE=@earendil-works/pi-coding-agent
RUN npm install -g --ignore-scripts ${PI_PACKAGE}

# No update checks or telemetry from inside sandboxes.
ENV PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0

RUN useradd --create-home --uid 1000 --shell /bin/bash sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
