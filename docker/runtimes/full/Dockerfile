# "Full" profile: the Native profile plus Go, Rust and a JDK with Maven.
# Built by the panel (Runtime tab) or by hand, on top of the Native image:
#   docker build -t pi-panel/sandbox-full:latest docker/runtimes/full
# BASE_ID is the id of the image built on, so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-native:latest
FROM eclipse-temurin:21-jdk-jammy AS jdk
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
ARG TARGETARCH
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && if [ "$arch" = arm64 ]; then sha="$GO_SHA256_ARM64"; else sha="$GO_SHA256_AMD64"; fi \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o /tmp/go.tgz \
 && echo "$sha  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
 && apt-get purge -y curl && apt-get autoremove -y
ENV PATH=/usr/local/go/bin:${PATH} GOPATH=/workspace/.go
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
# gcc is the linker rustc calls. The toolchain lives outside /workspace so a project cannot replace it.
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo PATH=/opt/rust/cargo/bin:${PATH}
RUN apt-get update && apt-get install -y --no-install-recommends curl \
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
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:/opt/maven/bin:${PATH}
ARG MAVEN_VERSION=3.9.9
ARG MAVEN_SHA512=a555254d6b53d267965a3404ecb14e53c3827c09c3b94b5678835887ab404556bfaf78dcfe03ba76fa2508649dca8531c74bca4d5846513522404d48e8c4ac8b
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL --retry 5 --retry-all-errors "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" -o /tmp/mvn.tgz \
 && echo "$MAVEN_SHA512  /tmp/mvn.tgz" | sha512sum -c - \
 && mkdir -p /opt/maven && tar -xzf /tmp/mvn.tgz -C /opt/maven --strip-components=1 && rm /tmp/mvn.tgz \
 && apt-get purge -y curl && apt-get autoremove -y
# Maven's repository cache goes to the workspace, which is writable.
ENV MAVEN_OPTS=-Dmaven.repo.local=/workspace/.m2/repository

LABEL org.pi-panel.base-id=${BASE_ID}
USER sandbox
LABEL org.pi-panel.runtime=full
