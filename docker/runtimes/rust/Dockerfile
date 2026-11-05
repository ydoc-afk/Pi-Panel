# Runtime variant of the sandbox image. Built by the panel (Runtimes card) or by hand:
#   docker build -t pi-panel/sandbox-rust:latest --build-arg BASE_IMAGE=pi-panel/sandbox-base:latest docker/runtimes/rust
# BASE_ID records which base image this was built on, so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-base:latest
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
ARG TARGETARCH
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
# gcc is the linker rustc calls. The toolchain lives outside /workspace so a project cannot replace it.
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo PATH=/opt/rust/cargo/bin:${PATH}
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && if [ "$arch" = arm64 ]; then sha="$RUSTUP_SHA256_ARM64"; triple=aarch64-unknown-linux-gnu; \
    else sha="$RUSTUP_SHA256_AMD64"; triple=x86_64-unknown-linux-gnu; fi \
 && curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init" -o /tmp/rustup-init \
 && echo "$sha  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --profile minimal --default-toolchain stable --no-modify-path \
 && rm /tmp/rustup-init \
 && chmod -R a+rX /opt/rust && apt-get purge -y curl && apt-get autoremove -y
# Cargo's download cache goes to the workspace, which is writable (the toolchain is not).
ENV CARGO_HOME=/workspace/.cargo

LABEL org.pi-panel.base-id=${BASE_ID}
USER sandbox
LABEL org.pi-panel.runtime=rust
