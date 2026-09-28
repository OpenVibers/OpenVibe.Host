# Deploy strategies (roadmap WS-N task 11)

`ovhost deploy <svc>` now covers the services that deployed with their own `deploy/scripts/deploy.sh`:
Live (release layout), Tools, Sites, OpenRe and Network, and Games (which deployed by hand). Each service
entry in the inventory names a **strategy**: an engine plus the defaults the script it replaces encoded.
Every repository keeps `deploy/scripts/deploy.sh` as a thin wrapper that maps its old flags onto ovhost,
with the old script body kept as `deploy/scripts/deploy-legacy.sh` for the fallback.

**State (2026-09-28):** in production since the 2026-09-27 cutover (the checklist below was run then).
Every service, including the six here, deploys with `sudo ovhost deploy <svc>` and rolls back with `sudo ovhost rollback
<svc>`; the strategies are tested against the fake host (`test/strategy-release-layout.test.js`,
`test/strategy-in-place.test.js`) and in each repository (the wrapper tests). The wrappers' legacy fallback is only
reached where an ovhost without `capabilities` answers, which no longer happens on the production host.

| Service | Strategy | Replaces | Wrapper (`deploy/scripts/deploy.sh`) |
|---|---|---|---|
| live | `release-layout` | Live `deploy.sh` (release layout) | `--wait-idle`, `--restart`, `--rollback` → `ovhost rollback live`, `DRY_RUN=1` → `ovhost plan live`; `--force` refused (see below) |
| openre | `release-layout` | OpenRe `deploy.sh release` + `api` | `deploy`, `release [<ref>]` → `--prepare-only`, `api [<sha>]` → `deploy --to <sha>`, `rollback`, `plan`; `workers`, `status`, `prune` stay in the legacy script |
| tools | `multi-app` | Tools `deploy.sh` | `--wait-idle`, `--restart`, `--force`, `--rollback`, `DRY_RUN=1` |
| sites | `static-build` | Sites `deploy.sh` (after a manual pull) | always `ovhost deploy sites --restart` (rebuild every run, as before); `DRY_RUN=1` |
| games | `pnpm-build` | the manual procedure | `--wait-idle`, `--restart`, `--force`, `--rollback`, `DRY_RUN=1` |
| network | `git-checkout` | Network `deploy.sh` | always `--install-units`; `--restart`, `--wait-idle`, `--force`, `--rollback`, `DRY_RUN=1` |

Every other service keeps the default strategy, `git-checkout`, which is what `ovhost deploy` did before.

## The wrappers and their fallback

Each wrapper first asks `ovhost capabilities <svc>` (run as root: `sudo` when the wrapper is not root). It
hands over to ovhost only when every line it needs is there:

```
ovhost=0.3.0
deploy-api=1
strategies=git-checkout,multi-app,static-build,pnpm-build,release-layout
commands=plan,deploy,rollback,announce,capabilities
deploy-flags=--wait-idle,--force,--restart,--to,--install-units,--ready-timeout,--prepare-only,--no-announce
service=live
strategy=release-layout
managed=yes
layout=release
```

`deploy-api` is at least 1, `strategy=` is the one the wrapper was written for, and `managed=yes`.
Otherwise it prints why (`ovhost not found`, `no 'capabilities' (too old)`, `deploy-api is 0`, `the host
inventory does not deploy live with strategy release-layout (none)`, …) and runs `deploy-legacy.sh` with the
original arguments. So an old ovhost, a missing one, or an inventory that has not been changed yet never
breaks a deploy. `OVHOST_LEGACY=1` forces the fallback; `OVHOST=<path>` picks another ovhost. Where the legacy
script cannot do what was asked (Tools, Network and Games have no `--rollback`; none of them has `DRY_RUN`
except Live), the wrapper refuses instead of doing something else. The Sites fallback pulls first (it restores
`dist/` and runs `git pull --ff-only` as the checkout owner), then runs the pulled legacy script. OpenRe's
fallback runs `release` then `api` for `deploy`.

