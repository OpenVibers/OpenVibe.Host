# Operator alerts

Roadmap WS-H task 11. The host's Prometheus evaluates the rules in
[deploy/prometheus/openvibe-rules.yml](../deploy/prometheus/openvibe-rules.yml): targets down, error
rates, disk and memory, backups, deploy drift, the developer path, the Tools job proof, the browser check
of each release and the relay itself. Until 2026-09-26 nothing delivered them.

## The path

```
Prometheus (127.0.0.1:9090)  ──GET /api/v1/alerts──▶  ovhost alerts relay   (openvibe-alerts.timer, every 2 min)
                                                          │  Host's service token (network.operator.alert)
                                                          ▼
                                   OpenVibe.Network POST /internal/operator/alerts
                                   (network.operator-alerts-request@1: the complete firing set)
                                                          │
                                                          ▼
                    an OPERATOR_ALERT notification (category admin) to the owner account:
                    the bell, web push and the realtime badge
```

- **Opened**: an alert that was not firing pages at once. Severity `page` is a critical notification and
  `ticket` a high one.
- **Reminded**: the alert pages again once a day while it stays open.
- **Resolved**: a notice goes out when the alert drops out of the firing set.
- **Recipients**: `OWNER_USERNAME` in Network's environment, plus the comma-separated `OPERATOR_ALERT_USERNAMES`.
- **What leaves the host**: only the alert name, severity, summary, description, `service` label and start time.
  Instance and job labels stay on the host; the fingerprint is a hash of the labels.
- **Pending alerts** (inside their `for:` window) are not sent.
- **Prometheus unreachable**: the relay sends nothing, because an empty set would resolve every open alert.
- **Relay failures**: `openvibe_alert_relay_last_run_ok` and `openvibe_alert_relay_last_success_timestamp_seconds`
  record them, and `OpenVibeAlertRelayFailing` pages as soon as delivery works again.

## Commands

```bash
sudo ovhost alerts relay --dry-run   # what is firing, nothing sent
sudo ovhost alerts relay             # deliver now
systemctl list-timers openvibe-alerts.timer
```

## Install (once)

```bash
sudo cp /usr/local/lib/openvibe-host/deploy/systemd/openvibe-alerts.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-alerts.timer
sudo cp /usr/local/lib/openvibe-host/deploy/prometheus/openvibe-rules.yml /etc/prometheus/rules/openvibe.yml
sudo promtool check rules /etc/prometheus/rules/openvibe.yml && sudo systemctl reload prometheus
```

Network grants the `host` principal `network.operator.alert` (Network `server/identity/principals.js`), and the
relay uses the same credentials as release notifications, from `/etc/openvibe/host.env`.
