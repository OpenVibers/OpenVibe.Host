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

## Tools job proof

`openvibe-toolsjob.timer` runs OpenVibe.Examples' `scripts/tools-job-proof.js` every six hours (xx:25 UTC,
up to 10 minutes later; roadmap WS-L task 4). It is the end-to-end proof of Tools jobs, using the SDK only. The `probe` service
principal gets tokens for `tools.job.create`, `tools.job.read` and `events.event.read`. It then:

1. submits an `img.process` job that converts a PNG to WebP;
2. drops the progress stream after its first event and reattaches with `Last-Event-ID`, as the UI does;
3. downloads the result, which is stored in Media;
4. finds the job's `tools.job.created`, `started` and `succeeded` events in the Events store.

A service principal runs it, not a developer app, because sandbox jobs are never announced to Events or
copied to Media.

| Piece | Where |
|---|---|
| Checkout | the same `/usr/local/lib/openvibe-examples` |
| Identity | `/etc/openvibe/probe.env` (root, 0600): `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET` of principal `probe`; grants in OpenVibe.Network `server/identity/principals.js` |
| Units | `deploy/systemd/openvibe-toolsjob.service` + `.timer` (runs as `ubuntu`) |
| Result | `/var/lib/openvibe-devpath/tools-job.json`: step names and ok only (shown on openvibe.network/status) |
| Metrics | `scripts/devpath-metrics.sh` with `METRIC_PREFIX=openvibe_toolsjob` → `openvibe_toolsjob.prom` |
| Alerts | `OpenVibeToolsJobProofFailed`, `OpenVibeToolsJobProofMissed` (13 h, two runs) |

Install (once, as root, in `/opt/openvibe.network`, then here):

```sh
node server/setup/service-principal.js create probe --env-file /etc/openvibe/probe.env   # secret never printed
systemctl restart openvibe-network        # seeds probe's default grants
install -m 644 deploy/systemd/openvibe-toolsjob.{service,timer} /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now openvibe-toolsjob.timer
```

Run now: `systemctl start openvibe-toolsjob.service`; read: `journalctl -u openvibe-toolsjob`.
