# D41 proof: deploy, restart and roll back one service with ovhost, and nothing else moves

Roadmap D41 and the Wave 21 exit criterion say: *deploy, restart and roll back one service without
interrupting unrelated runtimes or protected sessions.* `ovhost deploy` and `ovhost rollback` do this
in the tests against the fake host, but no production service has been deployed through ovhost yet.
[`scripts/d41-proof.sh`](../scripts/d41-proof.sh) is the production artifact. It uses ovhost's own
commands on one low-risk service and records evidence that every other unit on the host kept its
process.

**It has not been run on the production host.** The operator runs it after review (below).

## Which service

The service to use is **sources** (OpenVibe.Sources, loopback :4720):

- nothing public points at it (`sources.openvibe.network` serves the admin placeholder);
- all six seeds are disabled, so no fetch is in flight;
- it has one unit, no socket, no protected sessions and no worker units;
- its database is not touched by a code rollback of one commit, which the script checks.

**search** and **codes** also qualify on paper, but they are riskier. Search is queried by other
services, and Codes (openvibe.codes) is public.

The script refuses these services, whatever the options: `live`, `media`, `openre`, `chat`,
`network`, `events`, `billing`, `games`, `tools`, `host` and `sites`. It also refuses any service with a
socket unit, a protected-session probe or worker units.

## What it runs

Let S0 be the commit sources runs now and PREV its first parent (or `--prev`). The service is
restarted three times, and it ends on S0:

| Step | Command | Proves |
|---|---|---|
| A | `ovhost deploy sources --to S0 --restart` | a deploy through ovhost restarts only this unit and polls readiness (the checkout does not move) |
| B | `ovhost rollback sources --to PREV --restart` | a rollback: `git reset --hard` as the owner, restart, readiness |
| C | `ovhost deploy sources --to S0 --restart` | a forward deploy (fast-forward PREV → S0), restart, readiness; back where it started |

No commit newer than S0 is ever deployed, even if `origin/main` has moved on. Step C fetches but
fast-forwards only to S0.

Before step A the script checks the following, and **refuses (exit 1, nothing changed)** if any of
them fails:

- it runs as root;
- `ovhost validate sources` passes;
- sources is ready;
- the checkout is clean and on its branch;
- PREV is an ancestor of S0;
- `ovhost plan sources --to PREV --no-fetch` shows no dependency install (unless `--allow-install`)
  and no `backupOnChange` file between the two commits.

## Evidence

For each of these units, `systemctl show` records `MainPID`, `InvocationID`, `ActiveEnterTimestamp`,
`ExecMainStartTimestamp`, `NRestarts`, `ActiveState` and `SubState`:

- every unit and socket in the inventory except sources' own unit;
- every `openvibe-*` and `openre-*` unit (for example OpenRe's transport worker instances);
- `nginx.service`;
- always, even if not loaded: `openvibe-live.socket`, `openvibe-live.service`,
  `openvibe-chat.service` and `openvibe-media.service`;
- anything passed with `--watch`.

The records are taken before step A, after each step and at the end. The run **fails (exit 2)** as
soon as any of these units differs, and the evidence names the unit. `InvocationID` changes on every
start, restart included, so an identical `InvocationID` and `MainPID` means that unit was not
restarted.

For sources' own unit, each step must produce a new `InvocationID` and `MainPID`, the commit that
was asked for, and a ready service.

`ovhost status --json` is taken before and after. Every service that was ready before must still be
ready. The protected-session counts (Live streams, Media recordings, Events SSE) are recorded before
and after.

The evidence directory is `/var/lib/openvibe-host/d41/sources-<UTC stamp>/` (root, 0700). It holds:

| File | Contents |
|---|---|
| `summary.md` | verdict, steps table, a row for the table below |
| `proof.log` | every line the script printed |
| `watch.units` | the units that had to stay untouched |
| `others-before.txt`, `others-A.txt`, `others-B.txt`, `others-C.txt`, `others-after.txt` | their `systemctl show` values; a `*.diff` when anything changed |
| `target-0.txt` … `target-3.txt` | the sources unit before and after each step |
| `step-A.json`, `step-B.json`, `step-C.json` | ovhost's release records; `*.log` holds its stderr |
| `status-before.json`, `status-after.json` | `ovhost status --json` for every service |
| `plan-rollback.json`, `validate.txt`, `inventory.json`, `releases.json` | the plan for B, validate output, the inventory as ovhost read it, the last release records |

Nothing in it is secret. ovhost prints no env values, and `systemctl show` is limited to the
properties above.

If a step fails, the run stops. ovhost has usually already rolled back by itself: exit 3 is "not
ready, rolled back and serving". Otherwise the script returns sources to S0 with
`ovhost rollback sources --to S0 --restart`. Exit codes:

| Exit | Meaning |
|---|---|
| 0 | PASS |
| 1 | refused, nothing changed |
| 2 | another unit changed, or a service stopped being ready |
| 3 | an ovhost step failed; the service is back on S0 |
| 4 | the service could not be returned to S0: **manual intervention**, run `sudo ovhost rollback sources --to <S0>` |

## Running it (operator)

```
# 0. ovhost on the host must include scripts/d41-proof.sh and `ovhost show` (this commit or later)
sudo git -C /usr/local/lib/openvibe-host -c safe.directory=/usr/local/lib/openvibe-host pull --ff-only
# 1. look first: preflight and snapshots only, prints the three commands
sudo /usr/local/lib/openvibe-host/scripts/d41-proof.sh --dry-run sources
# 2. the proof (about a minute: three restarts, each polled until ready)
sudo /usr/local/lib/openvibe-host/scripts/d41-proof.sh sources
# 3. read the verdict and paste the row below
sudo cat /var/lib/openvibe-host/d41/sources-*/summary.md
```

Useful options:

| Option | Effect |
|---|---|
| `--prev <sha>` | choose the rollback target, if HEAD~1 of sources touches its dependencies or schema |
| `--watch <unit>` | add a unit to the untouched set |
| `--ready-timeout <s>` | passed to ovhost |
| `--out <dir>` | put the evidence somewhere else |

Live, Chat and Media are never restarted, so no live stream, recording or chat socket is affected. A
reader of Sources during its three restarts would see connection errors for about a second each;
nothing reads it in production today.

## Results

| Date (UTC) | Service | Releases | Other units / readiness | Evidence | Result |
|---|---|---|---|---|---|

*(no run yet)*

## Tests

`test/d41-proof.test.js` runs the real script in bash against the fake host. `ovhost`, `systemctl`
and `runuser` are stubs that call back into the test process, where the real ovhost CLI runs
against `test/fake-host.js`. The test covers:

- **PASS:** exactly three restarts, all of `openvibe-sources.service`; the Live socket and every
  other unit are untouched; the service ends on S0; the release log reads deployed, rolled-back,
  deployed.
- **Collateral change:** a Chat restart caused by the deploy is detected, named, and fails the run
  (exit 2).
- **Readiness failure:** a rollback target that never becomes ready is rolled back by ovhost itself,
  and the proof exits 3 with sources back on S0.
- **Refusals:** refuse-listed and protected services, an unknown `--prev`, a dependency change and an
  unknown service all refuse without restarting anything, and `--dry-run` runs no deploy.
