#!/usr/bin/env bash
# roles/data/switch-service.sh — the production switch of one service from its SQLite file to PostgreSQL (ADR-035).
#
#   sudo roles/data/switch-service.sh <service> [<sqlite file>]
#
# Before: the service's postgres branch is merged to main with green CI, its auto-deploy is frozen
# (ovhost freeze <svc> --reason …), and add-service.sh <svc> has written its database settings.
# It clones main as ubuntu into /var/tmp/pg-<svc> and installs it; waits until the service's protected sessions are
# idle (two checks a minute apart); stops the unit; keeps a read-only
# <svc>.pre-postgres-<time>.db backup next to the file; runs that release's scripts/migrate-to-postgres.js
# (openvibe-sdk runSqliteMigration: migrate, import, verify counts and checksums) with the unit's
# environment, as ubuntu; on any failure it starts the old release again and stops. Then it unfreezes and
# deploys (ovhost deploy), and makes the SQLite file read-only: it is the 7-day rollback (compatibility
# register C-89: sudo ovhost rollback <svc> to the release before, which reads the file).
#
# A service that is not one unit in /opt/openvibe.<svc> (OpenRestream: two units plus per-release transport workers, a
# release layout) sets, in the environment:
#   SWITCH_UNITS="a.service b.service 'worker@*.service'"   every unit to stop (the first one's environment runs the
#                                                          import); a pattern stops every running instance
#   SWITCH_DIR=/opt/openre.stream                           the checkout (a release layout's origin is in repo/)
#   SWITCH_AFTER="/opt/openre.stream/current/deploy/scripts/deploy.sh workers"   run after the deploy (as root)
set -euo pipefail
SVC=$1; UNIT=openvibe-$SVC.service; DIR=${SWITCH_DIR:-/opt/openvibe.$SVC}; DATA=/var/lib/openvibe-$SVC; DB=$DATA/$SVC.db
read -r -a UNITS <<< "${SWITCH_UNITS:-$UNIT}"; UNIT=${UNITS[0]}
# A second argument names the SQLite file when it is not /var/lib/openvibe-<svc>/<svc>.db (Host: /var/lib/openvibe-host-api/host.db).
if [ -n "${2:-}" ]; then DB=$2; DATA=$(dirname "$DB"); fi
WORK=/var/tmp/pg-$SVC; UB=$(id -u ubuntu); GB=$(id -g ubuntu)
[ -f "$DB" ] || { echo "no $DB"; exit 1; }
rm -rf "$WORK"; install -d -o ubuntu -g ubuntu "$WORK"
GITDIR=$DIR; [ -d "$DIR/repo/.git" ] || [ -f "$DIR/repo/HEAD" ] && GITDIR=$DIR/repo
REMOTE=$(git -C "$GITDIR" remote get-url origin)
setpriv --reuid=$UB --regid=$GB --init-groups env HOME=/home/ubuntu bash -c "cd $WORK && git clone -q --depth 1 --branch main '$REMOTE' src && cd src && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1 && git log --oneline -1"
# Protected sessions (the inventory's probe: Media's recordings, Live's streams) would be cut by the stop: wait for two
# idle checks a minute apart, as a deploy's --wait-idle does, for up to 12 hours. A probe that cannot answer counts as busy.
quiet=0
for _ in $(seq 1 720); do
    n=$(ovhost status "$SVC" --json | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8"))[0] || {}; const p = r.protected; process.stdout.write(!p ? "none" : p.count == null ? "unknown" : String(p.count));')
    [ "$n" = none ] && break
    if [ "$n" = 0 ]; then quiet=$((quiet + 1)); [ $quiet -ge 2 ] && break; else quiet=0; echo "[switch] waiting: $n protected session(s)"; fi
    sleep 60
done
[ "$n" = none ] || [ $quiet -ge 2 ] || { echo "[switch] still busy after 12 hours: not switching"; rm -rf "$WORK"; exit 1; }
echo "[switch] stopping ${UNITS[*]}"; systemctl stop "${UNITS[@]}"
sqlite3 "$DB" ".backup $WORK/source.db"; chown ubuntu:ubuntu "$WORK/source.db"
TS=$(date -u +%Y%m%dT%H%M%SZ); cp "$WORK/source.db" "$DATA/$SVC.pre-postgres-$TS.db"; chmod 0400 "$DATA/$SVC.pre-postgres-$TS.db"; echo "[switch] backup $DATA/$SVC.pre-postgres-$TS.db"
echo "[switch] importing"
# The unit's own environment, parsed by systemd (EnvironmentFile= and Environment=): sourcing the file with bash would
# mangle values systemd reads fine (JSON, quotes). As ubuntu, in the release just installed.
SETENV=(); while IFS= read -r kv; do [ -n "$kv" ] && SETENV+=(-E "$kv"); done < <(systemctl show "$UNIT" -p Environment --value | tr ' ' '\n')
ENVFILES=(); for f in $(systemctl show "$UNIT" -p EnvironmentFiles --value | grep -o '^[^ ]*\|; [^ ]*' | tr -d '; '); do ENVFILES+=(-p "EnvironmentFile=$f"); done
[ ${#ENVFILES[@]} -gt 0 ] || ENVFILES=(-p "EnvironmentFile=/etc/openvibe/$SVC.env")
if ! systemd-run --quiet --wait --pipe --collect --uid="$UB" --gid="$GB" -p WorkingDirectory="$WORK/src" -E HOME=/home/ubuntu "${ENVFILES[@]}" "${SETENV[@]}" \
        "$(command -v node)" scripts/migrate-to-postgres.js --sqlite "$WORK/source.db" 2>&1 | grep -v " 0 rows"; then
    echo "[switch] IMPORT FAILED: starting the old release again"; systemctl start "${UNITS[@]}" 2>/dev/null || systemctl start "$UNIT"; exit 1
fi
echo "[switch] deploying"
ovhost unfreeze "$SVC" >/dev/null
ovhost deploy "$SVC" 2>&1 | tail -3
if [ -n "${SWITCH_AFTER:-}" ]; then echo "[switch] $SWITCH_AFTER"; bash -c "$SWITCH_AFTER" 2>&1 | tail -5; fi
chmod 0400 "$DB"; [ -f "$DB-wal" ] && chmod 0400 "$DB-wal"; [ -f "$DB-shm" ] && chmod 0400 "$DB-shm"
rm -rf "$WORK"
echo "[switch] done"
