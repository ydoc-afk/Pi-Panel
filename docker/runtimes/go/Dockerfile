# Runtime variant of the sandbox image. Built by the panel (Runtimes card) or by hand:
#   docker build -t pi-panel/sandbox-go:latest --build-arg BASE_IMAGE=pi-panel/sandbox-base:latest docker/runtimes/go
# BASE_ID records which base image this was built on, so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-base:latest
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
ARG TARGETARCH
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && if [ "$arch" = arm64 ]; then sha="$GO_SHA256_ARM64"; else sha="$GO_SHA256_AMD64"; fi \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o /tmp/go.tgz \
 && echo "$sha  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
 && apt-get purge -y curl && apt-get autoremove -y
ENV PATH=/usr/local/go/bin:${PATH} GOPATH=/workspace/.go

LABEL org.pi-panel.base-id=${BASE_ID}
USER sandbox
LABEL org.pi-panel.runtime=go
