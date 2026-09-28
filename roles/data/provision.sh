#!/usr/bin/env bash
# roles/data/provision.sh — install and configure the OpenVibe data role on this host (ADR-035, roadmap WS-X2):
# PostgreSQL 18, PgBouncer (transaction pooling), pgBackRest (point-in-time recovery to the encrypted B2
# repository), Valkey (shared, never authoritative) and their Prometheus exporters, all on loopback.
#
#   sudo roles/data/provision.sh            apply roles/data/files/ and create what is missing
#   sudo roles/data/provision.sh --check    report what would change, change nothing
#
# Idempotent: a second run changes nothing unless files/ changed. Generated passwords live only in
# /etc/openvibe/data.env (root, 0600); they reach PostgreSQL as SCRAM secrets and Valkey as SHA-256
# hashes, so no plaintext appears in a log, a process list or this script's output. Per-service
# databases and users come from roles/data/add-service.sh.
set -euo pipefail
umask 077

HERE=$(cd "$(dirname "$0")" && pwd)
F=$HERE/files
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
# shellcheck source=lib.sh
. "$HERE/lib.sh"

[ "$(id -u)" = 0 ] || { echo "provision.sh: run as root" >&2; exit 1; }
RESTART_PG=0; RELOAD_PG=0; RESTART_BOUNCER=0; RESTART_VALKEY=0; RELOAD_UNITS=0; RESTART_EXPORTERS=0

