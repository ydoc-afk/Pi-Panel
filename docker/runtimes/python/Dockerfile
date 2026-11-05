# Runtime variant of the sandbox image. Built by the panel (Runtimes card) or by hand:
#   docker build -t pi-panel/sandbox-python:latest --build-arg BASE_IMAGE=pi-panel/sandbox-base:latest docker/runtimes/python
# BASE_ID is the id of the image built on (the sandbox image here), so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-base:latest
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv python3-dev \
 && rm -rf /var/lib/apt/lists/*
# uv: fast venv/package manager. Debian marks system pip as externally managed, hence the flag.
RUN pip3 install --no-cache-dir --break-system-packages uv==0.5.31

LABEL org.pi-panel.base-id=${BASE_ID}
USER sandbox
LABEL org.pi-panel.runtime=python
