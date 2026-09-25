# The developer path against production, daily (roadmap WS-N task 1)

`openvibe-devpath.timer` runs OpenVibe.Examples' `scripts/developer-path.js` once a day (05:10 UTC, up to
15 minutes later) against production, as an ordinary developer would: sign in with a dedicated test
account, create a sandbox project and app, get grants, upload and read a file through Media, publish and
pull an event through Events, rotate and revoke the credential, archive the project.

| Piece | Where |
|---|---|
| Checkout | `/usr/local/lib/openvibe-examples` (root-owned; `git pull` + `npm ci` to update) |
| Account | `/etc/openvibe/devpath.env` (root, 0600): `OV_E2E_USERNAME`, `OV_E2E_PASSWORD` — never printed |
| Units | `deploy/systemd/openvibe-devpath.service` + `.timer` (runs as `ubuntu`) |
| Result | `/var/lib/openvibe-devpath/last.json`: step names and ok only (shown on openvibe.network/status) |
| Metrics | `scripts/devpath-metrics.sh` → node_exporter textfile `openvibe_devpath.prom` |
| Alerts | `OpenVibeDeveloperPathFailed`, `OpenVibeDeveloperPathMissed` (30 h) in `deploy/prometheus/openvibe-rules.yml` |

Install (once, as root):

```sh
git clone https://github.com/OpenVibers/OpenVibe.Examples /usr/local/lib/openvibe-examples && (cd /usr/local/lib/openvibe-examples && npm ci --no-audit --no-fund)
umask 077; printf 'OV_E2E_USERNAME=ovprobe_devpath\nOV_E2E_PASSWORD=%s\n' "$(openssl rand -hex 24)" > /etc/openvibe/devpath.env
install -m 644 deploy/systemd/openvibe-devpath.{service,timer} /etc/systemd/system/ && systemctl daemon-reload
# first run registers the account:
set -a; . /etc/openvibe/devpath.env; set +a; runuser -u ubuntu -p -- node /usr/local/lib/openvibe-examples/scripts/developer-path.js --register
systemctl enable --now openvibe-devpath.timer
```

Run now: `systemctl start openvibe-devpath.service`; read: `journalctl -u openvibe-devpath` (masked).
