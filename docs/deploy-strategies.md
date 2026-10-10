# Deploy strategies (roadmap WS-N task 11)

`ovhost deploy <svc>` now covers the services that deployed with their own `deploy/scripts/deploy.sh`:
Live (release layout), Tools, Sites, OpenRestream and Network, and Games (which deployed by hand). Each service
entry in the inventory names a **strategy**: an engine plus the defaults the script it replaces encoded.
Every repository keeps `deploy/scripts/deploy.sh` as a thin wrapper that maps its old flags onto ovhost,
and invokes ovhost directly.

Production deploys and rollbacks use `ovhost deploy <svc>` and `ovhost rollback <svc>`. The strategy tests exercise each implementation against the fake host.

| Service | Strategy | Replaces | Wrapper (`deploy/scripts/deploy.sh`) |
|---|---|---|---|
| live | `release-layout` | Live `deploy.sh` (release layout) | `--wait-idle`, `--restart`, `--rollback` → `ovhost rollback live`, `DRY_RUN=1` → `ovhost plan live`; `--force` refused (see below) |
| openre | `release-layout` | OpenRestream `deploy.sh release` + `api` | `deploy`, `release [<ref>]` → `--prepare-only`, `api [<sha>]` → `deploy --to <sha>`, `rollback`, `plan` |
| tools | `multi-app` | Tools `deploy.sh` | `--wait-idle`, `--restart`, `--force`, `--rollback`, `DRY_RUN=1` |
| sites | `static-build` | Sites `deploy.sh` (after a manual pull) | always `ovhost deploy sites --restart` (rebuild every run, as before); `DRY_RUN=1` |
| games | `pnpm-build` | the manual procedure | `--wait-idle`, `--restart`, `--force`, `--rollback`, `DRY_RUN=1` |
| network | `git-checkout` | Network `deploy.sh` | always `--install-units`; `--restart`, `--wait-idle`, `--force`, `--rollback`, `DRY_RUN=1` |

Every other service keeps the default strategy, `git-checkout`, which is what `ovhost deploy` did before.

## Deploy wrappers

