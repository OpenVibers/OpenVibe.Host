'use strict';
/**
 * `ovhost browser-watch` (roadmap WS-H task 11, "release UX check"): each watched site is checked in a real
 * browser (scripts/browser-check.js through lib/browser-check-hook.js) after every release, and once a day
 * without one, and a failure pages the operator (OpenVibeBrowserCheckFailed → ovhost alerts relay → Network).
 *
 *   ovhost browser-watch [--sites live,network] [--force]      (openvibe-browsercheck.timer: every 5 minutes)
 *
 * Per site: GET <origin>/release.json. A release not checked yet, or a last check older than 24 hours, runs the
 * check as the unprivileged `ovcheck` account (Chrome never runs as root). A failing check runs once more before
 * it counts (a single network blip is not a regression). The outcome is kept in
 * <stateDir>/browser-watch/<site>.json, and every site's latest outcome is written to the textfile collector
 * (openvibe_browsercheck.prom):
 *
 *   openvibe_browser_check_ok{service,release}                  1 passed, 0 failed
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

async function currentRelease(exec, origin) {
    const r = await exec.request(`${origin}/release.json`, { timeoutMs: 8000 });
    if (r.status !== 200) return null;
    try {
        const m = JSON.parse(r.body);
        const rel = String(m.release || m.commit || '').slice(0, 12);
        return RELEASE_RE.test(rel) ? rel : null;
    } catch { return null; }
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
        '# HELP openvibe_browser_check_ok 1 when the last browser check of the site passed (label: the release it checked).',
        '# TYPE openvibe_browser_check_ok gauge',
        ...rows.map((s) => `openvibe_browser_check_ok{service="${esc(s.site)}",release="${esc(s.release || 'unknown')}"} ${s.ok ? 1 : 0}`),
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
async function watch(ctx, { sites = ['live'], force = false, asUser = 'ovcheck', home = '/var/lib/ovcheck', now = Date.now(), check = runBrowserCheck, contracts = null } = {}) {
    const { exec, inv } = ctx;
    const stateDir = path.join(inv.stateDir, 'browser-watch');
    await exec.mkdir(stateDir, { mode: 0o750 });
    const out = [];
    for (const site of sites) {
        if (!SITE_RE.test(site)) { out.push({ site, action: 'error', reason: 'not a service id' }); continue; }
        const origin = originOf(inv, site, contracts);
        if (!origin) { out.push({ site, action: 'error', reason: 'no origin (inventory origin or manifest publicOrigin)' }); continue; }
        const release = await currentRelease(exec, origin);
        const file = path.join(stateDir, `${site}.json`);
        let prev = null;
        try { prev = JSON.parse((await exec.readFile(file)) || 'null'); } catch { prev = null; }
        const fresh = prev && prev.release === release && now - Date.parse(prev.checkedAt) < DAY_MS;
        if (fresh && !force) { out.push({ site, release, action: 'skipped', ok: prev.ok, reason: 'this release was checked' }); continue; }
        let r = null;
        let reports = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            r = await check(site, { args: ['--json'], asUser, home });
            try { reports = JSON.parse(r.stdout || 'null'); } catch { reports = null; }
            if (r.code === 0 || r.code >= 2 || !reports) break;   // a pass, or a run that broke: no second attempt
        }
        if (r.code >= 2 || !Array.isArray(reports)) { out.push({ site, release, action: 'error', reason: r.error || `the check did not run (exit ${r.code})` }); continue; }
        const failing = failingChecks(reports);
        const state = { site, origin, release, ok: r.code === 0, failing, checkedAt: new Date(now).toISOString() };
        await exec.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
        out.push({ site, release, action: 'checked', ok: state.ok, failing });
    }
    try { await writeMetrics(exec, inv); } catch { /* metrics never fail a run */ }
    return { sites: out };
}

module.exports = { watch, failingChecks, writeMetrics, originOf, currentRelease, DAY_MS };
