#!/bin/sh
# OpenVibe LLM inference worker: verify the pinned GGUF, run llama.cpp server on loopback, and put
# Caddy in front for /health, /ready and the Prometheus /metrics passthrough.
#
# Bounded settings come from the environment; see README.md. The worker never exposes a dynamic
# LoRA API: llama.cpp is started without --lora, and Caddy refuses the LoRA load/unload paths.
set -eu

log() { printf 'llm-inference: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

is_uint() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    return 0
}

# uint_in_range NAME VALUE MIN MAX
uint_in_range() {
    name=$1
    value=$2
    min=$3
    max=$4
    is_uint "$value" || die "$name must be an integer (got '$value')"
    [ "$value" -ge "$min" ] || die "$name must be >= $min (got $value)"
    [ "$value" -le "$max" ] || die "$name must be <= $max (got $value)"
}

ARTIFACT_MANIFEST=${ARTIFACT_MANIFEST:-/etc/openvibe/artifact.json}
MODEL_DIR=${MODEL_DIR:-/models}
PORT=${PORT:-8080}
LLM_PORT=${LLM_PORT:-8081}
DRAIN_SECONDS=${DRAIN_SECONDS:-30}
LLM_CTX=${LLM_CTX:-4096}
LLM_CTX_MAX=${LLM_CTX_MAX:-32768}
LLM_PARALLEL=${LLM_PARALLEL:-1}
LLM_PARALLEL_MAX=${LLM_PARALLEL_MAX:-8}
LLM_KV_TYPE_K=${LLM_KV_TYPE_K:-f16}
LLM_KV_TYPE_V=${LLM_KV_TYPE_V:-f16}
LLM_GPU_LAYERS=${LLM_GPU_LAYERS:-99}
LLM_THREADS=${LLM_THREADS:-}

# Caddy reads these from its environment for {$PORT}, {$LLM_PORT} and {$DRAIN_SECONDS}.
export PORT LLM_PORT DRAIN_SECONDS

uint_in_range PORT "$PORT" 1 65535
uint_in_range LLM_PORT "$LLM_PORT" 1 65535
[ "$PORT" != "$LLM_PORT" ] || die "PORT and LLM_PORT must differ"

uint_in_range DRAIN_SECONDS "$DRAIN_SECONDS" 1 300
uint_in_range LLM_CTX "$LLM_CTX" 512 131072
uint_in_range LLM_CTX_MAX "$LLM_CTX_MAX" 512 131072
[ "$LLM_CTX" -le "$LLM_CTX_MAX" ] || die "LLM_CTX ($LLM_CTX) exceeds LLM_CTX_MAX ($LLM_CTX_MAX)"
uint_in_range LLM_PARALLEL "$LLM_PARALLEL" 1 16
uint_in_range LLM_PARALLEL_MAX "$LLM_PARALLEL_MAX" 1 16
[ "$LLM_PARALLEL" -le "$LLM_PARALLEL_MAX" ] || die "LLM_PARALLEL ($LLM_PARALLEL) exceeds LLM_PARALLEL_MAX ($LLM_PARALLEL_MAX)"
[ $((LLM_CTX / LLM_PARALLEL)) -ge 512 ] || die "LLM_CTX / LLM_PARALLEL must be at least 512 tokens per slot"
uint_in_range LLM_GPU_LAYERS "$LLM_GPU_LAYERS" 0 999
if [ -n "$LLM_THREADS" ]; then
    uint_in_range LLM_THREADS "$LLM_THREADS" 1 256
fi

allowed_kv=' f32 f16 bf16 q8_0 q4_0 q4_1 iq4_nl q5_0 q5_1 '
case "$allowed_kv" in
    *" $LLM_KV_TYPE_K "*) ;;
    *) die "LLM_KV_TYPE_K must be one of:$allowed_kv(got '$LLM_KV_TYPE_K')" ;;
esac
case "$allowed_kv" in
    *" $LLM_KV_TYPE_V "*) ;;
    *) die "LLM_KV_TYPE_V must be one of:$allowed_kv(got '$LLM_KV_TYPE_V')" ;;
esac

[ -x /app/llama-server ] || die "/app/llama-server is missing"
command -v caddy >/dev/null 2>&1 || die "caddy is missing"

log "verifying artifact from $ARTIFACT_MANIFEST"
MODEL_PATH=$(/usr/local/bin/verify-artifact.sh "$ARTIFACT_MANIFEST" "$MODEL_DIR") || exit 1
MODEL_ID=$(jq -r '.artifact.id' "$ARTIFACT_MANIFEST") || die "cannot read artifact.id"
log "artifact verified: $MODEL_PATH"

set -- /app/llama-server \
    --model "$MODEL_PATH" \
    --alias "$MODEL_ID" \
    --host 127.0.0.1 \
    --port "$LLM_PORT" \
    --ctx-size "$LLM_CTX" \
    --parallel "$LLM_PARALLEL" \
    --n-gpu-layers "$LLM_GPU_LAYERS" \
    --cache-type-k "$LLM_KV_TYPE_K" \
    --cache-type-v "$LLM_KV_TYPE_V" \
    --no-webui \
    --metrics
if [ -n "$LLM_THREADS" ]; then
    set -- "$@" --threads "$LLM_THREADS"
fi

log "starting llama-server on 127.0.0.1:$LLM_PORT (ctx $LLM_CTX total, $((LLM_CTX / LLM_PARALLEL)) per slot, parallel $LLM_PARALLEL, KV $LLM_KV_TYPE_K/$LLM_KV_TYPE_V)"
"$@" &
LLAMA_PID=$!

log "starting gateway on :$PORT (ready maps to llama.cpp /health)"
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

wait_pid() {
    pid=$1
    while kill -0 "$pid" 2>/dev/null; do
        wait "$pid" 2>/dev/null || true
    done
}

DRAINING=0
on_signal() {
    [ "$DRAINING" = 1 ] && return
    DRAINING=1
    log "SIGTERM: not ready; draining in-flight requests for up to ${DRAIN_SECONDS}s"
    # Caddy stops accepting at SIGTERM and waits for in-flight requests (grace_period).
    if kill -0 "$CADDY_PID" 2>/dev/null; then
        kill -TERM "$CADDY_PID" 2>/dev/null || true
        wait_pid "$CADDY_PID"
    fi
    log "gateway drained; stopping llama-server"
    if kill -0 "$LLAMA_PID" 2>/dev/null; then
        kill -TERM "$LLAMA_PID" 2>/dev/null || true
        wait_pid "$LLAMA_PID"
    fi
    log "drained"
    exit 0
}
trap on_signal TERM INT

while :; do
    if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
        status=0
        wait "$LLAMA_PID" 2>/dev/null || status=$?
        log "llama-server exited (status $status); stopping gateway"
        kill -TERM "$CADDY_PID" 2>/dev/null || true
        wait_pid "$CADDY_PID"
        exit "$status"
    fi
    if ! kill -0 "$CADDY_PID" 2>/dev/null; then
        status=0
        wait "$CADDY_PID" 2>/dev/null || status=$?
        log "gateway exited (status $status); stopping llama-server"
        kill -TERM "$LLAMA_PID" 2>/dev/null || true
        wait_pid "$LLAMA_PID"
        exit "$status"
    fi
    sleep 1 || true
done
