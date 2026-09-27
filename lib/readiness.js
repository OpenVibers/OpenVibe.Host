'use strict';
/**
 * Readiness: poll the service's loopback ready URL until it answers 2xx or the timeout passes.
 * A unit that systemd reports as `failed` ends the wait early — there is nothing left to wait for.
 *
 * Two stricter checks a service entry can ask for (ready.release, ready.allUnits):
 *   release   <ready origin>/release.json must name the release just deployed (a prefix of its sha):
 *             the process that answers is the new code, not a survivor (Tools: "gateway healthy with
 *             the new sha").
 *   allUnits  every unit must be active, not only the one behind the ready URL (Tools: eight units,
 *             one ready URL; a satellite crash-looping on a missing module reads "activating").
 */
const systemd = require('./systemd');

async function probe(exec, svc) {
    if (!svc.ready) return { ok: null, detail: 'no ready URL declared' };
    const t0 = exec.now();
    const r = await exec.http(svc.ready.url, { timeoutMs: 5000, headers: svc.ready.headers || {} });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, error: r.error, latencyMs: exec.now() - t0 };
}

/** Does <ready origin>/release.json name `sha`? -> { ok, release?, reason? } */
async function releaseMatches(exec, svc, sha) {
    let url;
    try { url = new URL('/release.json', svc.ready.url).href; } catch { return { ok: false, reason: 'no URL for /release.json' }; }
    const r = await exec.http(url, { timeoutMs: 5000, headers: svc.ready.headers || {} });
    if (r.status !== 200) return { ok: false, reason: `/release.json answered ${r.status || r.error || 'nothing'}` };
    let m;
    try { m = JSON.parse(r.body); } catch { return { ok: false, reason: '/release.json is not JSON' }; }
    const rel = String((m && m.release) || '').toLowerCase();
    if (/^[0-9a-f]{7,40}$/.test(rel) && String(sha).startsWith(rel)) return { ok: true, release: rel };
    return { ok: false, reason: `/release.json names ${rel || 'no release'}, not ${String(sha).slice(0, 12)}` };
}

async function waitReady(exec, svc, { timeoutSeconds, log = () => {}, expectSha = null, units = svc.units } = {}) {
    if (!svc.ready) return { ok: true, skipped: true, seconds: 0 };
    const limit = (timeoutSeconds || svc.ready.timeoutSeconds || 90) * 1000;
    const start = exec.now();
    let reason = 'never probed';
    while (exec.now() - start < limit) {
        const last = await probe(exec, svc);
        let states = null;
        if (last.ok) {
            reason = null;
            if (svc.ready.allUnits) {
                states = [];
                for (const u of units) states.push(await systemd.show(exec, u));
                const down = states.filter((st) => st.active !== 'active');
                if (down.length) reason = `not active: ${down.map((st) => `${st.unit} (${st.active})`).join(', ')}`;
            }
            if (!reason && svc.ready.release && expectSha) {
                const m = await releaseMatches(exec, svc, expectSha);
                if (!m.ok) reason = m.reason;
            }
            if (!reason) return { ok: true, seconds: Math.round((exec.now() - start) / 1000) };
        } else reason = last.status ? `HTTP ${last.status}` : last.error || 'unreachable';
        if (!states) {
            states = [];
            for (const u of units) states.push(await systemd.show(exec, u));
        }
        for (const st of states) {
            if (st.active === 'failed') {
                log(`${st.unit} is in state failed`);
                return { ok: false, reason: `${st.unit} failed`, seconds: Math.round((exec.now() - start) / 1000) };
            }
        }
        await exec.sleep(1000);
    }
    return { ok: false, reason, seconds: Math.round((exec.now() - start) / 1000) };
}

module.exports = { probe, waitReady, releaseMatches };
