#!/usr/bin/env bash
# ov-socketize.sh <service> : switch one ovhost service over to systemd socket activation, on the host, as root.
#
# Why (2026-10-31): a service without a .socket unit closes its port for its whole restart, and nginx answers 502 to
# every request in that window (a Codes deploy gave the owner a Cloudflare 502). With the listener held by systemd,
# requests wait in the kernel's accept queue and the new process serves them. The service's code must already listen
# on fd 3 when LISTEN_FDS=1 (the socketActivated lines); this refuses otherwise.
#
# Steps: write <name>.socket (127.0.0.1:<port>, loopback only) and <unit>.d/socket.conf, daemon-reload, enable the
# socket, stop the service, start the socket, start the service, check that systemd (pid 1) holds the port and the
# ready URL answers, record socketUnit in /etc/openvibe/host.json (backed up first), then prove it: 40 requests through
# a restart, none refused.
set -euo pipefail
svc=${1:?service}
HJ=/etc/openvibe/host.json
read -r unit port repo ready < <(node -e '
const j = require(process.argv[1]); const s = j.services[process.argv[2]];
if (!s) { console.error("no such service"); process.exit(2); }
console.log([s.units[0], s.port, s.repo, (s.ready && s.ready.url) || ""].join(" "));' "$HJ" "$svc")
[ -n "$port" ] && [ "$port" != "undefined" ] || { echo "$svc: no port in host.json"; exit 2; }
base=${unit%.service}
sock=$base.socket
code="$repo/server/index.js"; [ -L "$repo/current" ] && code="$repo/current/server/index.js"
grep -q 'socketActivated' "$code" || { echo "$svc: $code does not listen on fd 3 yet (deploy the socket-activation PR first)"; exit 3; }
if [ "$(node -e 'const s=require(process.argv[1]).services[process.argv[2]];console.log(s.socketUnit||"")' "$HJ" "$svc")" = "$sock" ] && \
   ss -ltnp "sport = :$port" | grep -q 'systemd'; then echo "$svc: already socket-activated ($sock holds :$port)"; exit 0; fi

cat > "/etc/systemd/system/$sock" <<EOF
# $base: listening socket owned by systemd, not by the process (written by ov-socketize.sh, 2026-10-31).
# Requests that arrive while the service restarts wait in the kernel's accept queue instead of being refused
# (nginx would answer 502). No PartOf=$unit: the socket must outlive every restart of the service.
[Unit]
Description=$base HTTP socket

[Socket]
# Loopback only: nginx is the only client (the host firewall is off, so 0.0.0.0 would be public).
ListenStream=127.0.0.1:$port
NoDelay=true
Backlog=511

[Install]
WantedBy=sockets.target
EOF
mkdir -p "/etc/systemd/system/$unit.d"
cat > "/etc/systemd/system/$unit.d/socket.conf" <<EOF
# Bind $unit to the socket unit that owns its listener (ov-socketize.sh, 2026-10-31).
[Unit]
Requires=$sock
After=$sock

[Service]
# Node's libuv expects a non-blocking descriptor (a [Service] option; in [Socket] systemd ignores it).
NonBlocking=true
EOF
systemctl daemon-reload
systemctl enable "$sock" >/dev/null 2>&1
systemctl stop "$unit"
systemctl start "$sock"
systemctl start "$unit"
for i in $(seq 1 30); do
    if [ -n "$ready" ]; then code_=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$ready" || true); else code_=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$port/" || true); fi
    [ "$code_" != "000" ] && [ "${code_:0:1}" != "5" ] && break
    sleep 1
done
ss -ltnp "sport = :$port" | grep -q 'systemd' || { echo "$svc: systemd does NOT hold :$port after the switch-over"; exit 4; }
systemctl is-active --quiet "$unit" || { echo "$svc: $unit is not active"; exit 5; }

cp -p "$HJ" "/root/host.json.bak-$(date -u +%Y%m%dT%H%M%SZ)-$svc"
node -e '
const fs = require("fs"); const f = process.argv[1]; const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.services[process.argv[2]].socketUnit = process.argv[3];
fs.writeFileSync(f + ".tmp", JSON.stringify(j, null, 2) + "\n"); fs.renameSync(f + ".tmp", f);' "$HJ" "$svc" "$sock"

# The proof: requests straight to the port while the service restarts; none may be refused.
url=${ready:-http://127.0.0.1:$port/}
bad=0
( for i in $(seq 1 40); do c=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$url" || echo 000); [ "$c" = "000" ] && echo refused; sleep 0.15; done ) > /tmp/ovsock.$$ &
p=$!
sleep 0.5; systemctl restart "$unit"; wait $p
bad=$(grep -c refused /tmp/ovsock.$$ || true); rm -f /tmp/ovsock.$$
echo "$svc: socket-activated ($sock holds :$port); restart proof: $bad of 40 refused"
[ "$bad" = "0" ]
