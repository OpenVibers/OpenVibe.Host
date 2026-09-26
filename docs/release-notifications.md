# Release notifications (`host.deploy.activated`)

Roadmap WS-P task 9, ADR-016 (active client updates). When a network service's release goes live,
Host publishes one `host.deploy.activated` event to OpenVibe.Events. The event has visibility
**public** and subject `{ type: "release", id: "<service>:<release>" }`. Open tabs run
`openvibe-shared/release-watch.js` (1.17.0 and later) and listen for it on the Events realtime stream.
When the event names their service, they check `/release.json` within about 20 seconds instead of
at their next 10-minute poll. The event carries identifiers only.

| Payload field | Value |
|---|---|
| `service` | The service id the pages' `/release.json` names (`live`, `tools`, a Sites placeholder's id such as `news`) |
| `release` | The release id `/release.json` reports, 7–40 hex characters |
| `commit` | The deployed commit when known and the release is its prefix, else `null` |
| `origin` | The public origin (`https://openvibe.live`), or `null` |
| `deployed_at` | When Host announced it |
| `components` | Optional: the manifest's `{ name: { kind, version } }` |
| `rollback` | Optional: `true` after `ovhost rollback` |

The payload contract is `host.deploy.activated@1` in openvibe-contracts 0.58.0. The same event type also
covers Stage B tenant activations, which use subject `deploy`, a different payload and visibility
`internal`, so browsers never receive them.

## Who announces

- `ovhost deploy <service>` and `ovhost rollback <service>` announce after a deploy that went live
  (result `deployed` or `rolled-back`, exit 0). `--no-announce` skips it.
- Services deployed by their own scripts call `ovhost announce <service>` at the end:
  - Live: `deploy/scripts/deploy.sh`.
  - Tools: `deploy/scripts/deploy.sh`.
  - Sites: `deploy/scripts/deploy.sh`, one call per placeholder with `--release` and `--origin`.

  OpenRe and Games can do the same by hand or in their scripts. The scripts do nothing if `ovhost` is
  missing or has no `announce`, and a failed announcement never fails the deploy.

`ovhost announce <service> [--release <id>] [--commit <sha>] [--origin <url>] [--force] [--dry-run] [--events-env <file>] [--json]`

- **Release:** `--release`, else what the service's loopback `/release.json` reports (at the origin of its
  inventory ready URL, with the ready headers), else the checkout's HEAD (12 hex). A service that
  is not in the inventory needs `--release`.
- **Origin:** `--origin`, else the inventory entry's `origin`, else the service manifest's
  `publicOrigin` in the installed openvibe-contracts.
- **Once per release.** `<stateDir>/announced/<service>.json` remembers the last release sent, and the
  same release is not sent again. `--force` sends it again as a new event.
- **Best effort.** The token request and the publish time out after 2.5 s each. A failed publish is
  retried once with the same `event_id`, and Events stores it once. The whole announcement takes 6 s at
  most.
- **Exit codes:** `0` sent, already sent, or dry run. `1` usage error, or credentials not configured.
  `2` publishing failed. `--dry-run` prints the envelope and needs no credentials.

## Credentials

Host publishes as its Network service principal: OAuth client **`host`** (`svc:host`), grant
`events.event.publish` on audience `openvibe.events`. This is the client the Stage B Host API already
uses, and Network seeds the grant from `DEFAULT_GRANTS`
(`server/identity/principals.js`: `['host', 'events.event.publish', 'openvibe.events', []]`).

