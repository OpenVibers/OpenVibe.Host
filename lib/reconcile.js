'use strict';
/**
 * `ovhost reconcile` — the deploy controller, phase 1 (roadmap WS-X11, D72): main at its last green CI commit
 * is the desired state; this makes each `auto` service run it, without a person.
 *
 * For every service whose inventory entry says `"deploy": { "policy": "auto" }`:
 *   1. plan with a fetch (lib/release-ops plan): what main has that the host does not;
 *   2. up to date → nothing; only documentation and tests changed → nothing (the change rides the next deploy);
 *   3. CI: every check run on that exact commit completed and passed (GitHub API; a commit with no check runs,
 *      or one still running, waits for the next pass — never deployed on hope);
 *   4. deploy it (the same lib.deploy as `ovhost deploy --wait-idle`: freezes, protected sessions, readiness and
 *      automatic rollback all apply), then announce the release.
 * `gated` and `manual` services are reported, never deployed here. One service at a time, in inventory order.
 * The outcome of every pass goes to <stateDir>/reconcile.json and the node-exporter textfile collector
 * (openvibe_reconcile_*), which the OpenVibeReconcileFailed alert reads.
 */
const path = require('path');
const { git } = require('./git');

// Files that document or test a service and are not part of what it runs (the roadmap baseline's rule).
const DOCS_OR_TESTS = /^(README\.md|STATUS\.json|CHANGELOG\.md|SECURITY\.md|docs\/.*\.md|tests?\/|\.github\/)|\.test\.[cm]?[jt]s$/;
const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';

/** owner/repo from a GitHub remote URL (https or ssh), or null. */
function githubSlug(url) {
    const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
    return m ? `${m[1]}/${m[2]}` : null;
}

/** The CI verdict for one commit: 'green' | 'pending' | 'red' | 'none' | 'unknown'. */
async function ciStatus(exec, slug, sha, { token = null } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'openvibe-host-reconcile', 'x-github-api-version': '2022-11-28' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await exec.request(`https://api.github.com/repos/${slug}/commits/${sha}/check-runs?per_page=100`, { method: 'GET', headers, timeoutMs: 15000 });
    if (r.status !== 200) return { verdict: 'unknown', detail: `GitHub answered ${r.status || r.error}` };
    let body;
    try { body = JSON.parse(r.body); } catch { return { verdict: 'unknown', detail: 'unreadable GitHub answer' }; }
    const runs = body.check_runs || [];
    if (!runs.length) return { verdict: 'none', detail: 'no check runs on this commit' };
    if (runs.some((c) => c.status !== 'completed')) return { verdict: 'pending', detail: `${runs.filter((c) => c.status !== 'completed').length} check(s) still running` };
    const bad = runs.filter((c) => !['success', 'skipped', 'neutral'].includes(c.conclusion));
    if (bad.length) return { verdict: 'red', detail: bad.map((c) => `${c.name}: ${c.conclusion}`).join(', ').slice(0, 300) };
    return { verdict: 'green', detail: `${runs.length} check(s) passed` };
}

/**
 * One pass. ctx is the ovhost context ({ exec, inv, log, … }); lib is lib/index.js (plan, deploy, announce).
 * opts: { only: [ids], dryRun, token, stateDir, textfileDir, env }
 * → { at, services: [{ id, policy, action, from, to, detail, result? }] }
 */
