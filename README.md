# OpenVibe.Host

> The network's deployment/control plane first; then isolated hosting for community sites, bots and mods.

**Status:** alpha. Stage A (operator plane) is a CLI, `ovhost`, tested against a fake host. It is installed on the production host (2026-09-23, `/usr/local/bin/ovhost`, inventory `/etc/openvibe/host.json`) and used read-only (`status`, `validate`); no service's deploy has moved to it yet. Stage B (tenant static hosting) is a service, written and tested, **not deployed**. Stage C (sandboxed user code) is **not started**.
**Domain:** `openvibe.host` (dashboard and API) and `*.openvibe.host` (tenant sites). The domain keeps its placeholder page on [OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until Stage B is deployed and launched (see [Launch rule](#launch-rule)).
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.3 and §15.17; roadmap Wave 21.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Every repository ships its own deploy script, and each one encodes rules learned from an outage. Stage A pulls those rules into one tool that works the same way for every service on the host:

| Rule | Where it came from | How `ovhost` applies it |
|---|---|---|
| Never stop `openvibe-live.socket`; restart only the service unit | Live (socket activation, `deploy/systemd`) | Every `systemctl` call goes through a guard that refuses `stop`/`restart`/`reload` on a `.socket` unit. A socket that is down gets `start`ed. |
| Don't restart Live while anyone is live; `--wait-idle` holds the restart | Live `deploy.sh --wait-idle` (`/api/streams`) | Protected-session probe (`http-json-count`). Checked before the checkout moves and again right before the restart. |
| Don't restart Media while it is recording | Media hazard H3 (`vods-orphans/` in B2) | Protected-session probe (`sqlite-count`: `SELECT count(*) FROM vods WHERE is_recording = 1`), run read-only **as the service user**. |
| Poll `/api/ready` after a restart; roll back if it doesn't come up | Live `deploy.sh` | Readiness poll with a timeout; on failure the checkout goes back to the previous sha, deps are reinstalled if they differed, the unit is restarted again. |
| Install only when the lockfile or dependencies changed; restore `package-lock.json` afterwards | Network `deploy.sh` and host practice | `npm install --omit=dev` as the checkout owner, then `git checkout -- package-lock.json` if npm rewrote it. |
| Every dependency must resolve before anything restarts | Tools `deploy.sh` (an emptied `file:` link crash-looped every unit) | `node_modules/<dep>/package.json` must exist, parse and name the package. A broken dependency is reinstalled once, and if it still fails the deploy aborts and the checkout is restored. |
| Build, install vhosts, `nginx -t`, reload | Sites `deploy.sh` | `build` hooks and `nginx.installOnDeploy`. Vhost installs are transactional: if `nginx -t` fails, the previous files come back and nginx is not reloaded. |
| git as the checkout owner; never leave root-owned files under `/opt` | Community/Events/Tools checkouts | git, npm, builds, SQLite queries and backups all run as the declared owner/service user (`runuser` from root, `sudo -u` otherwise). |

Stage A adds a few safety rules of its own:

- A protected-session probe that **cannot answer** while the service is running counts as "sessions may be active", never as zero. Live's `deploy.sh` treated a failed `curl` as 0 live streams.
- Tracked local changes block a deploy. The script never discards them.
- One operation per service at a time, using a pid lock with stale-lock recovery.
- Every attempt goes into the release log, refusals and failures included.

## Owns

- Stage A: the host inventory (services, units, env names, ports, probes, drain policy), environment validation, release install and rollback for git-checkout services, readiness and drain orchestration, the release log, certificate inventory, nginx vhost rendering and transactional install, config snapshots, SQLite backup hooks, restore drills.
- Stage B: tenant projects (keyed by project id), static sites, immutable content-addressed deploy artifacts, activation and rollback, default and custom domains (DNS TXT verification), per-project quotas, upload/validation logs, the tenant vhosts (`ovhost nginx tenants`).
- Later (Stage C): sandbox profiles, budgets, secret references, outbound policy.

## Does not own

- Product business logic. Host calls product hooks (`build`) and reads product endpoints (`/api/ready`, `/api/streams`). It never embeds product rules.
- Secrets. `ovhost` reads env files only to learn variable **names** and whether each one is empty. It never stores, prints or snapshots a value.
- Platform-wide credentials for hosted code (never).
- Certificate issuance/renewal (certbot does this today). Stage A only takes inventory; Stage B never handles a certificate or key through its API.
- Projects as an identity concept: ADR-014 puts projects in OpenVibe.Network. Until Network has them, Host creates a `prj_` project for its owner and records `network_project_id` when one is given.
- Tenant secrets. Stage B stores none (no environment variables, no build secrets, no deploy keys).

## Depends on

- OpenVibe.Contracts (`openvibe-contracts` v0.19.0): service manifests (vhost rendering, snapshots, the first-party domain list), ids, problem+json, service-token verification, capability checks.
- OpenVibe.Network (Stage B): SSO for the dashboard, the JWKS that verifies user and service tokens, client-credentials tokens for the outbox relay.
- OpenVibe.Events (Stage B): `host.*` events through the `openvibe-sdk` v0.2.2 transactional outbox.
- `openvibe-shared` v1.3.0 (Stage B): shared chrome, legal pages, `/release.json`, `/metrics`, `/api/ready`.
- OpenVibe.Media: not yet. The roadmap stores artifacts "through Media where practical"; Stage B keeps them on local disk for now (see [Not done yet](#not-done-yet-stage-b)).

## Stages

| Stage | Scope | State |
|---|---|---|
| **A: operator plane** | `ovhost` CLI and library: inventory, validate, plan, deploy (`--wait-idle`/`--force`), automatic rollback, rollback, status, releases, certs, nginx render/install, snapshot, backup, restore drill. No daemon and no server. Port **4910** is reserved for a later operator API. | **alpha**: written and tested (fake host, plus the real executor against temp SQLite/HTTP/git). Installed on the host; used read-only so far. |
| **B: tenant static hosting** | The Host API service (port 4910): projects, sites, immutable content-addressed deploys, activation and rollback, `<site>.openvibe.host` and TXT-verified custom domains, quotas, upload logs, events, a server-rendered dashboard; tenant vhosts via `ovhost nginx tenants`. | **alpha**: written and tested (`npm test`, against a temp database, a mock Network and a DNS table). Not deployed. |
| **C: sandboxed user code** | Isolation profiles, CPU/memory/time/network/storage budgets, secret references, outbound policy, metering, kill/revoke without touching platform services. | **not started**, deliberately. Blocked until isolation and metering are proven. Nothing in Stage B runs tenant code. |

Not in Stage A yet (from the charter/roadmap list): container adapters, DNS adapters, certificate **renewal**, logs/metrics links, incident/maintenance controls, the release-manifest/active-client work in §15.18, `host.release.deployed|rolled_back` events (they need an Events outbox and a service principal), and the Wave 22 cutover runbook. Restore drills (`ovhost drill`) are written and tested against the fake host but have not been run on the host yet.

## Acceptance (Stage A)

What the tests demonstrate (`npm test`, every system call made against `test/fake-host.js`):

- A Live restart is **refused** while `/api/streams` reports a live stream. The checkout does not move, nothing is restarted, and the refusal is logged. `--wait-idle` waits for two idle checks in a row. `--force` proceeds and prints a warning. An unreachable probe counts as live.
- A Media restart is **refused** while `vods.is_recording = 1`. The query runs read-only as `ubuntu`.
- A failed readiness check **rolls back** to the previous sha, reinstalls the previous dependencies and restarts again (exit 3). If that also fails, the exit code is 4 with MANUAL INTERVENTION.
- A dependency that does not resolve **aborts before any restart** and restores the checkout (exit 2).
- Env validation **never outputs a value**, in text or JSON output.
- The socket unit is **never stopped or restarted**, in any flow.
- Only the service being deployed is restarted. Static-only changes (for example Live `public/`) are deployed without a restart, even while streams are live.
- `nginx -t` failures restore the previous vhost state. `certs` never reads a key file. Snapshots contain no secret values or remote-URL credentials.
- A **restore drill** restores the latest backup into a service-user-owned temp directory and requires `integrity_check = ok`. It starts a sandboxed second instance through `systemd-run` with the production env file plus an override file. It compares the declared paths and row counts with production, then stops the instance by its own pid and removes the directory. Failed integrity, a readiness timeout, an instance that dies, mismatches and a failed `systemd-run` are all reported, logged and cleaned up. It refuses to run without root or on a port already in use. A filesystem diff of the fake host shows it writes nothing outside the drill directory, its lock and its log, and it never reads the env file or passes on a secret-looking unit `Environment=`.

Not demonstrated yet: any of this on the production host. The Wave 21 exit criterion ("deploy, restart and roll back one service without interrupting unrelated runtimes or protected sessions") still needs a run on the host, with evidence.

## Using ovhost

```
ovhost status [<service>...]            unit state, sha, readiness, protected sessions
ovhost validate <service>               env NAMES, unit files, port, vhost + nginx -t, deps
ovhost env-names <service>              names declared in the checkout's .env.example
ovhost plan <service> [--to <sha>] [--no-fetch]
ovhost deploy <service> [--wait-idle] [--force] [--restart] [--to <sha>] [--install-units] [--ready-timeout <s>]
ovhost rollback <service> [--to <sha>] [--wait-idle] [--force]
ovhost releases <service> [--limit <n>]
ovhost certs [--warn-days <n>]
ovhost nginx render <service> [--variant http|sse|websocket] [--manifest <file>] [--install]
ovhost nginx tenants <service> [--wildcard-cert <name|dir>] [--install]    Stage B tenant vhosts
ovhost snapshot <service> [--out <file>]
ovhost backup <service>
ovhost drill <service> [--backup <dir>] [--keep]     restore drill (root only)
```

Every command accepts `--json` and `--inventory <file>`. `drill` exits `0` passed, `1` refused (not root, port in use, no backup, unsupported), `2` failed. Other exit codes: `0` ok · `1` usage/precondition (including a held lock) · `2` validation failed, nothing restarted · `3` not ready, rolled back and serving · `4` rollback failed, **manual intervention** · `5` protected sessions active (refused, or `--wait-idle` gave up).

### Deploy sequence

1. Take the per-service lock. Refuse if the checkout uses Live's `releases/current` layout (Stage A only drives in-place checkouts, which is what every service runs today).
2. `git fetch` as the owner, then work out the from/to shas, changed files, per-package install need and whether a restart is needed (`noRestartPaths`).
3. Refuse a tracked local change or a wrong branch.
4. **Protected sessions** (only if a restart is needed): refuse, wait (`--wait-idle` or drain policy `wait`), report (drain policy `report`, Events SSE), or `--force`.
5. `git merge --ff-only` as the owner (rollback uses `git reset --hard <sha>`).
6. Install dependencies where needed and restore the lockfile. **Verify every dependency resolves**, reinstalling a broken one once. Run the build hooks. Install repo vhosts (Sites). Install unit files if `--install-units` was given. Back up databases if a `backupOnChange` file changed.
7. Protected sessions again, immediately before the restart. If this or anything in step 6 fails, the checkout and node_modules are restored and nothing is restarted.
8. Start the socket if it is down, restart the service units, poll readiness.
9. If readiness fails, run the automatic rollback (restore, reinstall, restart, poll).
10. Append the release record to `<stateDir>/releases/<service>.jsonl`.

### Restore drills (Wave 22)

`sudo ovhost drill <service>` restores the latest `ovhost backup` (or `--backup <dir>`) and starts a second instance on a spare loopback port. It compares that instance with production, stops it and logs the result to `<stateDir>/drills/<service>.jsonl`. It also prints a Markdown row for [docs/restore-drills.md](docs/restore-drills.md), which covers the steps, the sandbox and the per-service status.

Each inventory entry's `drill` block declares:

- `port`: the service port + 10000 in the example;
- `databases`: the env var that points the service at each restored copy;
- `env`: overrides that turn side effects off. Values may use `{tmp}`, `{port}` and `{db:<name>}`;
- `dirs` to create inside the drill directory;
- `ready`: the readiness path;
- `compare`: paths, plus volatile `ignore` keys where needed;
- `counts`: `{ db, table }` pairs;
- `supported: false` with a `reason` when a second instance cannot run without side effects.

In `host.example.json`, 18 services have drill blocks. live, media, tools and games are marked unsupported, and the reasons are in the file.

The sandbox blocks writes outside the drill directory and addresses beyond loopback. Loopback stays open, so the overrides are what keep a drill away from production services. Common overrides are `OV_OAUTH_CLIENT_SECRET=` (no service tokens) and `http://127.0.0.1:9` for URLs whose empty value would fall back to a production service.

### Inventory

`host.example.json` describes every service on the host. It records the checkout, owner/`runAs`, units and socket unit, `unitSources` (repo unit files), env file, `env.required` (names, or `"from-example"`), port, loopback `ready` URL (plus headers, since Tools needs `Host: openvibe.tools`), `packages` (`"apps/*"` for Tools), install command, `build` hooks, `noRestartPaths`, the `protected` probe, the `drain` policy, `databases`, `backupOnChange` and `nginx`. The real file is `/etc/openvibe/host.json` and is **never committed**. When `ovhost` runs as root it refuses an inventory that is not root-owned or that anyone else can write, and it rejects relative paths, non-loopback probe URLs, non-SELECT probe queries and vhost names that contain a path.

`games` is listed as `managed: false`. It is a pnpm workspace with a TypeScript build, and those steps are not encoded yet. `status`, `validate`, `snapshot` and `backup` work for it; `deploy` and `rollback` refuse it.

## Installing on the host (for the operator)

Nothing here has been done yet. These are the steps:

1. **Code** is root-owned and outside `/opt`, so it never mixes with the ubuntu-owned service checkouts:
   ```
   sudo git clone https://github.com/OpenVibers/OpenVibe.Host /usr/local/lib/openvibe-host
   cd /usr/local/lib/openvibe-host && sudo npm ci --omit=dev --no-audit --no-fund
   sudo ln -s /usr/local/lib/openvibe-host/bin/ovhost /usr/local/bin/ovhost
   ```
   The tree must stay world-readable (default 0755/0644). The SQLite worker runs as `ubuntu` from this directory.
2. **Inventory:** `sudo install -o root -g root -m 0640 host.example.json /etc/openvibe/host.json`, then correct it against the machine. Check the Community database path, the Tools unit list, and Events, which was not deployed as of 22 Sep.
3. **State:** `/var/lib/openvibe-host` (root, 0750) holds the release logs, locks, snapshots and drill logs. `/var/lib/openvibe-drills` (root, 0711) holds one directory per running drill, owned by the service user and removed afterwards. `/var/backups/openvibe/<service>` is created per service, owned by the service user, so the backup worker can write there. Both directories are created on first use.
4. **Run as root:** `sudo ovhost …`. `ovhost` drops to `ubuntu` for git/npm/SQLite (`runuser`) and needs root for `systemctl`, `nginx -t`, reading `/etc/openvibe/*.env` (names only) and writing vhosts. For least privilege, give operator accounts a sudoers rule for `/usr/local/bin/ovhost` alone instead of a general `ALL`. Do **not** grant it to the `ubuntu` service user if that account has no sudo today.
5. **First run:** `sudo ovhost status`, then `sudo ovhost validate <each service>`, then `sudo ovhost plan live`, all read-only apart from `git fetch`. Adopt `deploy` one service at a time, starting with one that has no protected sessions.

## Stage B: tenant static hosting

A Node service (`server/`, Express 4, better-sqlite3, port **4910**, service id `host`) that hosts static sites for OpenVibe projects. Every request is dispatched on its `Host` header first:

| Host | What answers |
|---|---|
| `openvibe.host` (the `BASE_URL` host) and loopback | the dashboard, `/api/v1`, `/auth/*`, `/api/ready`, `/api/health`, `/release.json`, `/metrics` (direct loopback only), legal pages |
| `<site>.openvibe.host` (one label) | that site's active deploy, and nothing else: no API, no sign-in, no cookies |
| a custom domain with `status = verified` | the site it was verified for |
| anything else (including pending, failed or lapsed custom domains, and `a.b.openvibe.host`) | `404 Unknown host`, with no tenant content |

### Model

- **Projects** (`prj_<ULID>`) have an owner (a `usr_` subject), an environment (`production` or `sandbox`), members with a role (`owner` > `maintainer` > `deployer`), and optionally the `network_project_id` of the OpenVibe.Network project (ADR-014: Network owns projects; until it has them, Host creates one for its owner). Every Host row and every stored object is keyed by the project id.
- **Sites** (`site_<ULID>`) have a name (one DNS label, 3–40 characters, reserved names refused) that is their default host, `<name>.openvibe.host`, and a pointer to the active deploy. A deleted site's name is held for 30 days so nobody else can serve content on links that still point there.
- **Deploys** (`dpl_<ULID>`) are immutable artifacts: a manifest (`host.deploy-manifest@1`: path, sha256, size and content type of every file, file count, total bytes) with its own sha256, file rows, and the upload/validation log. Database triggers refuse any update of a deploy's artifact columns or file rows. The bytes are content-addressed per project: `<HOST_STORAGE_DIR>/projects/<prj_…>/<aa>/<sha256>`.
- **Domains**: every site has its default domain. A custom domain is added as `pending` and becomes `verified` (and served) once `_openvibe-host.<hostname>` has the TXT record `openvibe-host-verification=<token>`. A verified name belongs to one site. OpenVibe domains (every domain in the released service manifests, `openvibe.<tld>`, the sites domain itself) can never be claimed. The worker re-checks pending domains (they fail after `HOST_DOMAIN_PENDING_DAYS`) and re-checks verified ones daily: a TXT record gone for `HOST_DOMAIN_LAPSE_DAYS` lapses the domain and it stops being served.
- **Quotas** per project, enforced by Host: storage bytes (objects stored once per project, so re-uploading unchanged files costs nothing), deploys per rolling 24 hours (checked before the body is read; failed uploads count), files per deploy, bytes per file, sites, custom domains. A deploy's own size before deduplication may not exceed the storage quota. Defaults come from `HOST_QUOTA_*` / `HOST_SANDBOX_QUOTA_*`; staff override them per project. Sandbox projects get smaller quotas, no custom domains, and `X-Robots-Tag: noindex`.
- **Build logs**: Stage B has no build step. Each deploy's log records what was received, every validation problem, what was stored, the manifest digest and the activation, and says that nothing was executed. Refused uploads are recorded as `failed` deploys, so their logs are visible too.

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

Requests resolve their site once from the `Host` header, read the site's active deploy pointer once, and then read only that deploy's immutable rows. The file's bytes are opened at a path built from the site's project id and the manifest's sha256, never from the URL, so no path, encoding or `Host` trick can reach another project's objects. Absolute-form request targets must name the same host as the `Host` header.

- `GET`/`HEAD` only (405 otherwise). `/` and `/dir/` serve `index.html`; `/page` also tries `page.html`; `/dir` redirects to `/dir/` when `dir/index.html` exists.
- `Content-Type` from the manifest; strong `ETag` (the sha256) with `304` on `If-None-Match`; single byte ranges (`206`/`416`).
- `Cache-Control: public, max-age=31536000, immutable` for fingerprinted asset names (`app.3f2a9c1b.js`, `index-BdK3x9aQ.js`), `public, max-age=0, must-revalidate` for everything else, so an activation or rollback shows at once.
- `X-Content-Type-Options: nosniff`, a strict CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; … object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`), `Referrer-Policy`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`. Never a `Set-Cookie`.
- A missing file serves the deploy's own `404.html` with status 404, or a plain Host 404 page.

**Why a separate registrable domain.** Tenant pages are arbitrary HTML and JavaScript. They live under `openvibe.host`, never under `openvibe.network` or `openvibe.live`, so no OpenVibe session cookie can ever reach them (`ovhost nginx tenants` refuses a sites domain under a first-party domain). The dashboard shares `openvibe.host` with the tenants, which makes tenant pages *same-site* with it. So:

- the dashboard trusts only `__Host-` prefixed cookies (a subdomain cannot set them); the plain `ov_token` cookie the shared navbar reads is display-only and is never trusted;
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
| `GET/POST /sites/:id/domains` · `POST /domains/:id/verify` · `DELETE /domains/:id` | `host.domain.manage` | maintainer (reads: member) |

Errors are RFC 9457 problems (`application/problem+json`, with the legacy `error` field). A refused upload answers 413/422 with `deploy_id` and the log lines. Network staff (`role: admin`) can read every project, delete sites, projects and domains, and set quotas; they cannot publish into a tenant's site.

The three capability ids are proposals in [`docs/capabilities-proposal/`](docs/capabilities-proposal/) together with an updated [`docs/service-manifest-proposal.json`](docs/service-manifest-proposal.json). Until the lead releases them in `openvibe-contracts`, Host decides grants for exactly these ids with the library's own matching rule (`server/auth/capabilities.js`), and the CI contract check is non-blocking.

### Activation and rollback

Activation is one SQLite transaction: a compare-and-set on the site's `active_deploy_id`, an activation record and the `host.deploy.activated` event. If any part fails, none of it happens. `expected_active` turns a racing operator's switch into a 409. Rollback goes to a named ready deploy of the same site, or to the most recent previously active one that still exists. The active deploy cannot be deleted. Deleting another deploy removes its objects when no other deploy of the project uses them.

### Events

Through the `openvibe-sdk` v0.2.2 transactional outbox (`event_outbox`), inside the transaction that makes the change:

| Event | When | Payload |
|---|---|---|
| `host.deploy.created` | an upload became a ready deploy | `project_id, site_id, site, source, file_count, total_bytes, manifest_sha256` |
| `host.deploy.activated` | a site's active deploy changed | `project_id, site_id, site, deploy_id, previous_deploy_id, rollback` |
| `host.deploy.failed` | an upload was refused | `project_id, site_id, site, code, problems` (codes only, never file contents) |
| `host.domain.verified` | a custom domain's TXT record was found | `project_id, site_id, site, hostname` |

The relay publishes with Host's service token (`events.event.publish`, audience `openvibe.events`) only when `EVENTS_URL` and `OV_OAUTH_CLIENT_SECRET` are set. Otherwise rows wait and `/api/ready` says the relay is off.

### Dashboard

Server-rendered pages with the shared chrome (`openvibe-shared` v1.3.0: navbar and theme loader from the Network, `<noscript>` navigation, SSR footer, app icon, legal pages). Every action is a plain form, so it works without JavaScript: projects, quotas and usage, members, sites, folder or archive upload, deploys with activate/rollback/delete, activation history, upload logs and file lists, domains with their DNS records and a "check DNS now" button. Pages are `private, no-store`, `noindex`, `frame-ancestors 'none'`.

### Observability

`GET /api/ready` (openvibe-shared/ready): `db` and `storage` are required; `network_jwks`, `events_relay` and `domain_checks` are optional and report degradation. `GET /release.json`. `GET /metrics` for direct loopback callers only (nginx also returns 404): HTTP golden signals by route template (tenant requests are one `tenant_site` series), process metrics, release info and `host_sites`.

### Grants and registration (for the lead)

- OpenVibe.Network OAuth client **`host`**, redirect `https://openvibe.host/auth/callback`, scope `profile theme`. The same client is the service principal `svc:host`.
- Grant `[host, events.event.publish, openvibe.events]`.
- Callers of Host get `[<client>, host.site.manage | host.deploy.create | host.domain.manage, openvibe.host]` as needed. None exist yet (Codes, the expected first caller, is not built).
- Release `docs/capabilities-proposal/*.json` and `docs/service-manifest-proposal.json` in the next `openvibe-contracts`, then make the CI contract check blocking again.

### Deploying Stage B (for the operator)

Nothing here has been done yet.

1. **DNS.** `openvibe.host` and `*.openvibe.host`: `A`/`AAAA` records to the host. If the zone is on Cloudflare, keep `*.openvibe.host` **DNS-only** (grey cloud), or set `HOST_CNAME_TARGET` to a DNS-only name: custom domains in other accounts cannot CNAME to a proxied hostname (Cloudflare error 1014). Set `HOST_ORIGIN_IPV4`/`HOST_ORIGIN_IPV6` if tenants should be told the addresses for apex domains.
2. **Wildcard certificate.** A DNS-01 challenge is required for `*.openvibe.host`, for example `certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/certbot-cloudflare.ini -d openvibe.host -d '*.openvibe.host'`. The credentials file is root-only (0600), outside every repository, and never passed to Host. The certificate lands in `/etc/letsencrypt/live/openvibe.host/`; another location is passed with `--wildcard-cert <name|dir>`.
3. **Network.** Register the OAuth client `host` and the grant above.
4. **Code and state.** `sudo -u ubuntu git clone https://github.com/OpenVibers/OpenVibe.Host /opt/openvibe.host && cd /opt/openvibe.host && sudo -u ubuntu npm ci --omit=dev --no-audit --no-fund`. This checkout is the service; the root-owned `/usr/local/lib/openvibe-host` stays the `ovhost` CLI. The unit's state directory is `/var/lib/openvibe-host-api` (database and objects), deliberately **not** `/var/lib/openvibe-host`, which is `ovhost`'s own root-only state.
5. **Environment.** `/etc/openvibe/host.env` (0600), from [`.env.example`](.env.example): at least `BASE_URL=https://openvibe.host`, `HOST_SITES_DOMAIN=openvibe.host`, `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID=host`, `OV_OAUTH_CLIENT_SECRET`, `HOST_FORM_SECRET`, `EVENTS_URL`.
6. **Unit.** `sudo cp deploy/systemd/openvibe-host.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-host`, then `curl -s http://127.0.0.1:4910/api/ready`.
7. **nginx.** Add the `host` entry from [`host.example.json`](host.example.json) to `/etc/openvibe/host.json`, update `/usr/local/lib/openvibe-host`, then `sudo ovhost nginx tenants host` (review) and `sudo ovhost nginx tenants host --install` (writes `openvibe.host.conf` and `openvibe.host-custom-domains.conf`, `nginx -t`, reload; restored on failure). [`deploy/nginx/openvibe.host.conf`](deploy/nginx/openvibe.host.conf) is a reference copy.
8. **Custom domains** (whenever tenants verify one): `sudo ovhost nginx tenants host` lists the verified domains still waiting for a certificate. For each, `sudo certbot certonly --webroot -w /var/www/certbot -d <hostname>` (the generated port-80 block already answers the ACME challenge), then `sudo ovhost nginx tenants host --install` again. Until then, the domain is verified but only answers over HTTP with the challenge. Certificates never pass through the Host API.
9. **Launch.** The Sites placeholder stays until the launch rule below holds and the lead switches it. Until then [`deploy/nginx/openvibe.host-tenants-pending.conf`](deploy/nginx/openvibe.host-tenants-pending.conf) answers every `*.openvibe.host` name with a 404 over the wildcard certificate (installed 2026-09-23; without it the wildcard fell through to nginx's default server). Remove it in the same change that installs the tenant vhost.

### Not done yet (Stage B)

- Uploads are held in memory while they are validated (bounded by `HOST_MAX_UPLOAD_BYTES` and `HOST_MAX_UNPACKED_BYTES`), so the service needs that much headroom per concurrent upload.
- Objects live on the service's local disk, not in OpenVibe.Media; there is no replication and no backup beyond `ovhost backup host` (the SQLite database only).
- Certificates for custom domains are issued by hand (step 8); there is no automatic ACME flow.
- Projects are created in Host. When Network has projects (ADR-014), Host should accept only Network project ids and read membership from Network.
- `openvibe.host` is not on the Public Suffix List. Listing it would make each tenant its own site in browsers, but it would also make `openvibe.host` itself a public suffix, which affects the dashboard's cookies. Evaluate before submitting. The protections above do not depend on it.
- No per-site headers, redirects or SPA fallback configuration; no preview deploys; no deploy of a Git repository (uploads only).
- No sitemap/robots/feed behaviour for tenant sites beyond what tenants upload themselves.
- The Codes portal (Wave 20) does not exist, so there is no public developer onboarding for Host yet.

### Acceptance (what `npm test` demonstrates for Stage B)

- **Tenant isolation** (`test/host-isolation.test.js`): 25 path tricks (`..`, `%2e%2e`, `%2f`, `%5c`, `%00`, double encoding, absolute object-store paths, sha256 paths, `/host.db`) and 14 `Host` header tricks never return another tenant's bytes; absolute-form targets that disagree with `Host` are refused; tenant hosts never reach the API, auth, metrics or readiness; identical bytes are stored per project; every API route answers 404 to non-members; the API ignores cookies.
- **Traversal and links refused** (`test/host-uploads.test.js`): `..`, absolute, backslash, non-ASCII, pax and GNU long-name overrides, symlinks, hard links, devices, FIFOs, hidden files, server-side code, credentials, unknown types, duplicates, conflicts, corrupt archives and a 40 MB gzip bomb. Each becomes a failed deploy with a log and `host.deploy.failed`, nothing is stored, and the active deploy keeps serving.
- **Quotas** (`test/host-quota-auth.test.js`): deploys per day (rolling), deduplicated storage, files, bytes per file, request size, sites, custom domains, sandbox limits; service-token audience/capability, `X-OV-Subject` delegation, app principals, sandbox tokens, mods, staff.
- **Atomic rollback** (`test/host-rollback.test.js`): 320 requests while the pointer flips 40 times all return one whole deploy; a failure inside the switch changes nothing; `expected_active` conflicts; database-level immutability; the pointer survives a restart.
- **Custom domains** (`test/host-domains.test.js`): not served until verified; wrong or missing TXT stays pending; first verified proof wins; OpenVibe domains refused; removal and site deletion stop serving; background verification, pending expiry and lapse.
- **No secrets in responses** (`test/host-secrets-dashboard.test.js`): no API, dashboard, readiness or event body contains the OAuth client secret, the form secret, an uploaded `.env`'s values or any credential-like string; response objects are allowlisted; plus the dashboard (chrome, forms, CSRF against same-site tenant origins, planted cookies) and machine endpoints.
- **Lifecycle, headers, events** (`test/host-lifecycle.test.js`, `test/host-contracts-events.test.js`): content types, ETag/304, ranges, immutable caching, CSP, nosniff, custom 404, 405; valid event envelopes delivered by the relay with a Network service token; the proposals match the guarded routes.
- **Tenant vhosts** (`test/nginx-tenants.test.js`): the wildcard vhost with the certificate path parameter, HTTPS only for verified domains that have a certificate, hostile database values refused before they reach nginx, transactional install, no key file read.

Not demonstrated yet: any of this on the production host.

## Development

```
npm test                    # every test, each file in its own process (Node 22)
node test/deploy.test.js    # one file
npm run dev                 # Stage B service on http://localhost:4910 (HOST_SITES_DOMAIN=localhost serves sites at http://<site>.localhost:4910)
```

Stage B tests (`test/host-*.test.js`) boot the service on a temp database and object store with a controllable clock, a mock Network (real RS256 keys) and a DNS table, and talk to it over raw HTTP so they can send any `Host` header and request target.

Stage A: everything that touches the system goes through the executor (`lib/executor.js`). The tests replace it with `test/fake-host.js`, an in-memory host with git repos, systemd units, npm, nginx, ss, HTTP endpoints and SQLite. No test runs systemctl, git, npm, nginx or curl against the real machine. `test/executor.test.js` covers the real executor only where that is safe: SQLite on a temp database, HTTP to a local server, and temp files.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

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

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
