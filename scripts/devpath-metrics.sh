#!/usr/bin/env bash
# A scheduled proof's outcome for Prometheus (ExecStopPost, as root): the developer path
# (openvibe-devpath.service, WS-N task 1) and, with METRIC_PREFIX=openvibe_toolsjob and its own
# DEVPATH_RESULT, the Tools job proof (openvibe-toolsjob.service, WS-L task 4).
# node_exporter's textfile collector reads /var/lib/prometheus/node-exporter/<prefix>.prom.
#   <prefix>_last_run_timestamp_seconds, <prefix>_last_run_ok,
#   <prefix>_last_success_timestamp_seconds (kept from the previous file when this run failed),
#   <prefix>_steps_failed
# A run that refused to start or wrote no result (exit != 0, no fresh last.json) counts as failed.
set -euo pipefail
RESULT=${DEVPATH_RESULT:-/var/lib/openvibe-devpath/last.json}
PREFIX=${METRIC_PREFIX:-openvibe_devpath}
[[ "$PREFIX" =~ ^[a-z_]+$ ]] || { echo "bad METRIC_PREFIX" >&2; exit 1; }
DIR=${TEXTFILE_DIR:-/var/lib/prometheus/node-exporter}
[ -d "$DIR" ] || exit 0
OUT="$DIR/$PREFIX.prom"
node - "$RESULT" "$OUT" "${EXIT_STATUS:-}" "$PREFIX" <<'JS'
const fs = require('fs');
const [file, out, exitStatus, p] = process.argv.slice(2);
const now = Math.floor(Date.now() / 1000);
let rec = null;
try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rec = null; }
const fresh = rec && Date.parse(rec.finished_at) / 1000 > now - 3600;
const ok = !!(fresh && rec.ok && (exitStatus === '' || exitStatus === '0'));
let lastSuccess = null;
try { const m = new RegExp(`^${p}_last_success_timestamp_seconds (\\d+)$`, 'm').exec(fs.readFileSync(out, 'utf8')); if (m) lastSuccess = Number(m[1]); } catch { /* first run */ }
if (ok) lastSuccess = Math.floor(Date.parse(rec.finished_at) / 1000);
const failed = fresh ? rec.steps.filter((s) => !s.ok && !s.skipped).length : 1;
const lines = [
  `# HELP ${p}_last_run_timestamp_seconds When the last run ended.`,
  `# TYPE ${p}_last_run_timestamp_seconds gauge`, `${p}_last_run_timestamp_seconds ${fresh ? Math.floor(Date.parse(rec.finished_at) / 1000) : now}`,
  `# HELP ${p}_last_run_ok 1 when every step passed.`, `# TYPE ${p}_last_run_ok gauge`, `${p}_last_run_ok ${ok ? 1 : 0}`,
  `# HELP ${p}_steps_failed Steps that failed in the last run.`, `# TYPE ${p}_steps_failed gauge`, `${p}_steps_failed ${failed}`,
];
if (lastSuccess) lines.push(`# HELP ${p}_last_success_timestamp_seconds When the last fully passing run ended.`, `# TYPE ${p}_last_success_timestamp_seconds gauge`, `${p}_last_success_timestamp_seconds ${lastSuccess}`);
fs.writeFileSync(`${out}.tmp`, lines.join('\n') + '\n', { mode: 0o644 });
fs.renameSync(`${out}.tmp`, out);
JS