async function reconcile(ctx, lib, { only = null, dryRun = false, token = null, stateDir = '/var/lib/openvibe-host', textfileDir = TEXTFILE_DIR, env = process.env } = {}) {
    const { exec, inv } = ctx;
    const log = ctx.log || (() => {});
    const pass = { at: new Date(exec.now()).toISOString(), dryRun, services: [] };
    for (const [id, svc] of Object.entries(inv.services)) {
        if (only && !only.includes(id)) continue;
        const policy = (svc.deploy && svc.deploy.policy) || 'manual';
        const entry = { id, policy };
        pass.services.push(entry);
        if (!svc.managed || !svc.repo) { entry.action = 'skip'; entry.detail = 'not managed by ovhost'; continue; }
        let p;
        try { p = await lib.plan(ctx, id, { fetch: true }); } catch (err) { entry.action = 'error'; entry.detail = `plan failed: ${err.message}`; continue; }
        Object.assign(entry, { from: p.from, to: p.to });
        if (p.upToDate) { entry.action = 'current'; continue; }
        const runtime = (p.changed || []).filter((f) => !DOCS_OR_TESTS.test(f));
        if (!runtime.length) { entry.action = 'docs-only'; entry.detail = `${(p.changed || []).length} file(s), documentation and tests only`; continue; }
        if (policy !== 'auto') { entry.action = 'waiting'; entry.detail = `policy ${policy}: ${runtime.length} runtime file(s) wait for a person`; continue; }
        const slug = githubSlug(await git(exec, svc).remoteUrl().catch(() => ''));
        if (!slug) { entry.action = 'error'; entry.detail = 'the remote is not a GitHub repository: no CI to read'; continue; }
        const ci = await ciStatus(exec, slug, p.to, { token });
        entry.ci = ci.verdict;
        if (ci.verdict !== 'green') { entry.action = ci.verdict === 'red' ? 'blocked' : 'waiting'; entry.detail = `CI ${ci.verdict}: ${ci.detail}`; continue; }
        if (dryRun) { entry.action = 'would-deploy'; entry.detail = `${runtime.length} runtime file(s), CI green`; continue; }
        log(`[reconcile] ${id}: deploying ${p.from.slice(0, 12)} → ${p.to.slice(0, 12)} (${runtime.length} runtime file(s), CI green)`);
        let r;
        try { r = await lib.deploy(ctx, id, { waitIdle: true }); } catch (err) { entry.action = 'error'; entry.detail = `deploy threw: ${err.message}`; continue; }
        entry.action = 'deployed';
        entry.result = r.record && r.record.result;
        entry.exitCode = r.exitCode;
        if (r.exitCode !== 0) { entry.action = 'failed'; entry.detail = `deploy exit ${r.exitCode} (${entry.result})`; continue; }
        if (['deployed'].includes(entry.result) && lib.announce) {
            try { const a = await lib.announce(ctx, id, { head: r.record.to, env }); entry.announced = !!(a && a.published); } catch { entry.announced = false; }
        }
    }
    if (!dryRun) await record(exec, pass, { stateDir, textfileDir, log });
    return pass;
}

async function record(exec, pass, { stateDir, textfileDir, log }) {
    const count = (a) => pass.services.filter((s) => s.action === a).length;
    const lines = [
        '# HELP openvibe_reconcile_last_run_timestamp_seconds When ovhost reconcile last ran.',
        '# TYPE openvibe_reconcile_last_run_timestamp_seconds gauge',
        `openvibe_reconcile_last_run_timestamp_seconds ${Math.floor(Date.parse(pass.at) / 1000)}`,
        '# HELP openvibe_reconcile_services Services by the last pass\'s action.',
        '# TYPE openvibe_reconcile_services gauge',
        ...['current', 'docs-only', 'waiting', 'blocked', 'deployed', 'failed', 'error', 'skip'].map((a) => `openvibe_reconcile_services{action="${a}"} ${count(a)}`),
        '# HELP openvibe_reconcile_failed_total_last Deploys the last pass started that failed or rolled back.',
        '# TYPE openvibe_reconcile_failed_total_last gauge',
        `openvibe_reconcile_failed_total_last ${count('failed') + count('error')}`,
    ];
    try {
        await exec.writeFile(path.join(textfileDir, 'openvibe_reconcile.prom'), `${lines.join('\n')}\n`, { mode: 0o644 });
        await exec.writeFile(path.join(stateDir, 'reconcile.json'), `${JSON.stringify(pass, null, 1)}\n`, { mode: 0o644 });
    } catch (err) { log(`[reconcile] could not record the pass: ${err.message}`); }
}

module.exports = { reconcile, ciStatus, githubSlug, DOCS_OR_TESTS };
