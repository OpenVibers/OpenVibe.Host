'use strict';
/**
 * The release-lifecycle acceptance suite (D46, roadmap WS-P task 16): every D46 scenario as gates, each gate a
 * test in some repository (run as `node <file>` from that repository) or a production record, and a numeric
 * budget. scripts/release-acceptance.js is the command; docs/release-acceptance.md the table and the last run.
 *
 * A gate:
 *   { id, what, repo, cwd?, files: [paths], expect?: [RegExp], pins?: [{ file, text }], budget, measure,
 *     category, source, base?: true, ignoreExit?: true, timeoutMs? }
 *   kind 'record' (a production proof in this repository's docs/deploy-proofs.md), 'manifest' (the site's
 *   /release.json, with --base) or 'open' (known to be missing) instead of files.
 * Judging a test gate: the repository must be there, every pin (the assertion the budget rests on) must still be
 * in its test file, the test must pass (exit 0; a line `<name>: skipped (<why>)` makes it skipped), every expected
 * line must be printed, and the measured value must be inside the budget. A test that only asserts a bound gives
 * that bound, marked "asserted". Results: pass, fail, skipped (with the reason; never a pass) and open.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST_DIR = path.join(__dirname, '..');

/** The repositories the gates run in: <repos>/<dir>; Live is found separately (see resolveRepos). */
const REPOS = {
    host: { dir: 'OpenVibe.Host', name: 'OpenVibe.Host' },
    shared: { dir: 'OpenVibe.Shared', name: 'OpenVibe.Shared' },
    live: { dir: 'OpenVibe.Live', name: 'OpenVibe.Live' },
    tools: { dir: 'OpenVibe.Tools', name: 'OpenVibe.Tools' },
    chat: { dir: 'OpenVibe.Chat', name: 'OpenVibe.Chat' },
    media: { dir: 'OpenVibe.Media', name: 'OpenVibe.Media' },
    blog: { dir: 'OpenVibe.Blog', name: 'OpenVibe.Blog' },
};

/** What D46 asks to measure; every gate names one. */
const CATEGORIES = ['affected sessions', 'drain duration', 'update eligibility', 'deferred and failed clients', 'reconnects', 'resource growth', 'rollback results'];

// ── Measuring ───────────────────────────────────────────────────

/** The test only asserts the bound: a pass means the budget holds exactly. */
const asserted = (note) => ({ asserted: true, note });

/** Every `[metric] name=value` line, the last one of each name winning. */
function parseMetrics(out) {
    const m = {};
    for (const [, k, v] of String(out || '').matchAll(/^\[metric\] ([\w.-]+)=(-?\d+(?:\.\d+)?)\s*$/gm)) m[k] = Number(v);
    return m;
}
/** Reads one `[metric]` line. */
const metric = (name, text) => (out) => {
    const v = parseMetrics(out)[name];
    return v === undefined ? null : { value: v, text: text ? text(v) : undefined };
};

/** Tools' graceful.test.js: "SIGTERM → exit 0 … gateway 365 ms, img 431 ms, …": the slowest stop. */
function gracefulStop(out) {
    const line = String(out || '').split('\n').find((l) => /SIGTERM/.test(l) && /\d+ ms/.test(l));
    if (!line) return null;
    const stops = [...line.matchAll(/([a-z][\w-]*) (\d+) ms/g)].map(([, name, ms]) => ({ name, ms: Number(ms) }));
    if (!stops.length) return null;
    const worst = stops.reduce((a, b) => (b.ms > a.ms ? b : a));
    return { value: worst.ms, text: `${worst.ms} ms (${worst.name}; ${stops.length} processes)` };
}

/** Live's browser smoke: "lap probes: {…}\n {…}\n {…}" — growth from lap 2 to lap 3 of each counter. */
function lapProbes(out) {
    const s = String(out || '');
    const at = s.indexOf('lap probes:');
    if (at < 0) return null;
    const laps = [...s.slice(at).matchAll(/\{[^{}\n]*\}/g)].slice(0, 3).map((m) => { try { return JSON.parse(m[0]); } catch { return null; } });
    if (laps.length < 3 || laps.some((l) => !l)) return null;
    const [, second, third] = laps;
    const growth = {};
    for (const k of Object.keys(third)) growth[k] = third[k] - (second[k] || 0);
    return growth;
}
const lapGrowth = (keys) => (out) => {
    const g = lapProbes(out);
    if (!g) return null;
    const value = Math.max(...keys.map((k) => g[k] ?? 0));
    return { value, text: `${keys.map((k) => `${k} ${g[k] >= 0 ? '+' : ''}${g[k]}`).join(', ')} (laps 2→3)` };
};

/** Live's browser smoke: duplicate script requests over SPA navigation. */
function duplicateScripts(out) {
    const s = String(out || '');
    const ok = /no script requested twice \((\d+) scripts\)/.exec(s);
    if (ok) return { value: 0, text: `0 of ${ok[1]} scripts` };
    const bad = /scripts requested more than once: (.+)$/m.exec(s);
    return bad ? { value: bad[1].split(', ').length, text: bad[1] } : null;
}

/** Host's scripts/browser-check.js --json: the site's report (from stdout; progress goes to stderr). */
function browserReport(out, io) {
    const s = String((io && io.stdout) || out || '');
    const start = s.indexOf('[');
    if (start < 0) return null;
    try { const j = JSON.parse(s.slice(start)); return Array.isArray(j) ? j[0] : null; } catch { return null; }
}
function navigationGrowth(out, io) {
    const r = browserReport(out, io);
    const g = r && r.navigation && r.navigation.growth;
    if (!g || !g.measured) return null;
    const d = g.deltas || {};
    return { value: (g.over || []).length, text: `${(g.over || []).length} over; heap ${d.heapKB >= 0 ? '+' : ''}${d.heapKB} KB, nodes ${d.nodes >= 0 ? '+' : ''}${d.nodes}, listeners ${d.listeners >= 0 ? '+' : ''}${d.listeners}, intervals ${d.intervals}, timeouts ${d.timeouts}, sockets ${d.sockets} (laps ${g.from}→${g.laps})` };
}
function noJsRoutes(out, io) {
    const r = browserReport(out, io);
    const c = r && r.summary && r.summary.checks && r.summary.checks.nojs;
    if (!c) return null;
    const chars = (r.routes || []).filter((x) => x.nojs && typeof x.nojs.textChars === 'number').map((x) => x.nojs.textChars);
    return { value: c.fail, text: `${c.fail} of ${c.pass + c.fail} routes unreadable${chars.length ? ` (least text ${Math.min(...chars)} chars)` : ''}` };
}

/**
 * A passing test's summary line, found: the value it guarantees (`value`, by default 0: the test fails on any
 * violation), with the counts the line gives for the text.
 */
const found = (re, text, value = 0) => (out) => {
    const m = re.exec(String(out || ''));
    return m ? { value, text: text(m) } : null;
};

// ── Budgets ─────────────────────────────────────────────────────

/** { max } | { min } | { equals }, with a name and an optional unit. */
function withinBudget(value, budget) {
    if (typeof value !== 'number' || Number.isNaN(value)) return false;
    if (budget.max !== undefined && value > budget.max) return false;
    if (budget.min !== undefined && value < budget.min) return false;
    if (budget.equals !== undefined && value !== budget.equals) return false;
    return true;
}
function formatBudget(budget) {
    const u = budget.unit ? ` ${budget.unit}` : '';
    if (budget.equals !== undefined) return `= ${budget.equals}${u}`;
    if (budget.max !== undefined && budget.min !== undefined) return `${budget.min}–${budget.max}${u}`;
    if (budget.max !== undefined) return `≤ ${budget.max}${u}`;
    return `≥ ${budget.min}${u}`;
}
/** The bound an asserted gate proves. */
const boundOf = (budget) => (budget.equals !== undefined ? budget.equals : budget.max !== undefined ? budget.max : budget.min);
const formatValue = (value, budget) => `${value}${budget && budget.unit ? ` ${budget.unit}` : ''}`;

