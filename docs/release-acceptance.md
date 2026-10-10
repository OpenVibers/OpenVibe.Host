# Release-lifecycle acceptance (D46, roadmap WS-P task 16)

`scripts/release-acceptance.js` runs the release-lifecycle acceptance suite: the 14 D46 scenarios as 63 gates, held
in [`lib/acceptance.js`](../lib/acceptance.js). A gate is evidence that exists somewhere in the estate with a numeric
budget. It is usually a test in one of seven repositories, sometimes a production proof in
[deploy-proofs.md](deploy-proofs.md) or the running site. The runner records the release and component versions it
ran against. It reports each gate as pass, fail, skipped or open, with the measured value next to the budget.

## Running it

```sh
fnm exec --using=22.22.1 node scripts/release-acceptance.js            # every gate that needs no site (about 1.5 min)
fnm exec --using=22.22.1 node scripts/release-acceptance.js \
    --base https://openvibe.live --channel /@JapaneseOldGuy            # plus the site gates (about 7 more minutes)
node scripts/release-acceptance.js --only 9,14,6a --json               # scenarios by number, gates by id; JSON report
node scripts/release-acceptance.js --list                              # the gates, without running anything
```

| Option | |
|---|---|
| `--repos <dir>` | where the repositories are checked out (default `~/OpenVibers`). The Host gates always run in this checkout. |
| `--live <dir>` | OpenVibe.Live. The default is `~/orca/workspaces/OpenVibe.Live/seadragon` when it exists, else `<repos>/OpenVibe.Live`. |
| `--base <url>` | a running site for the browser gates (Live's `test/browser/smoke.js` with `BASE`, this repository's `scripts/browser-check.js`) and the manifest gate. Without it those gates are **skipped, never passed**. |
| `--channel </@name>` | the channel page the Live smoke visits. Its default, `/@admin`, exists only on a local seed. |
| `--node <path>` | the node that runs the tests (default: the one running the script). The repositories test on Node 22. |
| `--timeout <s>` | the default per-gate timeout (180 s). Slow gates set their own: deploy-sim and the rollback test 300 s, the smoke 1200 s, browser-check 600 s. |
| `--logs <dir>` | keep each test's full output as `<repo>__<file>.log`. |
| `--json`, `--out <file.md>` | the report as JSON on stdout; the run as Markdown in a file (overwritten), in the form pasted below. |
| `--strict` | exit 1 unless every selected gate passed (skipped and open count against it). |

Exit codes: 0 when no gate failed, 1 when one did, 2 on bad arguments. Skipped and open gates are listed with their
reason and never counted as passes.

What the tests need: Node 22, the repositories' `node_modules`, git history in Live (`13a` checks out the release
of 7 days ago into a temporary worktree and removes it; without history it says so and the gate is **skipped**), and
Chrome for the Shared Chrome tests (`8b`, `10b`, `11b`; skipped without it) and the site gates.

**The site gates only read.** The smoke and browser-check load pages and navigate as a guest. They send what any
visitor's page sends: analytics beacons, the Frame's hit counter, release-watch beats and an anonymous chat join.
They never sign in and never post.

## How a gate is judged

- **The repository is there.** Otherwise the gate is skipped, and the reason names the path.
- **Its pins are still in the test file.** A pin is the text of the assertion the budget rests on, such as
  `'never while the camera/mic is live'`. If someone deletes or rewords that assertion, the gate fails before it runs,
  so a gate cannot pass on a test that stopped checking its number.
- **The test passes.** It runs as `node <file>` from the repository with `NODE_ENV=test`, the way each repository's
  own runner does. Each file runs once per run, however many gates read it. A line `<name>: skipped (<why>)` makes
  the gate skipped. The browser smoke is the one exception (`ignoreExit`): its gates judge their own lines, and the
  other checks that failed are counted in a note.
- **Every expected line is printed.** These are the named checks (`✓ live: a public/-only change switches current
  without a restart…`), so a renamed or removed case fails the gate.
