#!/usr/bin/env bash
# d41-proof.sh: roadmap D41 / Wave 21 exit evidence. Deploy, restart and roll back ONE service with
# `ovhost deploy` and `ovhost rollback`, and prove that nothing else on the host was touched.
#
#   sudo scripts/d41-proof.sh [options] <service>          (recommended service: sources)
#
# What it does (docs/d41-proof.md has the full procedure and how to read the evidence):
#   0. Preflight: root, the service is managed, has no socket unit and no protected-session probe,
#      is not on the refuse list, `ovhost validate` passes, the checkout is clean, and the rollback
#      target (--prev, default: the first parent of the running commit) needs no npm install and no
#      schema backup. S0 is the commit running now; the service ENDS on S0 again, and no new code is
#      ever deployed.
#   1. Snapshot every other unit on the host (every inventory unit, socket and worker instance,
#      openvibe-*, openre-*, nginx) with systemctl show: MainPID, InvocationID, ActiveEnterTimestamp,
#      NRestarts, ActiveState. Snapshot `ovhost status --json` (readiness, protected sessions).
#   2. A: ovhost deploy   <svc> --to S0   --restart    restart in place on the running commit
#      B: ovhost rollback <svc> --to PREV --restart    roll back one release
#      C: ovhost deploy   <svc> --to S0   --restart    deploy forward again, back where it started
#      After each step: the service's sha, a NEW InvocationID/MainPID for its units, readiness, and
#      every other unit still identical. A failing step stops the run and returns the service to S0.
#   3. Compare everything again, write the evidence directory, print a verdict and a Markdown row.
#
# Options:
#   --prev <sha>          rollback target (an ancestor of the running commit); default: its first parent
#   --out <dir>           evidence directory (default /var/lib/openvibe-host/d41/<service>-<UTC stamp>)
#   --watch <unit>        another unit that must stay untouched (repeatable)
#   --ready-timeout <s>   passed to ovhost deploy/rollback
#   --allow-install       allow a rollback target whose dependencies differ (npm install on B and C)
#   --dry-run             preflight and snapshots only: print the three commands, change nothing
#
# Exit codes: 0 PASS · 1 refused (precondition; nothing was changed) · 2 FAIL (another unit changed,
# or a service stopped being ready) · 3 an ovhost step failed (see the evidence; the service was
# returned to S0 if possible) · 4 the service could NOT be returned to S0: MANUAL INTERVENTION.
#
# The system commands can be replaced for testing (test/d41-proof.test.js runs this script against
# the fake host): OVHOST, SYSTEMCTL, RUNUSER, NODE, D41_INVENTORY, D41_REQUIRE_ROOT=0, D41_STATE_DIR.
# Nothing here reads an env file or prints a secret: ovhost and systemctl show carry no values.
set -euo pipefail
umask 077

OVHOST=${OVHOST:-ovhost}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
RUNUSER=${RUNUSER:-runuser}
NODE=${NODE:-node}
D41_STATE_DIR=${D41_STATE_DIR:-/var/lib/openvibe-host/d41}
# Services the proof never uses: live sessions, recordings, ingest, chat, identity, money, games,
# the eight-unit Tools, and Host itself.
REFUSE="live media openre chat network events billing games tools host sites"
MUST_WATCH="openvibe-live.socket openvibe-live.service openvibe-chat.service openvibe-media.service nginx.service"
PROPS="Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ActiveEnterTimestamp,ExecMainStartTimestamp,NRestarts"

SERVICE="" PREV="" OUT="" READY_TIMEOUT="" ALLOW_INSTALL=0 DRY_RUN=0
EXTRA_WATCH=()
usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
    case "$1" in
        --prev) PREV=${2:?--prev needs a sha}; shift 2 ;;
        --out) OUT=${2:?--out needs a directory}; shift 2 ;;
        --watch) EXTRA_WATCH+=("${2:?--watch needs a unit}"); shift 2 ;;
        --ready-timeout) READY_TIMEOUT=${2:?--ready-timeout needs seconds}; shift 2 ;;
        --allow-install) ALLOW_INSTALL=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) echo "d41-proof: unknown option $1" >&2; exit 1 ;;
        *) [ -z "$SERVICE" ] || { echo "d41-proof: one service only" >&2; exit 1; }; SERVICE=$1; shift ;;
    esac
