'use strict';
/**
 * `ovhost browser-watch` (roadmap WS-H task 11, "release UX check"): each watched site is checked in a real
 * browser (scripts/browser-check.js through lib/browser-check-hook.js) after every release, and once a day
 * without one, and a failure pages the operator (OpenVibeBrowserCheckFailed → ovhost alerts relay → Network).
 *
 *   ovhost browser-watch [--sites live,network] [--force]      (openvibe-browsercheck.timer: every 5 minutes)
 *
 * Per site: GET <origin>/release.json. A release not checked yet, or a last check older than 24 hours, runs the
 * check as the unprivileged `ovcheck` account (Chrome never runs as root), once its process has run 3 minutes
 * (/release.json booted_at). A failing check runs once more, a minute later, before it counts (a single network blip or
 * a restart's reconnects are not a regression). The outcome is kept in
 * <stateDir>/browser-watch/<site>.json, and every site's latest outcome is written to the textfile collector
 * (openvibe_browsercheck.prom):
 *
 *   openvibe_browser_check_ok{service}                          1 passed, 0 failed
 *   openvibe_browser_check_release_info{service,release}        1: the release that check saw
 *   openvibe_browser_check_failing_checks{service}              checks with failures (status, console, overflow, axe…)
 *   openvibe_browser_check_last_run_timestamp_seconds{service}  when the last check ran to the end
 *
 * A check that could not run (Chrome missing, the harness broke: exit 2) is not recorded as a pass or a fail;
 * the next timer run tries again, and OpenVibeBrowserCheckMissed notices when none has run for a day.
 * The origin comes from the inventory entry's `origin`, else the service manifest's publicOrigin.
 */
const path = require('path');
const { runBrowserCheck } = require('./browser-check-hook');

const DAY_MS = 24 * 3600 * 1000;
const SETTLE_MS = 3 * 60 * 1000;        // a release is checked once its process has run this long
const RETRY_DELAY_MS = 60 * 1000;      // before the confirming second run
const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';
const SITE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const RELEASE_RE = /^[0-9A-Za-z._+-]{1,64}$/;

function originOf(inv, id, contracts) {
    const entry = inv.services && inv.services[id];
    if (entry && entry.origin) return String(entry.origin).replace(/\/+$/, '');
    let lib = contracts;
    if (!lib) { try { lib = require('openvibe-contracts'); } catch { return null; } }
    const m = lib.services && typeof lib.services.get === 'function' ? lib.services.get(id) : null;
    return m && m.publicOrigin ? String(m.publicOrigin).replace(/\/+$/, '') : null;
}

async function currentRelease(exec, origin, { withAge = false } = {}) {
    const r = await exec.request(`${origin}/release.json`, { timeoutMs: 8000 });
    if (r.status !== 200) return withAge ? { release: null, bootedAt: null } : null;
    try {
        const m = JSON.parse(r.body);
        const rel = String(m.release || m.commit || '').slice(0, 12);
        const release = RELEASE_RE.test(rel) ? rel : null;
        const booted = Date.parse(m.booted_at || m.released_at || '');
        return withAge ? { release, bootedAt: Number.isFinite(booted) ? booted : null } : release;
    } catch { return withAge ? { release: null, bootedAt: null } : null; }
}

/**
 * What failed, for the operator (kept in the state file, never in metrics): per route, the axe rule ids
 * with up to 3 targets, the first console errors, overflow and status. At most 20 entries, text clipped.
 */
function failureDetails(reports) {
    const out = [];
    const clip = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
    for (const r of reports || []) {
        for (const route of r.routes || []) {
            if (route.ok !== false) continue;
            for (const v of (route.axe && route.axe.violations) || []) out.push({ route: route.path, check: 'axe', rule: v.id, impact: v.impact || null, targets: (v.targets || []).slice(0, 3).map((t) => clip(t, 160)) });
            for (const e of route.errors || []) out.push({ route: route.path, check: 'errors', message: clip(e && (e.text || e.message) ? (e.text || e.message) : e) });
            for (const w of route.widths || []) {
                for (const e of (w.errors || []).slice(0, 3)) out.push({ route: route.path, check: 'errors', width: w.width, message: clip(e && (e.text || e.message) ? (e.text || e.message) : e) });
                if (w.overflow) out.push({ route: route.path, check: 'overflow', width: w.width, offenders: (w.offenders || []).slice(0, 3).map((t) => clip(typeof t === 'string' ? t : JSON.stringify(t), 160)) });
                if (w.status && w.status >= 400 && !route.expectStatus) out.push({ route: route.path, check: 'status', width: w.width, status: w.status });
            }
        }
    }
    return out.slice(0, 20);
}