- **The measured value is within the budget.** Where a test prints a number, it is parsed:
  `[metric] name=value` lines (Shared's new release tests), Tools' per-process stop times, Live's N-1 call count,
  the smoke's lap probes and script count, browser-check's growth deltas and no-JS counts. Where a test only asserts
  a bound (`[p.reloads, p.toasts.length] = [0, 0]`), a pass proves exactly that bound, and the table says
  **asserted**. When a test fails, the value it measured is still shown.
- **Records** (`6f`, `6g`, `6h`, `7e`) are production proofs. The row of deploy-proofs.md decides the result: a
  `passed` row passes if the quoted numbers are still in the doc, and an `open` row stays open. **Open** gates
  (`6i`) are known gaps, stated as such. The **manifest** gate (`1e`) reads the site's `/release.json`.
- **Versions** are recorded at the start of the run: each repository's commit, branch, uncommitted files, version
  and `openvibe-shared` pin, plus the site's release and components with `--base`. A repository that moves during
  the run is flagged in the report.

## What D46 asks to measure, and which gates measure it

| Measure | Gates |
|---|---|
| affected sessions | 1a, 1b, 2c, 3c, 3d, 4a, 4b, 4d, 5a, 6a, 6b, 6c, 6e, 6f, 6i, 7a, 7b, 7d, 7e, 9b, 12a, 12b, 12c |
| drain duration | 5b, 5c, 6h |
| update eligibility | 1d, 1e, 2a, 2d, 2e, 3a, 9c, 14b |
| deferred and failed clients | 1c, 2b, 3b, 8a, 9a, 10a, 10b, 10c, 14c |
| reconnects | 6d, 6g, 8b, 9e, 14a, 14d |
| resource growth | 4c, 8c, 9d, 10d, 11a, 11b, 11c, 11d, 11e |
| rollback results | 7c, 13a, 13b, 13c, 13d |

## The scenarios

Where the budget came from: most budgets are the bound the test asserts (0 reloads, 0 lost, 1 request per burst). The
others are the test's own threshold (the smoke's 120 px and its growth slack of 2 per counter and 150 nodes), a
declared deadline (the lifecycle manifest's 5 s stop), browser-check's growth budgets, or a production measurement with
its headroom (a chat reconnect of 1.1 s against a 2 s budget; the longest wait during Live's restart, 0.955 s,
against the 2 s the deploy took to report ready).

### 1. Home styles deployed during a broadcast

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 1a | a styles-only release is switched without restarting Live, streams live | Host `test/strategy-release-layout.test.js` | Live restarts (dropped streams) ≤ 0 | asserted: the test asserts host.restarts() is [] and the record says restarted: false |
| 1b | the same through Live's deploy wrapper on a simulated host | Live `test/deploy-sim.test.js` | Live restarts ≤ 0 | asserted: the test compares the process id before and after the switch |
| 1c | a tab broadcasting (live camera/mic) or playing a stream is never reloaded | Shared `test/release.test.js` | reloads while capturing or playing ≤ 0 | asserted: asserts [reloads, metrics] = [0, { deferred: { capture: 1 } }] with a live track, and the same for a playing &lt;video&gt; |
| 1d | a style change is applied in place: only the changed stylesheet moves | Shared `test/release-update.test.js` | reloads + prompts for a styles-only release ≤ 0 | asserted: asserts [p.reloads, p.toasts.length] = [0, 0] after the update |
| 1e | Live's manifest declares style components, so its open tabs take styles in place | `<base>/release.json` (--base) | style components in /release.json ≥ 1 | GET <base>/release.json |

### 2. A shared navbar update

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 2a | a shared-package (navbar) bump changes the shell; a changed shell is never swapped in place | Shared `test/release.test.js`, `test/release-update.test.js` | shell updates applied in place ≤ 0 | asserted: release.test.js asserts the shell version moves when openvibe-sdk is bumped; release-update.test.js asserts plan() prompts |
| 2b | a visible tab someone is using is not reloaded for it | Shared `test/release.test.js` | reloads under an active user ≤ 0 | asserted: asserts [reloads, metrics] = [0, { prompted: { window: 1 }, deferred: { active: 1 } }] |
| 2c | each Tools page runs the navbar its own pin serves, never Network's copy | Tools `apps/_shared/test/shared-pins.test.js` | pages loading shared files from another origin ≤ 0 | measured: the test fails on any page loading a shared file from openvibe.network; the counts are its summary line |
| 2d | the previous release's client (N-1) against this server, every call it makes | Live `test/n-1.test.js` | incompatible N-1 calls ≤ 0 | measured: test/fixtures/n-1/client.json, recorded from the release in production; the count is the test's line |
| 2e | adjacent releases stay compatible in the mixed-version matrix; incompatible ones reload (contract) | Shared `test/release-mixed-version.test.js` | adjacent pairs that break ≤ 0 | asserted: assertMixedVersion over R1/R2/R3 with real servers |

### 3. An article or paste edit

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 3a | a content edit replaces its region in place (no script, frame or handler carried) | Shared `test/release-update.test.js` | reloads + prompts for a content edit ≤ 0 | asserted: asserts [p.reloads, p.toasts.length] = [0, 0] and the region's new text |
| 3b | a region the person is typing in waits; a tab with unsent input is never reloaded | Shared `test/release-update.test.js`, `test/release.test.js` | input lost to an update ≤ 0 | asserted: asserts the region keeps its old text while focused and commits after blur; 0 reloads with focus or form[data-dirty] |
| 3c | Blog: an edit is a new revision; a stale save is refused (412), never lost; readers see a revision only once published | Blog `test/lifecycle.test.js` | edits lost to a concurrent save ≤ 0 | asserted: the Blog lifecycle test (API with a member JWT) |
| 3d | Blog without JavaScript: a stale form is a clear refusal, not a lost edit | Blog `test/nojs-editor.test.js` | edits lost (no-JS form) ≤ 0 | asserted: the Blog no-JS editor test |

### 4. A feed update while reading

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 4a | a feed region above the viewport changes height: the page scrolls by exactly that | Shared `test/release-reading.test.js` | reading position shift ≤ 0 px | measured: [metric] feed-reading.position-shift-px: the feed's height change minus what the page scrolled (+300 and -200 px cases) |
| 4b | the region the person reads inside keeps its own scroll | Shared `test/release-reading.test.js` | region scroll lost ≤ 0 px | measured: [metric] feed-reading.region-scroll-lost-px (also asserted in release-update.test.js) |
| 4c | a burst of new notifications re-reads the count once | Shared `test/notification-live.test.js` | count requests per burst ≤ 1 | asserted: asserts p.counts() === before + 1 after a burst |
| 4d | Live chat keeps following when content grows under the reader | Live `test/browser/smoke.js` (--base) | distance from the bottom after growth ≤ 120 px | asserted: test/browser/smoke.js 3b (fails above 120 px) |

### 5. A tool upgrade during a job

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 5a | an accepted job survives a restart; a running one is re-queued (or failed retryable); reattach and SSE resume | Tools `apps/_shared/test/jobs.test.js` | accepted jobs lost across a restart ≤ 0 | asserted: the jobs runtime end to end over HTTP, the app closed and reopened |
| 5b | SIGTERM with a request in flight: answered, every Tools process stops within the manifest deadline | Tools `apps/_shared/test/graceful.test.js` | slowest graceful stop ≤ 5000 ms | measured: measured per process by the test; the budget is the lifecycle manifest's 5 s shutdown deadline |
| 5c | a Tools deploy reports running jobs, --wait-idle holds for them, a oneshot job unit is never restarted | Host `test/strategy-in-place.test.js` | job units restarted by a deploy ≤ 0 | asserted: the multi-app strategy against the fake host |

### 6. An API restart during streams or calls

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 6a | a Live deploy refuses to restart with streams live; --wait-idle holds until two idle checks | Host `test/strategy-release-layout.test.js` | streams dropped by a deploy without --force ≤ 0 | asserted: exit 5 and host.restarts() = []; --wait-idle deploys only after two idle polls |
| 6b | a stream that starts during the install stops the restart | Host `test/deploy.test.js` | streams dropped (late start) ≤ 0 | asserted: the protected probe runs again immediately before the restart |
| 6c | systemd holds Live's listener across a restart (loopback socket unit) | Live `test/systemd-units.test.js` | connections refused during a restart ≤ 0 | asserted: the fault the 2026-09-26 web drain proof found (4 × 502) is pinned here |
| 6d | Chat restarts (SIGTERM, new process): readers reconnect and read after their cursor | Chat `test/restart-resume.test.js` | messages missed or repeated after a restart ≤ 0 | asserted: each reader's rows equal the database's, nothing twice |
| 6e | a Chat restart closes the calls it left open (failed / missed / ended, reason restart) | Chat `test/calls.test.js` | calls left open after a restart ≤ 0 | measured: the calls lifecycle test; the closed counts are Chat's boot log |
| 6f | production web drain across a Live restart (release ab8abff) | production record, [deploy-proofs.md](deploy-proofs.md) (Web drain (Live)) | failed requests across a restart ≤ 0 | recorded: docs/deploy-proofs.md |
| 6g | production chat resume across a Chat restart | production record, [deploy-proofs.md](deploy-proofs.md) (Chat resume (Chat)) | reconnect after a restart ≤ 2 s | recorded: docs/deploy-proofs.md; budget: the client's 1 s first backoff plus a connect |
| 6h | production web drain: the longest a request waited across the Live restart | production record, [deploy-proofs.md](deploy-proofs.md) (Web drain (Live)) | longest wait across a restart ≤ 2 s | recorded: docs/deploy-proofs.md; budget: the 2 s the deploy took to report ready, the most a queued connection waits |
| 6i | a call in progress during a Chat deploy (production) | none yet | calls dropped by a deploy ≤ 0 | open: no proof: Chat's drain policy is report (a deploy restarts with calls up); a restart ends them with end_reason restart (6e) and people call again |

### 7. A media-worker rollout

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 7a | a Media deploy refuses to restart while a recording is in progress | Host `test/deploy.test.js` | recordings cut by a deploy without --force ≤ 0 | asserted: exit 5, nothing restarted |
| 7b | a job left running by the old worker is re-queued at start (or failed when out of attempts) | Media `test/jobs.test.js` | jobs lost across a worker restart ≤ 0 | asserted: Media's jobs test |
| 7c | fencing: the old worker's late checkpoint, heartbeat and completion are refused after a takeover | Media `test/jobs-fencing.test.js` | stale writes accepted from a replaced worker ≤ 0 | asserted: lease_token matched on renew, checkpoint, succeed and fail |
| 7d | the finalize job never touches a recording still live | Media `test/vod-finalize-job.test.js` | live recordings finalized ≤ 0 | asserted: Media's vod.finalize test |
| 7e | production: a recorder checkpoint across a Media deploy with a live ingest | production record, [deploy-proofs.md](deploy-proofs.md) (Recorder / media-worker checkpoint (Media)) | recording gaps across a rollout ≤ 0 s | recorded: docs/deploy-proofs.md |

### 8. Duplicate or older notifications

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 8a | the bell's feed ignores replayed and older seqs, another person's events and other types | Shared `test/notification-live.test.js` | duplicate or older notifications shown ≤ 0 | asserted: five frames (one replayed seq, one other person, two other types), one heard |
| 8b | the same in headless Chrome with a real EventSource: drop and resume, nothing lost or repeated | Shared `test/notification-live-chrome.test.js` | notifications repeated after a resume ≤ 0 | asserted: a local stand-in for Network and Events; skipped without Chrome |
| 8c | release notifications: a replayed seq or a repeated event id is dropped; a burst is one check | Shared `test/release-watch-realtime.test.js` | /release.json reads per burst ≤ 1 | asserted: asserts one fetch for a burst of four events, one of them a replay |

### 9. An account switch during an update

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 9a | a region fetched for the previous account (waiting, or in flight) is fetched again, never committed | Shared `test/release-account-switch.test.js` | regions committed as rendered for the previous account ≤ 0 | measured: [metric] account-switch.stale-regions-committed (Shared 1.23.1 fixed this: it was 1 in each case) |
| 9b | the switch reloads nothing and prompts nothing | Shared `test/release-account-switch.test.js` | reloads caused by a switch ≤ 0 | measured: [metric] account-switch.reloads (also counted: prompts) |
| 9c | update eligibility never depends on the account: /release.json is read without credentials | Shared `test/release-account-switch.test.js` | manifest reads carrying the session ≤ 0 | measured: [metric] account-switch.manifest-reads-with-credentials |
| 9d | still one release stream per tab after a switch | Shared `test/release-account-switch.test.js`, `test/release-watch-realtime.test.js` | release streams per tab ≤ 1 | measured: [metric] account-switch.release-streams |
| 9e | the bell restarts for the new account: its token, no cursor carried over | Shared `test/notification-live.test.js` | events read with the previous account's ticket ≤ 0 | asserted: setToken() asks a ticket with the new token and opens without last_event_id |

### 10. A partial asset group

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 10a | a feature whose script fails rolls back: no hook, its stylesheets withdrawn, the retry fetches only what is missing | Shared `test/web-runtime.test.js` | half-loaded features committed ≤ 0 | asserted: linkedom page where tags load or fail on cue |
| 10b | the same in headless Chrome: a real 404 rolls the group back and the retry completes it | Shared `test/web-runtime-chrome.test.js` | half-loaded features committed (Chrome) ≤ 0 | asserted: skipped without Chrome |
| 10c | an in-place update whose stylesheet fails keeps the old one and commits nothing | Shared `test/release-update.test.js` | pages left half updated ≤ 0 | asserted: asserts the old &lt;link&gt;s and the old region after a failed or timed-out stylesheet |
| 10d | Live: no script requested twice over SPA navigation | Live `test/browser/smoke.js` (--base) | scripts requested twice ≤ 0 | measured: test/browser/smoke.js 2+3 |

### 11. Repeated navigation leaks

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 11a | a route's timers, listeners and fetches end with it; late registrations are refused | Shared `test/web-runtime.test.js` | intervals + timeouts left after a route ends ≤ 0 | asserted: asserts p.out.intervals.size === 0 and p.out.timers.length === 0 after nextRoute() |
| 11b | the same in headless Chrome: the route's interval stops and its fetch aborts | Shared `test/web-runtime-chrome.test.js` | intervals left after a route ends (Chrome) ≤ 0 | asserted: skipped without Chrome |
| 11c | Live: three laps of ten routes; intervals, sockets and listeners between laps 2 and 3 | Live `test/browser/smoke.js` (--base) | growth per counter ≤ 2 | measured: test/browser/smoke.js 4 (slack 2 per counter) |
| 11d | Live: DOM nodes between laps 2 and 3 | Live `test/browser/smoke.js` (--base) | DOM node growth ≤ 150 | measured: test/browser/smoke.js 4 (slack 150 nodes) |
| 11e | home ↔ second route five times: heap, nodes, listeners, documents, intervals, timeouts, sockets | Host `scripts/browser-check.js` (--base) | measures over their growth budget ≤ 0 | measured: openvibe-shared/browser-harness growth budgets: heap 3 MB, nodes 300, listeners 30, documents 1, intervals 1, timeouts 10, sockets 1 (docs/browser-check.md) |

### 12. JS-disabled routes

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 12a | Live channel, VOD and clip pages render a real body without JavaScript | Live `test/seo-ssr.test.js` | SSR routes without a body ≤ 0 | asserted: Live's SEO middleware and SPA fallback, mounted as server/index.js mounts them |
| 12b | Blog: write, edit, publish and comment with plain forms | Blog `test/nojs-editor.test.js` | journey steps needing JavaScript ≤ 0 | asserted: the Blog no-JS editor test |
| 12c | the running site's routes, read with JavaScript off | Host `scripts/browser-check.js` (--base) | routes unreadable without JS ≤ 0 | measured: openvibe-shared/browser-harness nojs check (a page needs its minimum of text) |

### 13. Rollback with new writes

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 13a | the release of a week ago boots on this release's database, reads the newer rows and writes; then forward again | Live `test/rollback-newer-writes.test.js` | newer rows read after the rollback ≥ 100 % | measured: a git worktree of the release of 7 days ago on a database this release wrote; skipped without git history |
| 13b | rolling back returns the old release and its own node_modules; a release never ready is switched back | Host `test/strategy-release-layout.test.js` | rollbacks that leave new code or dependencies ≤ 0 | asserted: the release-layout strategy against the fake host |
| 13c | the same through Live's deploy script | Live `test/deploy-sim.test.js` | rollbacks that leave new code or dependencies ≤ 0 | asserted: simulated host with a real git origin |
| 13d | open tabs follow a rollback in place; schema generations say when a rollback is safe | Shared `test/release-update.test.js`, `test/release-mixed-version.test.js` | reloads for a rollback of styles or content ≤ 0 | asserted: release-update.test.js and release-compat rollbackSafe |

### 14. Resuming an offline tab

| Gate | What | Evidence | Budget | Where the number comes from |
|---|---|---|---|---|
| 14a | back online, the release stream reconnects at once from its cursor (given up or backing off) | Shared `test/release-offline-resume.test.js` | stream reconnect delay after online ≤ 0 ms | measured: [metric] offline-resume.stream-reconnect-delay-ms (Shared 1.23.1 fixed this: 30 000 ms in the test, up to 8 min before) |
| 14b | one /release.json read brings it straight to the newest release, in place | Shared `test/release-offline-resume.test.js` | manifest reads on resume ≤ 1 | measured: [metric] offline-resume.manifest-reads-on-resume |
| 14c | offline: no prompt, no reload, nothing counted as failed; mid-update loss leaves the page whole | Shared `test/release-offline-resume.test.js` | reloads + prompts + failures while offline, and half-updated pages ≤ 0 | measured: [metric] offline-resume.* (reloads, prompts, failures, partial pages, reloads while typing) |
| 14d | the bell resumes from its cursor when the browser is back online | Shared `test/notification-live.test.js` | notifications missed on resume ≤ 0 | asserted: asserts a new stream with last_event_id = the last seq seen |

## What the suite found

Two real bugs, both in openvibe-shared's `release-watch.js`, both fixed in Shared **1.23.1** (`23d41bf`, not tagged
or published yet; each site picks it up with a pin bump):

