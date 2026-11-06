# Readiness check

A readiness check for every OpenVibe service on the production host. On 2026-11-05 openvibe.games
answered its `/api/ready` with 503 for eight hours while its process and `/metrics` stayed up: `TargetDown`
never fired and nobody knew. This notices.

`deploy/scripts/ready-health.sh` (openvibe-readyhealth.timer, every 5 minutes) reads the host inventory
(`/etc/openvibe/host.json`), and for every service with a `ready.url` — the same field `ovhost deploy`
polls — GETs that URL with the entry's `ready.headers` and a 5 s timeout. It writes node_exporter's
textfile collector in one rename:

| Answer | Means | Metric |
|---|---|---|
| 2xx | the service answers its readiness endpoint | `openvibe_service_ready{service="<id>"} 1` |
| any other status (a 500, a 503, a redirect), or no answer at all | not ready | `openvibe_service_ready{service="<id>"} 0` |
| a service with no `ready.url` | nothing declared to judge | no line |

Every completed run also writes `openvibe_service_ready_last_run_timestamp` (Unix seconds), so a check
that stops running is noticed too.

## The run

`deploy/scripts/ready-health.sh` reads the inventory named by `OVHOST_INVENTORY` (default
`/etc/openvibe/host.json`), one service at a time, and writes
`/var/lib/prometheus/node-exporter/openvibe_service_ready.prom` in one rename, so Prometheus never reads
half a file. It prints the lines it wrote.

- **The inventory cannot be read** (missing, not JSON, no `services`, or no service with a ready URL): it
  exits 2 and leaves the previous file alone. An inventory that cannot be checked is not green.
- **No collector directory**: it writes nothing (the lines are still printed), so it is harmless off the
  host.
- **Exit code**: 0 every service is ready · 1 one service is 0 · 2 the inventory could not be read.
- **Secrets**: it reads no env file and prints nothing from one. A `ready.headers` value (for example the
  Tools gateway's `Host`) reaches curl through a mode-0600 temp file and is never echoed; the metric is a
  service id and 0 or 1.

After a deploy, or to run it by hand now:

```bash
sudo systemctl start openvibe-readyhealth.service        # every service, now
sudo /usr/local/lib/openvibe-host/deploy/scripts/ready-health.sh   # the lines, without the unit
```

## The alert

Host keeps its rules in [deploy/prometheus/openvibe-rules.yml](../deploy/prometheus/openvibe-rules.yml);
nothing installs them automatically, so the copy in [Install](#install-once) is how a rule — this one and
the others — reaches `/etc/prometheus/rules/openvibe.yml`.

- `OpenVibeServiceNotReady` fires on `openvibe_service_ready == 0` for 15 minutes, severity `page`:
  > `games` has not been ready for 15 minutes (read its /api/ready; sudo ovhost status games)
- `OpenVibeServiceReadyMissed` fires when `openvibe_service_ready_last_run_timestamp` is more than
  20 minutes old (or is absent), severity `page`: the probe itself has stopped, so every service would
  look fine.

Both travel the usual path ([operator-alerts.md](operator-alerts.md)).

## Install (once)

```bash
sudo cp /usr/local/lib/openvibe-host/deploy/systemd/openvibe-readyhealth.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-readyhealth.timer
sudo cp /usr/local/lib/openvibe-host/deploy/prometheus/openvibe-rules.yml /etc/prometheus/rules/openvibe.yml
sudo promtool check rules /etc/prometheus/rules/openvibe.yml && sudo systemctl reload prometheus
```

The script lives in the `ovhost` CLI's own checkout (`/usr/local/lib/openvibe-host`), which
`sudo ovhost self-update` brings up to `main`; the unit runs it from there.

## What it cannot see

- A 2xx says the readiness endpoint answered, not that the service works: a readiness route that forgets
  to check its database still looks green. It complements `/metrics` and `TargetDown`, it does not
  replace them.
- A service without `ready.url` is outside the check, and a ready URL that takes longer than 5 s counts
  as not ready.
- The inventory is root-owned and never committed; this check reads it and writes only the textfile.