# ── 1. Packages ───────────────────────────────────────────────────────────────────────────────
PKGS=(postgresql-$PGV pgbouncer pgbackrest valkey-server prometheus-postgres-exporter prometheus-redis-exporter prometheus-pgbouncer-exporter)
MISSING=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
if [ ${#MISSING[@]} -gt 0 ]; then
    if [ "$CHECK" = 1 ]; then log "would install packages: ${MISSING[*]}"
    else
        log "installing ${MISSING[*]}"
        DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${MISSING[@]}" >/dev/null
        # Exporters start listening on every interface when installed; stop them until they are bound to loopback below.
        for u in prometheus-postgres-exporter prometheus-redis-exporter prometheus-pgbouncer-exporter; do systemctl stop "$u" 2>/dev/null || true; done
    fi
fi
[ "$CHECK" = 1 ] && [ ${#MISSING[@]} -gt 0 ] && { log "check: packages missing, stopping here"; exit 0; }

# ── 2. PostgreSQL ────────────────────────────────────────────────────────────────────────────
install_file "$F/postgresql-openvibe.conf" "$PGCONF/conf.d/openvibe.conf" 644 postgres:postgres && RESTART_PG=1
install_file "$F/pg_hba.conf" "$PGCONF/pg_hba.conf" 640 postgres:postgres && RELOAD_PG=1

# Archiving: pgBackRest when the off-site repository is configured, else nothing (and say so).
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
HAVE_REPO=0
if [ -f "$BACKUP_ENV" ] && grep -q '^BACKUP_S3_BUCKET=' "$BACKUP_ENV"; then HAVE_REPO=1; fi
if [ "$HAVE_REPO" = 1 ]; then
    echo "archive_command = 'pgbackrest --stanza=openvibe archive-push %p'" > "$TMP/archive.conf"
else
    echo "archive_command = '/bin/true'   # no backup repository configured ($BACKUP_ENV): WAL is not archived" > "$TMP/archive.conf"
    log "WARNING: $BACKUP_ENV has no BACKUP_S3_BUCKET; WAL archiving is off until it does"
fi
install_file "$TMP/archive.conf" "$PGCONF/conf.d/openvibe-archive.conf" 644 postgres:postgres && RELOAD_PG=1

# ── 3. pgBackRest (the encrypted repository sits beside, never under, ovhost's pruned backup prefix) ──
if [ "$HAVE_REPO" = 1 ]; then
    CIPHER=$(secret PGBACKREST_CIPHER_PASS)
    (
        set -a; . "$BACKUP_ENV"; set +a
        endpoint=${BACKUP_S3_ENDPOINT#https://}; endpoint=${endpoint#http://}; endpoint=${endpoint%/}
        region=${BACKUP_S3_REGION:-us-east-1}
        cat > "$TMP/pgbackrest.conf" <<CONF
# Written by OpenVibe.Host roles/data/provision.sh (ADR-035). Root and postgres only.
[global]
repo1-type=s3
repo1-s3-endpoint=$endpoint
repo1-s3-bucket=$BACKUP_S3_BUCKET
repo1-s3-region=$region
repo1-s3-key=$BACKUP_S3_KEY_ID
repo1-s3-key-secret=$BACKUP_S3_SECRET
repo1-s3-uri-style=path
repo1-path=/openvibe-pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$CIPHER
repo1-retention-full=2
repo1-retention-full-type=count
process-max=2
start-fast=y
compress-type=zst
log-level-console=warn
log-level-file=info

[openvibe]
pg1-path=$PGDATA
CONF
    )
    mkdir -p -m 755 /etc/pgbackrest   # umask 077 would make it 700, and postgres must read the file inside
    install_file "$TMP/pgbackrest.conf" /etc/pgbackrest/pgbackrest.conf 640 root:postgres || true
    for u in pgbackrest-backup@.service pgbackrest-full.timer pgbackrest-diff.timer; do
        install_file "$F/$u" "/etc/systemd/system/$u" 644 root:root && RELOAD_UNITS=1
    done
fi

# ── 4. Valkey ────────────────────────────────────────────────────────────────────────────────
if install_file "$F/sysctl-valkey.conf" /etc/sysctl.d/60-openvibe-valkey.conf 644 root:root; then sysctl -q -p /etc/sysctl.d/60-openvibe-valkey.conf; fi
install_file "$F/valkey-openvibe.conf" /etc/valkey/openvibe.conf 640 valkey:valkey && RESTART_VALKEY=1
if ! grep -qx 'include /etc/valkey/openvibe.conf' /etc/valkey/valkey.conf; then
    if [ "$CHECK" = 1 ]; then log "would include openvibe.conf in /etc/valkey/valkey.conf"
    else echo 'include /etc/valkey/openvibe.conf' >> /etc/valkey/valkey.conf; RESTART_VALKEY=1; log "valkey.conf includes openvibe.conf"; fi
fi
if [ "$CHECK" = 0 ]; then
    build_valkey_acl "$TMP/users.acl"
    install_file "$TMP/users.acl" /etc/valkey/users.acl 640 valkey:valkey && RESTART_VALKEY=1
fi

# ── 5. Restart or reload what changed, then the roles that need a running server ────────────
if [ "$CHECK" = 1 ]; then log "check done"; exit 0; fi
[ "$RELOAD_UNITS" = 1 ] && systemctl daemon-reload
systemctl enable -q postgresql valkey-server pgbouncer
if [ "$RESTART_PG" = 1 ]; then log "restarting PostgreSQL"; systemctl restart "postgresql@$PGV-main"; elif [ "$RELOAD_PG" = 1 ]; then systemctl reload "postgresql@$PGV-main"; fi
systemctl is-active -q "postgresql@$PGV-main" || systemctl start "postgresql@$PGV-main"
[ "$RESTART_VALKEY" = 1 ] && { log "restarting Valkey"; systemctl reset-failed valkey-server 2>/dev/null || true; systemctl restart valkey-server; }
systemctl is-active -q valkey-server || { systemctl reset-failed valkey-server 2>/dev/null || true; systemctl start valkey-server; }

# Roles every data host has: the PgBouncer auth user (and its lookup function) and the monitoring user.
BOUNCER_PW=$(secret PGBOUNCER_AUTH_PASSWORD); PGMON_PW=$(secret PG_MONITOR_PASSWORD)
BOUNCER_SCRAM=$(scram "$BOUNCER_PW"); PGMON_SCRAM=$(scram "$PGMON_PW")
psql_su postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN CREATE ROLE pgbouncer_auth LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_monitor') THEN CREATE ROLE ov_monitor LOGIN IN ROLE pg_monitor; END IF;
END \$\$;
ALTER ROLE pgbouncer_auth PASSWORD '$BOUNCER_SCRAM';
ALTER ROLE ov_monitor PASSWORD '$PGMON_SCRAM';
CREATE SCHEMA IF NOT EXISTS pgbouncer AUTHORIZATION postgres;
CREATE OR REPLACE FUNCTION pgbouncer.get_auth(p_usename TEXT) RETURNS TABLE(usename name, passwd text)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS
  \$f\$ SELECT rolname, rolpassword FROM pg_authid WHERE rolname = p_usename AND rolcanlogin AND NOT rolsuper \$f\$;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT) TO pgbouncer_auth;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- Service roles reach only their own database: nobody else connects to the maintenance database.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO pgbouncer_auth, ov_monitor;
SQL

# ── 6. PgBouncer (its auth user's password is the one plaintext it must hold: root and postgres only) ──
printf '"pgbouncer_auth" "%s"\n' "$BOUNCER_PW" > "$TMP/userlist.txt"
install_file "$F/pgbouncer.ini" /etc/pgbouncer/pgbouncer.ini 640 postgres:postgres && RESTART_BOUNCER=1
install_file "$TMP/userlist.txt" /etc/pgbouncer/userlist.txt 640 postgres:postgres && RESTART_BOUNCER=1
if [ "$RESTART_BOUNCER" = 1 ]; then log "restarting PgBouncer"; systemctl restart pgbouncer; fi
systemctl is-active -q pgbouncer || systemctl start pgbouncer

# ── 7. Exporters, on loopback only (the host firewall is off: never bind them publicly) ─────
VALKEY_MON_PW=$(secret VALKEY_MONITOR_PASSWORD)
cat > "$TMP/pg-exporter" <<EOF
DATA_SOURCE_NAME='postgresql://ov_monitor:$PGMON_PW@127.0.0.1:5432/postgres?sslmode=disable'
ARGS='--web.listen-address=127.0.0.1:9187'
EOF
cat > "$TMP/redis-exporter" <<EOF
REDIS_ADDR='redis://127.0.0.1:6379'
REDIS_USER='ov_monitor'
REDIS_PASSWORD='$VALKEY_MON_PW'
ARGS='-web.listen-address 127.0.0.1:9121'
EOF
cat > "$TMP/bouncer-exporter" <<EOF
ARGS='--web.listen-address=127.0.0.1:9127 --pgBouncer.connectionString=postgres://ov_monitor:$PGMON_PW@127.0.0.1:6432/pgbouncer?sslmode=disable'
EOF
install_file "$TMP/pg-exporter" /etc/default/prometheus-postgres-exporter 640 root:prometheus && RESTART_EXPORTERS=1
install_file "$TMP/redis-exporter" /etc/default/prometheus-redis-exporter 640 root:prometheus && RESTART_EXPORTERS=1
install_file "$TMP/bouncer-exporter" /etc/default/prometheus-pgbouncer-exporter 640 root:prometheus && RESTART_EXPORTERS=1
for u in prometheus-postgres-exporter prometheus-redis-exporter prometheus-pgbouncer-exporter; do
    systemctl enable -q "$u"
    if [ "$RESTART_EXPORTERS" = 1 ] || ! systemctl is-active -q "$u"; then systemctl restart "$u"; fi
done

# ── 8. The pgBackRest stanza and its schedule ───────────────────────────────────────────────
if [ "$HAVE_REPO" = 1 ]; then
    if ! runuser -u postgres -- pgbackrest --stanza=openvibe info --output=json 2>/dev/null | grep -q '"status":{"code":0'; then
        log "creating the pgBackRest stanza"
        runuser -u postgres -- pgbackrest --stanza=openvibe stanza-create
        runuser -u postgres -- pgbackrest --stanza=openvibe check
        log "starting the first full backup (pgbackrest-backup@full.service)"
        systemctl start --no-block pgbackrest-backup@full.service
    fi
    systemctl enable -q --now pgbackrest-full.timer pgbackrest-diff.timer
fi

log "done: PostgreSQL $PGV :5432, PgBouncer :6432, Valkey :6379 (all loopback); exporters :9187 :9121 :9127"
[ "$HAVE_REPO" = 1 ] && log "escrow reminder: PGBACKREST_CIPHER_PASS in $SECRETS decrypts the database backups; keep an off-host copy (O8)"
exit 0
