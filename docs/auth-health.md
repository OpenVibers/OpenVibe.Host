# Sign-in canary

A canary for every OpenVibe site's sign-in, on the production host. On 2026-10-29 openvibe.cam's OAuth
client secret was the `.env.example` placeholder for two days: nobody could sign in, and nothing noticed.
This notices.

Sites on openvibe-sdk 0.73.0 or later answer `GET /auth/health` (`src/sso/index.js`, `handlers.health`):
they make one token request with a code no sign-in ever has, and read which way the Network refuses it.
`invalid_grant` means the client is fine, `invalid_client` that its id or secret is wrong. The answer is
cached for ten minutes in the site's process.

| Answer | Means | Metric |
|---|---|---|
| 200 | the Network accepts the site's OAuth client | `openvibe_auth_health{site="<id>"} 1` |
| 503 | the Network refuses it (a wrong `OV_OAUTH_CLIENT_SECRET` or `OV_OAUTH_CLIENT_ID`) | `openvibe_auth_health{site="<id>"} 0` |
| any other status (a 500, a 502, a redirect), or no answer at all | a broken site or a broken path, not a healthy one | `openvibe_auth_health{site="<id>"} 0` |
| 404 | the site is not on the SDK's sign-in yet: nothing to judge | no line |
| 401 | the site's own sign-in gate answered: openvibe.ai's operator console is staff-only, so `/auth/health` is never the SDK's handler there | no line |

## The run

`deploy/scripts/auth-health.sh` (openvibe-authhealth.timer, every 15 minutes) asks OpenVibe.Network's
registry (`/api/v1/registry/services`, the same list `scripts/browser-check.js` uses) for every service
with a public origin, and gets `<origin>/auth/health` with a 10 s timeout, one site at a time. It writes
node_exporter's textfile collector in one rename (`/var/lib/prometheus/node-exporter/openvibe_auth_health.prom`),
so Prometheus never reads half a file, and prints the lines it wrote.

- **The registry does not answer**: it asks up to three times, ten seconds apart (a Network release
  restarts it), then exits 2 and leaves the previous file alone. An unreadable list is not a green canary.
- **No collector directory**: it writes nothing and exits 0, so it is harmless off the host.
- **Exit code**: 0 every probed site is 1 or 404 · 1 one site is 0 · 2 the list could not be read.
- **Secrets**: it reads no env file and prints nothing from one. The metric is a site id and 0 or 1.

After a deploy, or when checking one site now:

```bash
sudo systemctl start openvibe-authhealth.service        # every site, now
sudo ovhost deploy <service>                            # a deploy is followed by the timer within 15 minutes
deploy/scripts/auth-health.sh --sites live,cam          # these sites, printing the lines
```

## The alert

`OpenVibeSignInBroken` in [deploy/prometheus/openvibe-rules.yml](../deploy/prometheus/openvibe-rules.yml)
fires on `openvibe_auth_health == 0` for 30 minutes, severity `ticket`: the owner's bell, not a push,
because the site still serves; only its sign-in is broken. It travels the usual path
([operator-alerts.md](operator-alerts.md)):

> Sign-in is broken on cam: the Network refuses its OAuth client (check OV_OAUTH_CLIENT_SECRET in its env)

The fix is the site's env file, never a change made by this check.

## Install (once)

```bash
sudo cp /usr/local/lib/openvibe-host/deploy/systemd/openvibe-authhealth.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-authhealth.timer
sudo cp /usr/local/lib/openvibe-host/deploy/prometheus/openvibe-rules.yml /etc/prometheus/rules/openvibe.yml
sudo promtool check rules /etc/prometheus/rules/openvibe.yml && sudo systemctl reload prometheus
```

The script lives in the `ovhost` CLI's own checkout (`/usr/local/lib/openvibe-host`), which
`sudo ovhost self-update` brings up to `main`; the unit runs it from there.

## What it cannot see

- A site on openvibe-sdk before 0.73.0 answers 404, and is silently outside the canary until its pin moves.
  So is a site whose own sign-in gate answers first, as openvibe.ai's staff console does (401).
- `/auth/health` tells a broken client secret from a working one. It does not finish a sign-in, so a
  broken callback URL, a Network that is down, or a site whose sessions cannot be verified still look fine.
- The check is one request per site per 15 minutes, from the host. It never signs anybody in.
