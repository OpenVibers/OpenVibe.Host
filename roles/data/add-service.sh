#!/usr/bin/env bash
# roles/data/add-service.sh — give one service its PostgreSQL database and roles and its Valkey user
# (ADR-035), and write its connection settings into the service's env file.
#
#   sudo roles/data/add-service.sh <service> [--env-file /etc/openvibe/<service>.env]
#
# Per service <svc> (id "-" → "_"):
#   database  ov_<id>            owned by ov_<id>
#   ov_<id>        owner role: migrations and session features, direct on :5432 (DATABASE_DIRECT_URL)
#   ov_<id>_app    runtime role through PgBouncer :6432 (DATABASE_URL): DML only, statement_timeout 15 s,
#                  lock_timeout 5 s, idle-in-transaction 30 s
#   ov_svc_<id>    Valkey user limited to keys and channels under ov:<svc>: (VALKEY_URL, VALKEY_PREFIX)
# Idempotent: passwords are generated once (/etc/openvibe/data.env) and the env file lines are replaced in
# place. Nothing is printed but names.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

usage() { echo "usage: add-service.sh <service> [--env-file <path>]" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "add-service.sh: run as root" >&2; exit 1; }
SVC=${1:-}; [[ "$SVC" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || usage
ENV_FILE=/etc/openvibe/$SVC.env
if [ "${2:-}" = "--env-file" ]; then ENV_FILE=${3:?}; elif [ -n "${2:-}" ]; then usage; fi
ID=${SVC//-/_}; UP=$(echo "$ID" | tr a-z A-Z)
DB=ov_$ID; OWNER=ov_$ID; APP=ov_${ID}_app; VUSER=ov_svc_$ID; PREFIX="ov:$SVC:"

OWNER_PW=$(secret "PG_${UP}_OWNER_PASSWORD"); APP_PW=$(secret "PG_${UP}_APP_PASSWORD"); V_PW=$(secret "VALKEY_${UP}_PASSWORD")
OWNER_SCRAM=$(scram "$OWNER_PW"); APP_SCRAM=$(scram "$APP_PW")

# ── PostgreSQL: roles, database, privileges ────────────────────────────────────────────────
psql_su postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$OWNER') THEN CREATE ROLE $OWNER LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP') THEN CREATE ROLE $APP LOGIN; END IF;
END \$\$;
ALTER ROLE $OWNER PASSWORD '$OWNER_SCRAM';
ALTER ROLE $APP PASSWORD '$APP_SCRAM';
ALTER ROLE $APP SET statement_timeout = '15s';
ALTER ROLE $APP SET lock_timeout = '5s';
ALTER ROLE $APP SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE $OWNER SET statement_timeout = '0';
SELECT format('CREATE DATABASE %I OWNER %I', '$DB', '$OWNER') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB') \gexec
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $DB TO $APP;
GRANT CONNECT ON DATABASE $DB TO ov_monitor;
SQL
psql_su "$DB" <<SQL
ALTER SCHEMA public OWNER TO $OWNER;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $APP;
ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP;
ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO $APP;
ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO $APP;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $APP;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO $APP;
SQL

# ── Valkey: one user, confined to its prefix ────────────────────────────────────────────────
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
touch /etc/valkey/services.acl
{ grep -vE "^user $VUSER " /etc/valkey/services.acl || true
  echo "user $VUSER on #$(sha256hex "$V_PW") resetkeys ~${PREFIX}* resetchannels &${PREFIX}* +@all -@dangerous"; } > "$TMP/services.acl"
install -m 640 -o valkey -g valkey "$TMP/services.acl" /etc/valkey/services.acl
build_valkey_acl "$TMP/users.acl"
if ! cmp -s "$TMP/users.acl" /etc/valkey/users.acl; then
    install -m 640 -o valkey -g valkey "$TMP/users.acl" /etc/valkey/users.acl
    valkey_admin ACL LOAD >/dev/null
fi

# ── The service's env file: four settings, replaced in place ────────────────────────────────
[ -f "$ENV_FILE" ] || { install -m 600 /dev/null "$ENV_FILE"; log "created $ENV_FILE"; }
set_env() {
    local k=$1 v=$2
    if grep -qE "^$k=" "$ENV_FILE"; then
        python3 - "$ENV_FILE" "$k" "$v" <<'PY'
import sys
p, k, v = sys.argv[1:4]
lines = open(p).read().split('\n')
out = [f'{k}={v}' if l.startswith(k + '=') else l for l in lines]
open(p, 'w').write('\n'.join(out))
PY
    else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi
}
set_env DATABASE_URL "postgresql://$APP:$APP_PW@127.0.0.1:6432/$DB"
set_env DATABASE_DIRECT_URL "postgresql://$OWNER:$OWNER_PW@127.0.0.1:5432/$DB"
set_env VALKEY_URL "redis://$VUSER:$V_PW@127.0.0.1:6379/0"
set_env VALKEY_PREFIX "$PREFIX"
log "$SVC: database $DB (owner $OWNER, runtime $APP via PgBouncer), Valkey user $VUSER on ${PREFIX}*; DATABASE_URL, DATABASE_DIRECT_URL, VALKEY_URL, VALKEY_PREFIX set in $ENV_FILE (values not shown)"
