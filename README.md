# OpenVibe.Host

> The network's deployment/control plane first; then isolated hosting for community sites, bots and mods.

**Status:** alpha. Stage A (operator plane) is a CLI, `ovhost`, tested against a fake host. It is installed on the production host (2026-09-23, `/usr/local/bin/ovhost`, inventory `/etc/openvibe/host.json`) and it deploys 20 services (`ovhost deploy <svc>`: Network, Events, Chat, Billing, Tips, VIP, AI, Search, Sources, Wiki, Blog, News, Reviews, Deals, Coupons, Trade, Codes, Host, Media, Community; 70+ releases since 2026-09-23, with automatic rollback on a failed readiness check) and runs the nightly backups and the restore drills of 19 services. Live, Tools, Sites, Games and OpenRe moved to it in the 2026-09-27 cutover (roadmap WS-N task 11) through the deploy strategies `release-layout`, `multi-app`, `static-build` and `pnpm-build`, so every service now deploys with `sudo ovhost deploy <svc>` (Live with `--wait-idle`); each of those repositories keeps `deploy/scripts/deploy.sh` as a thin wrapper that hands over to ovhost or falls back to its old script: [docs/deploy-strategies.md](docs/deploy-strategies.md). Stage B (tenant static hosting) is a service, written and tested, and **launched on 2026-10-07**: `openvibe.host` serves the dashboard, API and front page, and `*.openvibe.host` serves tenant sites (vhosts from `ovhost nginx tenants host --install`; the Sites placeholder and the pending 404 vhost are gone; certificate lifecycle on `openvibe-certs.timer`; an nginx catch-all refuses hosts no site names). The launch record, verification and rollback: [docs/launch.md](docs/launch.md); the threat review: [docs/threat-review.md](docs/threat-review.md). Stage C (sandboxed user code) is **not started**.
**Domain:** `openvibe.host` (dashboard and API) and `*.openvibe.host` (tenant sites). Launched on 2026-10-07 (see [Launch rule](#launch-rule)); OpenVibe.Sites no longer serves it.
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.3 and §15.17; roadmap Wave 21.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Every repository ships its own deploy script, and each one encodes rules learned from an outage. Stage A pulls those rules into one tool that works the same way for every service on the host:

| Rule | Where it came from | How `ovhost` applies it |
|---|---|---|
| Never stop `openvibe-live.socket`; restart only the service unit | Live (socket activation, `deploy/systemd`) | Every `systemctl` call goes through a guard that refuses `stop`/`restart`/`reload` on a `.socket` unit. A socket that is down gets `start`ed. The one exception is the rebind Live's script also made (`systemd.rebindSocket`, release-layout only): when the socket unit file changed or pid 1 does not hold the port, the service is stopped, the socket restarted and the service started on it. |
| Don't restart Live while anyone is live; `--wait-idle` holds the restart | Live `deploy.sh --wait-idle` (`/api/streams`) | Protected-session probe (`http-json-count`). Checked before the checkout moves and again right before the restart. |
| Don't restart Media while it is recording | Media hazard H3 (`vods-orphans/` in B2) | Protected-session probe (`sqlite-count` of a file, or `postgresql-count` of a database in the cluster: Media's `SELECT count(*) FROM vods WHERE is_recording = 1`), run read-only **as the owning user** (the service user, or the postgres OS user for the cluster). |
| Poll `/api/ready` after a restart; roll back if it doesn't come up | Live `deploy.sh` | Readiness poll with a timeout; on failure the checkout goes back to the previous sha, deps are reinstalled if they differed, the unit is restarted again. |
| Install only when the lockfile or dependencies changed; restore `package-lock.json` afterwards | Network `deploy.sh` and host practice | `npm install --omit=dev` as the checkout owner, then `git checkout -- package-lock.json` if npm rewrote it. |
| Every dependency must resolve before anything restarts | Tools `deploy.sh` (an emptied `file:` link crash-looped every unit) | `node_modules/<dep>/package.json` must exist, parse and name the package. A broken dependency is reinstalled once, and if it still fails the deploy aborts and the checkout is restored. |
| Build, install vhosts, `nginx -t`, reload | Sites `deploy.sh` | `build` hooks and `nginx.installOnDeploy`. Vhost installs are transactional: if `nginx -t` fails, the previous files come back and nginx is not reloaded. |
| Build a release while the old one serves; switch a symlink; roll back to a release with its own `node_modules`; pid 1 must hold the socket | Live `deploy.sh` (release layout), OpenRe `deploy.sh release`/`api` | Strategy `release-layout` ([docs/deploy-strategies.md](docs/deploy-strategies.md)). The socket unit is restarted only when its unit file changed or systemd does not hold the port. |
| Per-app installs (not `apps/_shared`), jobs runtime and guard load before the restart, every `openvibe-tools*` unit | Tools `deploy.sh` | Strategy `multi-app`: `skipPackages`, `preflight`, `unitsMatch`, `ready.release`. |
| git as the checkout owner; never leave root-owned files under `/opt` | Community/Events/Tools checkouts | git, npm, builds, SQLite queries and backups all run as the declared owner/service user (`runuser` from root, `sudo -u` otherwise); PostgreSQL dumps and probes run as the postgres OS user. |

Stage A adds a few safety rules of its own:

- A protected-session probe that **cannot answer** while the service is running counts as "sessions may be active", never as zero. Live's `deploy.sh` treated a failed `curl` as 0 live streams.
- Tracked local changes block a deploy. The script never discards them.
- One operation per service at a time, using a pid lock with stale-lock recovery.
- Every attempt goes into the release log, refusals and failures included.

## Owns

- Stage A: the host inventory (services, units, env names, ports, probes, drain policy), environment validation, release install and rollback for git-checkout services, readiness and drain orchestration, the release log, certificate inventory, nginx vhost rendering and transactional install, config snapshots, scheduled backups (online SQLite copies, pgBackRest verification and logical PostgreSQL dumps) with retention and encrypted off-host copies, restore drills.
- Stage B: tenant projects (keyed by project id), static sites, immutable content-addressed deploy artifacts, activation and rollback, default and custom domains (DNS TXT verification), per-project quotas, upload/validation logs, the tenant vhosts (`ovhost nginx tenants`).
- Later (Stage C): sandbox profiles, budgets, secret references, outbound policy.
- Host roles, provisioned from code so any machine can take them: the **data role** (`roles/data/`, ADR-035): PostgreSQL 18, PgBouncer, pgBackRest, Valkey and their exporters, plus `add-service.sh` giving each service its database, roles and Valkey user. `ovhost data provision <svc>` and `ovhost data switch <svc> [--sqlite <file>]` run `add-service.sh` and `switch-service.sh` from the installed CLI, redacting every URL and password: [docs/data-provisioning.md](docs/data-provisioning.md).

## Does not own

- Product business logic. Host calls product hooks (`build`) and reads product endpoints (`/api/ready`, `/api/streams`). It never embeds product rules.
- Secrets. `ovhost` reads service env files only to learn variable **names** and whether each one is empty. It never stores, prints or snapshots a value. The one exception is its own `/etc/openvibe/backup.env` (root-only): it reads the `BACKUP_*` values there to reach the backup bucket, and never prints or stores them.
- Platform-wide credentials for hosted code (never).
- Certificate issuance/renewal (certbot does this today). Stage A only takes inventory; Stage B never handles a certificate or key through its API.
- Projects as an identity concept: ADR-014 puts projects in OpenVibe.Network. Until Network has them, Host creates a `prj_` project for its owner and records `network_project_id` when one is given.
- Tenant secrets. Stage B stores none (no environment variables, no build secrets, no deploy keys).

## Depends on

- OpenVibe.Contracts (`openvibe-contracts` v0.107.0; `host.*` capabilities and the `host` manifest were released in v0.24.0, v0.32.0 added the takedown routes to `host.site.manage`, v0.83.0 added `host.site.config`, and v0.107.0 adds the planned `host.resource.read` and the git-source routes to `host.site.manage`/`host.deploy.create`): service manifests (vhost rendering, snapshots, the first-party domain list), ids, problem+json, service-token verification, capability checks, the `common.resource-summary@1`/`common.resource-list-result@1` schemas and the `contracts.resources` OVRN helpers (ADR-048).
- OpenVibe.Network (Stage B): SSO for the dashboard, the JWKS that verifies user and service tokens, client-credentials tokens for the outbox relay.
- OpenVibe.Events (Stage B): `host.*` events through the `openvibe-sdk` v0.35.0 transactional outbox (openvibe-sdk/limits for the per-actor limits).
- `openvibe-shared` v2.15.0 (Stage B): shared chrome (Host's own pages are composed with `openvibe-shared/shell`), legal pages, `/release.json`, `/metrics`, `/api/ready`.
- OpenVibe.Media (Stage B, opt-in): with `HOST_OBJECT_STORE=media`, deploy objects are written through to Media's Object API v2 (`openvibe-sdk/media`) and local disk becomes the read cache; unset keeps them on local disk (see [Storage](#storage)).

## Capabilities

Implemented here (the service manifest's `capabilities`, Stage B's API, audience `openvibe.host`):
`host.site.manage` (sites, members, takedowns), `host.deploy.create` (uploads, activation, rollback),
`host.domain.manage` (custom domains) and `host.site.config` (headers, redirects, SPA fallback). See
[Grants and registration](#grants-and-registration-for-the-lead).

`host.resource.read` (first-party) is the authority resource index Host serves for OpenVibe.Services'
fan-out ([ADR-048](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-048-services-control-plane.md)
section 3, plan T13 step 8): `GET /api/v1/resources` lists Host's sites, deploys and domains as a page of
`common.resource-summary@1` and `GET /api/v1/resources/:ovrn` reads one by its OVRN, exactly as
OpenVibe.Network's index does. Host ships it; OpenVibe.Contracts keeps the capability `planned` with no
`implementedBy` routes until the deploy, and flips it afterwards.

Called elsewhere, as the service principal `host` (the OAuth client `host`; `ovhost` reads the same
credentials from `/etc/openvibe/host.env`):

| Service | Grant | Used by |
|---|---|---|
| OpenVibe.Events | `events.event.publish` | Stage B's outbox (`host.deploy.*`, `host.domain.verified`) and `ovhost announce` (`host.release.published`) |
| OpenVibe.Network | `network.operator.alert` | `ovhost alerts relay` (Prometheus alerts that page the operator) |
| OpenVibe.Network | `network.status.incident` | `ovhost incident` and `ovhost maintenance` (the public status page) |

## Stages

| Stage | Scope | State |
|---|---|---|
| **A: operator plane** | `ovhost` CLI and library: inventory, validate, plan, deploy (`--wait-idle`/`--force`), automatic rollback, rollback, status, releases, certs, nginx render/install, snapshot, backup, restore drill. No daemon and no server. Port **4910** is reserved for a later operator API. | **alpha**: written and tested (fake host, plus the real executor against temp SQLite/HTTP/git). Installed on the host: deploys every service, runs the nightly backups and the restore drills. |
| **B: tenant static hosting** | The Host API service (port 4910): projects, sites, immutable content-addressed deploys, activation and rollback, `<site>.openvibe.host` and TXT-verified custom domains, quotas, upload logs, events, a server-rendered dashboard; tenant vhosts via `ovhost nginx tenants`. | **alpha**: written and tested (`npm test`, against a temp database, a mock Network and a DNS table). Runs on the host on `:4910` behind nginx; launched at openvibe.host on 2026-10-07. |
| **C: sandboxed user code** | Isolation profiles, CPU/memory/time/network/storage budgets, secret references, outbound policy, metering, kill/revoke without touching platform services. | **not started**, deliberately. Blocked until isolation and metering are proven. Nothing in Stage B runs tenant code. |

Not in Stage A yet (from the charter/roadmap list): container adapters, DNS adapters, certificate **renewal**, logs/metrics links, the release-manifest/active-client work in §15.18, and the Wave 22 cutover runbook. (Incident and maintenance controls, `ovhost incident|maintenance|freeze`, and release notifications, `host.release.published`, exist now.) Restore drills (`ovhost drill`) ran on the host for 19 services on 2026-09-23 ([docs/restore-drills.md](docs/restore-drills.md)).

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
- A **restore drill** restores the latest backup into a service-user-owned temp directory and requires `integrity_check = ok` (a SQLite copy) or `pg_restore --list` on the `.dump` of a PostgreSQL service. It starts a sandboxed second instance through `systemd-run` with the production env file plus an override file. It compares the declared paths and row counts with production, then stops the instance by its own pid and removes the directory. Failed integrity, a readiness timeout, an instance that dies, mismatches and a failed `systemd-run` are all reported, logged and cleaned up. It refuses to run without root or on a port already in use. A filesystem diff of the fake host shows it writes nothing outside the drill directory, its lock and its log, and it never reads the env file or passes on a secret-looking unit `Environment=`.

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
ovhost data switch <service> [--sqlite <file>] [--dry-run]   run roles/data/switch-service.sh: stop, back up, import, deploy (docs/data-provisioning.md)
ovhost --version
ovhost announce <service> [--release <id>] [--commit <sha>] [--origin <url>] [--force] [--dry-run]   release notification
ovhost releases <service> [--limit <n>]
ovhost certs [--warn-days <n>]
ovhost nginx render <service> [--variant http|sse|websocket] [--manifest <file>] [--install]
ovhost nginx tenants <service> [--wildcard-cert <name|dir>] [--install]    Stage B tenant vhosts
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

**Deploy strategies** (roadmap WS-N task 11). The inventory entry's `strategy` picks how a service deploys: `git-checkout` (the default: an in-place checkout, every service above), `multi-app` (Tools), `static-build` (Sites), `pnpm-build` (Games) or `release-layout` (Live, OpenRe: `releases/<id>` behind a `current` symlink, prepared while the old release serves, `--prepare-only` to stop after preparing). Each strategy carries the rules of the script it replaces: preflight checks, build output restored from git, untracked lockfiles, `unitsMatch`, `/release.json` naming the new sha, the socket rule. [docs/deploy-strategies.md](docs/deploy-strategies.md) has the engines, every inventory field, the rule-by-rule mapping from each script, what was not ported and why, the production cutover checklist and the proposed inventory diff.

`deploy --browser-check` checks the service's public site in headless Chrome after a deploy that went through. It runs [`scripts/browser-check.js`](docs/browser-check.md) for that one site. The check is report only: it never changes the exit code or the release record. It needs Chrome where ovhost runs.

**Release notifications** (WS-P task 9). A deploy or rollback that went live is announced to OpenVibe.Events as `host.release.published`. The event is public, has subject `release` and carries the service, its `/release.json` release id, commit and origin. Open tabs (openvibe-shared release-watch 1.17.0 and later) then check `/release.json` within seconds instead of at their next poll. `ovhost announce <service>` does the same for services deployed by their own scripts (Live, Tools and Sites call it at the end of theirs). It is best effort: a few seconds at most, never a failed deploy, one event per release. The credentials are Host's service principal from `/etc/openvibe/host.env`. [docs/release-notifications.md](docs/release-notifications.md) covers the payload, the credentials, provisioning and an end-to-end check.

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
- A **SQLite** database is copied online (as the service user). A **PostgreSQL** database is verified, not copied: every run checks pgBackRest for the whole cluster and records `verified`, and a logical `pg_dump -Fc` per database is taken when the last good one is over 7 days old or on any run with `--logical`. A failed verification is `failed`, never `skipped`.
- It keeps the last 7 daily and 4 weekly good backups per service.
- It writes a JSON summary to `<stateDir>/backup-runs/<run>.json`.
- It encrypts every copy on the host (AES-256-GCM, Node crypto, with a key that stays on the host) and uploads it to S3-compatible storage (Backblaze B2). Off-host copies are kept for 30 days.
- Backups are `root:root`: directories 0700, files 0600, no `-wal`/`-shm`. PostgreSQL dumps are made as the postgres OS user over peer auth; ovhost reads no service env value.

`ovhost restore-download` fetches, verifies and decrypts a run into a new root-only directory, and never touches a live database. See [docs/backups.md](docs/backups.md) for the install steps, the env names (`/etc/openvibe/backup.env`), the encryption format and the restore procedure.

### Restore drills (Wave 22)

`sudo ovhost drill <service>` restores the latest `ovhost backup` (or `--backup <dir>`) and starts a second instance on a spare loopback port. It compares that instance with production, stops it and logs the result to `<stateDir>/drills/<service>.jsonl`. It also prints a Markdown row for [docs/restore-drills.md](docs/restore-drills.md), which covers the steps, the sandbox and the per-service status.

Each inventory entry's `drill` block declares:

- `port`: the service port + 10000 in the example;
- `databases`: the env var that points the service at each restored copy, or `{ "url": "<NAME>", "directUrl": "<NAME>" }` for a PostgreSQL database (the drill creates a scratch database and role, restores the `.dump` into it, and sets both vars to it);
- `env`: overrides that turn side effects off. Values may use `{tmp}`, `{port}` and `{db:<name>}`;
- `dirs` to create inside the drill directory;
- `ready`: the readiness path;
- `compare`: paths, plus volatile `ignore` keys where needed;
- `counts`: `{ db, table }` pairs;
- `countsTolerance` (default `0`): how many rows a busy table may differ by, because production keeps writing between the backup read and the drill;
- `supported: false` with a `reason` when a second instance cannot run without side effects.

In `host.example.json`, 25 services have drill blocks, and 24 can be drilled. ai is marked unsupported, and the reason is in the file. live and media rely on their own drill switches (`LIVE_DRILL`, `MEDIA_DRILL`), which `requires` checks for in the deployed checkout. For a service with several units, `unit` (as tools does: only the docs app runs) or `command` (an absolute argv, as openre does: only `openre-api` runs) says which one process the drill starts. `productionPort` says which production port to compare against, `databases` entries can be data directories (`{ "env": "DATA_DIR", "dir": true }`) or a PostgreSQL database's two URL env vars, `bind` redirects paths a service opens relative to its checkout into the drill directory (`BindPaths=`, in the drill unit's own mount namespace), and `requires` refuses the drill unless the deployed checkout has each switch the overrides rely on. A PostgreSQL drill always overrides `DATABASE_URL`, `DATABASE_DIRECT_URL` and `VALKEY_URL` and drops its scratch database and role in a `finally` ([docs/restore-drills.md](docs/restore-drills.md#a-postgresql-drill)). The Tools and Games drills rely only on switches those repositories already have. [docs/restore-drills.md](docs/restore-drills.md) lists what each repository could add to make its drill stricter.

The sandbox blocks writes outside the drill directory and addresses beyond loopback. Loopback stays open, so the overrides are what keep a drill away from production services. Common overrides are `OV_OAUTH_CLIENT_SECRET=` (no service tokens) and `http://127.0.0.1:9` for URLs whose empty value would fall back to a production service.

### Inventory

`host.example.json` describes every service on the host. It records the checkout, owner/`runAs`, units and socket unit, `unitSources` (repo unit files), env file, `env.required` (names, or `"from-example"`), port, loopback `ready` URL (plus headers, since Tools needs `Host: openvibe.tools`), `packages` (`"apps/*"` for Tools), install command, `build` hooks, `noRestartPaths`, the `protected` probe (`http-json-count`, `sqlite-count`, `postgresql-count`, or `sum` of several: Live streams, Media recordings, Events SSE connections, Chat sockets, Games players online, OpenRe ingest sessions, Tools running jobs), the `drain` policy, `databases` (each a SQLite file `{ "name", "path" }` or a PostgreSQL database `{ "name", "engine": "postgresql", "database": "ov_<name>" }`; [docs/db-inventory.md](docs/db-inventory.md)), `backupOnChange`, `nginx`, `layout` (`release` for a `releases/<id>` + `current` service deployed by its own script, which ovhost does not manage) and `workerUnits`. `workerUnits` are units, or templates such as OpenRe's `openre-rtmp-ingest@.service`, that belong to the service but that ovhost **never starts, stops or restarts**: they drain and exit on their own. `status` and `validate` list their instances read-only, `validate` warns when none runs, and the inventory refuses a worker unit, or an instance of one, in `units`. The real file is `/etc/openvibe/host.json` and is **never committed**. When `ovhost` runs as root it refuses an inventory that is not root-owned or that anyone else can write, and it rejects relative paths, non-loopback probe URLs, non-SELECT probe queries and vhost names that contain a path.

**Lifecycle** (roadmap WS-P task 1, `lib/lifecycle.js`). Each service's lifecycle is the `lifecycle` block of its manifest in openvibe-contracts (≥ 0.55.0): liveness, shutdown (signal, `deadlineSeconds`, drains, workers), startupRecovery, rollback, contracts and leases. A service entry may carry its own `lifecycle` block, which replaces the manifest's on this host, and `validate --manifest <file>` reads another manifest file. `ovhost validate` fails when no block is found or a field is missing, naming the service and the field (`live: lifecycle.shutdown.deadlineSeconds is missing`). It also fails when `deadlineSeconds` exceeds a unit's stop timeout (systemd's effective `TimeoutStopUSec`, else `TimeoutStopSec` in the unit source) or the unit's `KillSignal` is another signal, and when the checkout's installed openvibe-contracts is outside `contracts.range`. Worker units that drain longer than their stop timeout are a warning, since ovhost never stops them. This repository still pins openvibe-contracts v0.49.0, which has no lifecycle blocks, so until that pin moves to v0.55.0 or later `validate` reports every service as undeclared.

`games` deploys with the `pnpm-build` strategy (a pnpm workspace with a TypeScript build: `pnpm install --frozen-lockfile`, `pnpm build`, the tracked `dist-types/` restored from git before the merge). An entry with `layout: "release"` and no `strategy` stays unmanaged: `deploy` and `rollback` refuse it and the repository's own script deploys it. The deploy-strategy fields (`strategy`, `release`, `preflight`, `skipPackages`, `removeUntrackedLockfiles`, `generated`, `installUnits`, `unitsMatch`, `announce.releaseFiles`, `install.lockfile`, `install.workspace`, `ready.release`, `ready.allUnits`) are listed in [docs/deploy-strategies.md](docs/deploy-strategies.md#inventory-fields).

## Deploy

Two things deploy from this repository:

- **The `ovhost` CLI** is the root-owned checkout `/usr/local/lib/openvibe-host` (linked as
  `/usr/local/bin/ovhost`), with the inventory `/etc/openvibe/host.json`. It is updated by hand:
  `cd /usr/local/lib/openvibe-host && sudo git pull --ff-only && sudo npm ci --omit=dev --no-audit --no-fund`,
  then `ovhost --version` and `sudo ovhost capabilities` (ovhost does not deploy itself; an update is
  undone by checking out the previous commit there). Its timers (`openvibe-backup`, `openvibe-alerts`, `openvibe-browsercheck`,
  `openvibe-devpath`, `openvibe-toolsjob`) are unit files in [deploy/systemd/](deploy/systemd/).
- **The Stage B service** deploys like every other service, with `sudo ovhost deploy host` (strategy
  `git-checkout`: fetch, fast-forward `/opt/openvibe.host`, install on a lockfile change, restart, wait for `/api/ready`).
  The unit is `openvibe-host.service` on `127.0.0.1:4910`, the env file `/etc/openvibe/host.env`. Its state is
  `/var/lib/openvibe-host-api` (not ovhost's own `/var/lib/openvibe-host`).
  Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
  restart; afterwards `sudo ovhost rollback host --to <sha>`. Migrations only add tables and columns.

## Installing on the host (for the operator)

This was done on 2026-09-23 (the CLI and inventory are installed); the steps stay for a rebuild:

1. **Code** is root-owned and outside `/opt`, so it never mixes with the ubuntu-owned service checkouts:
   ```
   sudo git clone https://github.com/OpenVibers/OpenVibe.Host /usr/local/lib/openvibe-host
   cd /usr/local/lib/openvibe-host && sudo npm ci --omit=dev --no-audit --no-fund
   sudo ln -s /usr/local/lib/openvibe-host/bin/ovhost /usr/local/bin/ovhost
   ```
   The tree must stay world-readable (default 0755/0644). The SQLite worker runs as `ubuntu` from this directory.
2. **Inventory:** `sudo install -o root -g root -m 0640 host.example.json /etc/openvibe/host.json`, then correct it against the machine. Check the Community database path, the Tools unit list, and Events, which was not deployed as of 22 Sep.
3. **State:** `/var/lib/openvibe-host` (root, 0750) holds the release logs, locks, snapshots, drill logs and backup run summaries. `/var/lib/openvibe-drills` (root, 0711) holds one directory per running drill, owned by the service user and removed afterwards. `/var/backups/openvibe` and everything in it is root-only (directories 0700, files 0600). The backup worker writes as the service user into its own directory under `/var/backups/openvibe.staging` (root, 0711), and root takes each copy over from there. All of these are created on first use.
4. **Run as root:** `sudo ovhost …`. `ovhost` drops to `ubuntu` for git/npm/SQLite (`runuser`) and needs root for `systemctl`, `nginx -t`, reading `/etc/openvibe/*.env` (names only) and writing vhosts. For least privilege, give operator accounts a sudoers rule for `/usr/local/bin/ovhost` alone instead of a general `ALL`. Do **not** grant it to the `ubuntu` service user if that account has no sudo today.
5. **First run:** `sudo ovhost status`, then `sudo ovhost validate <each service>`, then `sudo ovhost plan live`, all read-only apart from `git fetch`. Adopt `deploy` one service at a time, starting with one that has no protected sessions.
6. **Scheduled backups:** see [docs/backups.md](docs/backups.md#installing-on-the-host-operator) (bucket, key, `/etc/openvibe/backup.env`, `openvibe-backup.timer`).
7. **Updating the CLI itself:** a deploy of this repository replaces `/opt/openvibe.host` (the Stage B service), not the root-owned install at `/usr/local/lib/openvibe-host`, so after a merge to `main` run `sudo ovhost self-update`. It finds its own install directory from its real path (`/usr/local/bin/ovhost` → `/usr/local/lib/openvibe-host/bin/ovhost`), fetches `origin main`, refuses a dirty tree, a branch other than `main` or a divergence, merges `--ff-only` and runs `npm ci --omit=dev --no-audit --no-fund` there; `--dry-run` prints the plan first. It restarts nothing — the next `ovhost` invocation runs the new code. Without it the installed CLI silently runs behind `main` (on 2026-10-02 it was 16 commits behind: no `env-names --set`, no `logs`, no Bot vhost).

## Stage B: tenant static hosting

A Node service (`server/`, Express 4, better-sqlite3, port **4910**, service id `host`) that hosts static sites for OpenVibe projects. Every request is dispatched on its `Host` header first:

| Host | What answers |
|---|---|
| `openvibe.host` (the `BASE_URL` host) and loopback | the dashboard, `/api/v1`, `/auth/*`, `/api/ready`, `/api/health`, `/release.json`, `/limits.json` (the default project limits, from config), `/metrics` (direct loopback only), legal pages, and the crawl files `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` (`text/plain`, cached like the sitemap; they list only Host's own public pages: the front page, `/updates` and the legal pages, never a customer site, a preview or an operator path) |
| `<site>.openvibe.host` (one label) | that site's active deploy, and nothing else: no API, no sign-in, no cookies |
| a custom domain with `status = verified` | the site it was verified for |
| anything else (including pending, failed or lapsed custom domains, and `a.b.openvibe.host`) | `404 Unknown host`, with no tenant content |

### Model

- **Projects** (`prj_<ULID>`) have an owner (a `usr_` subject), an environment (`production` or `sandbox`), members with a role (`owner` > `maintainer` > `deployer`), and optionally the `network_project_id` of the OpenVibe.Network project (ADR-014: Network owns projects; until it has them, Host creates one for its owner). Every Host row and every stored object is keyed by the project id.
- **Sites** (`sit_<ULID>`) have a name (one DNS label, 3–40 characters, reserved names refused) that is their default host, `<name>.openvibe.host`, and a pointer to the active deploy. A deleted site's name is held for 30 days so nobody else can serve content on links that still point there. (The id prefix is `sit_` since 2026-10-07, ADR-048's three-letter rule; it was `site_`, renamed with no conversion because production held no sites.)
- **Deploys** (`dpl_<ULID>`) are immutable artifacts: a manifest (`host.deploy-manifest@1`: path, sha256, size and content type of every file, file count, total bytes) with its own sha256, file rows, and the upload/validation log. Database triggers refuse any update of a deploy's artifact columns or file rows. The bytes are content-addressed per project: `<HOST_STORAGE_DIR>/projects/<prj_…>/<aa>/<sha256>`, with `HOST_OBJECT_STORE=media` writing them through to OpenVibe.Media as well ([Storage](#storage)).
- **Domains**: every site has its default domain. A custom domain is added as `pending` and becomes `verified` (and served) once `_openvibe-host.<hostname>` has the TXT record `openvibe-host-verification=<token>`. A verified name belongs to one site. OpenVibe domains (every domain in the released service manifests, `openvibe.<tld>`, the sites domain itself) can never be claimed. The worker re-checks pending domains (they fail after `HOST_DOMAIN_PENDING_DAYS`) and re-checks verified ones daily: a TXT record gone for `HOST_DOMAIN_LAPSE_DAYS` lapses the domain and it stops being served.
- **Quotas** per project, enforced by Host: storage bytes (objects stored once per project, so re-uploading unchanged files costs nothing), deploys per rolling 24 hours (checked before the body is read; failed uploads count), files per deploy, bytes per file, sites, custom domains. A deploy's own size before deduplication may not exceed the storage quota. Defaults come from `HOST_QUOTA_*` / `HOST_SANDBOX_QUOTA_*`; staff override them per project. Sandbox projects get smaller quotas, no custom domains, and `X-Robots-Tag: noindex`.
- **Build logs**: Stage B has no build step. Each deploy's log records what was received, every validation problem, what was stored, the manifest digest and the activation, and says that nothing was executed. Refused uploads are recorded as `failed` deploys, so their logs are visible too.

### Storage

Deploy objects are content-addressed and stored **per project** (ADR-014):
`<HOST_STORAGE_DIR>/projects/<prj_…>/<aa>/<sha256>`. The same bytes uploaded by two projects are
stored twice, and storage is accounted and deleted per project. Every read goes through
`server/storage.js` and is keyed by a validated project id and the manifest's sha256, so a request
can only ever name its own project's objects.

With **`HOST_OBJECT_STORE=media`** (opt-in; unset is the local store above, unchanged) local disk
becomes the read cache and **OpenVibe.Media** is the source of truth:

- every object is written through to Media's Object API v2 (`openvibe-sdk/media`
  `createObjectsClient`) as a **private** object in Host's own namespace (`OV_MEDIA_NAMESPACE`,
  default `host`), keyed per project by `metadata.project_id` with the file's sha256 as
  `content_hash`. A deploy is not reported as stored until Media acknowledged every object; a Media
  failure fails the deploy (`502 storage.object_store`) with its log, never a silent local-only
  success;
- serving reads the local cache; a miss re-fetches the object from Media, verifies its sha256 and
  only then caches and serves it (a mismatch is a `500`, never served);
- an object is deleted from Media exactly where the local store would delete the blob (deploy GC,
  project removal, the hourly orphan sweep), and the delete re-checks `host_blobs` just before it
  runs, so an object a deploy re-referenced while the delete was in flight keeps its Media copy;
- an empty file (0 bytes) is stored in the local cache only: Media's upload refuses empty
  objects, and the serving path never asks Media for a size-0 file;
- the hourly orphan sweep walks the **local cache files** only, so a Media object with no cache
  file (for example a duplicate left by two uploads that raced before puts were serialised) is
  not reaped by the sweep; project removal deletes it, and puts are serialised per
  `(project, sha256)` so two deploys sharing a new sha do not create a duplicate in the first
  place.

Host authenticates to Media with its Network service principal (client credentials, audience
`openvibe.media`), which must hold `media.object.upload`, `media.object.read`, `media.object.list`
and `media.object.delete` for the `host` namespace and everything below it (`host.*`), and a `host`
tenant must exist in Media. `OV_MEDIA_URL` is the internal Media base URL (default
`http://127.0.0.1:4100`). `ovhost backup host` still archives the local cache; in the Media mode the
Media objects are the durable copy.

### Uploads

`POST /api/v1/sites/:id/deploys[?activate=1][&root=dist]` accepts a tar or tar.gz archive (`Content-Type: application/gzip`, `application/x-tar`, `application/octet-stream`) or `multipart/form-data` (`archive=<one archive>` or `files=<file>…`, each part's filename being the path; `strip=folder` removes a browser folder upload's shared top folder). The archive is parsed in memory and never extracted. The whole upload is refused, and recorded as a failed deploy, when any of these is true:

- a path is absolute, contains `..`, `.`, an empty segment, a backslash, a control or non-ASCII character, or goes more than 32 levels deep; a pax or GNU long-name header that rewrites a name gets the same checks;
- an entry is a symbolic link, a hard link, a device, a FIFO or any other non-regular entry (never followed and never skipped);
- a hidden file or directory other than `.well-known/` is present (`.env`, `.git/`, `.htaccess`, …);
- a file is server-side code or an executable (`php`, `cgi`, `pl`, `py`, `sh`, `asp(x)`, `jsp`, `shtml`, `exe`, `jar`, …) or looks like a credential or database (`pem`, `key`, `p12`, `env`, `sqlite`, …);
- a file type is not on the allowlist (HTML, CSS, JavaScript, JSON, source maps, web manifests, text, Markdown, CSV, XML/RSS/Atom, WebVTT, SVG, PNG, JPEG, GIF, WebP, AVIF, ICO, BMP, fonts, MP4/WebM/Ogg video, MP3/Ogg/Opus/WAV/M4A/FLAC audio, PDF, WebAssembly, glTF, zip; extension-less files are plain text);
- two entries have the same path, a path is both a file and a directory, or there are no files;
- a limit is exceeded: request size (`HOST_MAX_UPLOAD_BYTES`, the connection is closed rather than drained), files, bytes per file, total bytes (decompression stops at `HOST_MAX_UNPACKED_BYTES`, default 256 MiB, or the storage quota if smaller, so a gzip bomb cannot fill memory), or storage.

### Serving

Requests resolve their site once from the `Host` header, read the site's active deploy pointer once, and then read only that deploy's immutable rows. The file's bytes come from the blob store keyed by the site's project id and the manifest's sha256 — the local disk cache, or, with `HOST_OBJECT_STORE=media`, the object fetched back from Media and sha256-verified ([Storage](#storage)) — never from the URL, so no path, encoding or `Host` trick can reach another project's objects. Absolute-form request targets must name the same host as the `Host` header.

- `GET`/`HEAD` only (405 otherwise). `/` and `/dir/` serve `index.html`; `/page` also tries `page.html`; `/dir` redirects to `/dir/` when `dir/index.html` exists.
- `Content-Type` from the manifest; strong `ETag` (the sha256) with `304` on `If-None-Match`; single byte ranges (`206`/`416`).
- `Cache-Control: public, max-age=31536000, immutable` for fingerprinted asset names (`app.3f2a9c1b.js`, `index-BdK3x9aQ.js`), `public, max-age=0, must-revalidate` for everything else, so an activation or rollback shows at once.
- `X-Content-Type-Options: nosniff`, a strict CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; … object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`), `Referrer-Policy`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`. Never a `Set-Cookie`.
- A missing file serves the deploy's own `404.html` with status 404, or a plain Host 404 page.

**Why a separate registrable domain.** Tenant pages are arbitrary HTML and JavaScript. They live under `openvibe.host`, never under `openvibe.network` or `openvibe.live`, so no OpenVibe session cookie can ever reach them (`ovhost nginx tenants` refuses a sites domain under a first-party domain). The dashboard shares `openvibe.host` with the tenants, which makes tenant pages *same-site* with it. So:

- the dashboard session is only Host's own `__Host-ov_host_session` cookie (HttpOnly, Secure, `Path=/`, no `Domain`; a subdomain cannot set it), written and cleared alongside the SDK's `ov_token` at sign-in, refresh and sign-out (`server/auth/sso.js`, read at `server/auth/viewer.js:99-103`). The plain `ov_token` cookie the shared navbar reads is display-only and is never trusted, a sign-in callback must match Host's own `__Host-ov_host_flow` state, and a refresh never changes the signed-in account. With `COOKIE_SECURE=false` (plain-http development) the names drop the `__Host-` prefix and are not Secure;
- every dashboard form needs the dashboard's own `Origin` **and** a form token (an HMAC of the signed-in subject); `SameSite` alone would not stop a tenant page;
- `/api/v1` ignores cookies entirely: `Authorization: Bearer` only;
- nginx strips `Cookie` and `Authorization` from tenant requests, hides `Set-Cookie` from tenant responses and allows only `GET`/`HEAD` with a 1 KB body limit.

### API (`/api/v1`)

People present their Network user JWT as a Bearer token. Services and apps present a Network client-credentials token for audience `openvibe.host`. Each route checks exactly one capability for service tokens, and every caller is also judged by its project role. A first-party service (`svc:…`) may act for a person with `X-OV-Subject: usr_…`; an app (`app:app_…`) is a principal and always acts as itself, so it must be added to a project as a member (for example as `deployer`, for CI). A token with the claim `env: "sandbox"` is refused on production projects (ADR-014). Callers who are not members get 404 for everything in a project.

| Route | Capability | Least role |
|---|---|---|
| `GET/POST /projects` · `GET/DELETE /projects/:id` | `host.site.manage` | member / owner (delete) |
| `GET /projects/:id/quota` · `PUT /projects/:id/quota` | `host.site.manage` | member / Network staff (PUT) |
| `PUT/DELETE /projects/:id/members/:principal` | `host.site.manage` | owner |
| `GET/POST /projects/:id/sites` · `GET/DELETE /sites/:id` | `host.site.manage` | member / maintainer |
| `GET/POST /sites/:id/deploys` · `GET /deploys/:id` · `GET /deploys/:id/log` | `host.deploy.create` | deployer |
| `POST /deploys/:id/activate` · `POST /sites/:id/rollback` (`{ deploy_id?, expected_active? }`) | `host.deploy.create` | deployer |
| `DELETE /deploys/:id` (not the active one) | `host.site.manage` | maintainer |
| `GET/PUT/DELETE /sites/:id/source` (`{ provider, repo_url, ref }`) | `host.site.manage` | maintainer (GET: member) |
| `POST /sites/:id/source/deploys?ref=…&commit_sha=…` (the upload body; always a preview) | `host.deploy.create` | deployer |
| `POST/DELETE /projects/:id/takedown` · `POST/DELETE /sites/:id/takedown` | `host.site.manage` | Network staff only |
| `GET/POST /sites/:id/domains` · `POST /domains/:id/verify` · `DELETE /domains/:id` | `host.domain.manage` | maintainer (reads: member) |
| `GET /resources[?project=&kind=&cursor=&limit=]` · `GET /resources/:ovrn` (the resource index, ADR-048) | `host.resource.read` | first-party service only |

Errors are RFC 9457 problems (`application/problem+json`, with the legacy `error` field). A refused upload answers 413/422 with `deploy_id` and the log lines; `503 upload.busy` (with `Retry-After`) when `HOST_MAX_CONCURRENT_UPLOADS` uploads are already being validated; `507 storage.host_full` while the disk has less than `HOST_MIN_FREE_BYTES` free. Network staff (`role: admin`) can read every project, site, deploy and log, delete sites, projects and domains, set quotas, and **take a site or project down** (451 on every host, content kept for review, members see the reason and cannot publish or delete around it); they cannot publish into a tenant's site.

The five capability ids (`host.site.config` since v0.83.0; `host.resource.read` planned since v0.107.0) and the service manifest are released in `openvibe-contracts`, which Host pins, and the CI contract check is blocking; `test/host-contracts-events.test.js` holds the routes, guards and emitted events to the released manifests.

#### The resource index (ADR-048 section 3)

`GET /api/v1/resources` lists the resources Host owns as a page of `common.resource-summary@1`
(`common.resource-list-result@1`: `{ resources, next_cursor }`), and `GET /api/v1/resources/:ovrn` reads
one by its computed OVRN. It is the same path, shape and paging every authority answers, so
OpenVibe.Services can fan out over all of them and merge:

| Kind | Rows | Name | State |
|---|---|---|---|
| `host.site` (`sit_`) | `host_sites` | the site's label (`<name>.openvibe.host`) | `active` / `deleted` |
| `host.deploy` (`dpl_`) | `host_deploys` | — | `ready` / `failed` / `deleted` |
| `host.domain` (`dom_`) | `host_domains` | the hostname it answers on | `pending` / `verified` / `failed` / `lapsed` |

Every summary carries `service: "host"`, the `project_id` of the project that owns it, the `created_by`
person as `owner` when it is a `usr_` subject, and its `ovrn` computed by
`contracts.resources.nameOf` — `ovrn:host:<prj_…>:site/<sit_…>`, `:deploy/<dpl_…>`,
`:domain/<dom_…>`. Host lists no projects (only Network lists projects): Host mints its own `prj_` ids
until it adopts Network projects (ADR-014). `?project=prj_…` is the tenancy boundary — with it only
that project's rows answer, and one of another project is never returned; without it the first-party
caller sees every Host-owned resource. `?kind=` narrows to one kind, `?cursor=` is an opaque keyset
position and `?limit=` is 1–1000 (default 100). A query that cannot be honoured is `400
resources.bad_query`; an OVRN that names nothing is `404 resources.unknown_resource`. The index is
first-party: only a service token holding `host.resource.read` is admitted (a person gets 403, no token
401), and `test/resource-index.test.js` validates every summary and page against the released schemas.

### Activation and rollback

Activation is one PostgreSQL transaction: a compare-and-set on the site's `active_deploy_id`, an activation record and the `host.deploy.activated` event. If any part fails, none of it happens. `expected_active` turns a racing operator's switch into a 409. Rollback goes to a named ready deploy of the same site, or to the most recent previously active one that still exists. The active deploy cannot be deleted. Deleting another deploy removes its objects when no other deploy of the project uses them.

### Git deploys (Phase 1)

A site can be connected to a Git repository, but **the build runs in the project's own CI, never in Host**. Host never clones or fetches the repository, holds no credential for it, and executes nothing; the CI's token is the trust boundary.

- **Connect.** A maintainer sets the site's source: `PUT /api/v1/sites/:id/source` with `{ "provider": "github", "repo_url": "https://github.com/<owner>/<repo>", "ref": "main" }`. `repo_url` must be `https` on the provider's own host (`github.com`, `gitlab.com`, `codeberg.org`) with the path `owner/repo` and an optional `.git`, and no user, port, query or fragment; `ref` must be a branch name by `git check-ref-format`'s rules (at most 200 characters, no `..`, no leading `-`). Any other field (a token, a key) is refused with 422. The row (`host_site_sources`) is public provenance; the read role can GET it.
- **Deploy.** The CI checks out the commit, builds, and posts the output to `POST /api/v1/sites/:id/source/deploys?ref=<branch>&commit_sha=<full sha>` with the same body and limits as an upload (`ref` and `commit_sha` may also be multipart fields). It authenticates as an app (`app:app_…`, a Network client-credentials token for audience `openvibe.host` with `host.deploy.create`) that is a `deployer` of the project, or with a person's Bearer token. A site with no source answers `409 source.not_connected`, another branch `409 source.ref_mismatch`, a commit that is not 40 or 64 lowercase hex characters `422 source.commit_sha`, and `activate` `422 source.activate`. The files then go through exactly the upload validation; a refused file is a failed deploy with `host.deploy.failed`.
- **Preview, then approve.** An accepted build is stored as a deploy with `source: "git"` and an immutable `host_deploy_git` row (provider, repo URL, ref, commit), written in the same transaction, and becomes the site's live preview at `/preview/<deploy-id>/` (one hour, members only). It never touches the active deploy. A deployer approves it with the ordinary `POST /api/v1/deploys/:id/activate`; responses show the provenance as `deploy.git`.

A minimal GitHub Actions workflow (the app's client id and secret are repository secrets; Host never sees them):

```yaml
name: Deploy to OpenVibe Host
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build          # your build; the output is in dist/
      - name: Post the build as a preview
        env:
          CLIENT_ID: ${{ secrets.OPENVIBE_CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.OPENVIBE_CLIENT_SECRET }}
          SITE_ID: ${{ vars.OPENVIBE_SITE_ID }}
        run: |
          TOKEN=$(curl -fsS https://openvibe.network/oauth/token \
            -d grant_type=client_credentials -d audience=openvibe.host \
            -d client_id="$CLIENT_ID" -d client_secret="$CLIENT_SECRET" | jq -r .access_token)
          tar -czf site.tar.gz -C dist .
          curl -fsS -X POST "https://openvibe.host/api/v1/sites/$SITE_ID/source/deploys?ref=${GITHUB_REF_NAME}&commit_sha=${GITHUB_SHA}" \
            -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/gzip' --data-binary @site.tar.gz
```

### Events

Through the `openvibe-sdk` v0.35.0 transactional outbox (`event_outbox`), inside the transaction that makes the change:

| Event | When | Payload |
|---|---|---|
| `host.deploy.created` | an upload became a ready deploy | `project_id, site_id, site, source, file_count, total_bytes, manifest_sha256` |
| `host.deploy.activated` | a site's active deploy changed | `project_id, site_id, site, deploy_id, previous_deploy_id, rollback` |
| `host.deploy.failed` | an upload was refused | `project_id, site_id, site, code, problems` (codes only, never file contents) |
| `host.domain.verified` | a custom domain's TXT record was found | `project_id, site_id, site, hostname` |

The relay publishes with Host's service token (`events.event.publish`, audience `openvibe.events`) only when `EVENTS_URL` and `OV_OAUTH_CLIENT_SECRET` are set. Otherwise rows wait and `/api/ready` says the relay is off.

These tenant events have subject `deploy` and visibility `internal`; `host.deploy.activated@1` in openvibe-contracts 0.58.0 is the tenant shape only. Releases of network services are a separate event type: the operator plane (`ovhost`) publishes `host.release.published` with subject `release` and visibility `public` ([docs/release-notifications.md](docs/release-notifications.md)).

### Dashboard

Server-rendered pages with the shared chrome (`openvibe-shared` v2.15.0 `shell.page`: navbar and theme loader from the Network, `<noscript>` navigation, SSR footer, app icon, legal pages). Every action is a plain form, so it works without JavaScript: projects, quotas and usage, members, sites, folder or archive upload, deploys with activate/rollback/delete, activation history, upload logs and file lists, domains with their DNS records and a "check DNS now" button. Pages are `private, no-store`, `noindex`, `frame-ancestors 'none'`.

### Observability

`GET /api/ready` (openvibe-shared/ready): `db` and `storage` are required; `network_jwks`, `events_relay` and `domain_checks` are optional and report degradation. `GET /release.json`. `GET /metrics` for direct loopback callers only (nginx also returns 404): HTTP golden signals by route template (tenant requests are one `tenant_site` series), process metrics, release info and `host_sites`.

### IndexNow (openvibe-shared/indexnow)

`INDEXNOW_KEY` (`openvibe-shared` v2.2.0) turns on IndexNow. The key file is served at `/<key>.txt` on every host (the dashboard and each tenant site, so an engine can verify a ping that names a tenant host). When a tenant site's active deploy appears, changes (a new deploy or a rollback) or goes away (the site or its project is deleted), the site's page and its `/sitemap.xml` are queued to `api.indexnow.org`; a verified custom domain is queued when it starts serving. The module batches and debounces (one POST per 30 s window), filters to https URLs on the pinged host and never throws, so a failed ping cannot fail a deploy. A ready deploy that is not active (a draft) and a sandbox site (already `noindex`) never ping. Unset → off: no key route is mounted and nothing is sent. Tests and drills never set it (the drill's override in [`host.example.json`](host.example.json) sets `INDEXNOW_KEY` empty).

### Grants and registration (for the lead)

- OpenVibe.Network OAuth client **`host`**, redirect `https://openvibe.host/auth/callback`, scope `profile theme`. The same client is the service principal `svc:host`.
- Grant `[host, events.event.publish, openvibe.events]`.
- With `HOST_OBJECT_STORE=media`: grants `[host, media.object.upload, openvibe.media]`, `[host, media.object.read, openvibe.media]`, `[host, media.object.list, openvibe.media]` and `[host, media.object.delete, openvibe.media]`, covering the `host` namespace and its subtree (`host.*`), plus a `host` tenant in Media. Network-side; Host asks for the verbs as its scope.
- Callers of Host get `[<client>, host.site.manage | host.deploy.create | host.domain.manage, openvibe.host]` as needed. None exist yet (Codes, the expected first caller, is not built).
- The resource index is read the other way round: **OpenVibe.Services** (not built yet) calls `GET /api/v1/resources` on `svc:services` with `host.resource.read` for audience `openvibe.host`, without `X-OV-Subject` (the capability is first-party and answers the whole index).
- Released in `openvibe-contracts` v0.107.0 (CI contract check blocking); v0.32.0 added the takedown routes to `host.site.manage.implementedBy` and v0.107.0 added the git-source routes. `host.resource.read` stays `planned` with an empty `implementedBy` until Opus flips it after the deploy.

### Deploying Stage B (for the operator)

The service runs on the host (loopback, since 2026-09-23) and the pending tenant vhost of step 9 is installed; the launch has not been run.

1. **DNS.** `openvibe.host` and `*.openvibe.host`: `A`/`AAAA` records to the host. If the zone is on Cloudflare, keep `*.openvibe.host` **DNS-only** (grey cloud), or set `HOST_CNAME_TARGET` to a DNS-only name: custom domains in other accounts cannot CNAME to a proxied hostname (Cloudflare error 1014). Set `HOST_ORIGIN_IPV4`/`HOST_ORIGIN_IPV6` if tenants should be told the addresses for apex domains.
2. **Wildcard certificate.** A DNS-01 challenge is required for `*.openvibe.host`, for example `certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/certbot-cloudflare.ini -d openvibe.host -d '*.openvibe.host'`. The credentials file is root-only (0600), outside every repository, and never passed to Host. The certificate lands in `/etc/letsencrypt/live/openvibe.host/`; another location is passed with `--wildcard-cert <name|dir>`.
3. **Network.** Register the OAuth client `host` and the grant above.
4. **Code and state.** `sudo -u ubuntu git clone https://github.com/OpenVibers/OpenVibe.Host /opt/openvibe.host && cd /opt/openvibe.host && sudo -u ubuntu npm ci --omit=dev --no-audit --no-fund`. This checkout is the service; the root-owned `/usr/local/lib/openvibe-host` stays the `ovhost` CLI. The unit's state directory is `/var/lib/openvibe-host-api` (database and objects), deliberately **not** `/var/lib/openvibe-host`, which is `ovhost`'s own root-only state.
5. **Environment.** `/etc/openvibe/host.env` (0600), from [`.env.example`](.env.example): at least `BASE_URL=https://openvibe.host`, `HOST_SITES_DOMAIN=openvibe.host`, `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID=host`, `OV_OAUTH_CLIENT_SECRET`, `HOST_FORM_SECRET`, `EVENTS_URL`, `INDEXNOW_KEY` (optional).
6. **Unit.** `sudo cp deploy/systemd/openvibe-host.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-host`, then `curl -s http://127.0.0.1:4910/api/ready`.
7. **nginx.** Add the `host` entry from [`host.example.json`](host.example.json) to `/etc/openvibe/host.json`, update `/usr/local/lib/openvibe-host`, then `sudo ovhost nginx tenants host` (review) and `sudo ovhost nginx tenants host --install` (writes `openvibe.host.conf` and `openvibe.host-custom-domains.conf`, `nginx -t`, reload; restored on failure). [`deploy/nginx/openvibe.host.conf`](deploy/nginx/openvibe.host.conf) is a reference copy.
8. **Certificates.** `sudo ovhost certs renew --install` renews the existing lineages with `certbot renew` (the wildcard) and issues `certbot certonly --webroot -w /var/www/certbot -d <hostname>` for every verified custom domain that still has no certificate (the generated port-80 block already answers the ACME challenge), then re-renders the tenant vhosts through the same transactional install. A failure leaves that domain HTTP-only and fails the command; the others still proceed. `ovhost certs renew` without `--install` only reviews. `deploy/systemd/openvibe-certs.timer` runs it twice a day (the [unit](deploy/systemd/openvibe-certs.service) runs as root; certificates never pass through the Host API). The manual equivalent is `sudo ovhost nginx tenants host` to list the domains still waiting, then `certbot certonly` and `ovhost nginx tenants host --install` for each.
9. **Launch.** Follow [docs/launch.md](docs/launch.md). Until then [`deploy/nginx/openvibe.host-tenants-pending.conf`](deploy/nginx/openvibe.host-tenants-pending.conf) answers every `*.openvibe.host` name with a 404 over the wildcard certificate (installed 2026-09-23; without it the wildcard fell through to nginx's default server). `ovhost nginx tenants host --install` removes it in the same `nginx -t` and reload that installs the tenant vhost (`nginx.tenants.replaces`), and puts it back if the test fails.

### Not done yet (Stage B)

- Uploads are held in memory while they are validated (bounded by `HOST_MAX_UPLOAD_BYTES` and `HOST_MAX_UNPACKED_BYTES`), so the service needs that much headroom per concurrent upload.
- Objects are on the service's local disk by default; there is no replication. `HOST_OBJECT_STORE=media` (opt-in) additionally writes every object through to OpenVibe.Media and keeps local disk as the read cache. `ovhost backup host` archives `/var/lib/openvibe-host-api/objects` (the inventory's `objects` entry) alongside `ov_host`, uploads the encrypted archive off-host, and a restore drill extracts it and checks every blob's sha256. The database (`ov_host` on the host's data role, ADR-035; schema in [migrations/](migrations/)) is backed up with the others by pgBackRest.
- Certificates for custom domains are issued and installed by `ovhost certs renew --install` (step 8) on the `openvibe-certs.timer`; certbot stays outside the Host service and no key file is read.
- Projects are created in Host. When Network has projects (ADR-014), Host should accept only Network project ids and read membership from Network.
- `openvibe.host` is not on the Public Suffix List, so a tenant page can still set `Domain=openvibe.host` cookies (a cookie bomb breaks the dashboard and other tenant sites for that visitor). The protections above do not depend on it. [docs/threat-review.md §5](docs/threat-review.md#5-the-public-suffix-list-question) records the decision (launch without it) and the recommended follow-up (dashboard off the tenant zone, then list the zone).
- Tenant objects are in `ovhost backup`: the inventory declares them as `objects` (`/var/lib/openvibe-host-api/objects`), the backup archives the tree, the off-host copy encrypts it, and a drill extracts it and checks every blob's sha256. With `HOST_OBJECT_STORE=media`, this archives the read cache and Media holds the durable objects.
- Git deploys are Phase 1 only (see [Git deploys](#git-deploys-phase-1)): the project's own CI builds and posts the output. Host never clones, fetches, holds a repository credential or builds; in-Host builds belong to Run (plan T14). There is no webhook: a push reaches Host only through the CI's call.
- Tenant sites publish their own sitemap/robots/feed; when a deploy ships no `sitemap.xml` or `robots.txt`, Host generates one (the manifest's HTML pages on the host the request came in on, so a verified custom domain gets its own `sitemap.xml`; sandbox projects get `Disallow: /` and are `noindex`). A tenant's own file at either path always wins. The dashboard host serves `/robots.txt` and `/sitemap.xml` (front page and legal pages).
- The Codes portal (Wave 20) does not exist, so there is no public developer onboarding for Host yet.

### Acceptance (what `npm test` demonstrates for Stage B)

- **Tenant isolation** (`test/host-isolation.test.js`): 25 path tricks (`..`, `%2e%2e`, `%2f`, `%5c`, `%00`, double encoding, absolute object-store paths, sha256 paths, `/host.db`) and 14 `Host` header tricks never return another tenant's bytes; absolute-form targets that disagree with `Host` are refused; tenant hosts never reach the API, auth, metrics or readiness; identical bytes are stored per project; every API route answers 404 to non-members; the API ignores cookies.
- **Traversal and links refused** (`test/host-uploads.test.js`): `..`, absolute, backslash, non-ASCII, pax and GNU long-name overrides, symlinks, hard links, devices, FIFOs, hidden files, server-side code, credentials, unknown types, duplicates, conflicts, corrupt archives and a 40 MB gzip bomb. Each becomes a failed deploy with a log and `host.deploy.failed`, nothing is stored, and the active deploy keeps serving.
- **Quotas** (`test/host-quota-auth.test.js`): deploys per day (rolling), deduplicated storage, files, bytes per file, request size, sites, custom domains, sandbox limits; service-token audience/capability, `X-OV-Subject` delegation, app principals, sandbox tokens, mods, staff.
- **Atomic rollback** (`test/host-rollback.test.js`): 320 requests while the pointer flips 40 times all return one whole deploy; a failure inside the switch changes nothing; `expected_active` conflicts; database-level immutability; the pointer survives a restart.
- **Custom domains** (`test/host-domains.test.js`): not served until verified; wrong or missing TXT stays pending; first verified proof wins; OpenVibe domains refused; removal and site deletion stop serving; background verification, pending expiry and lapse.
- **No secrets in responses** (`test/host-secrets-dashboard.test.js`): no API, dashboard, readiness or event body contains the OAuth client secret, the form secret, an uploaded `.env`'s values or any credential-like string; response objects are allowlisted; plus the dashboard (chrome, forms, CSRF against same-site tenant origins, planted cookies) and machine endpoints.
- **Lifecycle, headers, events** (`test/host-lifecycle.test.js`, `test/host-contracts-events.test.js`): content types, ETag/304, ranges, immutable caching, CSP, nosniff, custom 404, 405; valid event envelopes delivered by the relay with a Network service token; the proposals match the guarded routes.
- **Tenant vhosts** (`test/nginx-tenants.test.js`): the wildcard vhost with the certificate path parameter, HTTPS only for verified domains that have a certificate, hostile database values refused before they reach nginx, transactional install that removes the pending vhost in the same change, `www.` redirect, client address headers from `$remote_addr` only, no key file read.
- **Abuse controls** (`test/host-abuse.test.js`): staff takedowns (451 with Clear-Site-Data on every host, content kept, members cannot publish or delete around them, lift), certificate-validation paths refused, uploads validated two at a time (503 + Retry-After), the disk floor (507), the per-person project cap, fingerprinted assets capped at an hour at a CDN.
- **IndexNow** (`test/indexnow.test.js`): off without `INDEXNOW_KEY` (no key route, nothing sent); with a key the key file is served at `/<key>.txt` as `text/plain` on the dashboard and on tenant hosts; activating a deploy pings the site page and its sitemap, a rollback or a site deletion pings again, a ready-but-not-active deploy and a sandbox site never ping.
- **Tenant sitemap/robots** (`test/host-sitemap.test.js`): a deploy that ships none gets a generated `sitemap.xml` (the manifest's HTML pages, `index.html` → the directory URL, the error page left out, on the host the request came in on — so a verified custom domain gets its own) and `robots.txt` (crawlers welcomed and the sitemap named; a sandbox site gets `Disallow: /` and stays `noindex`); a file the tenant uploaded at either path wins; correct content types and caching; HEAD works; no secret in the body.
- **Preview deploys** (`test/host-preview.test.js`): `POST /sites/:id/deploys?preview=1` stores a deploy with `source=preview` and points the site at it without activating (the public site keeps serving its active deploy); `/preview/<deploy-id>/…` on the dashboard is served to a project member only — non-members and signed-out callers get a plain 404, a public tenant host never serves it, every response is `noindex, no-store`, and the response's CSP sandboxes the tenant content into an opaque origin (no `allow-same-origin`) so it can never act as `openvibe.host`; a preview is never pinged to IndexNow and never listed in the site's sitemap; it vanishes when it expires, when the site deploys or rolls back, or when it is deleted; and it serves only its own project's objects (a same-named file of another project is not reachable).
- **Git deploys** (`test/host-git-source.test.js`): a maintainer connects a source, a deployer gets 403 and a non-member 404, a bad URL, provider or ref is 422 and a credential field is refused; an app deployer's ingest is a `source=git` deploy with its `host_deploy_git` row and the site's preview while the public host keeps serving the active deploy; activate flips the pointer and clears the preview; an invalid file (a failed deploy and `host.deploy.failed`), a ref mismatch, an unconnected site, a bad SHA and `activate=1` all leave `active_deploy_id` unchanged; `host_deploy_git` rows are immutable; source responses hold only the allowlisted fields.
- **Resource index** (`test/resource-index.test.js`): no token 401, a person 403, a service token without `host.resource.read` 403 and with it 200; every summary and every page validates against `common.resource-summary@1` and `common.resource-list-result@1`; all three kinds (sites, deploys, domains) with their states, names, owners and OVRNs; `?project=` never returns another project's rows; `?kind=` narrows and an unknown kind is an empty page; the cursor pages the whole index with no duplicate, gap or reordering; `GET /:ovrn` reads the one resource whose computed OVRN it is (a wrong project, another service's OVRN, an unknown id and a non-OVRN are 404 `resources.unknown_resource`); a bad query is 400 `resources.bad_query`.
- **Home-page size budget** (`test/perf-budget.test.js`): the server on a fresh database, the home page measured with `openvibe-shared/perf-budget` — html 15.9 KB (4.3 br), js 4 files 212.2 KB (49.9 br), css 1 file 3.1 KB (0.9 br), 0 external — within the committed budgets.
- The isolation test also covers cross-origin reads from a tenant page (no CORS grant anywhere), ETag/Range existence oracles, delegated service tokens, app principals and the dashboard.

Not demonstrated yet: any of this on the production host.

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). Stage B's threat review, with the decisions it
records: [docs/threat-review.md](docs/threat-review.md). The rules the code keeps:

- **Secrets.** `ovhost` reads service env files for variable **names** and emptiness only; it never
  stores, prints or snapshots a value. The one exception is its own root-only `/etc/openvibe/backup.env`.
  Backups are root-only (0700/0600) and off-host copies are AES-256-GCM encrypted and authenticated.
- **Operator plane.** `ovhost` runs as root and drops to the checkout owner for git, npm, builds and
  SQLite; it never stops or restarts a socket unit except the release-layout rebind; a protected-session
  probe that cannot answer counts as sessions active; tracked local changes block a deploy.
- **Tenants (Stage B).** Static files only: no tenant code runs, no tenant secret is stored, uploads are
  validated and content-addressed, tenant hosts get no CORS grant, staff takedowns answer 451. Custom
  domains are proven by DNS TXT through the configured resolver, and certificates never pass through
  the API. Dashboard and API auth is Network SSO and service tokens with the `host.*` capabilities.
- **Egress.** Stage B calls only its configured Network and Events hosts; `ovhost` calls the host's own
  services, Network, Events, Prometheus and the backup bucket.

## Development

```
npm test                    # every test, each file in its own process (Node 22)
node test/deploy.test.js    # one file
npm run dev                 # Stage B service on http://localhost:4910 (HOST_SITES_DOMAIN=localhost serves sites at http://<site>.localhost:4910)
```

Stage B tests (`test/host-*.test.js`) boot the service on a temp database and object store with a controllable clock, a mock Network (real RS256 keys) and a DNS table, and talk to it over raw HTTP so they can send any `Host` header and request target.

Stage A: everything that touches the system goes through the executor (`lib/executor.js`). The tests replace it with `test/fake-host.js`, an in-memory host with git repos, systemd units, npm, nginx, ss, HTTP endpoints and SQLite. No test runs systemctl, git, npm, nginx or curl against the real machine. `test/executor.test.js` covers the real executor only where that is safe: SQLite on a temp database, HTTP to a local server, and temp files.

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

**Stage B against this rule (2026-09-23):** every item is met in code and tests. The evidence per
item, the exact launch steps (tenant vhost with the pending vhost removed in the same change, Sites,
Network registry), verification and rollback are in [docs/launch.md](docs/launch.md); the threat
review is [docs/threat-review.md](docs/threat-review.md). The launch has not been run.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.15.0
<!-- versions:end -->
