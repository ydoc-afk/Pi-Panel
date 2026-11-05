# Runtime variant of the sandbox image. Built by the panel (Runtimes card) or by hand:
#   docker build -t pi-panel/sandbox-build:latest --build-arg BASE_IMAGE=pi-panel/sandbox-base:latest docker/runtimes/build
# BASE_ID records which base image this was built on, so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-base:latest
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake pkg-config \
 && rm -rf /var/lib/apt/lists/*

LABEL org.pi-panel.base-id=${BASE_ID}
USER sandbox
LABEL org.pi-panel.runtime=build