1. **An account switch during an update committed the previous account's rendering** (scenario 9). An in-place update
   fetches its content regions with the session (`credentials: 'same-origin'`). On a site that switches accounts in
   place (Live's `openvibe-auth-changed`), a region fetched for the previous account was committed as it was. That
   happened whether the region was still waiting for focus to leave it or was in flight when the account changed.
   The new account, or a guest after signing out, then saw what the server had rendered for the previous one. Before
   the fix, `9a` measured 1 (the test stops at its first case; the in-flight case, run on its own, committed the
   stale answer too). Now `openvibe-auth-changed` fetches such regions
   again with the new session, and an answer that arrives after a switch is never committed; it is counted as
   `deferred: account`. No site declares content regions yet, so production was not affected.
2. **A tab back online kept waiting out its release-stream backoff** (scenario 14). `online` reconnected at once only
   after the stream had given up (6 failures). A tab that came back while still backing off waited up to 8 minutes
   for release notifications. `14a` measured 30 000 ms in the test; it now measures 0, as `notification-live.js`
   already did.

The feed-reading test written for scenario 4 found nothing to fix: a region above the viewport that changes height
moves the page by exactly that amount.

## Open

- **`1e`: Live's open tabs cannot take a styles-only release in place.** Production's `/release.json` declares
  only `shell` and `server` components (release `4b7fa3f0`). So a home-styles release prompts open tabs with
  Reload instead of swapping the stylesheet. That is safe: the static switch restarts nothing (`1a`, `1b`), and
  nobody capturing or typing is reloaded (`1c`, `2b`, `3b`). But the in-place path proven in Shared (`1d`,
  `10c`) is unused. Closing it is a Live change: declare `components: { styles: { kind: 'style', assets: [...] } }`
  in its `createRelease`.
- **`6i`: calls across a Chat deploy.** Chat's drain policy is `report`, so a deploy restarts Chat with calls up.
  The restart closes them cleanly (`6e`: failed, missed or ended with `end_reason: 'restart'`, nothing left
  dangling), and people call again. Nothing holds a deploy for a call, and there is no production proof.
- **`7e`: the recorder checkpoint across a Media deploy.** This needs a live ingest during a Media deploy
  ([deploy-proofs.md](deploy-proofs.md)). The gates that exist are tests: a Media deploy refuses while a recording
  is in progress (`7a`), interrupted jobs are requeued (`7b`), a replaced worker's writes are fenced (`7c`) and
  a live recording is never finalized (`7d`).
- **Asserted, not measured.** Most gates prove their bound by assertion. Real measurements are `2c`, `2d`, `4a`,
  `4b`, `5b`, `9a`–`9d`, `10d`, `11c`–`11e`, `12c`, `13a`, `14a`–`14c` and the production records.
  Production telemetry of the same things (updates by outcome, sessions by generation) is D46's other half, the
  `release_client_*` metrics. This suite does not read them.
- **The Live smoke on production fails two checks that are not gates, for one reason.** A guest on `/broadcast`
  (direct and by SPA navigation) is reported as sending `POST https://openvibe.network/api/frame/hit`. That is the
  shared Frame's hit counter, which the smoke's plumbing filter (`/api/(auth/|analytics)`) predates. Without
  `--channel`, the four `/@admin` loads fail too: that channel exists only on a local seed. Both belong to Live's
  smoke and were not changed here.

## Runs

Both runs are from 2026-09-27, on the workstation, with Node 22.22.1. The Live checkout (`4b7fa3f`) is the release
production served during the `--base` run (`4b7fa3f0`). The `--base` run flags two repositories as changed during
the run. Host is this suite's own report formatting: the Markdown table columns and the text of an open
proof row, committed with this document; the tables below are in the committed form. Chat is another session's
uncommitted work, which the runner noticed.

### Local run, 2026-09-27 21:45 UTC

Node v22.22.1, no --base.

| Repository | Commit | Uncommitted | Version | openvibe-shared |
|---|---|---|---|---|
| host | `cfd38602ed24` (main) | 0 | 0.3.0 | 1.22.0 |
| live | `4b7fa3f06d96` (seadragon) | 1 | 1.0.0 | 1.23.0 |
| shared | `23d41bf72c66` (main) | 0 | 1.23.1 | (this) |
| tools | `390d3dfdb10b` (main) | 0 | 1.0.0 |  |
| blog | `21d5db386b7c` (main) | 0 | 0.1.0 | 1.22.0 |
| chat | `b3252cbc7e61` (main) | 0 | 0.1.0 | 1.22.0 |
| media | `be0facd28e64` (main) | 0 | 1.0.0 | 1.22.0 |

| # | Gate | Result | Measured | Budget |
|---|---|---|---|---|
| 1 | 1a | pass | 0 (asserted) | Live restarts (dropped streams) ≤ 0 |
| 1 | 1b | pass | 0 (asserted) | Live restarts ≤ 0 |
| 1 | 1c | pass | 0 (asserted; deferred: capture / media) | reloads while capturing or playing ≤ 0 |
| 1 | 1d | pass | 0 (asserted) | reloads + prompts for a styles-only release ≤ 0 |
| 1 | 1e | **skipped**: needs a running site: --base &lt;url&gt; | — | style components in /release.json ≥ 1 |
| 2 | 2a | pass | 0 (asserted; prompt instead) | shell updates applied in place ≤ 0 |
| 2 | 2b | pass | 0 (asserted; deferred: active) | reloads under an active user ≤ 0 |
| 2 | 2c | pass | 0 of 45 pages (217 references) | pages loading shared files from another origin ≤ 0 |
| 2 | 2d | pass | 0 of 481 calls | incompatible N-1 calls ≤ 0 |
| 2 | 2e | pass | 0 (asserted) | adjacent pairs that break ≤ 0 |
| 3 | 3a | pass | 0 (asserted) | reloads + prompts for a content edit ≤ 0 |
| 3 | 3b | pass | 0 (asserted; deferred: typing / dirty) | input lost to an update ≤ 0 |
| 3 | 3c | pass | 0 (asserted) | edits lost to a concurrent save ≤ 0 |
| 3 | 3d | pass | 0 (asserted) | edits lost (no-JS form) ≤ 0 |
| 4 | 4a | pass | 0 px | reading position shift ≤ 0 px |
| 4 | 4b | pass | 0 px | region scroll lost ≤ 0 px |
| 4 | 4c | pass | 1 (asserted) | count requests per burst ≤ 1 |
| 4 | 4d | **skipped**: needs a running site: --base &lt;url&gt; | — | distance from the bottom after growth ≤ 120 px |
| 5 | 5a | pass | 0 (asserted) | accepted jobs lost across a restart ≤ 0 |
| 5 | 5b | pass | 674 ms (food; 8 processes) | slowest graceful stop ≤ 5000 ms |
| 5 | 5c | pass | 0 (asserted) | job units restarted by a deploy ≤ 0 |
| 6 | 6a | pass | 0 (asserted) | streams dropped by a deploy without --force ≤ 0 |
| 6 | 6b | pass | 0 (asserted) | streams dropped (late start) ≤ 0 |
| 6 | 6c | pass | 0 (asserted; socket held by pid 1) | connections refused during a restart ≤ 0 |
| 6 | 6d | pass | 0 (asserted; 3 readers) | messages missed or repeated after a restart ≤ 0 |
| 6 | 6e | pass | 0 (closed at boot: {"failed":1,"missed":2,"ended":1}) | calls left open after a restart ≤ 0 |
| 6 | 6f | pass (recorded: passed 2026-09-26) | 0 of 57 requests (2026-09-26) | failed requests across a restart ≤ 0 |
| 6 | 6g | pass (recorded: passed 2026-09-26, with a limit) | 1.1 s, 0 missed, 0 duplicate (2026-09-26) | reconnect after a restart ≤ 2 s |
| 6 | 6h | pass (recorded: passed 2026-09-26) | 0.955 s (20 requests in the window, median 0.134 s; ready after 2 s) | longest wait across a restart ≤ 2 s |
| 6 | 6i | **open**: no proof: Chat's drain policy is report (a deploy restarts with calls up); a restart ends them with end_reason restart (6e) and people call again | — | calls dropped by a deploy ≤ 0 |
| 7 | 7a | pass | 0 (asserted) | recordings cut by a deploy without --force ≤ 0 |
| 7 | 7b | pass | 0 (asserted) | jobs lost across a worker restart ≤ 0 |
| 7 | 7c | pass | 0 (asserted) | stale writes accepted from a replaced worker ≤ 0 |
| 7 | 7d | pass | 0 (asserted) | live recordings finalized ≤ 0 |
| 7 | 7e | **open**: needs a live ingest during a Media deploy | — | recording gaps across a rollout ≤ 0 s |
| 8 | 8a | pass | 0 (asserted; 1 of 5 frames heard) | duplicate or older notifications shown ≤ 0 |
| 8 | 8b | pass | 0 (asserted) | notifications repeated after a resume ≤ 0 |
| 8 | 8c | pass | 1 (asserted) | /release.json reads per burst ≤ 1 |
| 9 | 9a | pass | 0 | regions committed as rendered for the previous account ≤ 0 |
| 9 | 9b | pass | 0 | reloads caused by a switch ≤ 0 |
| 9 | 9c | pass | 0 | manifest reads carrying the session ≤ 0 |
| 9 | 9d | pass | 1 | release streams per tab ≤ 1 |
| 9 | 9e | pass | 0 (asserted) | events read with the previous account's ticket ≤ 0 |
| 10 | 10a | pass | 0 (asserted) | half-loaded features committed ≤ 0 |
| 10 | 10b | pass | 0 (asserted) | half-loaded features committed (Chrome) ≤ 0 |
| 10 | 10c | pass | 0 (asserted; failed: style → prompt) | pages left half updated ≤ 0 |
| 10 | 10d | **skipped**: needs a running site: --base &lt;url&gt; | — | scripts requested twice ≤ 0 |
| 11 | 11a | pass | 0 (asserted) | intervals + timeouts left after a route ends ≤ 0 |
| 11 | 11b | pass | 0 (asserted) | intervals left after a route ends (Chrome) ≤ 0 |
| 11 | 11c | **skipped**: needs a running site: --base &lt;url&gt; | — | growth per counter ≤ 2 |
| 11 | 11d | **skipped**: needs a running site: --base &lt;url&gt; | — | DOM node growth ≤ 150 |
| 11 | 11e | **skipped**: needs a running site: --base &lt;url&gt; | — | measures over their growth budget ≤ 0 |
| 12 | 12a | pass | 0 (asserted) | SSR routes without a body ≤ 0 |
| 12 | 12b | pass | 0 (asserted) | journey steps needing JavaScript ≤ 0 |
| 12 | 12c | **skipped**: needs a running site: --base &lt;url&gt; | — | routes unreadable without JS ≤ 0 |
| 13 | 13a | pass | 100 % (user and setting written by the newer release; older release ac64530f, 0 boot errors) | newer rows read after the rollback ≥ 100 % |
| 13 | 13b | pass | 0 (asserted) | rollbacks that leave new code or dependencies ≤ 0 |
| 13 | 13c | pass | 0 (asserted) | rollbacks that leave new code or dependencies ≤ 0 |
| 13 | 13d | pass | 0 (asserted) | reloads for a rollback of styles or content ≤ 0 |
| 14 | 14a | pass | 0 ms | stream reconnect delay after online ≤ 0 ms |
| 14 | 14b | pass | 1 | manifest reads on resume ≤ 1 |
| 14 | 14c | pass | reloads-while-offline 0, prompts-while-offline 0, failures-counted-offline 0, partial-pages 0, reloads-while-typing 0 | reloads + prompts + failures while offline, and half-updated pages ≤ 0 |
| 14 | 14d | pass | 0 (asserted) | notifications missed on resume ≤ 0 |

54 passed, 0 failed, 7 skipped, 2 open (63 gates, 14 scenarios).

### With --base https://openvibe.live, 2026-09-27 21:46 UTC

Node v22.22.1, --base https://openvibe.live.

| Repository | Commit | Uncommitted | Version | openvibe-shared |
|---|---|---|---|---|
| host | `cfd38602ed24` (main) (changed during the run: now cfd38602ed24, 2 uncommitted) | 0 | 0.3.0 | 1.22.0 |
| live | `4b7fa3f06d96` (seadragon) | 1 | 1.0.0 | 1.23.0 |
| shared | `23d41bf72c66` (main) | 0 | 1.23.1 | (this) |
| tools | `390d3dfdb10b` (main) | 0 | 1.0.0 |  |
| blog | `21d5db386b7c` (main) | 0 | 0.1.0 | 1.22.0 |
| chat | `b3252cbc7e61` (main) (changed during the run: now b3252cbc7e61, 4 uncommitted) | 0 | 0.1.0 | 1.22.0 |
| media | `be0facd28e64` (main) | 0 | 1.0.0 | 1.22.0 |

Site https://openvibe.live: `live` release `4b7fa3f0` (2026-09-27T21:40:17.783Z), components `shell` script@4b7fa3f0, `server` server@4b7fa3f0.

| # | Gate | Result | Measured | Budget |
|---|---|---|---|---|
| 1 | 1a | pass | 0 (asserted) | Live restarts (dropped streams) ≤ 0 |
| 1 | 1b | pass | 0 (asserted) | Live restarts ≤ 0 |
| 1 | 1c | pass | 0 (asserted; deferred: capture / media) | reloads while capturing or playing ≤ 0 |
| 1 | 1d | pass | 0 (asserted) | reloads + prompts for a styles-only release ≤ 0 |
| 1 | 1e | **open**: the manifest declares no style component, so a styles-only release prompts open tabs (Reload) instead of swapping the stylesheet; never a reload under the person | 0 (components: shell:script, server:server) | style components in /release.json ≥ 1 |
| 2 | 2a | pass | 0 (asserted; prompt instead) | shell updates applied in place ≤ 0 |
| 2 | 2b | pass | 0 (asserted; deferred: active) | reloads under an active user ≤ 0 |
| 2 | 2c | pass | 0 of 45 pages (217 references) | pages loading shared files from another origin ≤ 0 |
| 2 | 2d | pass | 0 of 481 calls | incompatible N-1 calls ≤ 0 |
| 2 | 2e | pass | 0 (asserted) | adjacent pairs that break ≤ 0 |
| 3 | 3a | pass | 0 (asserted) | reloads + prompts for a content edit ≤ 0 |
| 3 | 3b | pass | 0 (asserted; deferred: typing / dirty) | input lost to an update ≤ 0 |
| 3 | 3c | pass | 0 (asserted) | edits lost to a concurrent save ≤ 0 |
| 3 | 3d | pass | 0 (asserted) | edits lost (no-JS form) ≤ 0 |
| 4 | 4a | pass | 0 px | reading position shift ≤ 0 px |
| 4 | 4b | pass | 0 px | region scroll lost ≤ 0 px |
| 4 | 4c | pass | 1 (asserted) | count requests per burst ≤ 1 |
| 4 | 4d | pass (the smoke's other checks: 2 failed (not this gate's)) | 120 px (asserted) | distance from the bottom after growth ≤ 120 px |
| 5 | 5a | pass | 0 (asserted) | accepted jobs lost across a restart ≤ 0 |
| 5 | 5b | pass | 668 ms (food; 8 processes) | slowest graceful stop ≤ 5000 ms |
| 5 | 5c | pass | 0 (asserted) | job units restarted by a deploy ≤ 0 |
| 6 | 6a | pass | 0 (asserted) | streams dropped by a deploy without --force ≤ 0 |
| 6 | 6b | pass | 0 (asserted) | streams dropped (late start) ≤ 0 |
| 6 | 6c | pass | 0 (asserted; socket held by pid 1) | connections refused during a restart ≤ 0 |
| 6 | 6d | pass | 0 (asserted; 3 readers) | messages missed or repeated after a restart ≤ 0 |
| 6 | 6e | pass | 0 (closed at boot: {"failed":1,"missed":2,"ended":1}) | calls left open after a restart ≤ 0 |
| 6 | 6f | pass (recorded: passed 2026-09-26) | 0 of 57 requests (2026-09-26) | failed requests across a restart ≤ 0 |
| 6 | 6g | pass (recorded: passed 2026-09-26, with a limit) | 1.1 s, 0 missed, 0 duplicate (2026-09-26) | reconnect after a restart ≤ 2 s |
| 6 | 6h | pass (recorded: passed 2026-09-26) | 0.955 s (20 requests in the window, median 0.134 s; ready after 2 s) | longest wait across a restart ≤ 2 s |
| 6 | 6i | **open**: no proof: Chat's drain policy is report (a deploy restarts with calls up); a restart ends them with end_reason restart (6e) and people call again | — | calls dropped by a deploy ≤ 0 |
| 7 | 7a | pass | 0 (asserted) | recordings cut by a deploy without --force ≤ 0 |
| 7 | 7b | pass | 0 (asserted) | jobs lost across a worker restart ≤ 0 |
| 7 | 7c | pass | 0 (asserted) | stale writes accepted from a replaced worker ≤ 0 |
| 7 | 7d | pass | 0 (asserted) | live recordings finalized ≤ 0 |
| 7 | 7e | **open**: needs a live ingest during a Media deploy | — | recording gaps across a rollout ≤ 0 s |
| 8 | 8a | pass | 0 (asserted; 1 of 5 frames heard) | duplicate or older notifications shown ≤ 0 |
| 8 | 8b | pass | 0 (asserted) | notifications repeated after a resume ≤ 0 |
| 8 | 8c | pass | 1 (asserted) | /release.json reads per burst ≤ 1 |
| 9 | 9a | pass | 0 | regions committed as rendered for the previous account ≤ 0 |
| 9 | 9b | pass | 0 | reloads caused by a switch ≤ 0 |
| 9 | 9c | pass | 0 | manifest reads carrying the session ≤ 0 |
| 9 | 9d | pass | 1 | release streams per tab ≤ 1 |
| 9 | 9e | pass | 0 (asserted) | events read with the previous account's ticket ≤ 0 |
| 10 | 10a | pass | 0 (asserted) | half-loaded features committed ≤ 0 |
| 10 | 10b | pass | 0 (asserted) | half-loaded features committed (Chrome) ≤ 0 |
| 10 | 10c | pass | 0 (asserted; failed: style → prompt) | pages left half updated ≤ 0 |
| 10 | 10d | pass (the smoke's other checks: 2 failed (not this gate's)) | 0 of 48 scripts | scripts requested twice ≤ 0 |
| 11 | 11a | pass | 0 (asserted) | intervals + timeouts left after a route ends ≤ 0 |
| 11 | 11b | pass | 0 (asserted) | intervals left after a route ends (Chrome) ≤ 0 |
| 11 | 11c | pass (the smoke's other checks: 2 failed (not this gate's)) | intervals +0, sockets +0, windowListeners +0, documentListeners +0 (laps 2→3) | growth per counter ≤ 2 |
| 11 | 11d | pass (the smoke's other checks: 2 failed (not this gate's)) | domNodes +0 (laps 2→3) | DOM node growth ≤ 150 |
| 11 | 11e | pass | 0 over; heap -33 KB, nodes -10, listeners -2, intervals 0, timeouts 0, sockets 0 (laps 2→5) | measures over their growth budget ≤ 0 |
| 12 | 12a | pass | 0 (asserted) | SSR routes without a body ≤ 0 |
| 12 | 12b | pass | 0 (asserted) | journey steps needing JavaScript ≤ 0 |
| 12 | 12c | pass | 0 of 5 routes unreadable (least text 1529 chars) | routes unreadable without JS ≤ 0 |
| 13 | 13a | pass | 100 % (user and setting written by the newer release; older release ac64530f, 0 boot errors) | newer rows read after the rollback ≥ 100 % |
| 13 | 13b | pass | 0 (asserted) | rollbacks that leave new code or dependencies ≤ 0 |
| 13 | 13c | pass | 0 (asserted) | rollbacks that leave new code or dependencies ≤ 0 |
| 13 | 13d | pass | 0 (asserted) | reloads for a rollback of styles or content ≤ 0 |
| 14 | 14a | pass | 0 ms | stream reconnect delay after online ≤ 0 ms |
| 14 | 14b | pass | 1 | manifest reads on resume ≤ 1 |
| 14 | 14c | pass | reloads-while-offline 0, prompts-while-offline 0, failures-counted-offline 0, partial-pages 0, reloads-while-typing 0 | reloads + prompts + failures while offline, and half-updated pages ≤ 0 |
| 14 | 14d | pass | 0 (asserted) | notifications missed on resume ≤ 0 |

60 passed, 0 failed, 0 skipped, 3 open (63 gates, 14 scenarios).
