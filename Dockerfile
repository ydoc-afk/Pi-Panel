FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps ./apps
RUN npm run build

# The updater: rebuilds and restarts the panel from this checkout when the admin presses Update
# (apps/server/src/updater.ts). It needs git, the Docker CLI and the compose plugin, and nothing
# from npm.
FROM docker:27.5.1-cli AS docker-cli

FROM node:22-bookworm-slim AS updater
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /updater
COPY --from=build /app/apps/server/dist/updater.js /app/apps/server/dist/updater-main.js ./
RUN echo '{"type":"module"}' > package.json
ENV NODE_ENV=production PORT=8080
CMD ["node", "/updater/updater-main.js"]

# The panel. Last, so `docker compose build` and a plain `docker build .` produce it by default.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev -w @pi-panel/server
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/assets apps/server/assets
# The panel builds the REA image from this Dockerfile (see apps/server/src/rea-build.ts).
COPY docker/rea docker/rea
COPY --from=build /app/apps/web/dist apps/web/dist
# The commit this image was built from; the updater passes it in. Late, so it does not bust the cache.
ARG PI_PANEL_COMMIT=
ENV PI_PANEL_COMMIT=$PI_PANEL_COMMIT
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