Exit codes are ovhost's: `0` ok · `1` usage/precondition · `2` validation failed, nothing restarted · `3` not
ready, rolled back and serving · `4` rollback failed, **manual intervention** · `5` protected sessions active
· `6` frozen.

**Live `--force`.** The old script's `--force` meant "discard local tracked changes" (legacy in-place layout
only). ovhost never discards changes, and its `--force` drops live streams and passes a freeze. The Live
wrapper therefore refuses `--force`; run `sudo ovhost deploy live --force` yourself when that is what you
mean. (In the fallback, `--force` goes to the legacy script as before.)

## The two engines

### In place (git-checkout, multi-app, static-build, pnpm-build)

`lib/release-ops.js`, the Stage A engine, with the strategy's defaults:

1. Lock, fetch as the owner, plan (from/to, changed files, installs, restart needed, unit drift).
2. Refuse a wrong branch or tracked local changes. Tracked **build output** (`generated`: Sites' `dist/`,
   Games' `dist-types/`) is not a local change: it is restored from git before the merge.
3. Protected sessions (refuse, `--wait-idle`, `--force`, drain policy) before the checkout moves.
4. Remove untracked lockfiles the release tracks (`removeUntrackedLockfiles`), then `git merge --ff-only`.
5. Install where needed (per package, or once for a workspace), verify every dependency resolves, build,
   **preflight**, install repo vhosts behind `nginx -t`, install unit files (`installUnits` or
   `--install-units`), back up databases on a schema change, protected sessions again.
6. Any failure in 5 restores the checkout, its dependencies **and rebuilds** (a build writes what is served);
   nothing restarted (exit 2).
7. Restart the units (plus unit files matching `unitsMatch`), wait for readiness (`ready.release`,
   `ready.allUnits`), and on failure roll back: restore, reinstall, rebuild, restart (exit 3, or 4).
8. Record the release; announce it (Sites: one notification per `dist/<domain>/release.json`).

### Release layout (release-layout)

`lib/release-layout.js`:

1. Lock, fetch in the clone (`release.git`), plan against the release `current` points at.
2. Prepare the new release while the current one serves: `git worktree add --detach releases/<id> <sha>`,
   the links (`data -> ../../shared/data`), `npm ci` when the lockfile or dependency fields changed or
   `release.reuseModules` is false, else `cp -al` of the current `node_modules`; every dependency resolves;
   preflight (Live: `node --check` on each changed `.js`, `JSON.parse` on each changed `.json`); `release.chown`.
   Any failure removes the new release: nothing restarted, `current` untouched (exit 2). `--prepare-only`
   stops here.
3. Static-only change (nothing outside `noRestartPaths`, no unit file changed): switch `current` (a new link
   renamed over the old one), wait `release.settleSeconds`, the ready URL must answer, else switch back
   (exit 3).
4. Otherwise: protected sessions (a refusal removes the prepared release), a backup on a schema change,
   switch `current`, install the release's unit files (`unitSources` are paths inside the release), restart,
   readiness. Not ready: switch back, reinstall the previous release's unit files, restart (exit 3, or 4).
5. **The socket rule** (Live): pid 1 must hold the socket unit's listener (`ss`, the service port or
   `release.socketPort`). Only when the socket unit file changed in this deploy, or systemd does not hold the
   port, does ovhost stop the service, restart the socket and start the service on it
   (`systemd.rebindSocket`, the one place ovhost ever restarts a socket unit, and only for those two
   reasons). After readiness a listener that still is not systemd's is reported (`✗ socket activation is not
   in effect`) and recorded (`socketHeld: false`).
6. Prune to `release.keep`: never `current`, never the release just left, never one a worker unit instance
   runs from (OpenRe's `openre-rtmp-ingest@<id>`).
7. Record (`fromRelease`, `toRelease`), announce.

`ovhost rollback <svc>` switches back to the release the release log says the current one replaced (or
`--to <release id|sha>`, or the newest other release), with its own `node_modules`, restarting only when
code or unit files differ. Rollbacks are never frozen.

## Inventory fields

New fields (all optional; `lib/inventory.js` validates them). A strategy's defaults apply first, the entry
overrides them.

| Field | Meaning | Default |
|---|---|---|
| `strategy` | `git-checkout`, `multi-app`, `static-build`, `pnpm-build` or `release-layout` | `git-checkout`; an entry with `layout: "release"` and no strategy stays unmanaged (deployed by its own script), as before |
| `release.git` | the clone releases are made from (relative to `repo`, or absolute inside it) | `repo` |
| `release.releases`, `release.current` | the releases directory and the link | `releases`, `current` |
| `release.id` | `time-sha8` (`<UTC yyyymmdd-HHMMSS>-<sha8>`, Live; the old script used the host's local time, the same on a UTC host) or `sha12` (OpenRe; one release per commit, reused) | `time-sha8` |
| `release.links` | `{ name: target }` links made in every release | `{}` |
| `release.reuseModules` | hard-link the current `node_modules` when dependencies did not change | `true` |
| `release.chown` | `user[:group]` for each new release (OpenRe) | none |
| `release.keep` | releases kept (2–50) | 5 |
| `release.settleSeconds` | wait after a switch without restart before the ready check | 3 |
| `release.socketPort` | the port pid 1 must hold | the service `port` |
| `preflight.syntaxCheck` | `node --check` changed `.js`, parse changed `.json` | false |
| `preflight.dirs` | directories made in each package as `runAs` | `[]` |
| `preflight.checks` | `[{ label, packages: "*" \| [dirs], argv, timeoutSeconds }]`, run as `runAs` in each package | `[]` |
| `skipPackages` | package directories (or `prefix*`) that are not installed, verified or checked | multi-app: `["apps/_*"]` |
| `removeUntrackedLockfiles` | remove an untracked lockfile the incoming release tracks | multi-app: true |
| `generated` | tracked paths a build rewrites; restored from git before the merge, never a local change | static-build: `["dist/"]` |
| `installUnits` | install drifted `unitSources` on every deploy (as `--install-units`) | false |
| `unitsMatch` | also restart unit files matching this glob (named when the inventory lacks them) | none |
| `announce.releaseFiles` | one notification per `<dir>/*/release.json` instead of one for the service | static-build: `dist/*/release.json` |
| `install.lockfile` | the lockfile that decides an install | `package-lock.json` (pnpm-build: `pnpm-lock.yaml`) |
| `install.workspace` | one install at the root for a workspace | pnpm-build: true |
| `ready.release` | after a restart, `<ready origin>/release.json` must name the new sha | false |
| `ready.allUnits` | every unit must be active, not only the one behind the ready URL | false |

Strategy defaults: `static-build` also sets `install: npm ci, always`, `build: [["node", "build.js"]]` and
`nginx: { repoVhosts: "deploy/nginx/*.conf", installOnDeploy: true }`; `pnpm-build` sets
`packages: ["apps/*", "packages/*"]`, `install: pnpm install --frozen-lockfile --config.confirmModulesPurge=false, always` (pnpm's purge prompt has no one to answer it) and
`build: [["pnpm", "build"]]`; `release-layout` installs with `npm ci --omit=dev`.

A release-layout entry's `repo` is the release root (`/opt/openvibe.live`); an entry that names the link
itself (`/opt/openvibe.live/current`) is read the same way. `status`, `validate`, `snapshot`, `drill` and
`announce` read the code from `current` (the new `codeDir`).

## What each script did, and where it went

| Rule (script) | Where it is now |
|---|---|
| Live: release built while the old one serves; `npm ci` only on a dependency change, else `cp -al` | release-layout step 2 |
| Live: `node --check` changed JS, parse changed JSON | `preflight.syntaxCheck` |
| Live: `public/`, `docs/` switch without a restart; the site must answer, else switch back (exit 3) | `noRestartPaths`, step 3 |
| Live: `--wait-idle` (8 h, two idle checks), `/api/streams` | `protected`, `drain` (a probe that cannot answer counts as live; the script counted 0) |
| Live: schema change → backup first | `backupOnChange` (to `/var/backups/openvibe/live/<stamp>/`, root-only, checked) |
| Live: units from `deploy/systemd/release`, daemon-reload, enable | `unitSources` inside the release |
| Live: `socket_held()`, `SOCKET_CHANGED` → stop, restart socket, start; warn after | the socket rule, step 5 |
| Live: readiness 90 s, roll back (3), rollback fails (4) | `ready`, step 4 |
| Live: `--rollback` to a release with its own `node_modules`; prune to 5 | `ovhost rollback live`; `release.keep` |
| Live: `ovhost announce live` | the deploy announces |
| Tools: untracked lockfiles removed before pulling | `removeUntrackedLockfiles` |
| Tools: install per app when `package.json` changed or no `node_modules`; skip `apps/_*` | installs (lockfile or dependency fields), `skipPackages` |
| Tools: every dependency resolves, reinstall once, else ABORT | dependency verification (all strategies) |
| Tools: jobs runtime in img/audio/docs, guard in every app, `data/` made | `preflight.checks`, `preflight.dirs` |
| Tools: restart every `openvibe-tools*` unit; gateway health; print each unit | `unitsMatch`, `ready` (Host header), `ready.release`, `ready.allUnits` |
| Sites: pull BEFORE running | ovhost fetches and merges first by construction |
| Sites: `npm ci`, `node build.js`, vhosts, `nginx -t` then reload, never reload after a failed test | static-build defaults; `nginx.install` restores the previous files |
| Sites: one announce per placeholder, stop at the first failure | `announce.releaseFiles` |
| OpenRe: `release` (worktree, `npm ci`, chown ubuntu), `api` (switch, restart API + coordinator, 60 s ready, roll back) | release-layout with `release.id: sha12`, `reuseModules: false`, `chown`; `--prepare-only` |
| OpenRe: never touch a worker; `prune` keeps what runs | `workerUnits` are never restarted; pruning skips releases a worker instance runs from |
| Network: pull, `npm install` on a lockfile change, unit file installed when it differs, restart, health | git-checkout with `installUnits` |
| Games: `git pull`, `pnpm install --frozen-lockfile`, `pnpm build`, restart | pnpm-build (git as the owner, not `sudo git`) |

Stricter than the scripts, on purpose: Tools and Network roll back automatically and check every dependency;
Tools checks `/api/ready` (not `/api/health`) and the new sha; OpenRe refuses an API restart while an ingest
session is open (the script did not check; `--wait-idle` holds, `--force` goes ahead; if the restart provably
never cuts a session, set its `drain.policy` to `report`); `--wait-idle` now also holds a `report`-policy
service (Tools jobs, Games players, Events SSE) instead of being ignored; every attempt is in the release
log and a freeze refuses.

## Not ported (and why)

- **Live's chat notice** (`notify_chat`, `POST /api/admin/broadcast` with `ADMIN_TOKEN` from the
  operator's environment): `sudo` does not pass `ADMIN_TOKEN`, so it said "chat notification skipped" in
  practice, and Live posts its own deploy notice when it boots on new commits (`server/chat/deploy-notice.js`,
  through Events).
- **Live's in-place (legacy) layout branch** of `deploy.sh`: production runs the release layout since
  2026-09-24; an in-place Live would be `strategy: git-checkout`.
- **Live `--force`** (discard local tracked changes): ovhost never discards changes (see above).
- **Network's "restart anyway" when nothing is new**: only with `--restart` now.
- **OpenRe `workers`, `status`, `prune`**: they stay in the repository's script. Starting a worker
  generation is not a deploy ovhost makes (it never starts, stops or restarts a worker unit); ovhost prunes
  on its own and keeps every release a worker runs from.
- **Games `sudo git`**: ovhost runs git as the checkout owner. If earlier `sudo git pull`s left root-owned
  objects in `.git`, fix the ownership once (checklist below).

## Production cutover checklist (for the operator)

Run on 2026-09-27 (the cutover); kept as the record of what was done and as the procedure for a new host. Each step is
read-only until step 5.

1. **Update ovhost.** `cd /usr/local/lib/openvibe-host && sudo git pull --ff-only && sudo npm ci --omit=dev
   --no-audit --no-fund`, then `ovhost --version` (0.3.0) and `sudo ovhost capabilities` (`deploy-api=1`).
   Until step 3 every wrapper still falls back (the inventory has no strategies).
2. **Check the checkouts.**
   - `sudo find /opt/openvibe.games/.git ! -user ubuntu | head`: if anything is listed,
     `sudo chown -R ubuntu:ubuntu /opt/openvibe.games/.git` (earlier `sudo git` pulls).
   - `sudo -u ubuntu bash -lc 'command -v pnpm && pnpm --version'`: ovhost runs pnpm as ubuntu with the
     PATH it was started with; if pnpm lives elsewhere, set `install.command`/`build` to its absolute path.
   - `ls -ld /opt/openvibe.live/repo /opt/openre.stream/repo` (root-owned clones, `owner: root`).
   - `sudo ss -Hltnp 'sport = :3000'` shows `"systemd",pid=1` (else the first Live deploy rebinds the socket).
3. **Edit the inventory.** `sudo cp /etc/openvibe/host.json /etc/openvibe/host.json.pre-ws-n-11`, apply the
   [proposed diff](#proposed-production-inventory-diff), then `sudo ovhost show live openre tools sites games
   network` and `sudo ovhost validate <svc>` for each (no new errors).
4. **Compare each plan with the old script** (`sudo ovhost plan <svc>` only fetches):
   - live: `sudo ovhost plan live` against `cd /opt/openvibe.live/current && sudo DRY_RUN=1 bash
     deploy/scripts/deploy-legacy.sh` (the old script; `deploy.sh` before the wrapper is deployed): same target sha and change classes (restart yes/no),
     `node_modules` hard-linked vs `npm ci` the same way, `socket held by systemd on :3000`,
     `strategy release-layout (release layout, keep 5)`.
   - openre: `sudo ovhost plan openre` against `sudo bash /opt/openre.stream/repo/deploy/scripts/deploy.sh
     status`: current release = the `current` link, restart = `openre-api.service,
     openre-session-coordinator.service` only, ingest sessions counted.
   - tools: `sudo ovhost plan tools`: the installs match the apps whose `package.json`/lockfile changed
     (`git -C /opt/openvibe.tools diff --name-only HEAD origin/main -- 'apps/*/package*.json'`), no
     `apps/_shared` line, the restart lists every `systemctl list-unit-files 'openvibe-tools*'` unit (no
     "not in the inventory" warning), the preflight lists the jobs and guard checks.
   - sites: `sudo ovhost plan sites --restart`: build output restored, `npm ci`, `node build.js`, repo vhosts,
     one notification per placeholder, no tracked changes.
   - games: `sudo ovhost plan games`: tracked changes none (dist-types restored), `install (always)`, build,
     preflight better-sqlite3, restart `openvibe-games.service`, players online counted (drain report).
   - network: `sudo ovhost plan network`: nothing unexpected (Network already deploys with ovhost; the
     entry only gains `installUnits`).
5. **Pull the wrappers.** Tools, Sites, Network and Games get theirs with their next pull (the old Tools and
   Network scripts pull themselves, so the deploy that brings the wrapper is still run by the old script).
   Live's arrives in the release that contains it; OpenRe's with `git -C /opt/openre.stream/repo pull`.
6. **Deploy through the wrapper**, one service at a time, lowest risk first: network, sites, games (quiet
   hour or `--wait-idle`), tools, openre (no ingest session, or `--wait-idle`), live (`--wait-idle`). Each
   wrapper prints `ovhost deploy <svc> …`; if it prints "running deploy-legacy.sh", read why.
7. **Verify.** `sudo ovhost releases <svc>` (strategy, from/to, result), `sudo ovhost status`, and for Live
   `sudo ss -Hltnp 'sport = :3000'` still shows `"systemd",pid=1`.
8. **Undo** (any step): `OVHOST_LEGACY=1 sudo deploy/scripts/deploy.sh` runs the old script for one deploy;
   restoring `/etc/openvibe/host.json.pre-ws-n-11` (or removing a `strategy`) makes the wrapper fall back
   for good.

## Proposed production inventory diff

`/etc/openvibe/host.json` is not changed by this work. These are the fields each entry needs (merge them
into the existing entries; `host.example.json` in this repository has the full entries). JSON has no
comments: the `//` notes below are for reading only.

