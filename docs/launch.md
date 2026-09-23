# Launching Stage B at openvibe.host

This is the launch release the [Launch rule](../README.md#launch-rule) describes. One change window:

- `*.openvibe.host` starts serving tenant sites;
- `openvibe.host` switches from the OpenVibe.Sites placeholder to the Host dashboard;
- the interim tenants-pending vhost goes;
- the domain leaves `OpenVibe.Sites/sites.json`;
- the Network registry says Host is live.

**Nothing here has been done.** The launch needs the owner's go and the checks below.

The readiness evidence is in [Launch readiness](#launch-readiness-2026-09-23) at the end of this
file, and the threat review is in [threat-review.md](threat-review.md).

## Before the window

State on 2026-09-23 (audit of 18:15 UTC, not re-checked here):

- The Host API runs on the host on loopback `:4910` with `/api/ready` 200, and 0 projects.
- `openvibe.host` is served by the Sites placeholder vhost `/etc/nginx/sites-available/openvibe.host.conf`
  (root `/opt/openvibe.sites/dist/openvibe.host`).
- `/etc/nginx/sites-available/openvibe.host-tenants-pending.conf` answers every `*.openvibe.host`
  with a 404.
- The wildcard certificate `/etc/letsencrypt/live/openvibe.host/` expires 2026-12-17.
- `*.openvibe.host` is proxied by Cloudflare; `cname.openvibe.host` is DNS-only.

Prepare these commits, pushed but **not deployed**:

1. **OpenVibe.Host:** this branch (`1e48cb2` and later): takedowns, bounded uploads, the disk floor,
   realip headers, `--install` removing the pending vhost, robots/sitemap.
2. **OpenVibe.Sites:** remove `openvibe.host`, the way `d3b71af` removed `openvibe.codes`:
   - delete the `openvibe.host` entry from `sites.json`;
   - run `node build.js`;
   - commit the removal of `deploy/nginx/openvibe.host.conf` and `dist/openvibe.host/`, and the
     one-line cross-link change in every other `dist/*/index.html`;
   - adjust `test/build.test.js` if it counts sites.

   `npm test` must pass. **Do not run Sites' `deploy.sh` until step 4.** Until this commit is pulled
   on the host, a Sites deploy would put its placeholder vhost back over Host's (same file name).
3. **OpenVibe.Network:** flip the exposure overlay.
   - `server/registry/exposure.js`: change `host: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER }`
     to `host: { state: 'live', public_site: 'service', note: 'dashboard and API at openvibe.host; tenant sites at <site>.openvibe.host' }`.
   - `test/registry-exposure.test.js`:
     - `PINNED.host = 'live'`;
     - remove `'host'` from `PLACEHOLDER_DOMAINS` and from the list of ids that must be `soon`;
     - add `'host'` to the expected `open` nav ids, in the order `server/chrome/sites.js` lists them.

   `npm test` must pass.

Run the pre-flight on the host. Everything here is read-only; stop if any line disagrees:

```bash
sudo ovhost status host                                    # openvibe-host active, ready
curl -s http://127.0.0.1:4910/api/ready | jq '{status, failed}'
sudo ovhost validate host                                  # required env NAMES set/empty (never values), unit, port 4910, deps
sudo ovhost certs | grep -E 'openvibe\.host'               # the wildcard, valid, covers openvibe.host + *.openvibe.host
dig +short openvibe.host; dig +short x.openvibe.host; dig +short cname.openvibe.host
sudo nginx -T 2>/dev/null | grep -E 'real_ip_header|set_real_ip_from' | head -3   # realip is configured
ls -l /etc/nginx/sites-enabled/ | grep openvibe.host      # openvibe.host.conf (Sites) + openvibe.host-tenants-pending.conf
df -h /var/lib/openvibe-host-api                          # well above 5 GiB free (HOST_MIN_FREE_BYTES)
curl -s https://openvibe.network/.well-known/openvibe | jq '.services[] | select(.id=="host")'
```

`/etc/openvibe/host.env` must have, by name (see `.env.example`):

- `BASE_URL=https://openvibe.host`
- `HOST_SITES_DOMAIN=openvibe.host`
- `HOST_CNAME_TARGET=cname.openvibe.host` (the DNS-only name; custom domains cannot CNAME to a
  proxied name)
- `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID=host` and a non-empty
  `OV_OAUTH_CLIENT_SECRET`
- a non-empty `HOST_FORM_SECRET`
- `EVENTS_URL`
- `TRUST_PROXY=1` or no `TRUST_PROXY` at all. Earlier copies of `.env.example` said 2. With the
  realip-only headers either value is safe, and 1 is correct.

Optionally set `HOST_MAX_PROJECTS_PER_OWNER` and lower `HOST_QUOTA_STORAGE_BYTES` for the first
weeks.

Save what the launch replaces, so the rollback is a copy:

```bash
B=/root/host-launch-$(date -u +%Y%m%d-%H%M%S); sudo mkdir -m 700 "$B"
sudo cp -a /etc/nginx/sites-available/openvibe.host.conf /etc/nginx/sites-available/openvibe.host-tenants-pending.conf "$B"/
sudo ovhost backup host
echo "$B"
```

**Optional step 0 (host-wide, reviewed separately).** This addresses a threat-review finding:
unverified custom domains reach nginx's default server. If `sudo nginx -T | grep default_server`
shows no catch-all, add one before tenants can point domains at the host. Test it with
`curl -sk --resolve nobody.example:443:127.0.0.1 https://nobody.example/`, which should fail the
handshake.

```nginx
server { listen 80 default_server; listen [::]:80 default_server; server_name _; return 444; }
server { listen 443 ssl default_server; listen [::]:443 ssl default_server; server_name _; ssl_reject_handshake on; }
```

## The window (in this order)

**1. Update the `ovhost` CLI, which carries `replaces` and the templates.**

```bash
sudo git -C /usr/local/lib/openvibe-host -c safe.directory=/usr/local/lib/openvibe-host pull --ff-only
sudo ovhost show host        # nginx.tenants in /etc/openvibe/host.json: keep "replaces": ["openvibe.host-tenants-pending.conf"] (also the default)
```

**2. Deploy the Host API code.** Nobody uses it yet, and this is also the first real `ovhost deploy`:

```bash
sudo ovhost plan host
sudo ovhost deploy host      # restarts openvibe-host only, polls /api/ready, rolls back by itself if not ready
curl -s http://127.0.0.1:4910/api/ready | jq '.checks'            # includes disk_headroom
curl -s -H 'Host: openvibe.host' http://127.0.0.1:4910/robots.txt  # Allow: /$ … Sitemap: https://openvibe.host/sitemap.xml
```

If the pre-flight changed `/etc/openvibe/host.env`, run `sudo systemctl restart openvibe-host` and
check readiness again.

**3. Install the tenant vhost, and remove the pending vhost in the same change.**

```bash
sudo ovhost nginx tenants host             # review: openvibe.host.conf + openvibe.host-custom-domains.conf;
                                           # "--install also removes … openvibe.host-tenants-pending.conf"
sudo ovhost nginx tenants host --install   # writes both, removes the pending vhost, ONE nginx -t, ONE reload;
                                           # a failed nginx -t restores all three files and reloads nothing
ls -l /etc/nginx/sites-enabled/ | grep openvibe.host   # openvibe.host.conf, openvibe.host-custom-domains.conf; no pending
```

`openvibe.host.conf` replaces the Sites placeholder vhost of the same name. The previous copy is in
`$B`.

**4. Sites.** Pull the commit that removed `openvibe.host`, then deploy. `deploy.sh` installs only
the vhosts still in the repository, so it never touches `openvibe.host.conf` again:

```bash
sudo -u ubuntu git -C /opt/openvibe.sites pull --ff-only
/opt/openvibe.sites/deploy/scripts/deploy.sh
```

**5. The Network registry.** Deploy the exposure commit the way Network is normally deployed (pull,
restart `openvibe-network`, poll `/api/ready`).

**6. Host's own records.** In a follow-up Host commit, set README **Status**, `STATUS.json`
(`"deployed"`, `"placeholderInSites": false`) and the Launch rule note to *launched on <date>*.

**Contracts** (no runtime effect, whenever the next release is cut): in
`manifests/capabilities/host.site.manage.json`, add the takedown routes and sentence from this
repository's `docs/capabilities-proposal/host.site.manage.json`:

- `POST /api/v1/projects/:id/takedown`
- `DELETE /api/v1/projects/:id/takedown`
- `POST /api/v1/sites/:id/takedown`
- `DELETE /api/v1/sites/:id/takedown`

Optionally add payload schemas `contracts/events/payloads/host.deploy.created|activated|failed.v1.json`
and `host.domain.verified.v1.json`, from the payloads in README [Events](../README.md#events).

## Verify

```bash
# The dashboard, not the placeholder
curl -s https://openvibe.host/ | grep -c 'Sign in with OpenVibe'          # 1
curl -s https://openvibe.host/ | grep -ci 'this page is a placeholder'     # 0
curl -s https://openvibe.host/ | grep -o '<meta name="robots"[^>]*>'       # index, follow
curl -s https://openvibe.host/robots.txt; curl -s https://openvibe.host/sitemap.xml
curl -s https://openvibe.host/api/health; curl -s https://openvibe.host/api/ready | jq .status
curl -s -o /dev/null -w '%{http_code}\n' https://openvibe.host/metrics     # 404
curl -sI https://www.openvibe.host/some/path | grep -i '^location'         # https://openvibe.host/some/path
# Tenant zone: Host answers, the pending vhost is gone
curl -s https://no-such-site-xyz.openvibe.host/                            # "Unknown host: no site is served at this address."
curl -s -X POST https://no-such-site-xyz.openvibe.host/ -o /dev/null -w '%{http_code}\n'   # 403 (nginx: GET/HEAD only)
# Everything else unchanged
for u in https://openvibe.live/api/ready https://openvibe.network/api/ready https://openvibe.codes/ https://openvibe.news/; do curl -s -o /dev/null -w "%{http_code} $u\n" "$u"; done
# Registry
curl -s https://openvibe.network/.well-known/openvibe | jq '.services[] | select(.id=="host") | {status, exposure}'
curl -s https://openvibe.network/api/v1/status | jq '.services[] | select(.id=="host")'
```

Then run one real tenant deploy and an isolation check in production (audit item 9), in a browser
signed in as an ordinary account:

1. At `https://openvibe.host/`, create a **sandbox** project `launch-smoke` and a site
   `launch-smoke-<yyyymmdd>`. Upload a folder with an `index.html` and a `secret.html`.
2. Check the site:
   - `curl -sI https://launch-smoke-<yyyymmdd>.openvibe.host/` returns 200, `x-robots-tag: noindex`,
     a CSP and no `set-cookie`;
   - `curl -s https://launch-smoke-<yyyymmdd>.openvibe.host/secret.html` returns the file.
3. With a second account, create a second sandbox site. From it:
   - `curl -s --path-as-is https://<second>.openvibe.host/../secret.html` returns 404;
   - `curl -s 'https://<second>.openvibe.host/%2e%2e/secret.html'` returns 404;
   - `curl -s --path-as-is https://<second>.openvibe.host/../../host.db` returns 404;
   - neither answer contains the first site's content.
4. As the second account, `GET https://openvibe.host/api/v1/sites/<first site id>` with its Bearer
   token returns 404.
5. As staff:
   - `POST /api/v1/sites/<first>/takedown` with `{"reason":"launch smoke"}`, then the site answers
     451 with `clear-site-data`;
   - `DELETE …/takedown`, and it serves again;
   - delete both sandbox projects.
6. Record the result in a row in [restore-drills.md](restore-drills.md)'s style, or in the launch
   commit message.

## Roll back

The rollback restores the old state in this order. Each step is independent and takes seconds.

**1. nginx.** Put the placeholder and the pending vhost back, and remove the tenant vhosts:

```bash
B=/root/host-launch-<stamp>
sudo install -m 644 "$B/openvibe.host.conf" /etc/nginx/sites-available/openvibe.host.conf
sudo install -m 644 "$B/openvibe.host-tenants-pending.conf" /etc/nginx/sites-available/openvibe.host-tenants-pending.conf
sudo ln -sf /etc/nginx/sites-available/openvibe.host-tenants-pending.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/openvibe.host-custom-domains.conf /etc/nginx/sites-available/openvibe.host-custom-domains.conf
sudo nginx -t && sudo systemctl reload nginx
curl -s https://openvibe.host/ | grep -ci 'placeholder'          # ≥ 1 once Sites' dist/openvibe.host is back (step 2)
```

**2. Sites.** Revert the removal commit, then pull and run `deploy.sh`. This rebuilds
`dist/openvibe.host` and reinstalls `deploy/nginx/openvibe.host.conf`, the same file as `$B`'s.

**3. Network.** Revert the exposure commit and deploy it.

**4. Host API code, only if the code is the problem.** Run `sudo ovhost rollback host`. It goes to
the release before the launch deploy (release log) and restarts `openvibe-host` only.

Tenant data needs no rollback. Projects, deploys and objects stay in `host.db` and the object store,
and they serve again at the next launch. If tenants existed during the window, tell them their sites
are paused.

## Launch readiness (2026-09-23)

Each launch-rule item, checked against the code at this commit:

| # | Launch-rule item | Evidence | Verdict |
|---|---|---|---|
| 1 | Owning runtime with health/readiness and observability | `server/index.js` + `deploy/systemd/openvibe-host.service`. `GET /api/health`, `/api/ready` (`server/observability.js`: required `db`, `storage`; optional `disk_headroom`, `network_jwks`, `events_relay`, `domain_checks`), `/release.json`, `/metrics` (loopback only; HTTP golden signals, process, release, `host_sites`). Running on loopback `:4910` with ready 200 (audit, 2026-09-23). `host-secrets-dashboard` "machine endpoints". | **met** |
| 2 | Canonical identity (Network subjects, scoped principals) | Network SSO OAuth client `host` (Network `server/db/database.js:516`); users are `usr_` subjects from Network JWTs verified against the JWKS (`server/auth/viewer.js`); services present client-credentials tokens for audience `openvibe.host` with one capability per route; `X-OV-Subject` for first-party services only; app principals act as themselves; sandbox tokens refused on production. Principal `svc:host` has `events.event.publish` (Network `server/identity/principals.js:100`). `host-quota-auth` tests. Projects are Host's own until Network has projects (ADR-014, documented). | **met** |
| 3 | SSR/static public routes useful without JS | Every dashboard page is server-rendered; every action is a plain form, including folder upload. Shared chrome with `<noscript>` nav and SSR footer. Legal pages. Tenant sites are static by definition. `host-secrets-dashboard` "signed-out home page … useful without JavaScript". | **met** |
| 4 | Real persistence and end-to-end workflows | SQLite `host.db` (WAL) plus the content-addressed object store; upload → validate → store → activate → serve → rollback → delete, custom domains through verification and lapse, all over HTTP in the tests (`host-lifecycle`, `host-rollback`, `host-domains`). `host.db` is in `ovhost backup` and the restore drill passed on the host (2026-09-23). Objects are not backed up (accepted for alpha, threat review §6). | **met** (objects backup: follow-up) |
| 5 | Capability and event registration against Contracts | `host.site.manage`, `host.deploy.create` and `host.domain.manage` and the `host` service manifest (with all four `host.*` events in `eventsProduced`) are released in `openvibe-contracts` **v0.24.0**, which Host pins, and are identical in **v0.30.1** (checked against the tag: every field matches `docs/capabilities-proposal/` as of `8575c91`). `npx openvibe-contracts-check --service host` passes, and CI runs it as a blocking step. Missing from the release: the four takedown routes in `host.site.manage.implementedBy` (this change; the exact addition is under *Contracts* above). No `host.*` payload schemas: optional, most services have none. | **met** (Contracts follow-up for takedown routes) |
| 6a | Migration/seed strategy | Bootstrap, not migration: Host replaces no legacy data (roadmap §8 register). The schema is created idempotently at every boot (`server/db.js`, `CREATE … IF NOT EXISTS`); `host_takedowns` is additive and appears on the next restart. There is no seed: a new database is an empty, valid Host. The pointer and data survive a restart (`host-rollback`). A future non-additive change needs a migration ledger, which Host does not have yet. | **met** |
| 6b | Security/threat review | [threat-review.md](threat-review.md): tenant isolation, uploads, custom domains, cookies, the PSL decision, quotas, abuse and takedown, Host's own surface. Seven gaps were fixed in `1e48cb2` and `0ff29d5`: takedowns, the upload concurrency cap, the CA-validation path refusal, the CDN cache cap, the realip templates, the disk floor with the owner project cap, and Clear-Site-Data. | **met** |
| 6c | Sitemap/robots/feed behaviour | Dashboard host: `/robots.txt` allows `/` and the legal pages and names `/sitemap.xml`; the signed-out front page is `index, follow` with a canonical URL; everything behind sign-in is `noindex` and `private, no-store`. Tenant sites: their own uploaded `robots.txt`/`sitemap.xml`; sandbox projects get `X-Robots-Tag: noindex`. No feed: a hosting control plane publishes no stream of public items, and tenants publish their own feeds. | **met** |
| 7 | Acceptance tests | `npm test` (20 files). Stage B: `host-isolation`, `host-uploads`, `host-quota-auth`, `host-rollback`, `host-domains`, `host-secrets-dashboard`, `host-lifecycle`, `host-contracts-events`, `host-abuse`, `nginx-tenants`. The exit criterion "a hosted static project cannot read another tenant's objects" is `host-isolation` (path, Host header, CORS, oracles, delegation, dashboard) plus `host-abuse` (CA paths). | **met** in CI; the production isolation check is part of *Verify* |

**Verdict: ready to launch** through the steps above, once the owner says go. Nothing in the code
blocks it. Before or at launch the owner must:

- **confirm the abuse contact:** `https://openvibe.host/dmca` names `dmca@openvibe.live`, which must
  be monitored for Host reports, with a named person to act on them;
- **accept the alpha limits**, or ask for the follow-ups first:
  - tenant objects are not backed up;
  - no Public Suffix List listing, so cookie bombs across tenants remain possible;
- optionally, **approve the host-wide catch-all `default_server`** (step 0). Without it, custom domains
  that are not yet verified reach whatever site nginx treats as default.

The D41 production proof (`scripts/d41-proof.sh`, [d41-proof.md](d41-proof.md)) is a separate Wave 21
exit item and is not required by the launch rule.
