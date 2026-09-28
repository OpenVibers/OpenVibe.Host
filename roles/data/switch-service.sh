#!/usr/bin/env bash
# roles/data/switch-service.sh — the production switch of one service from its SQLite file to PostgreSQL (ADR-035).
#
#   sudo roles/data/switch-service.sh <service>
#
# Before: the service's postgres branch is merged to main with green CI, its auto-deploy is frozen
# (ovhost freeze <svc> --reason …), and add-service.sh <svc> has written its database settings.
# It clones main as ubuntu into /var/tmp/pg-<svc> and installs it; stops the unit; keeps a read-only
# <svc>.pre-postgres-<time>.db backup next to the file; runs that release's scripts/migrate-to-postgres.js
# (openvibe-sdk runSqliteMigration: migrate, import, verify counts and checksums) with the unit's
# environment, as ubuntu; on any failure it starts the old release again and stops. Then it unfreezes and
# deploys (ovhost deploy), and makes the SQLite file read-only: it is the 7-day rollback (compatibility
# register C-89: sudo ovhost rollback <svc> to the release before, which reads the file).
set -euo pipefail
SVC=$1; UNIT=openvibe-$SVC.service; DIR=/opt/openvibe.$SVC; DATA=/var/lib/openvibe-$SVC; DB=$DATA/$SVC.db
WORK=/var/tmp/pg-$SVC; UB=$(id -u ubuntu); GB=$(id -g ubuntu)
[ -f "$DB" ] || { echo "no $DB"; exit 1; }
rm -rf "$WORK"; install -d -o ubuntu -g ubuntu "$WORK"
REMOTE=$(git -C "$DIR" remote get-url origin)
setpriv --reuid=$UB --regid=$GB --init-groups env HOME=/home/ubuntu bash -c "cd $WORK && git clone -q --depth 1 --branch main '$REMOTE' src && cd src && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1 && git log --oneline -1"
echo "[switch] stopping $UNIT"; systemctl stop "$UNIT"
sqlite3 "$DB" ".backup $WORK/source.db"; chown ubuntu:ubuntu "$WORK/source.db"
TS=$(date -u +%Y%m%dT%H%M%SZ); cp "$WORK/source.db" "$DATA/$SVC.pre-postgres-$TS.db"; chmod 0400 "$DATA/$SVC.pre-postgres-$TS.db"; echo "[switch] backup $DATA/$SVC.pre-postgres-$TS.db"
echo "[switch] importing"
set -a; . /etc/openvibe/$SVC.env; set +a
ENVS=$(systemctl show "$UNIT" -p Environment --value); [ -n "$ENVS" ] && export $ENVS >/dev/null
cd "$WORK/src"
if ! setpriv --reuid=$UB --regid=$GB --init-groups env HOME=/home/ubuntu node scripts/migrate-to-postgres.js --sqlite "$WORK/source.db" 2>&1 | grep -v " 0 rows"; then
    echo "[switch] IMPORT FAILED: starting the old release again"; systemctl start "$UNIT"; exit 1
fi
cd /
echo "[switch] deploying"
ovhost unfreeze "$SVC" >/dev/null
ovhost deploy "$SVC" 2>&1 | tail -3
chmod 0400 "$DB"; [ -f "$DB-wal" ] && chmod 0400 "$DB-wal"; [ -f "$DB-shm" ] && chmod 0400 "$DB-shm"
rm -rf "$WORK"
echo "[switch] done"
