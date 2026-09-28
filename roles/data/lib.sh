# roles/data/lib.sh — helpers shared by provision.sh and add-service.sh (ADR-035). Sourced, never run.
# No function here prints a secret.

PGV=18
PGCONF=/etc/postgresql/$PGV/main
PGDATA=/var/lib/postgresql/$PGV/main
SECRETS=/etc/openvibe/data.env
BACKUP_ENV=/etc/openvibe/backup.env
CHECK=${CHECK:-0}

log() { echo "[data] $*"; }

# install_file SRC DEST MODE OWNER:GROUP → true when DEST changed
install_file() {
    if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
    if [ "$CHECK" = 1 ]; then log "would install $2"; return 1; fi
    install -D -m "$3" -o "${4%%:*}" -g "${4##*:}" "$1" "$2"
    log "installed $2"
    return 0
}

# secret NAME → the value, generated once into $SECRETS (root, 0600)
secret() {
    mkdir -p /etc/openvibe && touch "$SECRETS" && chmod 600 "$SECRETS"
    local v
    v=$(grep -E "^$1=" "$SECRETS" | head -1 | cut -d= -f2- || true)
    if [ -z "$v" ]; then v=$(openssl rand -hex 24); printf '%s=%s\n' "$1" "$v" >> "$SECRETS"; fi
    printf '%s' "$v"
}

# scram PASSWORD → a PostgreSQL SCRAM-SHA-256 secret (RFC 5802/7677), so the plaintext never reaches SQL
scram() {
    python3 - "$1" <<'PY'
import base64, hashlib, hmac, os, sys
pw = sys.argv[1].encode(); salt = os.urandom(16); it = 4096
salted = hashlib.pbkdf2_hmac('sha256', pw, salt, it)
ck = hmac.new(salted, b'Client Key', 'sha256').digest(); sk = hmac.new(salted, b'Server Key', 'sha256').digest()
b = lambda x: base64.b64encode(x).decode()
print(f"SCRAM-SHA-256${it}:{b(salt)}${b(hashlib.sha256(ck).digest())}:{b(sk)}", end='')
PY
}

sha256hex() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

psql_su() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "${1:-postgres}"; }

# build_valkey_acl OUT → users.acl content: the role's users, then one line per service from services.acl.
# ACL files take no comments, so the service users live in /etc/valkey/services.acl.
build_valkey_acl() {
    local admin mon
    admin=$(secret VALKEY_ADMIN_PASSWORD); mon=$(secret VALKEY_MONITOR_PASSWORD)
    touch /etc/valkey/services.acl && chown valkey:valkey /etc/valkey/services.acl && chmod 640 /etc/valkey/services.acl
    {
        echo "user default off"
        echo "user ov_admin on #$(sha256hex "$admin") ~* &* +@all"
        echo "user ov_monitor on #$(sha256hex "$mon") -@all +info +ping +config|get +client|list +slowlog +latency +dbsize +memory|stats +select"
        grep -E '^user ov_svc_' /etc/valkey/services.acl || true
    } > "$1"
}

# valkey_admin ARGS… → valkey-cli as ov_admin (the password goes through the environment, not argv)
valkey_admin() {
    local pw; pw=$(secret VALKEY_ADMIN_PASSWORD)
    VALKEYCLI_AUTH="$pw" REDISCLI_AUTH="$pw" valkey-cli --no-auth-warning --user ov_admin "$@"
}
