# "Native" profile: Python (from the Scripting profile) plus C/C++ build tools and the usual
# binary-inspection helpers, for compiling and checking recovered or reverse-engineered code.
# Built by the panel (Runtime tab) or by hand, on top of the Scripting image:
#   docker build -t pi-panel/sandbox-native:latest docker/runtimes/native
# BASE_ID is the id of the image built on, so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-python:latest
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake pkg-config gdb nasm file xxd \
 && rm -rf /var/lib/apt/lists/*

LABEL org.pi-panel.base-id=${BASE_ID}
USER sandbox
LABEL org.pi-panel.runtime=native
