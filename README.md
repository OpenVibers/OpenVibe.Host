# OpenVibe.Host

> The network's deployment/control plane first; then isolated hosting for community sites, bots and mods.

**Status:** alpha. Stage A (operator plane) is a CLI, `ovhost`, tested against a fake host. It has **not** been installed on the production host yet, and no service's deploy has moved to it. Stages B and C are **not started**.
**Domain:** `openvibe.host`. It keeps its placeholder page on [OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites): a CLI for operators is not a public product.
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

- Stage A: the host inventory (services, units, env names, ports, probes, drain policy), environment validation, release install and rollback for git-checkout services, readiness and drain orchestration, the release log, certificate inventory, nginx vhost rendering and transactional install, config snapshots, SQLite backup hooks.
- Later: tenant projects, immutable deploy artifacts, domains/TLS, build logs, quotas (Stage B); sandbox profiles, budgets, secret references, outbound policy (Stage C).

## Does not own

- Product business logic. Host calls product hooks (`build`) and reads product endpoints (`/api/ready`, `/api/streams`). It never embeds product rules.
- Secrets. `ovhost` reads env files only to learn variable **names** and whether each one is empty. It never stores, prints or snapshots a value.
- Platform-wide credentials for hosted code (never).
- Certificate issuance/renewal (certbot does this today). Stage A only takes inventory.

## Depends on

- OpenVibe.Contracts (`openvibe-contracts` v0.7.0): service manifests, for vhost rendering and snapshots.
- OpenVibe.Network, OpenVibe.Media, OpenVibe.Events: Stage B/C only.

## Stages

| Stage | Scope | State |
|---|---|---|
| **A: operator plane** | `ovhost` CLI and library: inventory, validate, plan, deploy (`--wait-idle`/`--force`), automatic rollback, rollback, status, releases, certs, nginx render/install, snapshot, backup. No daemon and no server. Port **4910** is reserved for a later operator API. | **alpha**: written and tested (fake host, plus the real executor against temp SQLite/HTTP/git). Not installed on the host. |
| **B: tenant static hosting** | Immutable deploy artifacts stored through Media, domains and TLS, quotas, build logs, rollback. | **not started** |
| **C: sandboxed user code** | Isolation profiles, CPU/memory/time/network/storage budgets, secret references, outbound policy, metering, kill/revoke without touching platform services. | **not started**. Blocked until isolation and metering are proven. |

Not in Stage A yet (from the charter/roadmap list): container adapters, DNS adapters, certificate **renewal**, logs/metrics links, incident/maintenance controls, the release-manifest/active-client work in §15.18, `host.release.deployed|rolled_back` events (they need an Events outbox and a service principal), and the restore drills and cutover runbook that Wave 22 will add.

## Acceptance

What the tests demonstrate (`npm test`, every system call made against `test/fake-host.js`):

- A Live restart is **refused** while `/api/streams` reports a live stream. The checkout does not move, nothing is restarted, and the refusal is logged. `--wait-idle` waits for two idle checks in a row. `--force` proceeds and prints a warning. An unreachable probe counts as live.
- A Media restart is **refused** while `vods.is_recording = 1`. The query runs read-only as `ubuntu`.
- A failed readiness check **rolls back** to the previous sha, reinstalls the previous dependencies and restarts again (exit 3). If that also fails, the exit code is 4 with MANUAL INTERVENTION.
- A dependency that does not resolve **aborts before any restart** and restores the checkout (exit 2).
- Env validation **never outputs a value**, in text or JSON output.
- The socket unit is **never stopped or restarted**, in any flow.
- Only the service being deployed is restarted. Static-only changes (for example Live `public/`) are deployed without a restart, even while streams are live.
- `nginx -t` failures restore the previous vhost state. `certs` never reads a key file. Snapshots contain no secret values or remote-URL credentials.

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
ovhost snapshot <service> [--out <file>]
ovhost backup <service>
```

Every command accepts `--json` and `--inventory <file>`. Exit codes: `0` ok · `1` usage/precondition (including a held lock) · `2` validation failed, nothing restarted · `3` not ready, rolled back and serving · `4` rollback failed, **manual intervention** · `5` protected sessions active (refused, or `--wait-idle` gave up).

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
3. **State:** `/var/lib/openvibe-host` (root, 0750) holds the release logs, locks and snapshots. `/var/backups/openvibe/<service>` is created per service, owned by the service user, so the backup worker can write there. Both directories are created on first use.
4. **Run as root:** `sudo ovhost …`. `ovhost` drops to `ubuntu` for git/npm/SQLite (`runuser`) and needs root for `systemctl`, `nginx -t`, reading `/etc/openvibe/*.env` (names only) and writing vhosts. For least privilege, give operator accounts a sudoers rule for `/usr/local/bin/ovhost` alone instead of a general `ALL`. Do **not** grant it to the `ubuntu` service user if that account has no sudo today.
5. **First run:** `sudo ovhost status`, then `sudo ovhost validate <each service>`, then `sudo ovhost plan live`, all read-only apart from `git fetch`. Adopt `deploy` one service at a time, starting with one that has no protected sessions.

## Development

```
npm test                    # every test, each file in its own process
node test/deploy.test.js    # one file
```

Everything that touches the system goes through the executor (`lib/executor.js`). The tests replace it with `test/fake-host.js`, an in-memory host with git repos, systemd units, npm, nginx, ss, HTTP endpoints and SQLite. No test runs systemctl, git, npm, nginx or curl against the real machine. `test/executor.test.js` covers the real executor only where that is safe: SQLite on a temp database, HTTP to a local server, and temp files.

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
