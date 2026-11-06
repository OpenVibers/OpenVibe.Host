'use strict';
/**
 * Protected-session probes: how many sessions a restart of this service would cut.
 *
 *   http-json-count  GET a loopback URL and count: `array` (dotted path) filtered by `where`
 *                    (key: value equality), or a numeric `field` (dotted path) plus every numeric
 *                    `addFields` entry that is present. An absent addField is zero (an older service
 *                    that does not report it yet); a null one is unknown (the service reports it but
 *                    cannot answer it); a present one that is not a number is unknown.
 *                    Live: /api/streams, streams where is_live. Events: /api/ready realtime_connections.
 *                    Media: /api/ready recordings_in_progress + chunked_recordings_in_progress +
 *                    recordings_untracked_in_progress + uploads_in_progress.
 *   postgresql-count a read-only SELECT against a database in the cluster, run as the postgres OS
 *                    user over peer auth (no secret is read, and a PostgreSQL service's database has
 *                    no file to open). OpenRestream: ingest sessions in flight.
 *   sum              the total of `probes` (each an http-json-count or postgresql-count): Tools' running
 *                    jobs in each satellite's jobs.db. Unknown when any part is.
 *
 * A probe that cannot answer while the service is running is UNKNOWN, never zero: "could not ask"
 * must not be read as "nobody is live". (Live's deploy.sh counted a failed curl as 0.)
 */
const systemd = require('./systemd');

function at(obj, dotted) {
    return String(dotted || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function running(exec, svc) {
    if (!svc.units.length) return false;
    for (const u of svc.units) {
        const st = await systemd.show(exec, u);
        if (['active', 'activating', 'reloading', 'deactivating'].includes(st.active)) return true;
    }
    return false;
}

/** -> { count: number|null, label, unknown?: reason, notRunning?: true } */
async function countProtected(exec, svc) {
    const p = svc.protected;
    if (!p) return { count: 0, label: 'protected sessions', none: true };
    const label = p.label || 'protected sessions';
    if (!(await running(exec, svc))) return { count: 0, label, notRunning: true };
    if (p.kind === 'sum') {
        let total = 0;
        for (const [i, part] of (p.probes || []).entries()) {
            const r = await countOne(exec, svc, part, label);
            if (r.count == null) return { count: null, label, unknown: `part ${i + 1}: ${r.unknown}` };
            total += r.count;
        }
        return { count: total, label };
    }
    return countOne(exec, svc, p, label);
}

async function countOne(exec, svc, p, label) {
    try {
        if (p.kind === 'http-json-count') {
            const r = await exec.http(p.url, { timeoutMs: 5000, headers: p.headers || {} });
            if (r.status < 200 || r.status >= 300) return { count: null, label, unknown: r.status ? `HTTP ${r.status}` : r.error || 'unreachable' };
            let body;
            try { body = JSON.parse(r.body); } catch { return { count: null, label, unknown: 'response is not JSON' }; }
            if (p.array) {
                const arr = at(body, p.array);
                if (!Array.isArray(arr)) return { count: null, label, unknown: `no array at "${p.array}"` };
                const where = p.where || {};
                // `true` matches any truthy value.
                const matches = (x) => Object.entries(where).every(([k, v]) => {
                    const actual = x == null ? undefined : x[k];
                    return v === true ? Boolean(actual) && actual !== '0' : actual === v;
                });
                return { count: arr.filter(matches).length, label };
            }
            const n = Number(at(body, p.field));
            if (!Number.isFinite(n)) return { count: null, label, unknown: `no number at "${p.field}"` };
            let total = n;
            for (const field of p.addFields || []) {
                const raw = at(body, field);
                // An older service omits the field: count what it does report, never fail the probe.
                if (raw === undefined) continue;
                // The service reports the field but cannot answer it (null): unknown, never zero.
                if (raw === null) return { count: null, label, unknown: `unknown at "${field}"` };
                const extra = Number(raw);
                if (!Number.isFinite(extra)) return { count: null, label, unknown: `no number at "${field}"` };
                total += extra;
            }
            return { count: total, label };
        }
        if (p.kind === 'postgresql-count') {
            // As the postgres OS user over peer auth: the service's own role needs a password, which
            // ovhost must never read.
            const rows = await exec.psql(p.database, p.sql);
            const first = rows && rows[0] ? Object.values(rows[0])[0] : undefined;
            const n = Number(first);
            if (!Number.isFinite(n)) return { count: null, label, unknown: 'query returned no number' };
            return { count: n, label };
        }
    } catch (err) {
        return { count: null, label, unknown: err.message };
    }
    return { count: null, label, unknown: `unknown probe kind ${p.kind}` };
}

module.exports = { countProtected, running, at };