ovhost reads these names (never printed, logged or stored) from the first file that is set:
`--events-env`, then `$OVHOST_EVENTS_ENV`, then the inventory's `events.envFile`, then
**`/etc/openvibe/host.env`** (the Host API's env file).

| Name | |
|---|---|
| `OV_OAUTH_CLIENT_ID` | default `host` |
| `OV_OAUTH_CLIENT_SECRET` | required |
| `EVENTS_URL` | required, e.g. `http://127.0.0.1:4300` (plain http only on loopback) |
| `OV_NETWORK_INTERNAL_URL` | default `http://127.0.0.1:4000`. The token endpoint is `<it>/oauth/token` |

If the file or a required name is missing, the announcement is skipped. An `ovhost deploy` logs one line
and carries on, and `ovhost announce` exits 1.

## Provisioning on the host (for the lead)

All commands run on the production host. None of them prints a secret.

1. **Is the `host` client there?** Network seeds it at boot, with a secret that only its database holds.
   ```
   cd /opt/openvibe.network && sudo node server/setup/service-principal.js list | grep -E '^host\s'
   ```
   Expect `host	site	OpenVibe.Host`. It is listed as `site` because it has the dashboard's redirect
   URI; client_credentials works for it all the same. If the line is missing, create the client instead of rotating it in step 2:
   `sudo node server/setup/service-principal.js create host --env-file /etc/openvibe/host.env`.
2. **Does Host's env file already hold its secret?** It does if the Host API was set up with one. The
   first command counts matching lines and never prints a value.
   ```
   sudo grep -c '^OV_OAUTH_CLIENT_SECRET=.' /etc/openvibe/host.env
   ```
   If it prints `0`, or the file does not exist, write a fresh secret into it:
   ```
   cd /opt/openvibe.network && sudo node server/setup/service-principal.js rotate host --env-file /etc/openvibe/host.env
   sudo systemctl restart openvibe-host
   ```
   Rotating changes the secret the running Host API uses, so restart it afterwards. The script writes
   `OV_OAUTH_CLIENT_ID=host` and `OV_OAUTH_CLIENT_SECRET=…` with mode 0600.
3. **Events and Network URLs** in the same file, if they are absent (again, a count only):
   ```
   sudo grep -cE '^(EVENTS_URL|OV_NETWORK_INTERNAL_URL)=.' /etc/openvibe/host.env
   ```
   If the count is below 2, add the missing lines with `sudoedit /etc/openvibe/host.env`:
   `EVENTS_URL=http://127.0.0.1:4300` and `OV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000`.
4. **The grant.** It is a default grant, so a Network boot since 2026-09-23 has it. Check as the owner in
   the Network admin, `GET https://openvibe.network/api/admin/grants?client=host`, where it shows as
   active. Or check the database directly:
   ```
   cd /opt/openvibe.network && sudo sqlite3 data/network.db "SELECT capability, audience, revoked_at FROM principal_grants WHERE client_id='host'"
   ```
   Expect `events.event.publish|openvibe.events|` (not revoked). If it is missing, grant it in the
   admin: `POST /api/admin/grants { client_id: "host", capability: "events.event.publish", reason: "release notifications (WS-P 9)" }`.
5. **Events accepts `host` as a source and serves public events to signed-out browsers.** This is
   the default: `host` is in `DEFAULT_SOURCES`, and `REALTIME_ALLOW_ANONYMOUS` is not `false`. Check
   that `/etc/openvibe/events.env` does not override either one. Each count below should be 0:
   ```
   sudo grep -c '^EVENTS_SOURCE_PREFIXES=' /etc/openvibe/events.env
   sudo grep -c '^REALTIME_ALLOW_ANONYMOUS=false' /etc/openvibe/events.env
   ```
   A site outside `https://*.openvibe.*` (for example openre.stream) only gets the realtime stream if
   its origin is in Events' `REALTIME_CORS_ORIGINS`. Otherwise its tabs back off and keep polling.
6. **Update ovhost** to this release. The CLI is the checkout `/usr/local/bin/ovhost` points into
   (`readlink -f /usr/local/bin/ovhost`):
   ```
   cd "$(dirname "$(dirname "$(readlink -f /usr/local/bin/ovhost)")")" && sudo git pull --ff-only
   ovhost --help | grep -q 'announce <service>' && echo "announce available"
   ```
   No dependency changed.

## Before a site pins openvibe-shared 1.17.0

The tab's EventSource is subject to the site's Content-Security-Policy, so `connect-src` must allow
`https://events.openvibe.network`. As of 2026-09-26, Live and Community allow it. Network, Wiki, Blog, Codes,
Search, Reviews, VIP, Tips, Host (Stage B dashboard), News, Deals and Coupons do not. Without it, the
browser refuses the stream and logs one CSP error per page load (the browser check counts it).
release-watch then stops, with state `blocked`, and keeps polling. Add the origin in the same change that
moves the pin, or set `data-events="off"` on the `ov-release` meta tag.

## Verifying end to end

1. Subscribe the way a signed-out browser does, from any machine:
   ```
   curl -N 'https://events.openvibe.network/realtime/stream?topics=host.deploy.activated'
   ```
   The stream starts with `retry: 3000` and `: connected anonymous`, then sends a `: hb` comment every
   25 s.
2. On the host, see what would be sent:
   `sudo ovhost announce live --dry-run`. It prints the release from Live's `/release.json` and the
   envelope. Then send it:
   `sudo ovhost announce live --force`
   ```
   [ovhost] release notification sent: live 1a2b3c4d (from /release.json) as evt_01… (seq 12345)
   ```
3. The subscriber prints
   `id: 12345` / `data: {"seq":12345,"event":{"event_type":"host.deploy.activated",…,"visibility":"public","subject":{"type":"release","id":"live:1a2b3c4d"},"payload":{"service":"live",…}}}`.
4. In a browser on a site that pins openvibe-shared 1.17.0 or later, run `OVRelease.state().realtime` in
   the console. It shows `{ state: 'open', service: 'live', events: 1, … }` after the announcement.
   An `--force` of the release the tab already runs is ignored (`ignored: 1`).

On failure: `token: HTTP 401 invalid_client` means the secret in the file does not match Network
(step 2). `token: HTTP 400 invalid_scope` means the grant is missing (step 4). `publish: HTTP 403 …`
means Events refused the source or the type (step 5). `ECONNREFUSED` means a wrong URL in the file
(step 3).