```jsonc
"live": {
  "repo": "/opt/openvibe.live",                  // the release root (".../current" is read the same way)
  "owner": "root",                               // git runs as root in the root-owned clone
  "runAs": "ubuntu",
  "strategy": "release-layout",
  "release": { "git": "repo", "id": "time-sha8", "links": { "data": "../../shared/data" }, "keep": 5 },
  // MUST be the release-layout units: the in-place ones (deploy/systemd/*.service) run from
  // /opt/openvibe.live, and installing them would point Live at the stale checkout.
  "unitSources": {
    "openvibe-live.service": "deploy/systemd/release/openvibe-live.service",
    "openvibe-live.socket": "deploy/systemd/release/openvibe-live.socket",
    "openvibe-live.service.d/socket.conf": "deploy/systemd/release/openvibe-live.service.d/socket.conf"
  },
  "ready": { "url": "http://127.0.0.1:3000/api/ready", "timeoutSeconds": 90, "release": true },
  "preflight": { "syntaxCheck": true }
  // unchanged: units, socketUnit, port, noRestartPaths, protected, drain (refuse, 28800 s), databases,
  // backupOnChange, nginx (repoVhost is never installed by a deploy; the plan names a change)
},
"openre": {
  "repo": "/opt/openre.stream",                  // the release root; the clone is /opt/openre.stream/repo
  "strategy": "release-layout",                  // replaces "layout": "release"
  "owner": "root",
  "runAs": "ubuntu",
  "release": { "git": "repo", "id": "sha12", "reuseModules": false, "chown": "ubuntu:ubuntu", "keep": 5 },
  "ready": { "url": "http://127.0.0.1:4500/api/ready", "timeoutSeconds": 60 }
  // unchanged: units (API + coordinator), workerUnits, protected (ingest sessions), drain
},
"tools": {
  "strategy": "multi-app",                       // skipPackages apps/_*, removeUntrackedLockfiles
  "unitsMatch": "openvibe-tools*.service",
  "ready": { "url": "http://127.0.0.1:4001/api/ready", "headers": { "Host": "openvibe.tools" },
             "timeoutSeconds": 60, "release": true, "allUnits": true },
  "preflight": {
    "dirs": ["data"],
    "checks": [
      { "label": "jobs runtime loads", "packages": ["apps/img", "apps/audio", "apps/docs"],
        "argv": ["node", "-e", "const D=require('better-sqlite3'); new D(':memory:').close(); require('openvibe-contracts'); require('openvibe-sdk'); require('../_shared/jobs')"] },
      { "label": "guard loads", "packages": "*",
        "argv": ["node", "-e", "const D=require('better-sqlite3'); new D(':memory:').close(); require('../_shared/guard')"] }
    ]
  }
},
"sites": {
  "strategy": "static-build"                     // npm ci, node build.js, generated dist/, repo vhosts
                                                 // behind nginx -t, one announce per dist/*/release.json
},
"games": {
  // remove "managed": false and "unmanagedReason"
  "strategy": "pnpm-build",
  "generated": ["apps/client/dist-types/", "apps/server/dist-types/"],
  "preflight": { "checks": [ { "label": "better-sqlite3 loads under this Node", "packages": ["apps/server"],
                               "argv": ["node", "-e", "new (require('better-sqlite3'))(':memory:').close()"] } ] }
  // unchanged: units, ready, protected (players online), drain (report), databases, drill
},
"network": {
  "installUnits": true                           // the unit file is installed whenever it differs
}
```
