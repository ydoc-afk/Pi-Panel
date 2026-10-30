# Managed container for the REA MCP server (https://github.com/morluto/rea): Node, a JDK and Ghidra.
# Pi-Panel starts it on a private network with no internet access and mounts a project's uploaded
# samples read-only at /samples. NOT yet built or run end to end: see docs/rea.md.
#
# Build (the Ghidra URL and checksum are required; see docs/rea.md for where to get them):
#   docker build -t pi-panel/rea:6.8.0 \
#     --build-arg GHIDRA_URL=... --build-arg GHIDRA_SHA256=... docker/rea

# JDK 21 from Temurin; Debian bookworm only ships 17.
FROM eclipse-temurin:21-jdk-jammy AS jdk

# Node >= 22.23.4 or 24.22.1 is required by REA 6.8.0.
FROM node:24-bookworm-slim
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:${PATH}

# procps: REA checks process ownership with ps on Linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl procps unzip \
 && rm -rf /var/lib/apt/lists/*

ARG GHIDRA_URL
ARG GHIDRA_SHA256
RUN test -n "$GHIDRA_URL" && test -n "$GHIDRA_SHA256" \
 || { echo "Set the GHIDRA_URL and GHIDRA_SHA256 build args (see docs/rea.md)" >&2; exit 1; }
RUN curl -fsSL "$GHIDRA_URL" -o /tmp/ghidra.zip \
 && echo "$GHIDRA_SHA256  /tmp/ghidra.zip" | sha256sum -c - \
 && unzip -q /tmp/ghidra.zip -d /opt \
 && mv /opt/ghidra_* /opt/ghidra \
 && rm /tmp/ghidra.zip

# rea-agents has no install-time scripts, so --ignore-scripts costs nothing and removes that risk.
ARG REA_VERSION=6.8.0
RUN npm install -g --ignore-scripts rea-agents@${REA_VERSION}

ENV GHIDRA_INSTALL_DIR=/opt/ghidra \
    REA_LOG_LEVEL=info

# The node image already has UID 1000 (user "node"): rename it rather than add a clashing user.
RUN usermod --login sandbox --home /home/sandbox --move-home node \
 && groupmod --new-name sandbox node
USER sandbox
WORKDIR /home/sandbox

EXPOSE 8765
# Streamable HTTP at /mcp. It has no authentication, which is why it only ever runs on a private network.
CMD ["rea", "mcp", "--http", "--host", "0.0.0.0", "--port", "8765"]