Repository wrappers call `ovhost plan`, `ovhost deploy`, or `ovhost rollback` for their service. If ovhost is missing, the wrapper exits with an error. The `capabilities` command remains available for installed wrappers that still query it.

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
   runs from (OpenRestream's `openre-rtmp-ingest@<id>`).
7. Record (`fromRelease`, `toRelease`), announce.

`ovhost rollback <svc>` switches back to the release the release log says the current one replaced (or
`--to <release id|sha>`, or the newest other release), with its own `node_modules`, restarting only when
code or unit files differ. Rollbacks are never frozen.

## Inventory fields

New fields (all optional; `lib/inventory.js` validates them). A strategy's defaults apply first, the entry
overrides them.

| Field | Meaning | Default |
|---|---|---|
| `strategy` | `git-checkout`, `multi-app`, `static-build`, `pnpm-build` or `release-layout` | `git-checkout`; `layout: "release"` requires `release-layout` |
| `release.git` | the clone releases are made from (relative to `repo`, or absolute inside it) | `repo` |
| `release.releases`, `release.current` | the releases directory and the link | `releases`, `current` |
| `release.id` | `time-sha8` (`<UTC yyyymmdd-HHMMSS>-<sha8>`, Live; the old script used the host's local time, the same on a UTC host) or `sha12` (OpenRestream; one release per commit, reused) | `time-sha8` |
| `release.links` | `{ name: target }` links made in every release | `{}` |
| `release.reuseModules` | hard-link the current `node_modules` when dependencies did not change | `true` |
| `release.chown` | `user[:group]` for each new release (OpenRestream) | none |
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
| OpenRestream: `release` (worktree, `npm ci`, chown ubuntu), `api` (switch, restart API + coordinator, 60 s ready, roll back) | release-layout with `release.id: sha12`, `reuseModules: false`, `chown`; `--prepare-only` |
| OpenRestream: never touch a worker; `prune` keeps what runs | `workerUnits` are never restarted; pruning skips releases a worker instance runs from |
| Network: pull, `npm install` on a lockfile change, unit file installed when it differs, restart, health | git-checkout with `installUnits` |
| Games: `git pull`, `pnpm install --frozen-lockfile`, `pnpm build`, restart | pnpm-build (git as the owner, not `sudo git`) |

Stricter than the scripts, on purpose: Tools and Network roll back automatically and check every dependency;
Tools checks `/api/ready` (not `/api/health`) and the new sha; OpenRestream refuses an API restart while an ingest
session is open (the script did not check; `--wait-idle` holds, `--force` goes ahead; if the restart provably
never cuts a session, set its `drain.policy` to `report`); `--wait-idle` now also holds a `report`-policy
service (Tools jobs, Games players, Events SSE) instead of being ignored; every attempt is in the release
log and a freeze refuses.

## Not ported (and why)

- **Live's chat notice** (`notify_chat`, `POST /api/admin/broadcast` with `ADMIN_TOKEN` from the
  operator's environment): `sudo` does not pass `ADMIN_TOKEN`, so it said "chat notification skipped" in
  practice, and Live posts its own deploy notice when it boots on new commits (`server/chat/deploy-notice.js`,
  through Events).
- **Live `--force`** (discard local tracked changes): ovhost never discards changes (see above).
- **Network's "restart anyway" when nothing is new**: only with `--restart` now.
- **OpenRestream `workers`, `status`, `prune`**: they stay in the repository's script. Starting a worker
  generation is not a deploy ovhost makes (it never starts, stops or restarts a worker unit); ovhost prunes
  on its own and keeps every release a worker runs from.
- **Games `sudo git`**: ovhost runs git as the checkout owner. If earlier `sudo git pull`s left root-owned
  objects in `.git`, fix the ownership once.

## The deploy controller: `ovhost reconcile` (roadmap WS-X11 phase 1, D72)

Main at its last green CI commit is the desired state. `openvibe-reconcile.timer` runs `ovhost reconcile` every
5 minutes. For each service whose inventory entry has `"deploy": { "policy": "auto" }` (default `manual`):

1. It plans with a fetch. Up to date: nothing happens.
2. If the new commits change only documentation and tests (`README.md`, `STATUS.json`, `docs/*.md`, `test/`,
   `.github/`, `*.test.*`), it does nothing; the change rides the next deploy.
3. It reads GitHub's check runs for that exact commit. It deploys only when every one completed and passed.
   None yet, one still running, a failure, or GitHub unreachable all wait for the next pass (or block, on red).
4. It deploys with the same code as `ovhost deploy --wait-idle` (freezes, protected sessions, readiness and
   automatic rollback all apply), then sends the release notification.

`gated` and `manual` services are listed with what waits for a person. They are never deployed by the
controller. Each pass is written to `/var/lib/openvibe-host/reconcile.json` and to the textfile collector.
Alerts: `OpenVibeReconcileFailed` (page: an automatic deploy failed or rolled back) and `OpenVibeReconcileStalled`
(ticket: no pass for an hour).

```bash
sudo ovhost reconcile --dry-run          # what it would do now
sudo ovhost reconcile wiki blog          # one pass for some services
sudo systemctl list-timers openvibe-reconcile.timer
```

Install (once):

```bash
sudo cp /opt/openvibe.host/deploy/systemd/openvibe-reconcile.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-reconcile.timer
```

An optional read-only GitHub token (`OVHOST_GITHUB_TOKEN` in `/etc/openvibe/reconcile.env`, O19) lifts the
60-requests-an-hour anonymous limit. Without one, only a commit that changed code costs API calls.
Later phases (WS-X11): CI-built signed packages instead of `git` and `npm` on the host, contract-ordered waves,
canaries, and the GitHub App webhook for immediate passes.
