#!/usr/bin/env bash
# The developer path's outcome for Prometheus (openvibe-devpath.service ExecStopPost, as root; WS-N task 1):
# node_exporter's textfile collector reads /var/lib/prometheus/node-exporter/openvibe_devpath.prom.
#   openvibe_devpath_last_run_timestamp_seconds, openvibe_devpath_last_run_ok,
#   openvibe_devpath_last_success_timestamp_seconds (kept from the previous file when this run failed),
#   openvibe_devpath_steps_failed
# A run that refused to start or wrote no result (exit != 0, no fresh last.json) counts as failed.
set -euo pipefail
RESULT=${DEVPATH_RESULT:-/var/lib/openvibe-devpath/last.json}
DIR=${TEXTFILE_DIR:-/var/lib/prometheus/node-exporter}
[ -d "$DIR" ] || exit 0
OUT="$DIR/openvibe_devpath.prom"
node - "$RESULT" "$OUT" "${EXIT_STATUS:-}" <<'JS'
const fs = require('fs');
const [file, out, exitStatus] = process.argv.slice(2);
const now = Math.floor(Date.now() / 1000);
let rec = null;
try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rec = null; }
const fresh = rec && Date.parse(rec.finished_at) / 1000 > now - 3600;
const ok = !!(fresh && rec.ok && (exitStatus === '' || exitStatus === '0'));
let lastSuccess = null;
try { const m = /^openvibe_devpath_last_success_timestamp_seconds (\d+)$/m.exec(fs.readFileSync(out, 'utf8')); if (m) lastSuccess = Number(m[1]); } catch { /* first run */ }
if (ok) lastSuccess = Math.floor(Date.parse(rec.finished_at) / 1000);
const failed = fresh ? rec.steps.filter((s) => !s.ok && !s.skipped).length : 1;
const lines = [
  '# HELP openvibe_devpath_last_run_timestamp_seconds When the last developer-path run ended.',
  '# TYPE openvibe_devpath_last_run_timestamp_seconds gauge', `openvibe_devpath_last_run_timestamp_seconds ${fresh ? Math.floor(Date.parse(rec.finished_at) / 1000) : now}`,
  '# HELP openvibe_devpath_last_run_ok 1 when every step passed.', '# TYPE openvibe_devpath_last_run_ok gauge', `openvibe_devpath_last_run_ok ${ok ? 1 : 0}`,
  '# HELP openvibe_devpath_steps_failed Steps that failed in the last run.', '# TYPE openvibe_devpath_steps_failed gauge', `openvibe_devpath_steps_failed ${failed}`,
];
if (lastSuccess) lines.push('# HELP openvibe_devpath_last_success_timestamp_seconds When the last fully passing run ended.', '# TYPE openvibe_devpath_last_success_timestamp_seconds gauge', `openvibe_devpath_last_success_timestamp_seconds ${lastSuccess}`);
fs.writeFileSync(`${out}.tmp`, lines.join('\n') + '\n', { mode: 0o644 });
fs.renameSync(`${out}.tmp`, out);
JS
