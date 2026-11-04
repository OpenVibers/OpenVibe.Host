# LLM inference worker (llama.cpp, GGUF)

A portable GPU worker image for one pinned GGUF artifact: llama.cpp server on loopback, a small
Caddy gateway in front, checksum-verified model download, bounded context/parallel/KV settings,
`/health` + `/ready`, the Prometheus `/metrics` endpoint passed through, and a graceful drain on
`SIGTERM`. No dynamic LoRA API is exposed.

## Ownership

OpenVibe.Host owns worker/deployment orchestration and safe budgeted GPU placement (PLAN.md §B),
so the deployment artifact and its cost model live here. The model/variant registry, catalog
entries, revisions, routing and inference requests are OpenVibe.AI's (PLAN.md §B, D3/D4); this
worker consumes one pinned artifact and never registers or advertises a model. `docs/nodes.md`
describes Host's node-registry reporting, and Host's `workerUnits` inventory hook is for units that
drain and exit on their own (Host never starts, stops or restarts them). This image is that kind
of long-running worker: it can run under a `workerUnits` unit or any GPU orchestrator.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | llama.cpp base pinned by digest, plus a Caddy binary copied from a pinned image |
| `entrypoint.sh` | validates env bounds, verifies the artifact, starts llama.cpp + gateway, drains |
| `verify-artifact.sh` | downloads by URL, checks the manifest SHA-256, refuses a mismatch |
| `Caddyfile` | `/health`, `/ready`, `/metrics` and API passthrough; blocks LoRA paths |
| `examples/qwen3-4b-abliterated.manifest.example.json` | one compact abliterated Qwen 4B artifact, revision and hash **TODO** |
| `examples/inference-cost-model.example.json` | clearly labelled placeholder inputs for the cost model |

## Build

From this directory:

```sh
# GPU image (CUDA base, the default)
docker build -t openvibe/llm-inference:gpu .

# CPU image for a smoke test (same entrypoint and checks, CPU llama.cpp base)
docker build \
  --build-arg LLAMA_CPP_TAG=server \
  --build-arg LLAMA_CPP_DIGEST=sha256:10a38e6cc91760ab157f0a0a8546218d35f4a314432a70298abfa3d096829ad7 \
  -t openvibe/llm-inference:cpu .
```

Both bases are pinned by digest. Refresh a pin only as a deliberate change:

```sh
docker buildx imagetools inspect ghcr.io/ggml-org/llama.cpp:server-cuda
docker buildx imagetools inspect docker.io/library/caddy:2
```

## The artifact manifest

Copy `examples/qwen3-4b-abliterated.manifest.example.json` and fill in **both** placeholders before
running:

- `artifact.revision`: the immutable commit/revision of the artifact repository (for Hugging Face,
  the commit SHA, not a branch).
- `artifact.sha256` and `download.url`: the revision-pinned URL and the SHA-256 published for that
  exact file. The example deliberately contains `TODO` values; the verifier refuses them. Never
  invent a hash and never reuse one from another quantization.

```json
{
  "schema": "openvibe.ai.worker-artifact@1",
  "artifact": {
    "id": "mradermacher/Huihui-Qwen3-4B-Instruct-2507-abliterated:q4_k_m@<revision>",
    "revision": "<revision>",
    "sha256": "<64 lowercase hex>",
    "license": "apache-2.0"
  },
  "download": { "url": "https://…/<revision>/<file>.gguf", "filename": "<file>.gguf" }
}
```

`verify-artifact.sh`:

1. requires `schema`, `artifact.id`, `artifact.revision`, `artifact.sha256`, `download.url` and a
   plain `download.filename`;
2. refuses any `TODO` placeholder and any hash that is not 64 lowercase hex characters;
3. requires `https://` for a real pin (`file://` and loopback are allowed only with
   `ALLOW_LOCAL_ARTIFACT_URL=1` for a smoke test);
4. reuses an already-downloaded file only when its hash matches, otherwise downloads to a temporary
   file, verifies it and renames it into place;