// ── The scenarios ───────────────────────────────────────────────

const pass = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: all checks passed\\s*$`, 'm');
const line = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const ok = (text) => line(`✓ ${text}`);

const SCENARIOS = [
    {
        n: 1, name: 'Home styles deployed during a broadcast',
        gates: [
            {
                id: '1a', what: 'a styles-only release is switched without restarting Live, streams live', repo: 'host', files: ['test/strategy-release-layout.test.js'],
                expect: [ok('live: a public/-only change switches current without a restart, even with streams live')],
                budget: { name: 'Live restarts (dropped streams)', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the test asserts host.restarts() is [] and the record says restarted: false',
            },
            {
                id: '1b', what: 'the same through Live\'s deploy wrapper on a simulated host', repo: 'live', files: ['test/deploy-sim.test.js'], timeoutMs: 300000,
                expect: [ok('public/-only change: current switches, process is NOT restarted')],
                budget: { name: 'Live restarts', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the test compares the process id before and after the switch',
            },
            {
                id: '1c', what: 'a tab broadcasting (live camera/mic) or playing a stream is never reloaded', repo: 'shared', files: ['test/release.test.js'],
                expect: [pass('release')], pins: [{ file: 'test/release.test.js', text: 'never while the camera/mic is live' }, { file: 'test/release.test.js', text: 'never while a stream is playing' }],
                budget: { name: 'reloads while capturing or playing', max: 0 }, measure: asserted('deferred: capture / media'), category: 'deferred and failed clients',
                source: 'asserts [reloads, metrics] = [0, { deferred: { capture: 1 } }] with a live track, and the same for a playing <video>',
            },
            {
                id: '1d', what: 'a style change is applied in place: only the changed stylesheet moves', repo: 'shared', files: ['test/release-update.test.js'],
                expect: [line('release-update: all checks passed')], pins: [{ file: 'test/release-update.test.js', text: "'no reload, no prompt'" }, { file: 'test/release-update.test.js', text: 'only the changed stylesheet moved, in its place' }],
                budget: { name: 'reloads + prompts for a styles-only release', max: 0 }, measure: asserted(), category: 'update eligibility',
                source: 'asserts [p.reloads, p.toasts.length] = [0, 0] after the update',
            },
            {
                id: '1e', what: 'Live\'s manifest declares style components, so its open tabs take styles in place', kind: 'manifest', base: true,
                check: (m) => {
                    const styles = Object.entries(m.components || {}).filter(([, c]) => c && c.kind === 'style').map(([id]) => id);
                    return { value: styles.length, text: `${styles.length} (components: ${Object.entries(m.components || {}).map(([id, c]) => `${id}:${c.kind}`).join(', ') || 'none'})` };
                },
                onMiss: 'open', missReason: 'the manifest declares no style component, so a styles-only release prompts open tabs (Reload) instead of swapping the stylesheet; never a reload under the person',
                budget: { name: 'style components in /release.json', min: 1 }, category: 'update eligibility',
                source: 'GET <base>/release.json',
            },
        ],
    },
    {
        n: 2, name: 'A shared navbar update',
        gates: [
            {
                id: '2a', what: 'a shared-package (navbar) bump changes the shell; a changed shell is never swapped in place', repo: 'shared', files: ['test/release.test.js', 'test/release-update.test.js'],
                expect: [pass('release'), line('release-update: all checks passed')],
                pins: [{ file: 'test/release.test.js', text: 'A platform package bump is a shell change' }, { file: 'test/release-update.test.js', text: 'a changed shell is never in place' }],
                budget: { name: 'shell updates applied in place', max: 0 }, measure: asserted('prompt instead'), category: 'update eligibility',
                source: 'release.test.js asserts the shell version moves when openvibe-sdk is bumped; release-update.test.js asserts plan() prompts',
            },
            {
                id: '2b', what: 'a visible tab someone is using is not reloaded for it', repo: 'shared', files: ['test/release.test.js'],
                expect: [pass('release')], pins: [{ file: 'test/release.test.js', text: 'a visible tab someone just used is not reloaded' }],
                budget: { name: 'reloads under an active user', max: 0 }, measure: asserted('deferred: active'), category: 'deferred and failed clients',
                source: 'asserts [reloads, metrics] = [0, { prompted: { window: 1 }, deferred: { active: 1 } }]',
            },
            {
                id: '2c', what: 'each Tools page runs the navbar its own pin serves, never Network\'s copy', repo: 'tools', cwd: 'apps/_shared', files: ['test/shared-pins.test.js'],
                expect: [/shared pins: \d+ pages/],
                budget: { name: 'pages loading shared files from another origin', max: 0 }, category: 'affected sessions',
                measure: found(/shared pins: (\d+) pages, (\d+) references, all to their app's own \/shared/, (m) => `0 of ${m[1]} pages (${m[2]} references)`),
                source: 'the test fails on any page loading a shared file from openvibe.network; the counts are its summary line',
            },
            {
                id: '2d', what: 'the previous release\'s client (N-1) against this server, every call it makes', repo: 'live', files: ['test/n-1.test.js'],
                expect: [/every call the N-1 client makes is answered compatibly/],
                budget: { name: 'incompatible N-1 calls', max: 0 }, category: 'update eligibility',
                measure: found(/answered compatibly \((\d+) requests/, (m) => `0 of ${m[1]} calls`),
                source: 'test/fixtures/n-1/client.json, recorded from the release in production; the count is the test\'s line',
            },
            {
                id: '2e', what: 'adjacent releases stay compatible in the mixed-version matrix; incompatible ones reload (contract)', repo: 'shared', files: ['test/release-mixed-version.test.js'],
                expect: [line('release-mixed-version: all checks passed')],
                budget: { name: 'adjacent pairs that break', max: 0 }, measure: asserted(), category: 'update eligibility',
                source: 'assertMixedVersion over R1/R2/R3 with real servers',
            },
        ],
    },
    {
        n: 3, name: 'An article or paste edit',
        gates: [
            {
                id: '3a', what: 'a content edit replaces its region in place (no script, frame or handler carried)', repo: 'shared', files: ['test/release-update.test.js'],
                expect: [line('release-update: all checks passed')],
                pins: [{ file: 'test/release-update.test.js', text: 'no scripts, frames, meta refreshes or inline handlers come along' }, { file: 'test/release-update.test.js', text: "'no reload, no prompt'" }],
                budget: { name: 'reloads + prompts for a content edit', max: 0 }, measure: asserted(), category: 'update eligibility',
                source: 'asserts [p.reloads, p.toasts.length] = [0, 0] and the region\'s new text',
            },
            {
                id: '3b', what: 'a region the person is typing in waits; a tab with unsent input is never reloaded', repo: 'shared', files: ['test/release-update.test.js', 'test/release.test.js'],
                expect: [line('release-update: all checks passed'), pass('release')],
                pins: [{ file: 'test/release-update.test.js', text: 'the focused region is not replaced' }, { file: 'test/release.test.js', text: 'never with unsent form input' }, { file: 'test/release.test.js', text: 'never while a text field has focus' }],
                budget: { name: 'input lost to an update', max: 0 }, measure: asserted('deferred: typing / dirty'), category: 'deferred and failed clients',
                source: 'asserts the region keeps its old text while focused and commits after blur; 0 reloads with focus or form[data-dirty]',
            },
            {
                id: '3c', what: 'Blog: an edit is a new revision; a stale save is refused (412), never lost; readers see a revision only once published', repo: 'blog', files: ['test/lifecycle.test.js'],
                expect: [ok('edit: a new immutable revision; a stale expected_revision is a 412 and loses nothing'), ok('a revision after publication does not change what readers see until it is published')],
                budget: { name: 'edits lost to a concurrent save', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the Blog lifecycle test (API with a member JWT)',
            },
            {
                id: '3d', what: 'Blog without JavaScript: a stale form is a clear refusal, not a lost edit', repo: 'blog', files: ['test/nojs-editor.test.js'],
                expect: [ok('a stale form (someone saved first) is a clear refusal, not a lost edit')],
                budget: { name: 'edits lost (no-JS form)', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the Blog no-JS editor test',
            },
        ],
    },
    {
        n: 4, name: 'A feed update while reading',
        gates: [
            {
                id: '4a', what: 'a feed region above the viewport changes height: the page scrolls by exactly that', repo: 'shared', files: ['test/release-reading.test.js'],
                expect: [line('release reading: all checks passed')],
                budget: { name: 'reading position shift', max: 0, unit: 'px' }, measure: metric('feed-reading.position-shift-px'), category: 'affected sessions',
                source: '[metric] feed-reading.position-shift-px: the feed\'s height change minus what the page scrolled (+300 and -200 px cases)',
            },
            {
                id: '4b', what: 'the region the person reads inside keeps its own scroll', repo: 'shared', files: ['test/release-reading.test.js'],
                expect: [line('release reading: all checks passed')],
                budget: { name: 'region scroll lost', max: 0, unit: 'px' }, measure: metric('feed-reading.region-scroll-lost-px'), category: 'affected sessions',
                source: '[metric] feed-reading.region-scroll-lost-px (also asserted in release-update.test.js)',
            },
            {
                id: '4c', what: 'a burst of new notifications re-reads the count once', repo: 'shared', files: ['test/notification-live.test.js'],
                expect: [line('notification live: all checks passed')], pins: [{ file: 'test/notification-live.test.js', text: "'a burst is one request'" }],
                budget: { name: 'count requests per burst', max: 1 }, measure: asserted(), category: 'resource growth',
                source: 'asserts p.counts() === before + 1 after a burst',
            },
            {
                id: '4d', what: 'Live chat keeps following when content grows under the reader', repo: 'live', files: ['test/browser/smoke.js'], base: true, ignoreExit: true, timeoutMs: 1200000,
                expect: [ok('chat keeps following when content grows under it')],
                budget: { name: 'distance from the bottom after growth', max: 120, unit: 'px' }, measure: asserted(), category: 'affected sessions',
                source: 'test/browser/smoke.js 3b (fails above 120 px)',
            },
        ],
    },
    {
        n: 5, name: 'A tool upgrade during a job',
        gates: [
            {
                id: '5a', what: 'an accepted job survives a restart; a running one is re-queued (or failed retryable); reattach and SSE resume', repo: 'tools', cwd: 'apps/_shared', files: ['test/jobs.test.js'],
                expect: [/jobs \(shared runtime\): all checks passed/], pins: [{ file: 'test/jobs.test.js', text: "'accepted job after restart'" }, { file: 'test/jobs.test.js', text: "'the event log spans the restart'" }],
                budget: { name: 'accepted jobs lost across a restart', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the jobs runtime end to end over HTTP, the app closed and reopened',
            },
            {
                id: '5b', what: 'SIGTERM with a request in flight: answered, every Tools process stops within the manifest deadline', repo: 'tools', cwd: 'apps/_shared', files: ['test/graceful.test.js'],
                expect: [/graceful stop: helper ok/],
                budget: { name: 'slowest graceful stop', max: 5000, unit: 'ms' }, measure: gracefulStop, category: 'drain duration',
                source: 'measured per process by the test; the budget is the lifecycle manifest\'s 5 s shutdown deadline',
            },
            {
                id: '5c', what: 'a Tools deploy reports running jobs, --wait-idle holds for them, a oneshot job unit is never restarted', repo: 'host', files: ['test/strategy-in-place.test.js'],
                expect: [ok('tools: running jobs are reported (drain policy report); --wait-idle holds until they finish')], pins: [{ file: 'test/strategy-in-place.test.js', text: "'a oneshot job is not restarted'" }],
                budget: { name: 'job units restarted by a deploy', max: 0 }, measure: asserted(), category: 'drain duration',
                source: 'the multi-app strategy against the fake host',
            },
        ],
    },
    {
        n: 6, name: 'An API restart during streams or calls',
        gates: [
            {
                id: '6a', what: 'a Live deploy refuses to restart with streams live; --wait-idle holds until two idle checks', repo: 'host', files: ['test/strategy-release-layout.test.js'],
                expect: [ok('live: streams live refuse the restart (exit 5): the prepared release is removed, current never moves'), ok('live: --wait-idle holds until two idle checks, then deploys; --force drops streams loudly')],
                budget: { name: 'streams dropped by a deploy without --force', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'exit 5 and host.restarts() = []; --wait-idle deploys only after two idle polls',
            },
            {
                id: '6b', what: 'a stream that starts during the install stops the restart', repo: 'host', files: ['test/deploy.test.js'],
                expect: [ok('sessions that start during the install stop the restart and put the checkout back')],
                budget: { name: 'streams dropped (late start)', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the protected probe runs again immediately before the restart',
            },
            {
                id: '6c', what: 'systemd holds Live\'s listener across a restart (loopback socket unit)', repo: 'live', files: ['test/systemd-units.test.js'],
                expect: [line('systemd units: all checks passed')],
                budget: { name: 'connections refused during a restart', max: 0 }, measure: asserted('socket held by pid 1'), category: 'affected sessions',
                source: 'the fault the 2026-09-26 web drain proof found (4 × 502) is pinned here',
            },
            {
                id: '6d', what: 'Chat restarts (SIGTERM, new process): readers reconnect and read after their cursor', repo: 'chat', files: ['test/restart-resume.test.js'],
                expect: [ok('stream reader: reconnect, join, read after_id=<cursor> — no gap, no duplicate'), ok('global reader: reconnect, join, read after_id=<cursor> — no gap, no duplicate'), ok('channel reader: reconnect, join, read after_id=<cursor> — no gap, no duplicate')],
                budget: { name: 'messages missed or repeated after a restart', max: 0 }, measure: asserted('3 readers'), category: 'reconnects',
                source: 'each reader\'s rows equal the database\'s, nothing twice',
            },
            {
                id: '6e', what: 'a Chat restart closes the calls it left open (failed / missed / ended, reason restart)', repo: 'chat', files: ['test/calls.test.js'],
                expect: [ok('lifecycle: transitions are one-way; a restart closes what was left open')],
                budget: { name: 'calls left open after a restart', max: 0 }, category: 'affected sessions',
                measure: found(/closed calls left open by the last run: (\{[^}]*\})/, (m) => `0 (closed at boot: ${m[1]})`),
                source: 'the calls lifecycle test; the closed counts are Chat\'s boot log',
            },
            {
                id: '6f', what: 'production web drain across a Live restart (release ab8abff)', kind: 'record', row: 'Web drain (Live)',
                quote: '57 requests from 10:05:07 to 10:05:24, all 200', value: 0, text: '0 of 57 requests (2026-09-26)',
                budget: { name: 'failed requests across a restart', max: 0 }, category: 'affected sessions', source: 'docs/deploy-proofs.md',
            },
            {
                id: '6g', what: 'production chat resume across a Chat restart', kind: 'record', row: 'Chat resume (Chat)',
                quote: 'The client was connected again at 11:29:36.6, 1.1 s later', value: 1.1, text: '1.1 s, 0 missed, 0 duplicate (2026-09-26)',
                budget: { name: 'reconnect after a restart', max: 2, unit: 's' }, category: 'reconnects', source: 'docs/deploy-proofs.md; budget: the client\'s 1 s first backoff plus a connect',
            },
            {
                id: '6h', what: 'production web drain: the longest a request waited across the Live restart', kind: 'record', row: 'Web drain (Live)',
                quote: 'The slowest, 0.955 s at 10:05:21', value: 0.955, text: '0.955 s (20 requests in the window, median 0.134 s; ready after 2 s)',
                budget: { name: 'longest wait across a restart', max: 2, unit: 's' }, category: 'drain duration',
                source: 'docs/deploy-proofs.md; budget: the 2 s the deploy took to report ready, the most a queued connection waits',
            },
            {
                id: '6i', what: 'a call in progress during a Chat deploy (production)', kind: 'open', category: 'affected sessions',
                budget: { name: 'calls dropped by a deploy', max: 0 },
                reason: 'no proof: Chat\'s drain policy is report (a deploy restarts with calls up); a restart ends them with end_reason restart (6e) and people call again',
            },
        ],
    },
    {
        n: 7, name: 'A media-worker rollout',
        gates: [
            {
                id: '7a', what: 'a Media deploy refuses to restart while a recording is in progress', repo: 'host', files: ['test/deploy.test.js'],
                expect: [ok('refuses to restart Media while a recording is in progress (read-only query as the service user)')],
                budget: { name: 'recordings cut by a deploy without --force', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'exit 5, nothing restarted',
            },
            {
                id: '7b', what: 'a job left running by the old worker is re-queued at start (or failed when out of attempts)', repo: 'media', files: ['test/jobs.test.js'],
                expect: [line('✅ a job left running by a dead process is requeued (or failed when out of attempts)'), line('jobs: all checks passed')],
                budget: { name: 'jobs lost across a worker restart', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'Media\'s jobs test',
            },
            {
                id: '7c', what: 'fencing: the old worker\'s late checkpoint, heartbeat and completion are refused after a takeover', repo: 'media', files: ['test/jobs-fencing.test.js'],
                expect: [line('✅ the worker aborts a job whose lease it lost, and its failure is refused'), line('jobs fencing: all checks passed')],
                budget: { name: 'stale writes accepted from a replaced worker', max: 0 }, measure: asserted(), category: 'rollback results',
                source: 'lease_token matched on renew, checkpoint, succeed and fail',
            },
            {
                id: '7d', what: 'the finalize job never touches a recording still live', repo: 'media', files: ['test/vod-finalize-job.test.js'],
                expect: [line('✅ a live recording is never finalized by the job; out of attempts the VOD stays needs_review, hidden')],
                budget: { name: 'live recordings finalized', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'Media\'s vod.finalize test',
            },
            {
                id: '7e', what: 'production: a recorder checkpoint across a Media deploy with a live ingest', kind: 'record', row: 'Recorder / media-worker checkpoint (Media)',
                budget: { name: 'recording gaps across a rollout', max: 0, unit: 's' }, category: 'affected sessions', source: 'docs/deploy-proofs.md',
            },
        ],
    },
    {
        n: 8, name: 'Duplicate or older notifications',
        gates: [
            {
                id: '8a', what: 'the bell\'s feed ignores replayed and older seqs, another person\'s events and other types', repo: 'shared', files: ['test/notification-live.test.js'],
                expect: [line('notification live: all checks passed')], pins: [{ file: 'test/notification-live.test.js', text: "assert.deepStrictEqual(heard.map((h) => h[1]), [ALICE]);" }],
                budget: { name: 'duplicate or older notifications shown', max: 0 }, measure: asserted('1 of 5 frames heard'), category: 'deferred and failed clients',
                source: 'five frames (one replayed seq, one other person, two other types), one heard',
            },
            {
                id: '8b', what: 'the same in headless Chrome with a real EventSource: drop and resume, nothing lost or repeated', repo: 'shared', files: ['test/notification-live-chrome.test.js'],
                expect: [line('notification-live-chrome: all checks passed')], pins: [{ file: 'test/notification-live-chrome.test.js', text: 'the missed ones, in order, nothing twice' }],
                budget: { name: 'notifications repeated after a resume', max: 0 }, measure: asserted(), category: 'reconnects',
                source: 'a local stand-in for Network and Events; skipped without Chrome',
            },
            {
                id: '8c', what: 'release notifications: a replayed seq or a repeated event id is dropped; a burst is one check', repo: 'shared', files: ['test/release-watch-realtime.test.js'],
                expect: [line('release-watch realtime: ok')], pins: [{ file: 'test/release-watch-realtime.test.js', text: 'the same event id twice is one event' }, { file: 'test/release-watch-realtime.test.js', text: 'exactly one /release.json fetch' }],
                budget: { name: '/release.json reads per burst', max: 1 }, measure: asserted(), category: 'resource growth',
                source: 'asserts one fetch for a burst of four events, one of them a replay',
            },
        ],
    },
    {
        n: 9, name: 'An account switch during an update',
        gates: [
            {
                id: '9a', what: 'a region fetched for the previous account (waiting, or in flight) is fetched again, never committed', repo: 'shared', files: ['test/release-account-switch.test.js'],
                expect: [line('release account switch: all checks passed')],
                budget: { name: 'regions committed as rendered for the previous account', max: 0 }, measure: metric('account-switch.stale-regions-committed'), category: 'deferred and failed clients',
                source: '[metric] account-switch.stale-regions-committed (Shared 1.23.1 fixed this: it was 1 in each case)',
            },
            {
                id: '9b', what: 'the switch reloads nothing and prompts nothing', repo: 'shared', files: ['test/release-account-switch.test.js'],
                expect: [line('release account switch: all checks passed')],
                budget: { name: 'reloads caused by a switch', max: 0 }, measure: metric('account-switch.reloads'), category: 'affected sessions',
                source: '[metric] account-switch.reloads (also counted: prompts)',
            },
            {
                id: '9c', what: 'update eligibility never depends on the account: /release.json is read without credentials', repo: 'shared', files: ['test/release-account-switch.test.js'],
                expect: [line('release account switch: all checks passed')],
                budget: { name: 'manifest reads carrying the session', max: 0 }, measure: metric('account-switch.manifest-reads-with-credentials'), category: 'update eligibility',
                source: '[metric] account-switch.manifest-reads-with-credentials',
            },
            {
                id: '9d', what: 'still one release stream per tab after a switch', repo: 'shared', files: ['test/release-account-switch.test.js', 'test/release-watch-realtime.test.js'],
                expect: [line('release account switch: all checks passed'), line('release-watch realtime: ok')], pins: [{ file: 'test/release-watch-realtime.test.js', text: 'never a second EventSource' }],
                budget: { name: 'release streams per tab', max: 1 }, measure: metric('account-switch.release-streams'), category: 'resource growth',
                source: '[metric] account-switch.release-streams',
            },
            {
                id: '9e', what: 'the bell restarts for the new account: its token, no cursor carried over', repo: 'shared', files: ['test/notification-live.test.js'],
                expect: [line('notification live: all checks passed')], pins: [{ file: 'test/notification-live.test.js', text: 'restart (another account) forgets the cursor' }, { file: 'test/notification-live.test.js', text: "'Bearer jwt-bob'" }],
                budget: { name: 'events read with the previous account\'s ticket', max: 0 }, measure: asserted(), category: 'reconnects',
                source: 'setToken() asks a ticket with the new token and opens without last_event_id',
            },
        ],
    },
    {
        n: 10, name: 'A partial asset group',
        gates: [
            {
                id: '10a', what: 'a feature whose script fails rolls back: no hook, its stylesheets withdrawn, the retry fetches only what is missing', repo: 'shared', files: ['test/web-runtime.test.js'],
                expect: [line('web runtime: all checks passed')], pins: [{ file: 'test/web-runtime.test.js', text: "'no hook for a half-loaded feature'" }, { file: 'test/web-runtime.test.js', text: "'the failed tag is gone'" }],
                budget: { name: 'half-loaded features committed', max: 0 }, measure: asserted(), category: 'deferred and failed clients',
                source: 'linkedom page where tags load or fail on cue',
            },
            {
                id: '10b', what: 'the same in headless Chrome: a real 404 rolls the group back and the retry completes it', repo: 'shared', files: ['test/web-runtime-chrome.test.js'],
                expect: [line('web-runtime-chrome: all checks passed')],
                budget: { name: 'half-loaded features committed (Chrome)', max: 0 }, measure: asserted(), category: 'deferred and failed clients',
                source: 'skipped without Chrome',
            },
            {
                id: '10c', what: 'an in-place update whose stylesheet fails keeps the old one and commits nothing', repo: 'shared', files: ['test/release-update.test.js'],
                expect: [line('release-update: all checks passed')], pins: [{ file: 'test/release-update.test.js', text: 'a stylesheet that fails to load is removed; the old one stays' }, { file: 'test/release-update.test.js', text: 'nothing commits when a stylesheet fails' }],
                budget: { name: 'pages left half updated', max: 0 }, measure: asserted('failed: style → prompt'), category: 'deferred and failed clients',
                source: 'asserts the old <link>s and the old region after a failed or timed-out stylesheet',
            },
            {
                id: '10d', what: 'Live: no script requested twice over SPA navigation', repo: 'live', files: ['test/browser/smoke.js'], base: true, ignoreExit: true, timeoutMs: 1200000,
                expect: [/no script requested twice|scripts requested more than once/],
                budget: { name: 'scripts requested twice', max: 0 }, measure: duplicateScripts, category: 'resource growth',
                source: 'test/browser/smoke.js 2+3',
            },
        ],
    },
    {
        n: 11, name: 'Repeated navigation leaks',
        gates: [
            {
                id: '11a', what: 'a route\'s timers, listeners and fetches end with it; late registrations are refused', repo: 'shared', files: ['test/web-runtime.test.js'],
                expect: [line('web runtime: all checks passed')], pins: [{ file: 'test/web-runtime.test.js', text: "every interval cleared (the child\\'s too)" }, { file: 'test/web-runtime.test.js', text: "'every pending timeout cleared'" }],
                budget: { name: 'intervals + timeouts left after a route ends', max: 0 }, measure: asserted(), category: 'resource growth',
                source: 'asserts p.out.intervals.size === 0 and p.out.timers.length === 0 after nextRoute()',
            },
            {
                id: '11b', what: 'the same in headless Chrome: the route\'s interval stops and its fetch aborts', repo: 'shared', files: ['test/web-runtime-chrome.test.js'],
                expect: [line('web-runtime-chrome: all checks passed')],
                budget: { name: 'intervals left after a route ends (Chrome)', max: 0 }, measure: asserted(), category: 'resource growth',
                source: 'skipped without Chrome',
            },
            {
                id: '11c', what: 'Live: three laps of ten routes; intervals, sockets and listeners between laps 2 and 3', repo: 'live', files: ['test/browser/smoke.js'], base: true, ignoreExit: true, timeoutMs: 1200000,
                expect: [/lap probes:/],
                budget: { name: 'growth per counter', max: 2 }, measure: lapGrowth(['intervals', 'sockets', 'windowListeners', 'documentListeners']), category: 'resource growth',
                source: 'test/browser/smoke.js 4 (slack 2 per counter)',
            },
            {
                id: '11d', what: 'Live: DOM nodes between laps 2 and 3', repo: 'live', files: ['test/browser/smoke.js'], base: true, ignoreExit: true, timeoutMs: 1200000,
                expect: [/lap probes:/],
                budget: { name: 'DOM node growth', max: 150 }, measure: lapGrowth(['domNodes']), category: 'resource growth',
                source: 'test/browser/smoke.js 4 (slack 150 nodes)',
            },
            {
                id: '11e', what: 'home ↔ second route five times: heap, nodes, listeners, documents, intervals, timeouts, sockets', repo: 'host', files: ['scripts/browser-check.js'], base: true, timeoutMs: 600000,
                args: (ctx) => ['--sites', ctx.base, '--json', '--no-axe', '--widths', '1280', '--max-routes', '5'], expect: [/"growth":/],
                budget: { name: 'measures over their growth budget', max: 0 }, measure: navigationGrowth, category: 'resource growth',
                source: 'openvibe-shared/browser-harness growth budgets: heap 3 MB, nodes 300, listeners 30, documents 1, intervals 1, timeouts 10, sockets 1 (docs/browser-check.md)',
            },
        ],
    },
    {
        n: 12, name: 'JS-disabled routes',
        gates: [
            {
                id: '12a', what: 'Live channel, VOD and clip pages render a real body without JavaScript', repo: 'live', files: ['test/seo-ssr.test.js'],
                expect: [ok('without JavaScript the body shows (with the site links) and the empty app shell is hidden'), ok('the client still hydrates: the route boots its feature and the fragment is inlined')],
                budget: { name: 'SSR routes without a body', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'Live\'s SEO middleware and SPA fallback, mounted as server/index.js mounts them',
            },
            {
                id: '12b', what: 'Blog: write, edit, publish and comment with plain forms', repo: 'blog', files: ['test/nojs-editor.test.js'],
                expect: [ok('new draft, edit and publish with forms'), ok('the post page shows the Community thread and takes a comment by form')],
                budget: { name: 'journey steps needing JavaScript', max: 0 }, measure: asserted(), category: 'affected sessions',
                source: 'the Blog no-JS editor test',
            },
            {
                id: '12c', what: 'the running site\'s routes, read with JavaScript off', repo: 'host', files: ['scripts/browser-check.js'], base: true, timeoutMs: 600000,
                args: (ctx) => ['--sites', ctx.base, '--json', '--no-axe', '--widths', '1280', '--max-routes', '5'], expect: [/"nojs":/],
                budget: { name: 'routes unreadable without JS', max: 0 }, measure: noJsRoutes, category: 'affected sessions',
                source: 'openvibe-shared/browser-harness nojs check (a page needs its minimum of text)',
            },
        ],
    },
    {
        n: 13, name: 'Rollback with new writes',
        gates: [
            {
                id: '13a', what: 'the release of a week ago boots on this release\'s database, reads the newer rows and writes; then forward again', repo: 'live', files: ['test/rollback-newer-writes.test.js'], timeoutMs: 300000,
                expect: [/rollback with newer writes: the release of \w+ works on this release's database, and back again/],
                budget: { name: 'newer rows read after the rollback', min: 100, unit: '%' }, category: 'rollback results',
                measure: found(/the release of (\w+) works/, (m) => `100 % (user and setting written by the newer release; older release ${m[1]}, 0 boot errors)`, 100),
                source: 'a git worktree of the release of 7 days ago on a database this release wrote; skipped without git history',
            },
            {
                id: '13b', what: 'rolling back returns the old release and its own node_modules; a release never ready is switched back', repo: 'host', files: ['test/strategy-release-layout.test.js'],
                expect: [ok('live: a lockfile change installs into the new release only; rollback returns to the old release and its own node_modules'), ok('live: not ready after the restart: current switches back, the old units come back, exit 3')],
                budget: { name: 'rollbacks that leave new code or dependencies', max: 0 }, measure: asserted(), category: 'rollback results',
                source: 'the release-layout strategy against the fake host',
            },
            {
                id: '13c', what: 'the same through Live\'s deploy script', repo: 'live', files: ['test/deploy-sim.test.js'], timeoutMs: 300000,
                expect: [ok('--rollback returns code AND node_modules of the previous release'), ok('a release that never becomes ready is rolled back automatically (exit 3)')],
                budget: { name: 'rollbacks that leave new code or dependencies', max: 0 }, measure: asserted(), category: 'rollback results',
                source: 'simulated host with a real git origin',
            },
            {
                id: '13d', what: 'open tabs follow a rollback in place; schema generations say when a rollback is safe', repo: 'shared', files: ['test/release-update.test.js', 'test/release-mixed-version.test.js'],
                expect: [line('release-update: all checks passed'), line('release-mixed-version: all checks passed')],
                pins: [{ file: 'test/release-update.test.js', text: 'A rollback to the previous release is applied in place too' }, { file: 'test/release-mixed-version.test.js', text: 'compat.rollbackSafe(R3.manifest, R2.manifest).ok, false' }],
                budget: { name: 'reloads for a rollback of styles or content', max: 0 }, measure: asserted(), category: 'rollback results',
                source: 'release-update.test.js and release-compat rollbackSafe',
            },
        ],
    },
    {
        n: 14, name: 'Resuming an offline tab',
        gates: [
            {
                id: '14a', what: 'back online, the release stream reconnects at once from its cursor (given up or backing off)', repo: 'shared', files: ['test/release-offline-resume.test.js'],
                expect: [line('release offline resume: all checks passed')],
                budget: { name: 'stream reconnect delay after online', max: 0, unit: 'ms' }, measure: metric('offline-resume.stream-reconnect-delay-ms'), category: 'reconnects',
                source: '[metric] offline-resume.stream-reconnect-delay-ms (Shared 1.23.1 fixed this: 30 000 ms in the test, up to 8 min before)',
            },
            {
                id: '14b', what: 'one /release.json read brings it straight to the newest release, in place', repo: 'shared', files: ['test/release-offline-resume.test.js'],
                expect: [line('release offline resume: all checks passed')],
                budget: { name: 'manifest reads on resume', max: 1 }, measure: metric('offline-resume.manifest-reads-on-resume'), category: 'update eligibility',
                source: '[metric] offline-resume.manifest-reads-on-resume',
            },
            {
                id: '14c', what: 'offline: no prompt, no reload, nothing counted as failed; mid-update loss leaves the page whole', repo: 'shared', files: ['test/release-offline-resume.test.js'],
                expect: [line('release offline resume: all checks passed')],
                budget: { name: 'reloads + prompts + failures while offline, and half-updated pages', max: 0 },
                measure: (out) => {
                    const m = parseMetrics(out);
                    const keys = ['offline-resume.reloads-while-offline', 'offline-resume.prompts-while-offline', 'offline-resume.failures-counted-offline', 'offline-resume.partial-pages', 'offline-resume.reloads-while-typing'];
                    if (keys.some((k) => m[k] === undefined)) return null;
                    return { value: keys.reduce((a, k) => a + m[k], 0), text: keys.map((k) => `${k.split('.')[1]} ${m[k]}`).join(', ') };
                },
                category: 'deferred and failed clients',
                source: '[metric] offline-resume.* (reloads, prompts, failures, partial pages, reloads while typing)',
            },
            {
                id: '14d', what: 'the bell resumes from its cursor when the browser is back online', repo: 'shared', files: ['test/notification-live.test.js'],
                expect: [line('notification live: all checks passed')], pins: [{ file: 'test/notification-live.test.js', text: "'back online: a new stream'" }, { file: 'test/notification-live.test.js', text: "'14', 'from the cursor'" }],
                budget: { name: 'notifications missed on resume', max: 0 }, measure: asserted(), category: 'reconnects',
                source: 'asserts a new stream with last_event_id = the last seq seen',
            },
        ],
    },
];

// ── Repositories and versions ──────────────────────────────────

const LIVE_WORKTREE = path.join(os.homedir(), 'orca', 'workspaces', 'OpenVibe.Live', 'seadragon');

/** { host, shared, live, … } → absolute directories. Live: --live, else the seadragon worktree, else <repos>/OpenVibe.Live. */
function resolveRepos({ repos = path.join(os.homedir(), 'OpenVibers'), live = null, host = HOST_DIR, exists = fs.existsSync } = {}) {
    const out = {};
    for (const [id, r] of Object.entries(REPOS)) out[id] = path.join(repos, r.dir);
    out.host = host;
    out.live = live || (exists(path.join(LIVE_WORKTREE, 'package.json')) ? LIVE_WORKTREE : path.join(repos, REPOS.live.dir));
    return out;
}

function git(dir, args) {
    try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); } catch { return null; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** Release and component versions of each repository a gate ran in: commit, branch, changed files, package and pins. */
function recordVersions(dirs, used) {
    const out = {};
    for (const id of used) {
        const dir = dirs[id];
        if (!dir || !fs.existsSync(dir)) { out[id] = { dir, missing: true }; continue; }
        const pkg = readJson(path.join(dir, 'package.json')) || {};
        const status = git(dir, ['status', '--porcelain']);
        const pinned = (name) => {
            const installed = readJson(path.join(dir, 'node_modules', name, 'package.json'));
            if (installed) return installed.version;
            const spec = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }[name];
            const tag = spec && /\/v(\d+\.\d+\.\d+)$/.exec(spec);
            return tag ? tag[1] : spec || null;
        };
        out[id] = {
            dir, commit: git(dir, ['rev-parse', '--short=12', 'HEAD']), branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
            changed: status == null ? null : status.split('\n').filter(Boolean).length, version: pkg.version || null,
            shared: pinned('openvibe-shared'), contracts: pinned('openvibe-contracts'),
        };
    }
    return out;
}

// ── Running ─────────────────────────────────────────────────────

/** Runs `node <file> [args]` from `cwd`; resolves { code, signal, out (stdout and stderr), stdout, ms, timedOut }. */
function runNode({ node = process.execPath, file, args = [], cwd, env = {}, timeoutMs = 180000 }) {
    return new Promise((resolve) => {
        const started = Date.now();
        let out = ''; let stdout = ''; let timedOut = false;
        let child;
        try {
            child = spawn(node, [file, ...args], { cwd, env: { ...process.env, NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) { resolve({ code: null, signal: null, out: String(err && err.message), stdout: '', ms: 0, timedOut: false }); return; }
        child.stdout.on('data', (c) => { out += c; stdout += c; });
        child.stderr.on('data', (c) => { out += c; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', (err) => { out += `\n${err.message}`; });
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, stdout, ms: Date.now() - started, timedOut }); });
    });
}

const SKIP_RE = /^[\w .()-]+: skipped \((.+)\)\s*$/m;

/** Reads this repository's docs/deploy-proofs.md table: row name → { state, record }. */
function proofRows(text) {
    const rows = {};
    for (const l of String(text || '').split('\n')) {
        const cells = l.split('|').map((c) => c.trim());
        if (cells.length >= 4 && cells[1] && !/^-+$/.test(cells[1]) && cells[1] !== 'Proof') rows[cells[1]] = { state: cells[2], record: cells[3] };
    }
    return rows;
}

function result(gate, fields) {
    const budgetText = gate.budget ? formatBudget(gate.budget) : '';
    return { id: gate.id, what: gate.what, repo: gate.repo || null, files: gate.files || [], category: gate.category, source: gate.source || null, budget: gate.budget || null, budgetText, measured: null, measuredText: '—', reason: null, note: null, ms: 0, ...fields };
}

/**
 * Judges one gate. ctx: { dirs, base, node, run (cached runNode), readFile, fetchManifest, hostDir, timeoutMs }.
 */
async function judgeGate(gate, ctx) {
    const kind = gate.kind || 'test';
    if (kind === 'open') return result(gate, { result: 'open', reason: gate.reason });
    if (gate.base && !ctx.base) return result(gate, { result: 'skipped', reason: 'needs a running site: --base <url>' });
    if (kind === 'record') {
        const doc = ctx.readFile(path.join(ctx.hostDir, 'docs', 'deploy-proofs.md'));
        const row = doc == null ? null : proofRows(doc)[gate.row];
        if (!row) return result(gate, { result: 'fail', reason: `docs/deploy-proofs.md has no row "${gate.row}"` });
        if (!/^passed\b/i.test(row.state)) return result(gate, { result: 'open', reason: /^open$/i.test(row.state) && row.record ? row.record : `${row.state}${row.record ? `: ${row.record}` : ''}` });
        if (gate.quote && !doc.includes(gate.quote)) return result(gate, { result: 'fail', reason: `the record no longer says "${gate.quote}"` });
        const inside = withinBudget(gate.value, gate.budget);
        return result(gate, { result: inside ? 'pass' : 'fail', measured: gate.value, measuredText: gate.text || formatValue(gate.value, gate.budget), note: `recorded: ${row.state}`, reason: inside ? null : 'the recorded value is outside the budget' });
    }
    if (kind === 'manifest') {
        let m;
        try { m = await ctx.fetchManifest(ctx.base); } catch (err) { return result(gate, { result: 'fail', reason: `GET ${ctx.base}/release.json: ${err.message}` }); }
        const v = gate.check(m);
        const inside = withinBudget(v.value, gate.budget);
        const base = { measured: v.value, measuredText: v.text || formatValue(v.value, gate.budget) };
        if (inside) return result(gate, { result: 'pass', ...base });
        return result(gate, { result: gate.onMiss === 'open' ? 'open' : 'fail', reason: gate.missReason || 'outside the budget', ...base });
    }

    const dir = ctx.dirs[gate.repo];
    const cwd = path.join(dir || '', gate.cwd || '');
    if (!dir || !fs.existsSync(cwd)) return result(gate, { result: 'skipped', reason: `${(REPOS[gate.repo] || { name: gate.repo }).name} not found at ${cwd}` });
    for (const f of gate.files) {
        if (!fs.existsSync(path.join(cwd, f))) return result(gate, { result: 'fail', reason: `${f} is missing in ${REPOS[gate.repo].name}` });
    }
    for (const pin of gate.pins || []) {
        const src = ctx.readFile(path.join(cwd, pin.file));
        if (src == null || !src.includes(pin.text)) return result(gate, { result: 'fail', reason: `the assertion this gate rests on is gone from ${pin.file}: ${pin.text}` });
    }
    let out = ''; let stdout = ''; let ms = 0;
    // What a failing test still printed is shown (a [metric] line comes before the assertion that fails).
    const shown = () => {
        if (!gate.measure || gate.measure.asserted) return {};
        let v = null;
        try { v = gate.measure(out, { stdout, ctx }); } catch { /* not measurable */ }
        return v && typeof v.value === 'number' ? { measured: v.value, measuredText: v.text || formatValue(v.value, gate.budget) } : {};
    };
    for (const f of gate.files) {
        const args = typeof gate.args === 'function' ? gate.args(ctx) : gate.args || [];
        const env = gate.base ? { BASE: ctx.base, ...(ctx.channel ? { CHANNEL: ctx.channel } : {}) } : {};
        const r = await ctx.run({ repo: gate.repo, sub: gate.cwd || '', cwd, file: f, args, env, timeoutMs: gate.timeoutMs || ctx.timeoutMs || 180000 });
        out += r.out; stdout += r.stdout || ''; ms += r.ms;
        const skip = SKIP_RE.exec(r.out);
        if (r.code === 0 && skip) return result(gate, { result: 'skipped', reason: `${f}: ${skip[1]}`, ms, tail: tail(r.out) });
        if (r.timedOut) return result(gate, { result: 'fail', reason: `${f} timed out after ${Math.round((gate.timeoutMs || ctx.timeoutMs || 180000) / 1000)} s`, ms, tail: tail(r.out), ...shown() });
        if (r.code !== 0 && !gate.ignoreExit) return result(gate, { result: 'fail', reason: `${f} failed (exit ${r.code ?? r.signal})`, ms, tail: tail(r.out), ...shown() });
    }
    for (const re of gate.expect || []) {
        if (!re.test(out)) return result(gate, { result: 'fail', reason: `expected output missing: ${re.source.replace(/\\/g, '')}`, ms, tail: tail(out), ...shown() });
    }
    let v;
    if (gate.measure && gate.measure.asserted) {
        const b = boundOf(gate.budget);
        v = { value: b, text: `${formatValue(b, gate.budget)} (asserted${gate.measure.note ? `; ${gate.measure.note}` : ''})` };
    } else {
        try { v = gate.measure(out, { stdout, ctx }); } catch { v = null; }
    }
    if (!v || typeof v.value !== 'number') return result(gate, { result: 'fail', reason: 'the measured value is not in the output', ms, tail: tail(out) });
    const inside = withinBudget(v.value, gate.budget);
    const note = gate.ignoreExit && /\d+ browser check\(s\) failed/.test(out) ? `the smoke's other checks: ${/(\d+) browser check\(s\) failed/.exec(out)[1]} failed (not this gate's)` : null;
    return result(gate, { result: inside ? 'pass' : 'fail', measured: v.value, measuredText: v.text || formatValue(v.value, gate.budget), note, reason: inside ? null : 'outside the budget', ms, tail: inside ? undefined : tail(out) });
}

const tail = (out, n = 15) => String(out || '').trimEnd().split('\n').slice(-n).join('\n');

/** Selects scenarios by number and gates by id: ['1', '9', '6a'] → the gates to judge, in table order. */
function select(scenarios, only) {
    const list = [];
    const want = (only || []).map(String);
    for (const s of scenarios) {
        for (const g of s.gates) {
            if (want.length && !want.includes(String(s.n)) && !want.includes(g.id)) continue;
            list.push({ scenario: s, gate: g });
        }
    }
    return list;
}

async function defaultFetchManifest(base) {
    const r = await fetch(new URL('/release.json', base), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

/**
 * Runs the suite. opts: { scenarios, only, repos, live, base, channel, node, timeoutMs, runner, fetchManifest,
 * readFile, hostDir, logs (a directory: each run's output as <repo>__<file>.log), onGate(row) }. Each test file
 * runs once per run (gates share its output).
 */
async function runAcceptance(opts = {}) {
    const scenarios = opts.scenarios || SCENARIOS;
    const dirs = opts.dirs || resolveRepos({ repos: opts.repos, live: opts.live });
    const cache = new Map();
    const runner = opts.runner || runNode;
    const ctx = {
        dirs, base: opts.base ? String(opts.base).replace(/\/$/, '') : null, channel: opts.channel || null, node: opts.node || process.execPath,
        timeoutMs: opts.timeoutMs, hostDir: opts.hostDir || HOST_DIR,
        readFile: opts.readFile || ((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }),
        fetchManifest: opts.fetchManifest || defaultFetchManifest,
        run: (spec) => {
            const key = JSON.stringify([spec.cwd, spec.file, spec.args, spec.env]);
            if (cache.has(key)) return cache.get(key).then((r) => ({ ...r, ms: 0, cached: true }));
            cache.set(key, runner({ node: ctx.node, ...spec }).then((r) => {
                if (opts.logs) {
                    try { fs.mkdirSync(opts.logs, { recursive: true }); fs.writeFileSync(path.join(opts.logs, `${spec.repo}__${[spec.sub, spec.file].filter(Boolean).join('__').replace(/[^\w.-]+/g, '_')}.log`), r.out); } catch { /* best effort */ }
                }
                return r;
            }));
            return cache.get(key);
        },
    };
    const startedAt = new Date().toISOString();
    const selected = select(scenarios, opts.only);
    const used = [...new Set(['host', ...selected.filter(({ gate }) => gate.repo).map(({ gate }) => gate.repo)])];
    const versions = recordVersions(dirs, used);
    const rows = [];
    let site = null;
    if (ctx.base) { try { const m = await ctx.fetchManifest(ctx.base); site = { base: ctx.base, service: m.service, release: m.release, released_at: m.released_at, packages: m.packages, components: m.components ? Object.fromEntries(Object.entries(m.components).map(([k, c]) => [k, `${c.kind}@${c.version}`])) : null }; } catch (err) { site = { base: ctx.base, error: err.message }; } }
    for (const { scenario, gate } of selected) {
        const r = await judgeGate(gate, ctx);
        const row = { scenario: scenario.n, scenarioName: scenario.name, kind: gate.kind || 'test', ...r };
        rows.push(row);
        if (opts.onGate) opts.onGate(row);
    }
    // A repository that moved while its tests ran is named: the run tested a mix.
    const after = recordVersions(dirs, used);
    for (const id of used) {
        if (!versions[id].missing && (after[id].commit !== versions[id].commit || after[id].changed !== versions[id].changed)) versions[id].changedDuringRun = `${after[id].commit}${after[id].changed ? `, ${after[id].changed} uncommitted` : ''}`;
    }
    return { startedAt, finishedAt: new Date().toISOString(), node: process.version, base: ctx.base, site, versions, gates: rows, summary: summarize(rows) };
}

/** pass/fail/skipped/open counts; ok only when nothing failed (skipped and open are never passes). */
function summarize(rows) {
    const s = { gates: rows.length, pass: 0, fail: 0, skipped: 0, open: 0 };
    for (const r of rows) s[r.result] = (s[r.result] || 0) + 1;
    s.ok = s.fail === 0;
    s.scenarios = [...new Set(rows.map((r) => r.scenario))].length;
    return s;
}

// ── Reports ─────────────────────────────────────────────────────

function versionLine(id, v) {
    if (v.missing) return `${id}: not found (${v.dir})`;
    return `${id} ${v.commit || '?'}${v.branch && v.branch !== 'HEAD' ? ` (${v.branch})` : ''}${v.changed ? `, ${v.changed} uncommitted` : ''}${v.version ? `, v${v.version}` : ''}${v.shared && id !== 'shared' ? `, shared ${v.shared}` : ''}${v.changedDuringRun ? ` — CHANGED DURING THE RUN (now ${v.changedDuringRun})` : ''}`;
}

function formatTable(report) {
    const L = [];
    L.push(`Release-lifecycle acceptance (D46), ${report.startedAt} (node ${report.node})`);
    for (const [id, v] of Object.entries(report.versions)) L.push(`  ${versionLine(id, v)}`);
    if (report.site) L.push(`  site ${report.site.base}: ${report.site.error ? `unreachable (${report.site.error})` : `${report.site.service} ${report.site.release}, components ${Object.entries(report.site.components || {}).map(([k, c]) => `${k}=${c}`).join(' ') || 'none'}`}`);
    L.push('');
    const rows = report.gates.map((r) => [String(r.scenario), r.id, r.result, r.measuredText, r.budgetText, `${r.budget ? `${r.budget.name}: ` : ''}${r.what}`]);
    const head = ['#', 'gate', 'result', 'measured', 'budget', 'what'];
    const w = head.map((h, i) => Math.min(i === 3 ? 48 : 60, Math.max(h.length, ...rows.map((r) => r[i].length))));
    const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    L.push(head.map((h, i) => (i === head.length - 1 ? h : h.padEnd(w[i]))).join('  '));
    let last = null;
    for (let k = 0; k < rows.length; k++) {
        const r = report.gates[k];
        if (r.scenario !== last) { L.push(`── ${r.scenario}. ${r.scenarioName}`); last = r.scenario; }
        L.push(rows[k].map((c, i) => (i === rows[k].length - 1 ? c : cut(c, w[i]).padEnd(w[i]))).join('  '));
        if (r.reason && r.result !== 'pass') L.push(`${' '.repeat(w[0] + w[1] + 4)}↳ ${r.reason}`);
        else if (r.note && r.kind !== 'record') L.push(`${' '.repeat(w[0] + w[1] + 4)}↳ ${r.note}`);
    }
    const s = report.summary;
    L.push('');
    L.push(`${s.pass} passed, ${s.fail} failed, ${s.skipped} skipped, ${s.open} open (${s.gates} gates, ${s.scenarios} scenarios)${s.ok ? '' : ' — FAILED'}`);
    // One excerpt per failing output (gates that share a test share its failure).
    const tails = new Map();
    for (const r of report.gates.filter((x) => x.result === 'fail' && x.tail)) {
        const k = `${r.reason}\n${r.tail}`;
        if (!tails.has(k)) tails.set(k, { ids: [], reason: r.reason, tail: r.tail });
        tails.get(k).ids.push(r.id);
    }
    for (const t of tails.values()) L.push('', `── ${t.ids.join(', ')} (${t.reason}) ──`, t.tail);
    return L.join('\n');
}

const md = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
function formatMarkdown(report) {
    const L = [];
    L.push(`## Run ${report.startedAt.slice(0, 16).replace('T', ' ')} UTC`, '');
    L.push(`Node ${report.node}${report.base ? `, --base ${report.base}` : ', no --base'}.`, '');
    L.push('| Repository | Commit | Uncommitted | Version | openvibe-shared |', '|---|---|---|---|---|');
    for (const [id, v] of Object.entries(report.versions)) L.push(v.missing ? `| ${id} | not found | | | |` : `| ${id} | \`${v.commit}\`${v.branch && v.branch !== 'HEAD' ? ` (${v.branch})` : ''}${v.changedDuringRun ? ` (changed during the run: now ${v.changedDuringRun})` : ''} | ${v.changed ?? '?'} | ${v.version || ''} | ${id === 'shared' ? '(this)' : v.shared || ''} |`);
    if (report.site) L.push('', report.site.error ? `Site ${report.site.base}: unreachable (${report.site.error}).` : `Site ${report.site.base}: \`${report.site.service}\` release \`${report.site.release}\` (${report.site.released_at}), components ${Object.entries(report.site.components || {}).map(([k, c]) => `\`${k}\` ${c}`).join(', ') || 'none'}.`);
    L.push('', '| # | Gate | Result | Measured | Budget |', '|---|---|---|---|---|');
    for (const r of report.gates) {
        const res = r.result === 'pass' ? `pass${r.note ? ` (${md(r.note)})` : ''}` : `**${r.result}**${r.reason ? `: ${md(r.reason)}` : ''}`;
        L.push(`| ${r.scenario} | ${r.id} | ${res} | ${md(r.measuredText)} | ${md(r.budget ? `${r.budget.name} ${r.budgetText}` : r.budgetText)} |`);
    }
    const s = report.summary;
    L.push('', `${s.pass} passed, ${s.fail} failed, ${s.skipped} skipped, ${s.open} open (${s.gates} gates, ${s.scenarios} scenarios).`);
    return L.join('\n');
}

module.exports = {
    SCENARIOS, REPOS, CATEGORIES, HOST_DIR,
    parseMetrics, metric, gracefulStop, lapProbes, lapGrowth, duplicateScripts, navigationGrowth, noJsRoutes, proofRows,
    withinBudget, formatBudget, boundOf,
    resolveRepos, recordVersions, runNode, judgeGate, select, runAcceptance, summarize, formatTable, formatMarkdown,
};
