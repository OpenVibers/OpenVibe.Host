# AGENTS.md — OpenVibe.Host

## Project Overview

OpenVibe.Host is two things in one repository:

1. **The network's operator plane, `ovhost`** — a root-run CLI/library that deploys, rolls back, validates, probes,
   backs up and restore-drills every service on the host. It is installed at `/usr/local/lib/openvibe-host`
   (linked `/usr/local/bin/ovhost`) with the inventory `/etc/openvibe/host.json`; it is updated with
   `sudo ovhost self-update`, not by the catalog deploy.
2. **The `openvibe.host` catalog service** — hosting compared honestly (cloud/VPS/dedicated plans, offers, domain
   prices, benchmarks, price history, staff entries) and the console where a person connects their own hosting
   accounts. It runs at port 4910.

- **Domain:** `openvibe.host` (catalog) · **Port:** 4910 · **Service id:** `host` · **Env prefix:** `HOST`/`OV_`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9;
  plain systemd/nginx/git/ffmpeg-free host tools for the CLI.
- **Read first:** [README.md](README.md) (very long and authoritative), [docs/deploy-strategies.md](docs/deploy-strategies.md),
  [docs/backups.md](docs/backups.md), [docs/restore-drills.md](docs/restore-drills.md),
  [docs/data-provisioning.md](docs/data-provisioning.md), [host.example.json](host.example.json).