5. on mismatch deletes the temporary file, prints `SHA-256 mismatch … refusing to start` and exits
   non-zero, so the container never serves unverified weights.

The manifest is operator-controlled, not user input. The worker does not download LoRA adapters.

## Run on a GPU

```sh
cp examples/qwen3-4b-abliterated.manifest.example.json /tmp/artifact.json
# fill revision + sha256 + url in /tmp/artifact.json

docker run --rm --gpus all -p 8080:8080 \
  -v /tmp/artifact.json:/etc/openvibe/artifact.json:ro \
  -v openvibe-models:/models \
  -e LLM_CTX=8192 \
  -e LLM_PARALLEL=2 \
  -e LLM_KV_TYPE_K=f16 \
  -e LLM_KV_TYPE_V=f16 \
  openvibe/llm-inference:gpu
```

`/models` is a cache: a later run with the same manifest re-verifies the file and skips the
download. A bind-mounted host directory must be writable by the image's unprivileged `openvibe`
user (named volumes inherit the image ownership), and the bind-mounted manifest must be readable
by that user (uid 995): `chmod 644 /tmp/artifact.json`, or run with `--user "$(id -u):$(id -g)"`
only if your runtime gives that uid access to the GPU devices.

## Run on CPU for a smoke test

The CPU image exercises the same entrypoint, manifest verification, gateway and drain path:

```sh
docker run --rm -p 8080:8080 \
  -v /tmp/artifact.json:/etc/openvibe/artifact.json:ro \
  -v openvibe-models:/models \
  -e LLM_GPU_LAYERS=0 \
  -e LLM_THREADS=4 \
  -e LLM_CTX=2048 \
  -e LLM_PARALLEL=1 \
  openvibe/llm-inference:cpu
```

A 4B Q4_K_M model is slow on CPU; use it for one request and the endpoint checks, not for
throughput. Any small GGUF works for the smoke test as long as its manifest has the real revision
and hash — do not use a placeholder hash to bypass verification.

## Endpoints

The only public listener is the gateway on `$PORT` (default 8080); llama.cpp listens on
`127.0.0.1:$LLM_PORT` (default 8081).

| Path | Behaviour |
|---|---|
| `GET /health` | llama.cpp health (200 when the model/slot is loaded) |
| `GET /ready` | the same check as `/health`; use this as the orchestrator readiness probe |
| `GET /metrics` | llama.cpp Prometheus metrics, passed through |
| `/v1/chat/completions`, `/props`, `/slots`, … | passed through; streaming responses flush immediately |
| `/lora*`, `/v1/load_lora_adapter*`, `/v1/unload_lora_adapter*` | 404; no dynamic LoRA management |

The worker has **no authentication** of its own. Expose it only on a private network or behind
OpenVibe.AI's inference gateway; do not publish port 8080 to the internet.

## Bounded settings

All values are integers unless stated; a value outside its bound stops the worker before it
downloads or loads anything.

| Env | Default | Bound | Meaning |
|---|---|---|---|
| `LLM_CTX` | `4096` | `512`–`131072`, ≤ `LLM_CTX_MAX` | total context across slots (`--ctx-size`) |
| `LLM_CTX_MAX` | `32768` | `512`–`131072` | operator ceiling for `LLM_CTX` |
| `LLM_PARALLEL` | `1` | `1`–`16`, ≤ `LLM_PARALLEL_MAX` | slots (`--parallel`) |
| `LLM_PARALLEL_MAX` | `8` | `1`–`16` | operator ceiling for `LLM_PARALLEL` |
| — | — | `LLM_CTX / LLM_PARALLEL ≥ 512` | per-slot context floor |
| `LLM_KV_TYPE_K` | `f16` | `f32 f16 bf16 q8_0 q4_0 q4_1 iq4_nl q5_0 q5_1` | K KV cache type |
| `LLM_KV_TYPE_V` | `f16` | same list | V KV cache type |
| `LLM_GPU_LAYERS` | `99` | `0`–`999` | layers offloaded; use `0` on the CPU image |
| `LLM_THREADS` | unset | `1`–`256` | optional CPU thread count |
| `DRAIN_SECONDS` | `30` | `1`–`300` | gateway drain grace and shutdown budget |
| `PORT` | `8080` | `1`–`65535` | public gateway port |
| `LLM_PORT` | `8081` | `1`–`65535`, ≠ `PORT` | loopback llama.cpp port |
| `ARTIFACT_MANIFEST` | `/etc/openvibe/artifact.json` | — | manifest path |
| `MODEL_DIR` | `/models` | — | download/cache directory |

