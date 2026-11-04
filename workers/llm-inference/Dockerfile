# syntax=docker/dockerfile:1
#
# OpenVibe LLM inference worker (llama.cpp server, GGUF). Build from this directory:
#
#   docker build -t openvibe/llm-inference .
#   docker build --build-arg LLAMA_CPP_TAG=server \
#                --build-arg LLAMA_CPP_DIGEST=sha256:10a38e6cc91760ab157f0a0a8546218d35f4a314432a70298abfa3d096829ad7 \
#                -t openvibe/llm-inference:cpu .
#
# Both llama.cpp bases are pinned by digest, not by tag alone. The tag names the artifact for a
# human reader; the digest is what Docker resolves. Refresh a pin only as a deliberate change:
#
#   docker buildx imagetools inspect ghcr.io/ggml-org/llama.cpp:server-cuda
#   docker buildx imagetools inspect docker.io/library/caddy:2
#
# Resolved 2026-11-04 (server-cuda and server are the upstream rolling tags at that moment).
ARG LLAMA_CPP_IMAGE=ghcr.io/ggml-org/llama.cpp
ARG LLAMA_CPP_TAG=server-cuda
ARG LLAMA_CPP_DIGEST=sha256:d5ffba7d096ab0236c65dc147d797b4b7658a7e5425634593373635d661bccda

# The gateway binary is copied from the pinned Caddy image; no package repository is trusted at
# build time for it.
ARG CADDY_IMAGE=docker.io/library/caddy
ARG CADDY_TAG=2
ARG CADDY_DIGEST=sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e

FROM ${CADDY_IMAGE}:${CADDY_TAG}@${CADDY_DIGEST} AS gateway

FROM ${LLAMA_CPP_IMAGE}:${LLAMA_CPP_TAG}@${LLAMA_CPP_DIGEST}

# jq parses the manifest; curl and sha256sum come from the llama.cpp runtime image (curl is part
# of that image, the checksum tool is coreutils). passwd is explicit so groupadd/useradd exist on
# every base variant.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates jq passwd \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system openvibe \
    && useradd --system --gid openvibe --home-dir /app --shell /usr/sbin/nologin openvibe \
    && mkdir -p /models /etc/openvibe /etc/caddy /tmp/caddy \
    && chown -R openvibe:openvibe /models /tmp/caddy

COPY --from=gateway /usr/bin/caddy /usr/local/bin/caddy
COPY entrypoint.sh verify-artifact.sh /usr/local/bin/
COPY Caddyfile /etc/caddy/Caddyfile

RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/verify-artifact.sh /usr/local/bin/caddy \
    && chown -R openvibe:openvibe /etc/caddy /etc/openvibe

ENV PORT=8080 \
    LLM_PORT=8081 \
    DRAIN_SECONDS=30 \
    HOME=/tmp/caddy \
    XDG_DATA_HOME=/tmp/caddy \
    XDG_CONFIG_HOME=/tmp/caddy

USER openvibe
EXPOSE 8080

# Start period covers the artifact download plus model load; until llama.cpp answers /health the
# gateway's /ready is not 2xx.
HEALTHCHECK --interval=15s --timeout=3s --start-period=900s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/ready" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