**Network context:** the catalog uses Network SSO/staff (`host.catalog.manage`), the JWKS, client-credentials for the
outbox relay and `ovhost alerts relay`, and `network.status.incident` for incidents/maintenance. The catalog's pages
are OpenVibe.Search documents; discussion is OpenVibe.Community (thread refs only); prices come from OpenVibe.Sources
(optional ingest) and keyed provider APIs. `ovhost` calls only the host's own services, Network, Events, Prometheus and
the backup bucket.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared/publishing pinned by tag)
npm run dev                    # http://localhost:4910, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js; system calls go to test/fake-host.js
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- catalog            # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
sudo ovhost --version          # the installed CLI (not this checkout, unless run as ./bin/ovhost)
sudo ovhost status [<service>...]           # units, sha, readiness, protected sessions
sudo ovhost validate <service> [--manifest <file>]   # env NAMES, units, port, vhost+nginx -t, deps, lifecycle
sudo ovhost plan <service> [--to <sha>] [--no-fetch] [--restart]
sudo ovhost deploy <service> [--wait-idle] [--force] [--restart] [--to <sha>] [--install-units]
sudo ovhost rollback <service> [--to <sha|release>] [--wait-idle] [--force]
sudo ovhost backup --all [--offsite] [--logical] | sudo ovhost drill <service> [--keep]
sudo ovhost incident|maintenance|freeze ... | sudo ovhost alerts relay | sudo ovhost self-update
```

Every command takes `--json` and `--inventory <file>`. Exit codes: `0` ok · `1` usage/precondition (held lock) · `2`
validation failed, nothing restarted · `3` not ready, rolled back and serving · `4` rollback failed, **manual
intervention** · `5` protected sessions active (or `--wait-idle` gave up) · `6` frozen (`--force` goes through;
rollbacks are never frozen).

## Architecture at a Glance

- **CLI entry:** [bin/ovhost](bin/ovhost) → [lib/cli.js](lib/cli.js), commands under [lib/commands/](lib/commands/)
  (`backup.js`, `data.js`, `drill.js`, `self-update.js`, `service-add.js`, `snapshot.js`, `status.js`, `validate.js`).
- **Operator core:** [lib/inventory.js](lib/inventory.js) (the inventory model and its refusals),
  [lib/executor.js](lib/executor.js) (deploy/rollback orchestration), [lib/systemd.js](lib/systemd.js) (the socket
  guard and `setpriv` drops), [lib/readiness.js](lib/readiness.js), [lib/probes.js](lib/probes.js) (protected
  sessions, `http-json-count`/`postgresql-count`/`sum` and `addFields` semantics), [lib/nginx.js](lib/nginx.js)
  (render + transactional install), [lib/releases.js](lib/releases.js), [lib/release-layout.js](lib/release-layout.js),
  [lib/deps.js](lib/deps.js), [lib/deploy-guard.js](lib/deploy-guard.js), [lib/lock.js](lib/lock.js),
  [lib/envfile.js](lib/envfile.js) (names/emptiness only), [lib/lifecycle.js](lib/lifecycle.js),
  [lib/dbengine.js](lib/dbengine.js), [lib/backup-crypto.js](lib/backup-crypto.js), [lib/offsite.js](lib/offsite.js),
  [lib/retention.js](lib/retention.js), [lib/alerts.js](lib/alerts.js), [lib/announce.js](lib/announce.js),
  [lib/incidents.js](lib/incidents.js), [lib/nodes.js](lib/nodes.js), [lib/media.js](lib/media.js),
  [lib/browser-watch.js](lib/browser-watch.js), [lib/dns.js](lib/dns.js), [lib/certs.js](lib/certs.js),
  [lib/commands/snapshot.js](lib/commands/snapshot.js), [lib/tar.js](lib/tar.js), [lib/archive.js](lib/archive.js).
- **Inventory:** [host.example.json](host.example.json) is the model (checkout/owner/units/socket/unitSources, env
  required names, port, loopback ready URL/headers, packages/install/build hooks, `noRestartPaths`, `protected`
  probes, drain, databases, backupOnChange, nginx, layout, workerUnits, auxiliaryUnits, objects, strategy). The real
  `/etc/openvibe/host.json` is **never committed**.
- **Catalog service:** [server/app.js](server/app.js), [server/index.js](server/index.js), [server/config.js](server/config.js),
  [server/db.js](server/db.js), [server/catalog/](server/catalog/) (`mapping.js`, `ingest.js`, `keyed-feeds.js`,
  `offers.js`, `domains.js`, `domain-check.js`, `rdap.js`, `benchmarks.js`, `community.js`, `pricing.js`, `trend.js`,
  `search-index.js`), [server/console/console.js](server/console/console.js), [server/http/](server/http/),
  [server/auth/](server/auth/) (capabilities, forms, SSO, viewer), [server/render/](server/render/),
  [server/data-sources-config.js](server/data-sources-config.js), [server/account-data.js](server/account-data.js),
  [server/worker.js](server/worker.js).
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): catalog providers/plans/promos/
  price changes/offers/domain prices/benchmarks, `host_console_accounts`/`host_console_actions`, `config_keys`/
  `config_snapshots`, `event_outbox`, `account_data_events`, `telemetry_samples`. Migration 0008 dropped the old
  static-hosting engine tables on purpose.
- **Deploy:** [deploy/systemd/openvibe-host.service](deploy/systemd/openvibe-host.service) (127.0.0.1:4910,
  `/etc/openvibe/host.env`, checkout `/opt/openvibe.host`, state `/var/lib/openvibe-host-api`) and the operator
  timers in [deploy/systemd/](deploy/systemd/) (`openvibe-backup`, `-alerts`, `-browsercheck`, `-authhealth`,
  `-readyhealth`, `-devpath`, `-toolsjob`); nginx files in [deploy/nginx/](deploy/nginx/). `sudo ovhost deploy host`
  (strategy `git-checkout`); `sudo ovhost rollback host --to <sha>`.

## Ownership and Boundaries

Host owns (a) the operator plane: inventory, env-name validation, deploy strategies, readiness/drain, release log,
certificate inventory, vhost rendering/install, config snapshots, backups/offsite/retention, restore drills, incidents,
alerts relay and release announcements; (b) the catalog: providers/plans/promotions/price history, offers, registrar
prices and domain checks, benchmarks and their one-time links, the console's sealed provider tokens and action log, the
catalog Search documents; (c) the data role and its `add-service.sh`. It does **not** own: product business logic
(calls hooks and `/api/ready`, `/api/streams`), secrets (reads env **names** and emptiness only; the sole exception is
its own root-only `/etc/openvibe/backup.env`), certificate issuance (certbot; inventory only), platform-wide credentials
for hosted code, or static hosting (moved to OpenVibe.Space on 2026-10-12; `/hosting`, `/projects*`, `/sites*`,
`/deploys*`, `/domains*`, `/preview*`, `*.openvibe.host` and the old APIs answer **410** with a link to Space).

## Catalog and Console

- **Catalog data comes only from named sources**: Sources items (`HOST_CATALOG_INGEST`, `HOST_CATALOG_SOURCES_URL`),
  keyed provider feeds (DigitalOcean/Hetzner read every six hours with a sealed read-only token from
  `host.data_sources`; env fallback `HOST_DIGITALOCEAN_TOKEN`/`HOST_HETZNER_TOKEN`), and staff entries with a source
  URL. **Nothing is estimated**: a value the source does not state is "Unknown". LightSail monthly = hourly × 744,
  IPv6-only bundles show 0 IPv4, OVH addons are joined to their product, Vultr is disabled (its API host forbids
  robots). `POST /internal/config/host.data_sources/test/:key` makes one read-only call and never returns the token.
- **Offers** from LowEndSpirit's public feed; LowEndTalk/LowEndBox feeds are off (403 to the production host). Keep
  headline/poster/date/link and a stated monthly or yearly price with its monthly equivalent; editorials/giveaways are
  not offers; a removed post is hidden; >120 days drops off; `sort=price` needs a currency and converts nothing.
- **Domains** from registrars' public price lists (Porkbun keyless; Handshake names out) with append-only change
  history; a name check asks the ending's RDAP (IANA bootstrap, https only, no redirects, 6 s, 10 min cache, 30/min
  per address) and prices the name at popular endings; each registrar's search is a plain deep link.
- **Benchmarks**: a signed-in person gets a one-time YABS link (24 h, 10/day); Host parses the JSON field by field
  (never the server's address), stores it, and never shows the submitter. They or staff may remove a result; export
  carries results and links, erasure deletes the links and leaves results anonymous.
- **Order** comes only from the visitor's sort; affiliate links are `rel="sponsored nofollow noopener"` with the
  provider's disclosure beside them and never change the order.
- **Console**: each provider token is checked when added, sealed AES-256-GCM under `HOST_CREDENTIALS_KEY` (32 bytes,
  hex/base64), never shown again (only the last four clear), opened only to call that provider, deleted on disconnect.
  Power on/off/reboot reach the provider and are logged. With no key the console connects nothing and says so.
  Account export/deletion (ADR-033) carries accounts (never tokens) + action log and erases them.
- **Discussion** uses Community thread refs `{service:'host', type:'provider'|'plan', id}` only; hidden providers and
  hidden/gone plans have no page, and status changes hide/reopen threads after commit. With no
  `HOST_COMMUNITY_URL`, no Discussion block appears.

## Operator Rules (the ones that page you)

- **Socket units are never stopped/restarted** except the release-layout rebind when the unit file changed or pid 1
  does not hold the port. Every `systemctl` call goes through the guard.
- **Protected sessions:** Live's `/api/streams`, Media's `/api/ready` counters, Events SSE, Chat sockets, Games players,
  OpenRestream ingest, Tools jobs. A probe that **cannot answer while the service runs counts as active**, never zero.
  `--wait-idle` waits for two idle checks in a row; `--force` proceeds with a warning. `null` from a service is
  unknown, so the restart is held; an `addFields` field the service does not report at all is zero (older service).
- **Tracked local changes block a deploy**; they are never discarded. One operation per service at a time (pid lock
  with stale recovery). Every attempt is in the release log, refusals included.
- **Readiness:** poll `/api/ready`; on failure restore the previous sha, reinstall dependencies if they differed,
  restart, and exit 3 (or 4 + MANUAL INTERVENTION if that fails).
- **Dependencies** must resolve (`node_modules/<dep>/package.json` parses and names the package) before anything
  restarts; install only when the lockfile/deps changed and restore `package-lock.json` if npm rewrote it.
- **nginx** changes are transactional: render, `nginx -t`, install, reload; a failed test restores the previous files
  and does not reload. Certificates are inventory only; no key file is read.
- **Secrets** never leave an env file: no value in text/JSON output, logs, snapshots or backup manifests. Backups are
  root-only (0700/0600), off-host copies AES-256-GCM encrypted and authenticated; a failed verification is `failed`,
  never `skipped`.
- **Restore drills** check the dump, restore into a scratch database/role, start a sandboxed second instance, compare
  declared HTTP paths and row counts, then stop it and drop the scratch objects. `drill` exits 0 passed, 1 refused,
  2 failed; run as root only.
- **Inventory** must be root-owned and not group/world-writable when `ovhost` runs as root; relative paths, non-loopback
  probe URLs, non-SELECT probe queries and vhost names with a path are refused. `workerUnits` are never started/stopped
  by ovhost; `auxiliaryUnits` restart only when their `restartOn` path changed.
- **Lifecycle:** each service's Contracts manifest (≥0.55.0) supplies liveness/shutdown/drains/workers/rollback/
  contracts/leases; the inventory block may override. `validate` fails on a missing field or a deadline longer than a
  unit's stop timeout, and on a different `KillSignal`.
- **Self-update** refuses a dirty tree, a branch other than `main` or a divergence; it restarts nothing.

## Key Pitfalls

- **This repository deploys two things differently:** `sudo ovhost deploy host` replaces the catalog checkout at
  `/opt/openvibe.host`, but **not** the CLI install at `/usr/local/lib/openvibe-host`; after a merge to `main` run
  `sudo ovhost self-update` or the CLI silently runs behind.
- **Never commit `host.json`** or a real env value. `host.example.json` is the model; `service add` copies an entry
  and backs up the live inventory.
- **Stage C is not started** and Stage B's engine is gone. Do not resurrect `/projects`, `/sites`, `/deploys`,
  `/domains` or `*.openvibe.host`; they answer 410 for a reason.
- **Console tokens:** never log, return, export or snapshot a provider token; only the last four clear characters may
  appear. The export carries accounts without tokens.
- **Catalog honesty:** no estimated price, no converted currency, no affiliate-driven order, no invented benchmark
  field. A source that does not state a value is Unknown.
- **IndexNow** is off without `INDEXNOW_KEY`; a re-check at the same price sends nothing; key served at `/<key>.txt`.
- **Freeze** (`ovhost freeze`) makes deploys exit 6; rollbacks are never frozen and `--force` goes through.
- **Browser check** is report only: it never changes the exit code or the release record.
- **Boot order drop-ins** (`openvibe-.service.d/`, PgBouncer after PostgreSQL) are `unitSources` of the host service;
  `sudo ovhost validate host` reports drift and `sudo ovhost deploy host --install-units` installs them.

## Testing

`npm test` runs every file in [test/](test/) with every system call against [test/fake-host.js](test/fake-host.js):
acceptance, deploy/rollback/guard, release layouts and strategies, probes, readiness, socket guard, env
validation, nginx/certs, backups (pgBackRest/logical/offsite), drills, data provisioning/role, boot-order drop-ins,
alerts/announce/incidents, catalog (ingest, keyed feeds, offers, domains/RDAP, benchmarks, discussion, search, trends,
staff), console, account data, actor limits, CSP, engine-moved 410s, browser check/watch, DNS, nodes, inference planner,
and the deploy wrapper. `npm run test:pg` for PostgreSQL. Run the narrowest file first, then the suite; always
`node --check` changed files.

## Documentation

- [README.md](README.md) — catalog, console, static hosting moved, purpose/rules, owns, does-not-own, depends on,
  capabilities, stages, acceptance, using ovhost, inventory, deploy, installing, security, development, launch rule.
- [docs/deploy-strategies.md](docs/deploy-strategies.md), [docs/backups.md](docs/backups.md),
  [docs/restore-drills.md](docs/restore-drills.md), [docs/data-provisioning.md](docs/data-provisioning.md),
  [docs/db-inventory.md](docs/db-inventory.md), [docs/browser-check.md](docs/browser-check.md),
  [docs/release-notifications.md](docs/release-notifications.md), [docs/operator-alerts.md](docs/operator-alerts.md),
  [docs/incidents-and-dns.md](docs/incidents-and-dns.md), [docs/no-502.md](docs/no-502.md),
  [docs/ready-health.md](docs/ready-health.md), [docs/host-firewall.md](docs/host-firewall.md),
  [docs/threat-review.md](docs/threat-review.md), [docs/launch.md](docs/launch.md), [docs/developer-path.md](docs/developer-path.md).
- [SECURITY.md](SECURITY.md), [host.example.json](host.example.json).