/** The failing checks of a --json report list: [{ check, fail }]. */
function failingChecks(reports) {
    const out = [];
    for (const r of reports || []) {
        const checks = (r.summary && r.summary.checks) || {};
        for (const [k, c] of Object.entries(checks)) if (c && c.fail) out.push({ check: k, fail: c.fail });
        if (r.error) out.push({ check: 'run', fail: 1 });
    }
    return out;
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function writeMetrics(exec, inv) {
    const dir = inv.textfileDir || TEXTFILE_DIR;
    if (!(await exec.readdir(dir))) return false;
    const stateDir = path.join(inv.stateDir, 'browser-watch');
    const rows = [];
    for (const e of (await exec.readdir(stateDir)) || []) {
        if (!e.name.endsWith('.json')) continue;
        try { const s = JSON.parse((await exec.readFile(path.join(stateDir, e.name))) || 'null'); if (s && SITE_RE.test(s.site)) rows.push(s); } catch { /* skip */ }
    }
    rows.sort((a, b) => a.site.localeCompare(b.site));
    const lines = [
        // The release is its own series, so an alert keeps one identity across releases (no resolve-and-reopen).
        '# HELP openvibe_browser_check_ok 1 when the last browser check of the site passed.',
        '# TYPE openvibe_browser_check_ok gauge',
        ...rows.map((s) => `openvibe_browser_check_ok{service="${esc(s.site)}"} ${s.ok ? 1 : 0}`),
        '# HELP openvibe_browser_check_release_info The release the last browser check of the site checked.',
        '# TYPE openvibe_browser_check_release_info gauge',
        ...rows.map((s) => `openvibe_browser_check_release_info{service="${esc(s.site)}",release="${esc(s.release || 'unknown')}"} 1`),
        '# HELP openvibe_browser_check_failing_checks Checks with failures in the last browser check of the site.',
        '# TYPE openvibe_browser_check_failing_checks gauge',
        ...rows.map((s) => `openvibe_browser_check_failing_checks{service="${esc(s.site)}"} ${(s.failing || []).length}`),
        '# HELP openvibe_browser_check_last_run_timestamp_seconds When the last browser check of the site ran to the end.',
        '# TYPE openvibe_browser_check_last_run_timestamp_seconds gauge',
        ...rows.map((s) => `openvibe_browser_check_last_run_timestamp_seconds{service="${esc(s.site)}"} ${Math.floor(Date.parse(s.checkedAt) / 1000)}`),
    ];
    await exec.writeFile(path.join(dir, 'openvibe_browsercheck.prom'), `${lines.join('\n')}\n`, { mode: 0o644 });
    return true;
}

/**
 * One pass over the sites. Answers { sites: [{ site, release, action: 'checked'|'skipped'|'error', ok?, failing?, reason? }] }.
 * opts: sites (ids), force, asUser (default ovcheck), home, now, check (the runBrowserCheck to use; tests).
 */
async function watch(ctx, { sites = ['live'], force = false, asUser = 'ovcheck', home = '/var/lib/ovcheck', now = Date.now(), check = runBrowserCheck, contracts = null, settleMs = SETTLE_MS, retryDelayMs = RETRY_DELAY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const { exec, inv } = ctx;
    const stateDir = path.join(inv.stateDir, 'browser-watch');
    await exec.mkdir(stateDir, { mode: 0o750 });
    const out = [];
    for (const site of sites) {
        if (!SITE_RE.test(site)) { out.push({ site, action: 'error', reason: 'not a service id' }); continue; }
        const origin = originOf(inv, site, contracts);
        if (!origin) { out.push({ site, action: 'error', reason: 'no origin (inventory origin or manifest publicOrigin)' }); continue; }
        const { release, bootedAt } = await currentRelease(exec, origin, { withAge: true });
        // A process that just started (a deploy, a restart) gets a few minutes before it is judged: sockets
        // reconnect and caches warm, and the console errors of those minutes are not the release's.
        if (!force && bootedAt && now - bootedAt < settleMs) { out.push({ site, release, action: 'skipped', reason: 'the release is settling' }); continue; }
        const file = path.join(stateDir, `${site}.json`);
        let prev = null;
        try { prev = JSON.parse((await exec.readFile(file)) || 'null'); } catch { prev = null; }
        const fresh = prev && prev.release === release && now - Date.parse(prev.checkedAt) < DAY_MS;
        if (fresh && !force) { out.push({ site, release, action: 'skipped', ok: prev.ok, reason: 'this release was checked' }); continue; }
        let r = null;
        let reports = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (attempt === 2 && retryDelayMs > 0) await sleep(retryDelayMs);   // a transient blip gets a minute to pass
            r = await check(site, { args: ['--json'], asUser, home });
            try { reports = JSON.parse(r.stdout || 'null'); } catch { reports = null; }
            if (r.code === 0 || r.code >= 2 || !reports) break;   // a pass, or a run that broke: no second attempt
        }
        if (r.code >= 2 || !Array.isArray(reports)) { out.push({ site, release, action: 'error', reason: r.error || `the check did not run (exit ${r.code})` }); continue; }
        const failing = failingChecks(reports);
        const state = { site, origin, release, ok: r.code === 0, failing, ...(r.code === 0 ? {} : { details: failureDetails(reports) }), checkedAt: new Date(now).toISOString() };
        await exec.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
        out.push({ site, release, action: 'checked', ok: state.ok, failing });
    }
    try { await writeMetrics(exec, inv); } catch { /* metrics never fail a run */ }
    return { sites: out };
}

module.exports = { watch, failingChecks, failureDetails, writeMetrics, originOf, currentRelease, DAY_MS, SETTLE_MS };