`LLM_CTX` is llama.cpp's **total** context, not per slot; with `LLM_PARALLEL=2` and
`LLM_CTX=8192` each slot has about 4096 tokens. Measure VRAM with the real KV type, context,
concurrency and prompt lengths before choosing a GPU — the worker bounds these settings, it does
not model your model's memory.

## Graceful drain

On `SIGTERM` the entrypoint first stops the gateway: Caddy stops accepting new connections and
waits up to `DRAIN_SECONDS` for in-flight requests (its `grace_period`). Only after the gateway has
drained does the entrypoint stop llama.cpp, then exit 0. The orchestrator's stop timeout must be at
least `DRAIN_SECONDS` plus the time llama.cpp needs to exit; systemd's `TimeoutStopSec` and
`workerUnits` drain policies are the relevant Host settings.

## Cost model

`scripts/inference-cost-model.js` (schema: `scripts/inference-cost-model.schema.json`) computes
cost per request and cost per successful task for rented-warm GPU, scale-to-zero serverless and
wholesale API, following PLAN.md §E:

```sh
node scripts/inference-cost-model.js workers/llm-inference/examples/inference-cost-model.example.json
node scripts/inference-cost-model.js workers/llm-inference/examples/inference-cost-model.example.json --json
```

- **rented-warm:** steady-state busy seconds / occupancy at the GPU rate, idle at the
  `idle_policy` rate, one startup per window (a separate line, not part of occupancy), storage and
  egress.
- **scale-to-zero:** busy seconds + (`startup_seconds / requests_per_cold_start`) at the
  serverless rate, no idle, storage and egress.
- **api-wholesale:** `tokens * $/million` for input, cached read, cache write and output, plus a
  per-request fee. Wholesale rates are treated as all-in (no owned storage/egress line).

Cost per successful task divides by the success rate (expected attempts). Prompt time charges
cache-write tokens at prefill throughput and cached-read tokens at `cached_read_tokens_per_sec`
when measured, otherwise at prefill throughput (conservative). The example file is marked
**example, not a quote**; every price and throughput in it is a placeholder, and the model has no
built-in benchmarks. Replace them with dated complete quotes and measured tok/s first.

The script uses floats for forecasting. Customer liability is Billing's integer nano-USD ledger
(D1); this is not a settlement or quoting authority.

## Tests

```sh
node test/inference-artifact-verify.test.js
node test/inference-cost-model.test.js
# or, through the repository runner:
npm test -- inference
```

The artifact test covers a correct download, a wrong hash (refused, no file left), a `TODO`
placeholder, a traversal filename, a local URL without the smoke-test opt-in, a cached file, and
the entrypoint's bounded-env refusals. The cost-model test checks the arithmetic against numbers
worked out by hand, invalid inputs and the checked-in example.

## Not done here

- No artifact is pinned: the example's revision and hash are deliberately `TODO`. Pinning is an
  operator action with the model license/provenance check and a published hash.
- No model registry entry, catalog route or request routing; those belong to OpenVibe.AI.
- No GPU rental, deployment or benchmark run is performed by this directory.
- No quality, refusal, license or provenance gate is run here. The example artifact is a candidate,
  not an approval: benchmark gates and the upstream license/responsible-use review happen before it
  is served.
- No dynamic LoRA API; only a static `--lora` would be a future, admin-only change.