done
[ -n "$SERVICE" ] || { usage >&2; exit 1; }
[[ "$SERVICE" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "d41-proof: \"$SERVICE\" is not a service id" >&2; exit 1; }
[ -z "$PREV" ] || [[ "$PREV" =~ ^[0-9a-f]{7,40}$ ]] || { echo "d41-proof: --prev must be a commit sha" >&2; exit 1; }
[ -z "$READY_TIMEOUT" ] || [[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "d41-proof: --ready-timeout must be seconds" >&2; exit 1; }

INV_ARGS=()
[ -z "${D41_INVENTORY:-}" ] || INV_ARGS=(--inventory "$D41_INVENTORY")
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT=${OUT:-$D41_STATE_DIR/$SERVICE-$STAMP}

say() { printf '[d41] %s\n' "$*" | tee -a "$OUT/proof.log" >&2; }
refuse() { printf '[d41] REFUSED: %s\n' "$*" | tee -a "$OUT/proof.log" >&2; exit 1; }
ov() { "$OVHOST" "$@" "${INV_ARGS[@]}"; }
# jsonq <file> <js expression over `j`>: prints the expression's value (strings raw, others as JSON).
jsonq() { "$NODE" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=(new Function("j","return ("+process.argv[2]+")"))(j);process.stdout.write(v==null?"":typeof v==="string"?v:JSON.stringify(v));' "$1" "$2"; }

if [ "${D41_REQUIRE_ROOT:-1}" = 1 ] && [ "$(id -u)" != 0 ]; then echo "d41-proof: run as root (sudo): ovhost deploy needs it" >&2; exit 1; fi
for c in "$OVHOST" "$SYSTEMCTL" "$RUNUSER" "$NODE"; do command -v "$c" >/dev/null || { echo "d41-proof: $c not found" >&2; exit 1; }; done
[ ! -e "$OUT" ] || { echo "d41-proof: $OUT already exists" >&2; exit 1; }
mkdir -p "$OUT"
say "D41 proof for $SERVICE; evidence in $OUT"

# ── 0. preflight ─────────────────────────────────────────────────────────────
for r in $REFUSE; do [ "$r" != "$SERVICE" ] || refuse "$SERVICE is on the refuse list ($REFUSE): use a loopback service with no sessions, e.g. sources"; done
ov show --json >"$OUT/inventory.json" || refuse "ovhost show failed"
jsonq "$OUT/inventory.json" "j.find(s => s.id === '$SERVICE') || null" >"$OUT/service.json"
[ -s "$OUT/service.json" ] || refuse "$SERVICE is not in the inventory"
[ "$(jsonq "$OUT/service.json" 'j.managed')" = true ] || refuse "$SERVICE is not managed by ovhost"
[ "$(jsonq "$OUT/service.json" 'j.layout')" = git ] || refuse "$SERVICE does not run from a git checkout"
[ -z "$(jsonq "$OUT/service.json" 'j.socketUnit')" ] || refuse "$SERVICE has a socket unit"
[ -z "$(jsonq "$OUT/service.json" 'j.protected')" ] || refuse "$SERVICE has protected sessions (a probe is declared)"
[ -z "$(jsonq "$OUT/service.json" 'j.workerUnits.join(" ")')" ] || refuse "$SERVICE has worker units"
REPO=$(jsonq "$OUT/service.json" 'j.repo')
OWNER=$(jsonq "$OUT/service.json" 'j.owner')
TARGET_UNITS=$(jsonq "$OUT/service.json" 'j.units.join(" ")')
[ -n "$TARGET_UNITS" ] || refuse "$SERVICE has no units to restart"
[ -n "$(jsonq "$OUT/service.json" 'j.ready')" ] || refuse "$SERVICE declares no ready URL: nothing would prove it came back"

say "ovhost validate $SERVICE"
if ! ov validate "$SERVICE" >"$OUT/validate.txt" 2>&1; then refuse "ovhost validate $SERVICE failed (see $OUT/validate.txt)"; fi

ov status "$SERVICE" --json >"$OUT/target-status-0.json"
S0=$(jsonq "$OUT/target-status-0.json" 'j[0].sha')
[[ "$S0" =~ ^[0-9a-f]{40}$ ]] || refuse "could not read the running commit of $SERVICE"
[ "$(jsonq "$OUT/target-status-0.json" 'j[0].ready && j[0].ready.ok')" = true ] || refuse "$SERVICE is not ready now"
git_owner() { "$RUNUSER" -u "$OWNER" -- git -C "$REPO" "$@"; }
if [ -z "$PREV" ]; then PREV=$(git_owner rev-parse --verify "$S0^" 2>/dev/null) || refuse "$S0 has no parent; pass --prev"; fi
FULL=$(git_owner rev-parse --verify "$PREV^{commit}" 2>/dev/null) || refuse "--prev $PREV is not a commit in $REPO"
PREV=$FULL
[ "$PREV" != "$S0" ] || refuse "--prev is the running commit"
git_owner merge-base --is-ancestor "$PREV" "$S0" || refuse "$PREV is not an ancestor of $S0: deploying S0 again would not be a fast-forward"

say "ovhost plan $SERVICE --to $PREV --no-fetch"
ov plan "$SERVICE" --to "$PREV" --no-fetch --json >"$OUT/plan-rollback.json" || refuse "ovhost plan failed"
[ "$(jsonq "$OUT/plan-rollback.json" 'j.dirty.length')" = 0 ] || refuse "the checkout has tracked local changes"
[ "$(jsonq "$OUT/plan-rollback.json" 'j.branch === j.expectedBranch')" = true ] || refuse "the checkout is not on its branch"
[ "$(jsonq "$OUT/plan-rollback.json" 'j.backupNeeded')" = false ] || refuse "PREV..S0 changes schema files (backupOnChange): pick another --prev"
if [ "$(jsonq "$OUT/plan-rollback.json" 'j.installs.some(i => i.install)')" = true ] && [ "$ALLOW_INSTALL" != 1 ]; then
    refuse "PREV..S0 changes dependencies (npm install on B and C): pick another --prev or pass --allow-install"
fi
say "S0 (running) $S0; PREV (rollback target) $PREV; $(jsonq "$OUT/plan-rollback.json" 'j.changedFiles') file(s) differ"

# ── 1. what must not change ──────────────────────────────────────────────────
{
    jsonq "$OUT/inventory.json" "j.filter(s => s.id !== '$SERVICE').flatMap(s => [...s.units, ...(s.socketUnit ? [s.socketUnit] : [])]).join('\n')"; echo
    for pat in 'openvibe-*' 'openre-*'; do
        "$SYSTEMCTL" list-units --all --plain --no-legend --no-pager "$pat" | awk '{ print ($1 == "●" ? $2 : $1) }'
    done
    printf '%s\n' $MUST_WATCH "${EXTRA_WATCH[@]}"
} | grep -E '^[A-Za-z0-9@._:-]+\.(service|socket|timer)$' | grep -v '^ovhost-drill-' | sort -u >"$OUT/watch.all"
: >"$OUT/watch.units"
while read -r u; do
    case " $TARGET_UNITS " in *" $u "*) continue ;; esac
    echo "$u" >>"$OUT/watch.units"
done <"$OUT/watch.all"
say "watching $(wc -l <"$OUT/watch.units") other units; restarting only: $TARGET_UNITS"

# snapshot <file> <units file>: one "unit|Key=Value|…" line per unit, sorted.
snapshot() {
    : >"$1"
    while read -r u; do
        printf '%s|%s\n' "$u" "$("$SYSTEMCTL" show "$u" --property="$PROPS" --no-pager | sort | tr '\n' '|' | sed 's/|$//')" >>"$1"
    done <"$2"
}
printf '%s\n' $TARGET_UNITS >"$OUT/target.units"
snapshot "$OUT/others-before.txt" "$OUT/watch.units"
snapshot "$OUT/target-0.txt" "$OUT/target.units"
ov status --json >"$OUT/status-before.json"

A=(deploy "$SERVICE" --to "$S0" --restart)
B=(rollback "$SERVICE" --to "$PREV" --restart)
C=(deploy "$SERVICE" --to "$S0" --restart)
if [ -n "$READY_TIMEOUT" ]; then A+=(--ready-timeout "$READY_TIMEOUT"); B+=(--ready-timeout "$READY_TIMEOUT"); C+=(--ready-timeout "$READY_TIMEOUT"); fi
if [ "$DRY_RUN" = 1 ]; then
    say "dry run: would run, in order:"
    for s in A B C; do eval "cmd=(\"\${$s[@]}\")"; say "  $s: ovhost ${cmd[*]}"; done
    say "dry run: nothing was changed"
    exit 0
fi

# ── 2. deploy, roll back, deploy ─────────────────────────────────────────────
VERDICT=PASS
EXIT=0
PROBLEMS=()
ROWS=()
problem() { PROBLEMS+=("$1"); say "PROBLEM: $1"; }
field() { grep "^$1|" "$2" | tr '|' '\n' | sed -n "s/^$3=//p"; }

# The other units, compared with the snapshot taken before step A.
check_others() {
    snapshot "$OUT/others-$1.txt" "$OUT/watch.units"
    if ! cmp -s "$OUT/others-before.txt" "$OUT/others-$1.txt"; then
        diff "$OUT/others-before.txt" "$OUT/others-$1.txt" >"$OUT/others-$1.diff" || true
        problem "after $1, other units changed: $(diff "$OUT/others-before.txt" "$OUT/others-$1.txt" | sed -n 's/^> \([^|]*\)|.*/\1/p' | tr '\n' ' ')(see others-$1.diff)"
        return 1
    fi
}

PREV_SNAP="$OUT/target-0.txt"
N=0
for s in A B C; do
    N=$((N + 1))
    eval "cmd=(\"\${$s[@]}\")"
    want=$([ "$s" = B ] && echo "$PREV" || echo "$S0")
    say "step $s: ovhost ${cmd[*]}"
    set +e
    ov "${cmd[@]}" --json >"$OUT/step-$s.json" 2>"$OUT/step-$s.log"
    code=$?
    set -e
    ov status "$SERVICE" --json >"$OUT/target-status-$N.json" || true
    snapshot "$OUT/target-$N.txt" "$OUT/target.units"
    sha=$(jsonq "$OUT/target-status-$N.json" 'j[0].sha' 2>/dev/null || true)
    ready=$(jsonq "$OUT/target-status-$N.json" 'j[0].ready && j[0].ready.ok' 2>/dev/null || true)
    result=$(jsonq "$OUT/step-$s.json" 'j.result' 2>/dev/null || echo "?")
    restarted=""
    for u in $TARGET_UNITS; do
        before=$(field "$u" "$PREV_SNAP" InvocationID); after=$(field "$u" "$OUT/target-$N.txt" InvocationID)
        pid=$(field "$u" "$OUT/target-$N.txt" MainPID)
        if [ -n "$after" ] && [ "$before" != "$after" ]; then restarted+="$u (MainPID $pid) "; else problem "step $s: $u was not restarted (InvocationID unchanged)"; fi
    done
    ROWS+=("| $s | \`ovhost ${cmd[*]}\` | $code | $result | ${want:0:12} | ${sha:0:12} | ${ready:-?} | $(r=${restarted% }; echo "${r:-none}") |")
    PREV_SNAP="$OUT/target-$N.txt"
    if [ "$code" != 0 ] || [ "$sha" != "$want" ] || [ "$ready" != true ]; then
        problem "step $s: exit $code, result $result, sha ${sha:-?} (wanted $want), ready ${ready:-?}"
        VERDICT=FAIL; EXIT=3
        check_others "$s" || true
        break
    fi
    check_others "$s" || { VERDICT=FAIL; EXIT=2; break; }
done

# A failed run leaves the service where it started.
FINAL=$(jsonq "$OUT/target-status-$N.json" 'j[0].sha' 2>/dev/null || true)
if [ "$FINAL" != "$S0" ]; then
    say "returning $SERVICE to $S0"
    set +e
    ov rollback "$SERVICE" --to "$S0" --restart --json >"$OUT/restore.json" 2>"$OUT/restore.log"
    rc=$?
    set -e
    ov status "$SERVICE" --json >"$OUT/target-status-restore.json" || true
    if [ "$rc" != 0 ] || [ "$(jsonq "$OUT/target-status-restore.json" 'j[0].sha' 2>/dev/null || true)" != "$S0" ]; then
        problem "could not return $SERVICE to $S0 (exit $rc): MANUAL INTERVENTION: sudo ovhost rollback $SERVICE --to $S0"
        VERDICT=FAIL; EXIT=4
    fi
fi

# ── 3. after ─────────────────────────────────────────────────────────────────
snapshot "$OUT/others-after.txt" "$OUT/watch.units"
if ! cmp -s "$OUT/others-before.txt" "$OUT/others-after.txt"; then
    diff "$OUT/others-before.txt" "$OUT/others-after.txt" >"$OUT/others-after.diff" || true
    problem "other units differ from before the run (see others-after.diff)"
    VERDICT=FAIL; [ "$EXIT" != 0 ] || EXIT=2
fi
ov status --json >"$OUT/status-after.json" || true
jsonq "$OUT/status-before.json" 'j.filter(r => r.ready && r.ready.ok).map(r => r.service).join(" ")' >"$OUT/ready-before.txt"
STILL=$("$NODE" -e '
const fs = require("fs");
const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const lost = before.filter((r) => r.ready && r.ready.ok).filter((r) => { const a = after.find((x) => x.service === r.service); return !(a && a.ready && a.ready.ok); }).map((r) => r.service);
process.stdout.write(lost.join(" "));' "$OUT/status-before.json" "$OUT/status-after.json" 2>/dev/null || echo "?")
if [ -n "$STILL" ]; then problem "no longer ready after the run: $STILL"; VERDICT=FAIL; [ "$EXIT" != 0 ] || EXIT=2; fi
SESSIONS=$("$NODE" -e '
const fs = require("fs");
const f = (p) => JSON.parse(fs.readFileSync(p, "utf8")).filter((r) => r.protected).map((r) => `${r.service} ${r.protected.label}=${r.protected.count == null ? "unknown" : r.protected.count}`);
const b = f(process.argv[1]); const a = f(process.argv[2]);
process.stdout.write(b.map((x, i) => `${x} → ${(a[i] || "?").split("=").pop()}`).join("; "));' "$OUT/status-before.json" "$OUT/status-after.json" 2>/dev/null || echo "?")
ov releases "$SERVICE" --limit 5 --json >"$OUT/releases.json" 2>/dev/null || true

WATCHED=$(wc -l <"$OUT/watch.units")
{
    echo "# D41 proof: $SERVICE ($STAMP UTC): $VERDICT"
    echo
    echo "Host $(hostname), operator ${SUDO_USER:-$(id -un)}. Running commit S0 \`$S0\`, rollback target PREV \`$PREV\`."
    echo
    echo "| Step | Command | Exit | Result | Wanted | Running after | Ready | Restarted (new InvocationID) |"
    echo "|---|---|---|---|---|---|---|---|"
    printf '%s\n' "${ROWS[@]}"
    echo
    echo "- Other units watched: $WATCHED (every inventory unit and socket, openvibe-*, openre-*, nginx; see watch.units). MainPID, InvocationID, ActiveEnterTimestamp, NRestarts and ActiveState: $([ -e "$OUT/others-after.diff" ] && echo "CHANGED (others-after.diff)" || echo "identical before, after each step and at the end")."
    echo "- Services ready before and after: $(cat "$OUT/ready-before.txt")${STILL:+ (NOT ready after: $STILL)}."
    echo "- Protected sessions (before → after): ${SESSIONS:-none declared}."
    echo "- Release log: releases.json. Problems: ${#PROBLEMS[@]}."
    for p in "${PROBLEMS[@]}"; do echo "  - $p"; done
    echo
    echo "Row for docs/d41-proof.md:"
    echo
    echo "| $(date -u +'%Y-%m-%d %H:%M') | $SERVICE | \`${S0:0:12}\` → \`${PREV:0:12}\` → \`${S0:0:12}\` (3 restarts) | $WATCHED other units identical: $([ "$VERDICT" = PASS ] && echo yes || echo NO); readiness kept: $([ -z "$STILL" ] && echo yes || echo "NO ($STILL)") | \`$OUT\` | $VERDICT |"
} >"$OUT/summary.md"
cat "$OUT/summary.md"
exit "$EXIT"
