# Base image for per-project sandboxes: Node with the pi coding agent preinstalled.
# Mirrors the "plain Docker" recipe in pi's docs/containerization.md.
# Node 24: current MCP reference servers require it, pi needs >= 22.19, and REA needs >= 22.23.4.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

# Pinned: pi changes quickly and Pi-Panel is tested against this version (see docs/updates.md).
ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=1.4.0
RUN npm install -g --ignore-scripts ${PI_PACKAGE}@${PI_VERSION}
# Read by the panel to show which pi version projects run (About box).
LABEL org.pi-panel.pi-version=${PI_VERSION}

# No update checks or telemetry from inside sandboxes.
ENV PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0

# The node image already has UID 1000 (user "node"): rename it rather than add a clashing user.
RUN usermod --login sandbox --home /home/sandbox --move-home node \
 && groupmod --new-name sandbox node
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
