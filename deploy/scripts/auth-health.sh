#!/usr/bin/env bash
# Sign-in canary for every OpenVibe site (docs/auth-health.md, openvibe-authhealth.timer).
#
#   deploy/scripts/auth-health.sh                  every public origin in Network's registry
#   deploy/scripts/auth-health.sh --sites live,cam  only these (a post-deploy run)
#   AUTH_HEALTH_REGISTRY=<url|file>                where the list comes from (default Network's registry)
#   TEXTFILE_DIR=<dir>                             node_exporter's textfile collector (tests)
#
# For each site: GET <origin>/auth/health with a 10 s timeout (openvibe-sdk ≥ 0.73.0, src/sso/index.js
# handlers.health). One textfile line per site, written to <TEXTFILE_DIR>/openvibe_auth_health.prom:
#
#   openvibe_auth_health{site="<id>"} 1   200: the Network accepts the site's OAuth client
#   openvibe_auth_health{site="<id>"} 0   503 (the Network refuses it) or no answer at all, and any
#                                         other answer than 200 or 404 (a 502, a redirect, a 500)
#   (no line)                            404: the site is not on the SDK's sign-in yet, nothing to judge
#
# The file is written atomically (a temp file beside it, then rename), so Prometheus never reads half of
# it. Exit: 0 when every probed site is 1 or 404 · 1 when one is 0 · 2 when the registry could not be
# read or held no public origin (the previous file is kept: an unreadable list is not a green canary).
set -uo pipefail

REGISTRY=${AUTH_HEALTH_REGISTRY:-https://openvibe.network/api/v1/registry/services}
DIR=${TEXTFILE_DIR:-/var/lib/prometheus/node-exporter}
OUT=$DIR/openvibe_auth_health.prom
SITES=
TRIES=${AUTH_HEALTH_REGISTRY_TRIES:-3}
WAIT=${AUTH_HEALTH_REGISTRY_WAIT:-10}

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --sites) SITES=${2:-}; shift 2 ;;
        --sites=*) SITES=${1#*=}; shift ;;
        --registry) REGISTRY=${2:-}; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "auth-health: unknown argument $1" >&2; exit 2 ;;
    esac
done

command -v curl >/dev/null || { echo "auth-health: curl is needed" >&2; exit 2; }
command -v node >/dev/null || { echo "auth-health: node is needed" >&2; exit 2; }

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT

# The list of sites: Network's registry, asked again a couple of times because a release of Network
# restarts it (scripts/browser-check.js does the same). A file is read as is.
if [[ $REGISTRY =~ ^https?:// ]]; then
    attempt=1
    while :; do
        if curl -fsS --max-time 20 -H 'accept: application/json' -o "$TMP/registry.json" "$REGISTRY" 2>/dev/null; then break; fi
        if [ "$attempt" -ge "$TRIES" ]; then
            echo "auth-health: the registry did not answer after $TRIES tries ($REGISTRY); keeping $OUT" >&2
            exit 2
        fi
        echo "auth-health: the registry did not answer (Network restarting?); asking again in ${WAIT}s" >&2
        sleep "$WAIT"
        attempt=$((attempt + 1))
    done
elif ! cp -- "$REGISTRY" "$TMP/registry.json" 2>/dev/null; then
    echo "auth-health: cannot read the registry file $REGISTRY; keeping $OUT" >&2
    exit 2
fi

# id<TAB>origin, one line per service with a public origin. Both shapes Network has served are read: an
# array, or { "services": [...] }, with publicOrigin or public_origin. A trailing slash goes, and an id
# that is not a service id is skipped (it must be a Prometheus label value).
if ! node - "$TMP/registry.json" > "$TMP/sites" <<'JS'
const fs = require('fs');
let body;
try { body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch { process.stderr.write('auth-health: the registry is not JSON\n'); process.exit(1); }
const list = Array.isArray(body) ? body : (body && Array.isArray(body.services) ? body.services : []);
const seen = new Set();
for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id || s.name || '').trim();
    const origin = String(s.publicOrigin || s.public_origin || '').trim().replace(/\/+$/, '');
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) continue;
    if (!/^https?:\/\/[^/?#]+$/.test(origin)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    process.stdout.write(`${id}\t${origin}\n`);
}
JS
then
    echo "auth-health: the registry is not JSON; keeping $OUT" >&2
    exit 2
fi

if [ -n "$SITES" ]; then
    : > "$TMP/wanted"
    for s in ${SITES//,/ }; do echo "$s" >> "$TMP/wanted"; done
    awk -F'\t' 'NR==FNR { want[$1]=1; next } ($1 in want)' "$TMP/wanted" "$TMP/sites" > "$TMP/sites.wanted"
    mv "$TMP/sites.wanted" "$TMP/sites"
fi

if [ ! -s "$TMP/sites" ]; then
    echo "auth-health: the registry named no site with a public origin; keeping $OUT" >&2
    exit 2
fi

LINES=()
FAILED=0
PROBED=0
while IFS=$'\t' read -r id origin; do
    [ -n "$id" ] || continue
    code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' "$origin/auth/health" 2>/dev/null) || code=000
    case "$code" in
        200) value=1 ;;
        404) value= ;;
        *)   value=0 ;;
    esac
    [ -n "${value-}" ] || continue
    PROBED=$((PROBED + 1))
    [ "$value" = 1 ] || FAILED=$((FAILED + 1))
    LINES+=("openvibe_auth_health{site=\"$id\"} $value")
done < "$TMP/sites"

if [ "$PROBED" -eq 0 ]; then
    echo "auth-health: no site answered 200, 503 or an error (all 404: none on the SDK's sign-in yet); keeping $OUT" >&2
    exit 0
fi

if [ -d "$DIR" ]; then
    TMPFILE=$OUT.tmp.$$
    if ! {
        echo '# HELP openvibe_auth_health 1 when GET /auth/health answered 200 (the Network accepts the site OAuth client), 0 when it answered 503 or did not answer.'
        echo '# TYPE openvibe_auth_health gauge'
        printf '%s\n' "${LINES[@]}"
    } > "$TMPFILE"; then
        rm -f "$TMPFILE"
        echo "auth-health: could not write $TMPFILE" >&2
        exit 2
    fi
    chmod 0644 "$TMPFILE" || { rm -f "$TMPFILE"; echo "auth-health: could not chmod $TMPFILE" >&2; exit 2; }
    if ! mv -f "$TMPFILE" "$OUT"; then
        rm -f "$TMPFILE"
        echo "auth-health: could not rename $TMPFILE to $OUT" >&2
        exit 2
    fi
fi

printf '%s\n' "${LINES[@]}"

[ "$FAILED" -eq 0 ] || exit 1
exit 0
