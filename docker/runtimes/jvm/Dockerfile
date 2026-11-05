# Runtime variant of the sandbox image. Built by the panel (Runtimes card) or by hand:
#   docker build -t pi-panel/sandbox-jvm:latest --build-arg BASE_IMAGE=pi-panel/sandbox-base:latest docker/runtimes/jvm
# BASE_ID records which base image this was built on, so the panel can tell when it has gone stale.
ARG BASE_IMAGE=pi-panel/sandbox-base:latest
FROM eclipse-temurin:21-jdk-jammy AS jdk
FROM ${BASE_IMAGE}
ARG BASE_ID=unknown
USER root
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
LABEL org.pi-panel.runtime=jvm
