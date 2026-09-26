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

## The release UX check

`ovhost browser-watch --sites live` (openvibe-browsercheck.timer, every 5 minutes) reads each watched site's
`/release.json`. For a release it has not checked yet, or once a day, it runs
[scripts/browser-check.js](../scripts/browser-check.js) in Chrome as the unprivileged `ovcheck` account (never
root): routes × widths, console errors, overflow, duplicate scripts, no-JS content, axe, navigation growth.

- **Confirmation**: a failure is re-run once before it counts.
- **Outcome**: the result is kept in `/var/lib/openvibe-host/browser-watch/<site>.json` and written to
  `openvibe_browsercheck.prom`.
- **Paging**: `OpenVibeBrowserCheckFailed` (severity page) pages through the relay, naming the release and the
  number of failing checks.
- **Runs that never finish**: a run that broke (exit 2, e.g. Chrome missing) records nothing and is retried
  on the next tick, and `OpenVibeBrowserCheckMissed` notices a site with no finished check for 26 hours.
- **Cost**: a check of openvibe.live takes about a minute on the host.
- **Setup**: Chrome comes from Google's apt repository (`google-chrome-stable`, updated with the system), and
  `ovcheck` is a system account whose home is `/var/lib/ovcheck`.

To watch more sites, add them to `--sites` in the unit.

## Commands

```bash
sudo ovhost alerts relay --dry-run   # what is firing, nothing sent
sudo ovhost alerts relay             # deliver now
sudo ovhost browser-watch --sites live --force   # check the current release now
systemctl list-timers openvibe-alerts.timer
```

## Install (once)

```bash
sudo cp /usr/local/lib/openvibe-host/deploy/systemd/openvibe-alerts.{service,timer} /etc/systemd/system/
sudo cp /usr/local/lib/openvibe-host/deploy/systemd/openvibe-browsercheck.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-alerts.timer openvibe-browsercheck.timer
# Chrome and the check account (once):
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update && sudo apt-get install -y google-chrome-stable
sudo useradd --system --home-dir /var/lib/ovcheck --create-home --shell /usr/sbin/nologin ovcheck
sudo cp /usr/local/lib/openvibe-host/deploy/prometheus/openvibe-rules.yml /etc/prometheus/rules/openvibe.yml
sudo promtool check rules /etc/prometheus/rules/openvibe.yml && sudo systemctl reload prometheus
```

Network grants the `host` principal `network.operator.alert` (Network `server/identity/principals.js`), and the
relay uses the same credentials as release notifications, from `/etc/openvibe/host.env`.
