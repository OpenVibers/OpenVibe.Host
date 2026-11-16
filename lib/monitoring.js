'use strict';

/**
 * A deployed service is scraped (2026-11-16). The scrape config is generated from the inventory
 * (scripts/prometheus-config.js), but only by hand: service-add lists it as a step to run, and it was missed twice
 * (10-15: fifteen services; 11-16: twenty-two, so openvibe.report/stats showed "Requests, 24 h —" for 25 sites).
 *
 *   ensureScraped(ctx, id) → { state, line? }   after a deploy: nothing to do when the service already has a job;
 *     otherwise, when its loopback metrics path answers 200, the config is regenerated from the inventory keeping the
 *     jobs scraped today and this one (a job whose target does not answer would page TargetDown), checked with
 *     promtool, installed (the old config kept as prometheus.yml.bak) and Prometheus reloaded. Anything wrong leaves the
 *     old config in place and says why. Never throws for a monitoring problem: the deploy stands either way.
 */
const { render } = require('../scripts/prometheus-config');

const PROM = '/etc/prometheus/prometheus.yml';
const jobsIn = (text) => new Set([...String(text || '').matchAll(/^ {2}- job_name: ([a-z0-9_-]+)\s*$/gm)].map((m) => m[1]));

/** The config with only the jobs `keep` says yes to (a job's block runs to the next job or top-level key). */
function keepJobs(text, keep) {
    const out = [];
    let drop = false;
    for (const line of String(text).split('\n')) {
        const m = /^ {2}- job_name: ([a-z0-9_-]+)\s*$/.exec(line);
        if (m) drop = !keep(m[1]);
        else if (/^\S/.test(line)) drop = false;
        if (!drop) out.push(line);
    }
    return out.join('\n');
}

// A service just restarted may not listen yet: no answer, or a 502/503 from a proxy in front, is asked again (a 404 is
// an answer: that service has no metrics). Six tries two seconds apart, at most about half a minute with the timeouts.
const STARTING = (probe) => !probe || !probe.status || probe.status === 502 || probe.status === 503;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureScraped(ctx, id, { promPath = PROM, renderImpl = render, tries = 6, waitMs = 2000, wait = pause } = {}) {
    const { exec, inv } = ctx;
    let current;
    try { current = await exec.readFile(promPath, { privileged: true }); } catch { return { state: 'no-prometheus' }; }
    const have = jobsIn(current);
    if (have.has(id)) return { state: 'scraped' };
    let raw;
    try { raw = JSON.parse(await exec.readFile(inv.file, { privileged: true })); } catch (e) { return { state: 'no-inventory', line: `monitoring: the inventory did not read (${e.message}); ${id} is not scraped` }; }
    const svc = raw.services && raw.services[id];
    if (!svc || svc.metrics === false || !Number.isInteger(svc.port)) return { state: 'nothing', line: `monitoring: ${id} has nothing to scrape` };
    const path = (svc.metrics && typeof svc.metrics === 'object' && svc.metrics.path) || '/metrics';
    let probe = null;
    for (let k = 0; k < tries; k++) {
        if (k) await wait(waitMs);
        probe = await exec.http(`http://127.0.0.1:${svc.port}${path}`, { timeoutMs: 4000 });
        if (!STARTING(probe)) break;
    }
    if (probe.status !== 200) return { state: 'no-metrics', line: `monitoring: ${id} is not scraped: its ${path} answers ${probe.status || probe.error || 'nothing'} (give it metrics, or "metrics": false in the inventory)` };
    const next = keepJobs(renderImpl(raw), (job) => have.has(job) || job === id);
    if (!jobsIn(next).has(id)) return { state: 'nothing', line: `monitoring: the inventory renders no job for ${id}` };
    const tmp = `${promPath}.next`;
    await exec.writeFile(tmp, next, { privileged: true, mode: 0o644 });
    const check = await exec.run('promtool', ['check', 'config', tmp], { privileged: true });
    if (check.code !== 0) {
        await exec.removeFile(tmp, { privileged: true }).catch(() => {});
        return { state: 'invalid', line: `monitoring: the regenerated config failed promtool (${String(check.stderr || check.stdout || '').trim().slice(0, 160)}); the old one stays` };
    }
    await exec.writeFile(`${promPath}.bak`, current, { privileged: true, mode: 0o644 });
    await exec.writeFile(promPath, next, { privileged: true, mode: 0o644 });
    await exec.removeFile(tmp, { privileged: true }).catch(() => {});
    const reload = await exec.run('systemctl', ['reload', 'prometheus'], { privileged: true });
    return { state: 'added', line: reload.code === 0 ? `monitoring: ${id} is now scraped (${path})` : `monitoring: ${id} added to the scrape config; reload Prometheus by hand (${String(reload.stderr || '').trim().slice(0, 80)})` };
}

module.exports = { ensureScraped, keepJobs, jobsIn };
