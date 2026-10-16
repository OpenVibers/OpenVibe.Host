# OpenVibe.Host

> Hosting, compared honestly: plans side by side with dated, sourced prices. And the network's operator plane, `ovhost`.

**Status:** alpha. Stage A (operator plane) is a CLI, `ovhost`, tested against a fake host. It is installed on the production host at `/usr/local/bin/ovhost` with inventory `/etc/openvibe/host.json`; it deploys services, runs nightly backups, and performs restore drills. Repository deploy scripts are thin wrappers around `ovhost deploy|rollback|plan`: [docs/deploy-strategies.md](docs/deploy-strategies.md). The Host service on port 4910 serves the hosting comparison catalog at openvibe.host. Stage B (tenant static hosting) **moved to OpenVibe.Space on 2026-10-12** (see [Static hosting moved](#static-hosting-moved)). Stage C (sandboxed user code) is **not started**.
**Domain:** `openvibe.host` (the catalog). `*.openvibe.host` served Stage B's tenant sites; any request there now answers 410 with a link to OpenVibe.Space.
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.3 and §15.17; roadmap Wave 21; T20 (Host, Space and Community re-split, 2026-10-08).
**License:** AGPL-3.0 (same as every OpenVibe service).

## The hosting catalog (openvibe.host's front page)

Plan T20 step 3 (owner, 2026-10-08): openvibe.host is **hosting compared**: a modern LowEndBox with honest data. The signed-out front page and `/catalog` compare cloud, VPS and dedicated plans side by side:
- price per month, per vCPU and per GB of RAM and disk;
- the day each price was checked, and a link to its source;
- price changes kept as a history per plan.

OpenVibe's own static hosting moved to OpenVibe.Space ([below](#static-hosting-moved)); the front page links it in one line.

- **Where plans come from.**
  - OpenVibe.Sources items in category `hosting` (official provider APIs), read with `openvibe-publishing/ingest`: an event consumer at `/internal/catalog/events` plus a cursor pull. The switch is `HOST_CATALOG_INGEST` (default off) with `HOST_CATALOG_SOURCES_URL`.
  - The mapping is `server/catalog/mapping.js`, keyed by source: `linode-types`, `aws-lightsail-bundles` and `vultr-plans`.
    Lightsail's price list gives numbers as text and prices by the hour; a bundle's monthly price is its hourly rate for
    744 hours (AWS bills up to that cap), and IPv6-only bundles show 0 IPv4 addresses. Vultr's API host disallows
    robots, so that Sources seed stays disabled.
  - Staff entries, which must name their source URL.
  - Nothing is estimated. A value the source does not state is shown as Unknown.
- **Offers** (`/catalog/offers`, `GET /api/v1/catalog/offers`, a block on the front page). What providers post on LowEndTalk's Offers board and LowEndBox's offer posts, from their public feeds through Sources (`lowendtalk-offers`, `lowendbox-posts`; `server/catalog/offers.js`). Host keeps the headline, poster, date and link, and the cheapest "per month" or "per year" price the headline (or the post's opening) states, as stated, with its monthly equivalent (a yearly price divided by 12). LowEndBox editorials and giveaways are not offers; a post the source removes is hidden; offers older than 120 days drop off. Newest first, or cheapest a month within one currency (`sort=price` needs `currency`: nothing is converted); filters `currency`, `max_monthly`, `source`, `priced=1`.
- **Domains** (`/catalog/domains`, `/catalog/domains/:tld`, `/catalog/domains/check?name=`, a block on the front page; `GET /api/v1/catalog/domains`, `/domains/:tld`, `/domains/check?name=`). What registrars charge for each ending (the owner's "like tld-list.com"): the first year, a renewal, a transfer and five years added up (the first year and four renewals at one registrar), with a mark where the renewal is more than a fifth above the first year. Prices come from registrars' public price lists through Sources (`porkbun-tld-pricing`, Porkbun's documented keyless list, `server/catalog/domains.js`; Handshake names are left out) into `catalog_tld_prices` (migration 0011) with an append-only change history; the registrar is a catalog provider. Endings sort popular first, by first year, renewal, five years or A to Z, and filter by ending and kind (generic, country code, second level, internationalized). A name check (`server/catalog/domain-check.js`) reads what was typed (a URL, a bare label checked as .com, the longest priced suffix as the ending), asks the ending's registry over RDAP (`server/catalog/rdap.js`: IANA's bootstrap file, https servers only, no redirects, 6 s timeout, answers cached 10 minutes, 30 checks a minute per address) and prices the same name at the popular endings; every registrar's search is a plain deep link. Before migration 0011 applies the price sections are left out and the check still works. `/domains` (static hosting's old page) redirects here.
- **Order.** It comes only from the visitor's sort: price, per vCPU, per GB of RAM, per GB of disk, or recently checked. Affiliate links carry `rel="sponsored nofollow noopener"` with the provider's own disclosure beside them, and never change the order (`test/catalog-public.test.js`).
- **Staff.** `host.catalog.manage` (Network staff only) covers `POST`/`PATCH /api/v1/catalog/{providers,plans,promos}` and the no-JS forms at `/catalog/manage`.
- **Public reads.** `GET /api/v1/catalog/plans` (filters `kind`, `min_vcpu`, `min_ram_mb`, `min_disk_gb`, `max_price`, `currency`, `location`, `provider`; `sort`; cursor), `/plans/:id` (with price history), `/providers`, `/providers/:slug` and `/promos`.
- **Search.** Every public plan and provider page is an OpenVibe.Search document (`host.index_document.upserted|deleted`, `server/catalog/search-index.js` through openvibe-publishing/search-feed): sent a minute after boot, hourly, after each catalog pull and shortly after a staff change; only changed pages are sent, and a hidden or gone entry becomes a tombstone.
- **IndexNow.** With `INDEXNOW_KEY`, a catalog pull that adds a plan or a provider, or changes a plan's price, sends those pages and `/sitemap.xml` to search engines in one batch (a re-check at the same price sends nothing); a new offer post sends `/catalog/offers`. The key is served at `/<key>.txt`.
- **Pages.** `/catalog`, `/catalog/providers`, `/catalog/providers/:slug`, `/catalog/plans/:id`, `/catalog/promos`, `/catalog/offers` and `/catalog/domains` (with each ending's page and the name check). They are server-rendered and work without JavaScript; the styles are `public/css/catalog.css`.
- **Discussion.** Active public provider and plan pages lazily resolve Community threads with refs `{ service: 'host', type: 'provider', id: provider.id }` and `{ service: 'host', type: 'plan', id: plan.id }` (plus a display label), then render recent comments with a link to the thread on OpenVibe.Community. Host stores only the thread reference. `HOST_COMMUNITY_URL` enables the internal client; `OV_COMMUNITY_URL` sets the public link. With the internal URL unset, no Discussion block appears. Hidden providers and hidden or gone plans have no public page; status changes hide or reopen existing threads after commit. Host's Network service principal needs `community.comment.write` and `community.comment.moderate` for audience `openvibe.community`.

## Static hosting moved

The static hosting engine (Stage B: projects, sites, immutable content-addressed deploys, activation and rollback, previews, Git ingest, per-site configuration, custom domains, takedowns, the resource index and the dashboard) moved to **[OpenVibe.Space](https://openvibe.space)** on 2026-10-12 (plan T20 step 2), where sites are served at `<name>.openvibe.website` under `space.*` capabilities and events (openvibe-contracts 0.149.0). Production Host had 0 projects, 0 sites and 0 deploys, so no data moved.

What is left here answers **410 Gone** with a link to Space:

| Request | Answer |
| --- | --- |
| `/hosting`, `/projects*`, `/sites*`, `/deploys*`, `/domains*`, `/preview*` | a short page linking OpenVibe.Space |
| `/api/v1/projects*`, `/api/v1/sites*`, `/api/v1/deploys*`, `/api/v1/domains*`, `/api/v1/resources*` | problem JSON `{ "code": "host.moved_to_space", "url": "https://openvibe.space" }` |
| any `*.openvibe.host` tenant host | a short page linking OpenVibe.Space |

Migration `0008_drop_hosting_engine.sql` (`-- phase: contract`, after `0007`) drops the engine's tables once the expand window has passed; the catalog's tables stay.

## Purpose

Repository deploy scripts call ovhost. Stage A applies the deploy rules for every service on the host:

| Rule | Where it came from | How `ovhost` applies it |
|---|---|---|
| Never stop `openvibe-live.socket`; restart only the service unit | Live (socket activation, `deploy/systemd`) | Every `systemctl` call goes through a guard that refuses `stop`/`restart`/`reload` on a `.socket` unit. A socket that is down gets `start`ed. The one exception is the rebind Live's script also made (`systemd.rebindSocket`, release-layout only): when the socket unit file changed or pid 1 does not hold the port, the service is stopped, the socket restarted and the service started on it. |
| Don't restart Live while anyone is live; `--wait-idle` holds the restart | Live `deploy.sh --wait-idle` (`/api/streams`) | Protected-session probe (`http-json-count`). Checked before the checkout moves and again right before the restart. |
| Don't restart Media while it is recording | Media hazard H3 (`vods-orphans/` in B2) | Protected-session probe (`postgresql-count` of Media's `SELECT count(*) FROM vods WHERE is_recording = 1`), run read-only as the postgres OS user. |
| Poll `/api/ready` after a restart; roll back if it doesn't come up | Live `deploy.sh` | Readiness poll with a timeout; on failure the checkout goes back to the previous sha, deps are reinstalled if they differed, the unit is restarted again. |
| Install only when the lockfile or dependencies changed; restore `package-lock.json` afterwards | Network `deploy.sh` and host practice | `npm install --omit=dev` as the checkout owner, then `git checkout -- package-lock.json` if npm rewrote it. |
| Every dependency must resolve before anything restarts | Tools `deploy.sh` (an emptied `file:` link crash-looped every unit) | `node_modules/<dep>/package.json` must exist, parse and name the package. A broken dependency is reinstalled once, and if it still fails the deploy aborts and the checkout is restored. |
| Build, install vhosts, `nginx -t`, reload | Sites `deploy.sh` | `build` hooks and `nginx.installOnDeploy`. Vhost installs are transactional: if `nginx -t` fails, the previous files come back and nginx is not reloaded. |
| Build a release while the old one serves; switch a symlink; roll back to a release with its own `node_modules`; pid 1 must hold the socket | Live `deploy.sh` (release layout), OpenRestream `deploy.sh release`/`api` | Strategy `release-layout` ([docs/deploy-strategies.md](docs/deploy-strategies.md)). The socket unit is restarted only when its unit file changed or systemd does not hold the port. |
| Per-app installs (not `apps/_shared`), jobs runtime and guard load before the restart, every `openvibe-tools*` unit | Tools `deploy.sh` | Strategy `multi-app`: `skipPackages`, `preflight`, `unitsMatch`, `ready.release`. |
| git as the checkout owner; never leave root-owned files under `/opt` | Community/Events/Tools checkouts | git, npm and builds run as the checkout owner; PostgreSQL dumps and probes run as the postgres OS user. |

Stage A adds a few safety rules of its own:

- A protected-session probe that **cannot answer** while the service is running counts as "sessions may be active", never as zero. Live's `deploy.sh` treated a failed `curl` as 0 live streams.
- Tracked local changes block a deploy. The script never discards them.
- One operation per service at a time, using a pid lock with stale-lock recovery.
- Every attempt goes into the release log, refusals and failures included.

## Owns

- Stage A: the host inventory (services, units, env names, ports, probes, drain policy), environment validation, release install and rollback for git-checkout services, readiness and drain orchestration, the release log, certificate inventory, nginx vhost rendering and transactional install, config snapshots, scheduled backups (pgBackRest verification and logical PostgreSQL dumps) with retention and encrypted off-host copies, restore drills.
- The hosting comparison catalog: providers, plans, price history, promotions and their sources (migrations 0005-0007), offers (0009), registrars' domain prices and their history (0011), and the catalog's Search documents (`host.index_document.*`).
- Later (Stage C): sandbox profiles, budgets, secret references, outbound policy.
- Host roles, provisioned from code so any machine can take them: the **data role** (`roles/data/`, ADR-035): PostgreSQL 18, PgBouncer, pgBackRest, Valkey and their exporters, plus `add-service.sh` giving each service its database, roles and Valkey user. `ovhost data provision <svc>` runs `add-service.sh` from the installed CLI, redacting every URL and password: [docs/data-provisioning.md](docs/data-provisioning.md).

## Does not own

- Product business logic. Host calls product hooks (`build`) and reads product endpoints (`/api/ready`, `/api/streams`). It never embeds product rules.
- Secrets. `ovhost` reads service env files only to learn variable **names** and whether each one is empty. It never stores, prints or snapshots a value. The one exception is its own `/etc/openvibe/backup.env` (root-only): it reads the `BACKUP_*` values there to reach the backup bucket, and never prints or stores them.
- Platform-wide credentials for hosted code (never).
- Certificate issuance/renewal (certbot does this today). Stage A only takes inventory;
- Static hosting: OpenVibe.Space owns it since 2026-10-12.

## Depends on

- OpenVibe.Contracts (`openvibe-contracts`, pinned below): `host.catalog.manage`, the catalog's `host.index_document.*` events, and `host.release.published` from `ovhost announce`.
- OpenVibe.Network: SSO for catalog staff, the JWKS that verifies user and service tokens, client-credentials tokens for the outbox relay and `ovhost alerts relay`.
- OpenVibe.Events: the catalog's events through the `openvibe-sdk` transactional outbox, and `ovhost announce`.
- OpenVibe.Sources (optional): price ingestion for the catalog (`HOST_CATALOG_INGEST`); OpenVibe.Search: the catalog's pages as documents; OpenVibe.Community (optional): discussion on provider and plan pages; OpenVibe.Watch: the "Tell me when this price changes" link on plan pages (a link, no call).
- `openvibe-shared` (the OpenVibe Frame, legal pages, `/release.json`, `/metrics`, `/api/ready`) and `openvibe-publishing` (ingest and the search feed).

## Capabilities

Implemented here (the service manifest's `capabilities`, audience `openvibe.host`): `host.catalog.manage`
(staff-only catalog writes: providers, plans, promotions).

Retired with the engine (OpenVibe.Space implements the `space.*` equivalents since openvibe-contracts 0.149.0;
a Contracts release retires these): capabilities `host.site.manage`, `host.site.config`, `host.deploy.create`,
`host.domain.manage`, `host.resource.read`, and events `host.deploy.created`, `host.deploy.activated`,
`host.deploy.failed`, `host.domain.verified`.

Called elsewhere, as the service principal `host` (the OAuth client `host`; `ovhost` reads the same
credentials from `/etc/openvibe/host.env`):

| Service | Grant | Used by |
|---|---|---|
| OpenVibe.Events | `events.event.publish` | the catalog's outbox (`host.index_document.*`) and `ovhost announce` (`host.release.published`) |
| OpenVibe.Network | `network.operator.alert` | `ovhost alerts relay` (Prometheus alerts that page the operator) |
| OpenVibe.Network | `network.status.incident` | `ovhost incident` and `ovhost maintenance` (the public status page) |
| OpenVibe.Community | `community.comment.write`, `community.comment.moderate` | the catalog's discussion threads |

## Stages

| Stage | Scope | State |
|---|---|---|
| **A: operator plane** | `ovhost` CLI and library: inventory, validate, plan, deploy (`--wait-idle`/`--force`), automatic rollback, rollback, status, releases, certs, nginx render/install, snapshot, backup, restore drill. No daemon and no server. Port **4910** is reserved for a later operator API. | **alpha**: written and tested (fake host, plus the real executor against temp HTTP/git). Installed on the host: deploys every service, runs the nightly backups and the restore drills. |
| **B: tenant static hosting** | Projects, sites, immutable deploys, rollback, previews, Git ingest, custom domains. | **moved to OpenVibe.Space** on 2026-10-12 (T20 step 2); old URLs here answer 410. |
| **C: sandboxed user code** | Isolation profiles, CPU/memory/time/network/storage budgets, secret references, outbound policy, metering, kill/revoke without touching platform services. | **not started**, deliberately. Blocked until isolation and metering are proven. Nothing in Stage B runs tenant code. |

Stage A also provides incident and maintenance controls (`ovhost incident|maintenance|freeze`) and release notifications (`host.release.published`). Restore drills are described in [docs/restore-drills.md](docs/restore-drills.md).

## Acceptance (Stage A)

What the tests demonstrate (`npm test`, every system call made against `test/fake-host.js`):

- A Live restart is **refused** while `/api/streams` reports a live stream. The checkout does not move, nothing is restarted, and the refusal is logged. `--wait-idle` waits for two idle checks in a row. `--force` proceeds and prints a warning. An unreachable probe counts as live.
- A Media restart is **refused** while `vods.is_recording = 1`. The query runs read-only as `ubuntu`.
- A failed readiness check **rolls back** to the previous sha, reinstalls the previous dependencies and restarts again (exit 3). If that also fails, the exit code is 4 with MANUAL INTERVENTION.
- A dependency that does not resolve **aborts before any restart** and restores the checkout (exit 2).
- Env validation **never outputs a value**, in text or JSON output.
- The socket unit is **never stopped or restarted**, in any flow, except the release-layout rebind: only when its unit file changed or systemd does not hold the port (`test/strategy-release-layout.test.js`).
- Only the service being deployed is restarted. Static-only changes (for example Live `public/`) are deployed without a restart, even while streams are live.
- `nginx -t` failures restore the previous vhost state. `certs` never reads a key file. Snapshots contain no secret values or remote-URL credentials.
- A **restore drill** checks a PostgreSQL dump with `pg_restore --list`, restores it into a scratch database and role, starts a sandboxed second instance, compares declared HTTP paths and row counts, then stops it and drops the scratch database and role.

- **Backups:**
  - `backup --all` backs up every service with databases. One failing service leaves the others backed up and exits 2.
  - A PostgreSQL service is verified, not copied: every run checks pgBackRest (newest backup within 26 h, stanza ok, `pg_stat_archiver.failed_count` not rising) and reports `verified`; a logical `pg_dump -Fc` per database is taken weekly or with `--logical`, and a **failed verification** is `failed`, never `skipped`.
  - Retention keeps the newest good backup of each of the last 7 days and 4 ISO weeks. A service whose backups keep failing never loses its last good ones. Directories ovhost did not record are never touched.
  - Every backup directory is root 0700 and every copy is root 0600, with no `-wal`/`-shm`. A copy that is a link is refused.
  - Off-host copies round-trip through AES-256-GCM. Tampering, truncation, swapped objects, a forged manifest and another key are all refused.
  - Uploads go to a mocked S3 client (PutObject, or multipart with abort on failure). Off-host pruning never runs after a failed upload and always keeps the newest 7 runs.
  - `restore-download` never overwrites and refuses any directory near a database or checkout.
  - No secret value appears in any output, summary, request or manifest.

Production deploys, rollbacks, backups and drills now run through `ovhost`, and the stateful deploy proofs are recorded in [docs/deploy-proofs.md](docs/deploy-proofs.md). Not demonstrated yet: the Wave 21 exit criterion ("deploy, restart and roll back one service without interrupting unrelated runtimes or protected sessions") still needs a run on the host, with evidence. [`scripts/d41-proof.sh`](scripts/d41-proof.sh) is that run, written and tested against the fake host (`test/d41-proof.test.js`) but **not run yet**. It deploys, rolls back and redeploys `sources` through `ovhost`, and proves from `systemctl show` (MainPID, InvocationID, ActiveEnterTimestamp) that every other unit, the Live socket included, kept its process. See [docs/d41-proof.md](docs/d41-proof.md).

## Using ovhost

```
ovhost status [<service>...]            unit state, sha, readiness, protected sessions
ovhost logs <service> [--tail <n>]      the service's units' journal, newest last (default 200, max 2000)
ovhost validate <service> [--manifest <file>]  env NAMES, unit files, port, vhost + nginx -t, deps, lifecycle
ovhost env-names <service>              names declared in the checkout's .env.example
ovhost env-names <service> --set        names the service gets (env file + unit Environment=), never values
ovhost show [<service>...]              the inventory as ovhost reads it (repo, owner, units, socket, workers, probes)
ovhost plan <service> [--to <sha>] [--no-fetch] [--restart]
ovhost deploy <service> [--wait-idle] [--force] [--restart] [--to <sha>] [--install-units] [--ready-timeout <s>] [--browser-check] [--no-announce] [--prepare-only]
ovhost rollback <service> [--to <sha|release id>] [--wait-idle] [--force] [--no-announce]
ovhost capabilities [<service>]          key=value lines the deploy wrappers probe (deploy-api, strategy, managed)
ovhost self-update [--dry-run]           update the CLI install (/usr/local/lib/openvibe-host) itself: fetch origin main, --ff-only merge, npm ci
ovhost service add <id> [--dry-run]      first setup: inventory entry, checkout, 0600 env file, database if DATABASE_URL is declared
ovhost data provision <service> [--dry-run]   run roles/data/add-service.sh from the install: PostgreSQL database, roles and Valkey user (names only)
ovhost --version
ovhost announce <service> [--release <id>] [--commit <sha>] [--origin <url>] [--force] [--dry-run]   release notification
ovhost releases <service> [--limit <n>]
ovhost certs [--warn-days <n>]
ovhost nginx render <service> [--variant http|sse|websocket] [--manifest <file>] [--install]
ovhost nginx tenants <service> [--wildcard-cert <name|dir>] [--install]    tenant vhosts for a service whose inventory has `nginx.tenants`
ovhost snapshot <service> [--out <file>]
ovhost backup <service>
ovhost backup --all [--offsite] [--logical] [--no-prune] [--keep-daily <n>] [--keep-weekly <n>]
ovhost offsite push [--run <run>] | offsite list [<service>] | offsite check
ovhost archive push <file>... [--note <text>] | archive list | archive restore <stamp> <path> --out <dir>
ovhost restore-download <service> <run|latest> [--out <dir>] [--from-host <name>]
ovhost drill <service> [--backup <dir>] [--keep]     restore drill (root only)
```

Every command accepts `--json` and `--inventory <file>`. `drill` exits `0` passed, `1` refused (not root, port in use, no backup, unsupported), `2` failed. `self-update` exits `0` updated (or already up to date, or `--dry-run`), `1` refused (not root, dirty tree, not on `main`, diverged), `2` the checkout moved but `npm ci` failed. Other exit codes: `0` ok · `1` usage/precondition (including a held lock) · `2` validation failed, nothing restarted · `3` not ready, rolled back and serving · `4` rollback failed, **manual intervention** · `5` protected sessions active (refused, or `--wait-idle` gave up) · `6` frozen (`ovhost freeze`; `--force` goes through, rollbacks are never frozen).

`service add` runs as root against `/etc/openvibe/host.json`. It copies `services.<id>` from the installed CLI's `host.example.json`, drops `_note`, and backs up the live inventory before changing it. The example entry may set `cloneUrl` to a credential-free GitHub HTTPS URL; otherwise the repository is `https://github.com/OpenVibers/OpenVibe.<Capitalized id>.git`. The command refuses an existing entry, occupied checkout or env file. It holds the inventory lock (`<stateDir>/locks/_inventory.lock`) from reading the inventory to the end, and refuses a symlinked `.env.example`, which it reads with the checkout owner's permissions. It clones as the checkout owner, creates the entry's `envFile` (`/etc/openvibe/<id>.env`, 0600) as a copy of the checkout's `.env.example` with production `NODE_ENV`, `HOST` and `PORT`. It sets `BASE_URL` when the inventory vhost, origin or env example supplies a public HTTPS origin; otherwise it leaves an existing empty `BASE_URL` for the operator and does not add one to services without it. An explicitly required `BASE_URL` needs an inventory vhost or origin before setup begins. The tracked `.env.example` is never changed. It runs `data provision` if that example declares `DATABASE_URL`. Output lists env names but never values. `--dry-run` shows the plan without changing files. It then lists the env names still empty (leaving out the production overrides and, after provisioning, `DATABASE_URL`, `DATABASE_DIRECT_URL`, `VALKEY_URL`, `VALKEY_PREFIX`). When the example declares `OV_OAUTH_CLIENT_ID` or `OV_OAUTH_CLIENT_SECRET`, it prints one root command for the Network service principal. The command runs `server/setup/service-principal.js` through `systemd-run` with Network's env file (`services.network.envFile`, default `/etc/openvibe/network.env`) in Network's checkout (`services.network.repo`, default `/opt/openvibe.network`). It uses `rotate` when `list` already shows the id and `create` otherwise, so the principal never lands in a development database (the secret is never printed). It ends with `then: ovhost validate <id>; ovhost deploy <id> --restart`; ovhost runs neither. If a later step fails, the inventory backup path is printed; completed setup steps are not automatically undone.

**Deploy strategies** (roadmap WS-N task 11). The inventory entry's `strategy` picks how a service deploys: `git-checkout`, `multi-app` (Tools), `static-build` (Sites), `pnpm-build` (Games) or `release-layout` (Live, OpenRestream). Each strategy handles its service's preflight checks, build output, units and readiness rules. See [docs/deploy-strategies.md](docs/deploy-strategies.md).

`deploy --browser-check` checks the service's public site in headless Chrome after a deploy that went through. It runs [`scripts/browser-check.js`](docs/browser-check.md) for that one site. The check is report only: it never changes the exit code or the release record. It needs Chrome where ovhost runs.

**Release notifications** (WS-P task 9). A deploy or rollback that went live is announced to OpenVibe.Events as `host.release.published`. The event is public, has subject `release` and carries the service, its `/release.json` release id, commit and origin. Open tabs (openvibe-shared release-watch 1.17.0 and later) then check `/release.json` within seconds instead of at their next poll. `ovhost announce <service>` can announce the currently served release manually. It is best effort: a few seconds at most, never a failed deploy, one event per release. The credentials are Host's service principal from `/etc/openvibe/host.env`. [docs/release-notifications.md](docs/release-notifications.md) covers the payload, the credentials, provisioning and an end-to-end check.

### Browser check (all public sites)

`node scripts/browser-check.js [--sites a,b] [--out docs/browser-check.md] [--remote <ssh-host>]` loads every public product in headless Chrome with `openvibe-shared/browser-harness`. Per route it checks status, console errors, overflow at 390/768/1280 px, duplicate scripts, no-JS text, canonical, JSON-LD against the visible text and axe-core. Per site it checks repeated-navigation growth and idle work. See [docs/browser-check.md](docs/browser-check.md) for what it checks, the remote runner and the recorded runs.

**Release-lifecycle acceptance** (D46, roadmap WS-P task 16). `node scripts/release-acceptance.js [--base <url>] [--only 9,14] [--json] [--out run.md]` runs the 14 D46 scenarios (home styles during a broadcast, a shared navbar update, an article or paste edit, a feed update while reading, a tool upgrade during a job, an API restart during streams or calls, a media-worker rollout, duplicate or older notifications, an account switch during an update, a partial asset group, repeated navigation leaks, JS-disabled routes, rollback with new writes, resuming an offline tab) as 63 gates over the tests of Shared, Live, Tools, Chat, Media, Blog and this repository, the production proofs and, with `--base`, the running site. Each gate has a numeric budget. The output is a table of measured values against those budgets, with the versions it ran against. Skipped and open gates are never counted as passes. See [docs/release-acceptance.md](docs/release-acceptance.md) for the scenario table, where each number comes from, what is open and the recorded runs.

### Deploy sequence

1. Take the per-service lock. A `release-layout` service goes to its own engine ([docs/deploy-strategies.md](docs/deploy-strategies.md#release-layout-release-layout)); an in-place strategy refuses a checkout that has a `releases/current` layout.
2. `git fetch` as the owner, then work out the from/to shas, changed files, per-package install need and whether a restart is needed (`noRestartPaths`).
3. Refuse a tracked local change or a wrong branch.
4. **Protected sessions** (only if a restart is needed): refuse, wait (`--wait-idle` or drain policy `wait`), report (drain policy `report`, Events SSE), or `--force`.
5. `git merge --ff-only` as the owner (rollback uses `git reset --hard <sha>`).
6. Install dependencies where needed and restore the lockfile. **Verify every dependency resolves**, reinstalling a broken one once. Run the build hooks. Install repo vhosts (Sites). Install unit files if `--install-units` was given. Back up databases if a `backupOnChange` file changed.
7. Protected sessions again, immediately before the restart. If this or anything in step 6 fails, the checkout and node_modules are restored and nothing is restarted.
8. Start the socket if it is down, restart the service units, poll readiness.
9. If readiness fails, run the automatic rollback (restore, reinstall, restart, poll).
10. Append the release record to `<stateDir>/releases/<service>.jsonl`.

### Backups

`sudo ovhost backup --all --offsite` runs daily from `deploy/systemd/openvibe-backup.timer` (03:30 UTC). It works like this:

- It backs up every service that declares databases. A failing service never stops the others; exit `2` if anything failed.
- A **PostgreSQL** database is verified on every run: every run checks pgBackRest for the whole cluster and records `verified`, and a logical `pg_dump -Fc` per database is taken when the last good one is over 7 days old or on any run with `--logical`. A failed verification is `failed`, never `skipped`.
- It keeps the last 7 daily and 4 weekly good backups per service.
- It writes a JSON summary to `<stateDir>/backup-runs/<run>.json`.
- It encrypts every copy on the host (AES-256-GCM, Node crypto, with a key that stays on the host) and uploads it to S3-compatible storage (Backblaze B2). Off-host copies are kept for 30 days.
- Backups are `root:root`: directories 0700, files 0600. PostgreSQL dumps are made as the postgres OS user over peer auth; ovhost reads no service env value.

`ovhost restore-download` fetches, verifies and decrypts a run into a new root-only directory, and never touches a live database. See [docs/backups.md](docs/backups.md) for the install steps, the env names (`/etc/openvibe/backup.env`), the encryption format and the restore procedure.

### Restore drills (Wave 22)

`sudo ovhost drill <service>` restores the latest `ovhost backup` (or `--backup <dir>`) and starts a second instance on a spare loopback port. It compares that instance with production, stops it and logs the result to `<stateDir>/drills/<service>.jsonl`. It also prints a Markdown row for [docs/restore-drills.md](docs/restore-drills.md), which covers the steps, the sandbox and the per-service status.

Each inventory entry's `drill` block declares:

- `port`: the service port + 10000 in the example;
- `databases`: `{ "url": "<NAME>", "directUrl": "<NAME>" }` for each PostgreSQL database (the drill creates a scratch database and role, restores the `.dump` into it, and sets both vars to it);
- `env`: overrides that turn side effects off. Values may use `{tmp}` and `{port}`;
- `dirs` to create inside the drill directory;
- `ready`: the readiness path;
- `compare`: paths, plus volatile `ignore` keys where needed;
- `counts`: `{ db, table }` pairs;
- `countsTolerance` (default `0`): how many rows a busy table may differ by, because production keeps writing between the backup read and the drill;
- `supported: false` with a `reason` when a second instance cannot run without side effects.

In `host.example.json`, 25 services have drill blocks, and 24 can be drilled. ai is marked unsupported, and the reason is in the file. live and media rely on their own drill switches (`LIVE_DRILL`, `MEDIA_DRILL`), which `requires` checks for in the deployed checkout. For a service with several units, `unit` (as tools does: only the docs app runs) or `command` (an absolute argv, as openre does: only `openre-api` runs) says which one process the drill starts. `productionPort` says which production port to compare against, `databases` entries name the PostgreSQL database's two URL env vars, `bind` redirects paths a service opens relative to its checkout into the drill directory (`BindPaths=`, in the drill unit's own mount namespace), and `requires` refuses the drill unless the deployed checkout has each switch the overrides rely on. A PostgreSQL drill always overrides `DATABASE_URL`, `DATABASE_DIRECT_URL` and `VALKEY_URL` and drops its scratch database and role in a `finally` ([docs/restore-drills.md](docs/restore-drills.md#a-postgresql-drill)). The Tools and Games drills rely only on switches those repositories already have. [docs/restore-drills.md](docs/restore-drills.md) lists what each repository could add to make its drill stricter.

The sandbox blocks writes outside the drill directory and addresses beyond loopback. Loopback stays open, so the overrides are what keep a drill away from production services. Common overrides are `OV_OAUTH_CLIENT_SECRET=` (no service tokens) and `http://127.0.0.1:9` for URLs whose empty value would fall back to a production service.

### Inventory

`host.example.json` describes every service on the host. It records the checkout, owner/`runAs`, units and socket unit, `unitSources` (repo unit files), env file, `env.required` (names, or `"from-example"`), port, loopback `ready` URL (plus headers, since Tools needs `Host: openvibe.tools`), `packages` (`"apps/*"` for Tools), install command, `build` hooks, `noRestartPaths`, the `protected` probe (`http-json-count`, `postgresql-count`, or `sum` of several: Live streams, Media recordings, Events SSE connections, Chat sockets, Games players online, OpenRestream ingest sessions, Tools running jobs), the `drain` policy, `databases` (each a PostgreSQL database `{ "name", "engine": "postgresql", "database": "ov_<name>" }`; [docs/db-inventory.md](docs/db-inventory.md)), `backupOnChange`, `nginx`, `layout` (`release` for a `releases/<id>` + `current` service using the `release-layout` strategy) and `workerUnits`. `workerUnits` are units, or templates such as OpenRestream's `openre-rtmp-ingest@.service`, that belong to the service but that ovhost **never starts, stops or restarts**: they drain and exit on their own. `status` and `validate` list their instances read-only, `validate` warns when none runs, and the inventory refuses a worker unit, or an instance of one, in `units`. The real file is `/etc/openvibe/host.json` and is **never committed**. When `ovhost` runs as root it refuses an inventory that is not root-owned or that anyone else can write, and it rejects relative paths, non-loopback probe URLs, non-SELECT probe queries and vhost names that contain a path.

**Lifecycle** (roadmap WS-P task 1, `lib/lifecycle.js`). Each service's lifecycle is the `lifecycle` block of its manifest in openvibe-contracts (≥ 0.55.0): liveness, shutdown (signal, `deadlineSeconds`, drains, workers), startupRecovery, rollback, contracts and leases. A service entry may carry its own `lifecycle` block, which replaces the manifest's on this host, and `validate --manifest <file>` reads another manifest file. `ovhost validate` fails when no block is found or a field is missing, naming the service and the field (`live: lifecycle.shutdown.deadlineSeconds is missing`). It also fails when `deadlineSeconds` exceeds a unit's stop timeout (systemd's effective `TimeoutStopUSec`, else `TimeoutStopSec` in the unit source) or the unit's `KillSignal` is another signal, and when the checkout's installed openvibe-contracts is outside `contracts.range`. Worker units that drain longer than their stop timeout are a warning, since ovhost never stops them. This repository still pins openvibe-contracts v0.49.0, which has no lifecycle blocks, so until that pin moves to v0.55.0 or later `validate` reports every service as undeclared.

`games` deploys with the `pnpm-build` strategy (a pnpm workspace with a TypeScript build: `pnpm install --frozen-lockfile`, `pnpm build`, the tracked `dist-types/` restored from git before the merge). A release layout requires `strategy: "release-layout"`. The deploy-strategy fields (`strategy`, `release`, `preflight`, `skipPackages`, `removeUntrackedLockfiles`, `generated`, `installUnits`, `unitsMatch`, `announce.releaseFiles`, `install.lockfile`, `install.workspace`, `ready.release`, `ready.allUnits`) are listed in [docs/deploy-strategies.md](docs/deploy-strategies.md#inventory-fields).

## Deploy

Two things deploy from this repository:

- **The `ovhost` CLI** is the root-owned checkout `/usr/local/lib/openvibe-host` (linked as
  `/usr/local/bin/ovhost`), with the inventory `/etc/openvibe/host.json`. It is updated by hand:
  `cd /usr/local/lib/openvibe-host && sudo git pull --ff-only && sudo npm ci --omit=dev --no-audit --no-fund`,
  then `ovhost --version` and `sudo ovhost capabilities` (ovhost does not deploy itself; an update is
  undone by checking out the previous commit there). Its timers (`openvibe-backup`, `openvibe-alerts`, `openvibe-browsercheck`,
  `openvibe-devpath`, `openvibe-toolsjob`) are unit files in [deploy/systemd/](deploy/systemd/).
- **The catalog service** deploys like every other service, with `sudo ovhost deploy host` (strategy
  `git-checkout`: fetch, fast-forward `/opt/openvibe.host`, install on a lockfile change, restart, wait for `/api/ready`).
  The unit is `openvibe-host.service` on `127.0.0.1:4910`, the env file `/etc/openvibe/host.env`. Its state is
  `/var/lib/openvibe-host-api` (not ovhost's own `/var/lib/openvibe-host`).
  Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
  restart; afterwards `sudo ovhost rollback host --to <sha>`. Migrations only add tables and columns.

Request telemetry (plan T1 step 10) aggregates each HTTP request by route template, method and status class, never by raw URL. Once a minute, one `http.request` sample per key plus the active-requests, p95 latency and event-loop-lag gauges go into this service's own `telemetry_samples` table (openvibe-sdk 0.46 telemetry, the `platform.telemetry-sample@1` shape, migration `0010_telemetry.sql`); rows older than 14 days are deleted daily. `/shared` files, static assets, health, readiness and `/metrics` are not counted. `server/app.js` mounts openvibe-sdk's `telemetryMiddleware` (a no-op until init); `server/index.js` calls `telemetry.init()` at production start, runs the 14-day retention and flushes on stop.

## Installing on the host (for the operator)

This was done on 2026-09-23 (the CLI and inventory are installed); the steps stay for a rebuild:

1. **Code** is root-owned and outside `/opt`, so it never mixes with the ubuntu-owned service checkouts:
   ```
   sudo git clone https://github.com/OpenVibers/OpenVibe.Host /usr/local/lib/openvibe-host
   cd /usr/local/lib/openvibe-host && sudo npm ci --omit=dev --no-audit --no-fund
   sudo ln -s /usr/local/lib/openvibe-host/bin/ovhost /usr/local/bin/ovhost
   ```
   The tree must stay world-readable (default 0755/0644).
2. **Inventory:** `sudo install -o root -g root -m 0640 host.example.json /etc/openvibe/host.json`, then correct it against the machine. Check the Community database path, the Tools unit list, and Events, which was not deployed as of 22 Sep.
3. **State:** `/var/lib/openvibe-host` (root, 0750) holds the release logs, locks, snapshots, drill logs and backup run summaries. `/var/lib/openvibe-drills` (root, 0711) holds one directory per running drill, owned by the service user and removed afterwards. `/var/backups/openvibe` and everything in it is root-only (directories 0700, files 0600). The postgres OS user writes logical dumps into its own directory under `/var/backups/openvibe.staging` (root, 0711), and root takes each copy over from there. All of these are created on first use.
4. **Run as root:** `sudo ovhost …`. `ovhost` drops to `ubuntu` for git/npm (`runuser`) and needs root for `systemctl`, `nginx -t`, reading `/etc/openvibe/*.env` (names only) and writing vhosts. For least privilege, give operator accounts a sudoers rule for `/usr/local/bin/ovhost` alone instead of a general `ALL`. Do **not** grant it to the `ubuntu` service user if that account has no sudo today.
5. **First run:** `sudo ovhost status`, then `sudo ovhost validate <each service>`, then `sudo ovhost plan live`, all read-only apart from `git fetch`. Adopt `deploy` one service at a time, starting with one that has no protected sessions.
6. **Scheduled backups:** see [docs/backups.md](docs/backups.md#installing-on-the-host-operator) (bucket, key, `/etc/openvibe/backup.env`, `openvibe-backup.timer`).
7. **Updating the CLI itself:** a deploy of this repository replaces `/opt/openvibe.host` (the catalog service), not the root-owned install at `/usr/local/lib/openvibe-host`, so after a merge to `main` run `sudo ovhost self-update`. It finds its own install directory from its real path (`/usr/local/bin/ovhost` → `/usr/local/lib/openvibe-host/bin/ovhost`), fetches `origin main`, refuses a dirty tree, a branch other than `main` or a divergence, merges `--ff-only` and runs `npm ci --omit=dev --no-audit --no-fund` there; `--dry-run` prints the plan first. It restarts nothing — the next `ovhost` invocation runs the new code. Without it the installed CLI silently runs behind `main` (on 2026-10-02 it was 16 commits behind: no `env-names --set`, no `logs`, no Bot vhost).

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). Stage B's threat review (now Space's engine) stays in
[docs/threat-review.md](docs/threat-review.md) for the record. The rules the code keeps:

- **Secrets.** `ovhost` reads service env files for variable **names** and emptiness only; it never
  stores, prints or snapshots a value. The one exception is its own root-only `/etc/openvibe/backup.env`.
  Backups are root-only (0700/0600) and off-host copies are AES-256-GCM encrypted and authenticated.
- **Operator plane.** `ovhost` runs as root and drops to the checkout owner for git, npm, builds and
  PostgreSQL; it never stops or restarts a socket unit except the release-layout rebind; a protected-session
  probe that cannot answer counts as sessions active; tracked local changes block a deploy.
- **Catalog.** Public pages and reads are signed-out and cacheable; staff writes need `host.catalog.manage` and a
  Network staff user; affiliate links are marked and never change the order. Engine URLs answer 410.
- **Egress.** The service calls only its configured Network, Events, Sources and Community hosts; `ovhost` calls the host's own
  services, Network, Events, Prometheus and the backup bucket.

## Development

```
npm test                    # every test, each file in its own process (Node 22)
node test/deploy.test.js    # one file
npm run dev                 # the catalog service on http://localhost:4910
```

The service tests (`test/catalog-*.test.js`, `test/engine-moved.test.js`) boot it on a temp PGlite database with `test/helpers/boot.js` (a mock Network with real RS256 keys) and talk to it over raw HTTP.

Stage A: everything that touches the system goes through the executor (`lib/executor.js`). The tests replace it with `test/fake-host.js`, an in-memory host with git repos, systemd units, npm, nginx, ss, HTTP endpoints and PostgreSQL. No test runs systemctl, git, npm, nginx or curl against the real machine. `test/executor.test.js` covers the real executor only where that is safe: HTTP to a local server and temp files.

## Launch rule

**Launched on 2026-10-07.** Every item below is met (docs/launch.md, Launch readiness), and openvibe.host left
OpenVibe.Sites the same day. The rule, as it stood (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

**Stage B** never launched publicly here: it moved to OpenVibe.Space on 2026-10-12, where the same rule and
the owner's gates (go-ahead, a DMCA agent, a Public Suffix List entry for openvibe.website) apply.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.199.0
- openvibe-sdk: v0.46.0
- openvibe-shared: v4.2.2
- openvibe-publishing: v1.4.0
<!-- versions:end -->
---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
