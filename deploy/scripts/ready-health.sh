#!/usr/bin/env bash
# Readiness probe for every service with a ready URL (docs/ready-health.md, openvibe-readyhealth.timer).
#
#   deploy/scripts/ready-health.sh                 every service in the host inventory
#   OVHOST_INVENTORY=<file>                        the inventory (default /etc/openvibe/host.json)
#   TEXTFILE_DIR=<dir>                             node_exporter's textfile collector (tests)
#
# For each service in the inventory with a ready.url: GET it with the ready.headers and a 5 s timeout.
# One textfile line per service, written to <TEXTFILE_DIR>/openvibe_service_ready.prom:
#
#   openvibe_service_ready{service="<id>"} 1   the ready URL answered 2xx: the service is ready
#   openvibe_service_ready{service="<id>"} 0   any other answer (a 500, a 503, a redirect) or no answer
#   openvibe_service_ready_last_run_timestamp <seconds>   when the run finished
#
# A service with no ready URL gets no line: this check does not judge what the inventory does not declare.
# The file is written atomically (a temp file beside it, then rename), so Prometheus never reads half of it.
# Exit: 0 every service is ready · 1 one is not · 2 the inventory could not be read or named no service with
# a ready URL (the previous file is kept: an inventory that cannot be checked is not green).
set -uo pipefail

INVENTORY=${OVHOST_INVENTORY:-/etc/openvibe/host.json}
DIR=${TEXTFILE_DIR:-/var/lib/prometheus/node-exporter}
OUT=$DIR/openvibe_service_ready.prom

usage() { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *) echo "ready-health: unknown argument $1" >&2; exit 2 ;;
    esac
done

command -v curl >/dev/null || { echo "ready-health: curl is needed" >&2; exit 2; }
command -v node >/dev/null || { echo "ready-health: node is needed" >&2; exit 2; }

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT
umask 077

# The probes: id<TAB>curl-config, one line per service with a ready URL, sorted by id. Node validates the
# service id (a Prometheus label value), the URL and the headers (a header name and a single-line value),
# and quotes them into a curl config so a header value can hold spaces, colons and quotes. The inventory
# is root-owned: this reads it, and writes nothing back.
if ! node - "$INVENTORY" "$TMP" > "$TMP/probes" <<'JS'
const fs = require('fs');
const path = require('path');
const [inventory, tmp] = process.argv.slice(2);
let text;
try {
    text = fs.readFileSync(inventory, 'utf8');
} catch {
    process.stderr.write(`ready-health: cannot read the inventory file ${inventory}\n`);
    process.exit(1);
}
let body;
try {
    body = JSON.parse(text);
} catch {
    process.stderr.write(`ready-health: the inventory ${inventory} is not JSON\n`);
    process.exit(1);
}
const services = body && body.services;
if (!services || typeof services !== 'object' || Array.isArray(services)) {
    process.stderr.write(`ready-health: the inventory ${inventory} has no services object\n`);
    process.exit(1);
}
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const quoted = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
let n = 0;
for (const id of Object.keys(services).sort()) {
    const svc = services[id];
    if (!svc || typeof svc !== 'object' || !svc.ready || typeof svc.ready.url !== 'string' || !svc.ready.url) continue;
    if (!ID.test(id)) {
        process.stderr.write(`ready-health: skip "${id}": not a service id\n`);
        continue;
    }
    let url;
    try {
        url = new URL(svc.ready.url);
    } catch {
        process.stderr.write(`ready-health: skip ${id}: ready.url is not a URL\n`);
        continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        process.stderr.write(`ready-health: skip ${id}: ready.url must be an http(s) URL without credentials\n`);
        continue;
    }
    const lines = [`url = ${quoted(svc.ready.url)}`];
    const headers = svc.ready.headers && typeof svc.ready.headers === 'object' && !Array.isArray(svc.ready.headers) ? svc.ready.headers : {};
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
            process.stderr.write(`ready-health: skip ${id} header ${JSON.stringify(name)}: not a header name and a single-line value\n`);
            continue;
        }
        lines.push(`header = ${quoted(`${name}: ${value}`)}`);
    }
    const file = path.join(tmp, `probe-${n++}.conf`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    process.stdout.write(`${id}\t${file}\n`);
}
if (n === 0) {
    process.stderr.write(`ready-health: ${inventory} names no service with a ready URL\n`);
    process.exit(1);
}
JS
then
    echo "ready-health: the inventory could not be read; keeping $OUT" >&2
    exit 2
fi

LINES=()
FAILED=0
while IFS=$'\t' read -r id cfg; do
    [ -n "$id" ] || continue
    code=$(curl -sS -o /dev/null --max-time 5 --connect-timeout 5 -w '%{http_code}' -K "$cfg" 2>/dev/null) || code=000
    case "$code" in
        2??) value=1 ;;
        *)   value=0; FAILED=$((FAILED + 1)) ;;
    esac
    LINES+=("openvibe_service_ready{service=\"$id\"} $value")
done < "$TMP/probes"

LINES+=("openvibe_service_ready_last_run_timestamp $(date +%s)")

if [ -d "$DIR" ]; then
    TMPFILE=$OUT.tmp.$$
    if ! {
        echo '# HELP openvibe_service_ready 1 when the service ready URL answered 2xx within 5 s, 0 when it did not.'
        echo '# TYPE openvibe_service_ready gauge'
        echo '# HELP openvibe_service_ready_last_run_timestamp Unix time of the last readiness check that ran to the end.'
        echo '# TYPE openvibe_service_ready_last_run_timestamp gauge'
        printf '%s\n' "${LINES[@]}"
    } > "$TMPFILE"; then
        rm -f "$TMPFILE"
        echo "ready-health: could not write $TMPFILE" >&2
        exit 2
    fi
    chmod 0644 "$TMPFILE" || { rm -f "$TMPFILE"; echo "ready-health: could not chmod $TMPFILE" >&2; exit 2; }
    if ! mv -f "$TMPFILE" "$OUT"; then
        rm -f "$TMPFILE"
        echo "ready-health: could not rename $TMPFILE to $OUT" >&2
        exit 2
    fi
fi

printf '%s\n' "${LINES[@]}"

[ "$FAILED" -eq 0 ] || exit 1
exit 0
