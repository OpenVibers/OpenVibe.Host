'use strict';
/**
 * Readiness: poll the service's loopback ready URL until it answers 2xx or the timeout passes.
 * A unit that systemd reports as `failed` ends the wait early — there is nothing left to wait for.
 */
const systemd = require('./systemd');

async function probe(exec, svc) {
    if (!svc.ready) return { ok: null, detail: 'no ready URL declared' };
    const t0 = exec.now();
    const r = await exec.http(svc.ready.url, { timeoutMs: 5000, headers: svc.ready.headers || {} });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, error: r.error, latencyMs: exec.now() - t0 };
}

async function waitReady(exec, svc, { timeoutSeconds, log = () => {} } = {}) {
    if (!svc.ready) return { ok: true, skipped: true, seconds: 0 };
    const limit = (timeoutSeconds || svc.ready.timeoutSeconds || 90) * 1000;
    const start = exec.now();
    let last = null;
    while (exec.now() - start < limit) {
        last = await probe(exec, svc);
        if (last.ok) return { ok: true, seconds: Math.round((exec.now() - start) / 1000) };
        for (const u of svc.units) {
            const st = await systemd.show(exec, u);
            if (st.active === 'failed') {
                log(`${u} is in state failed`);
                return { ok: false, reason: `${u} failed`, seconds: Math.round((exec.now() - start) / 1000) };
            }
        }
        await exec.sleep(1000);
    }
    return { ok: false, reason: last ? (last.status ? `HTTP ${last.status}` : last.error || 'unreachable') : 'never probed', seconds: Math.round((exec.now() - start) / 1000) };
}

module.exports = { probe, waitReady };
