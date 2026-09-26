'use strict';
/**
 * Lifecycle declarations (roadmap WS-P task 1): how a service starts, stops, recovers and is rolled
 * back, as its manifest's `lifecycle` block says (openvibe-contracts ≥ 0.55.0,
 * registry.service-manifest@1). `ovhost validate` checks the declaration against the host.
 *
 *   resolve()        where the block comes from: the inventory entry's own `lifecycle` (the host's
 *                    word wins), else `--manifest <file>`, else the service manifest in the installed
 *                    openvibe-contracts (the inventory's `manifest` id)
 *   check()          every required field, named: `lifecycle.shutdown.deadlineSeconds is missing`
 *   parseSeconds()   a systemd time span ("1min 30s", "15", "30min", "infinity") in seconds
 *   satisfies()      "^x.y.z" / ">=x.y.z <a.b.c" / "x.y.z", the range forms the manifests use
 *
 * A part that does not apply is { none: "<why>" }. A service with units runs processes, so its
 * liveness and shutdown can never be none.
 */
const fs = require('fs');
const path = require('path');

const PARTS = ['liveness', 'shutdown', 'startupRecovery', 'rollback', 'contracts', 'leases'];
const RECOVERY_KINDS = ['outbox', 'jobs', 'sessions', 'consumer', 'schedule', 'state'];
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'];
// systemctl show prints KillSignal= as a number.
const SIGNAL_NUMBERS = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL', 10: 'SIGUSR1', 12: 'SIGUSR2', 15: 'SIGTERM' };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNone = (v) => isObj(v) && Object.keys(v).length === 1 && typeof v.none === 'string';
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * -> { lifecycle, source } — lifecycle is null when nothing declares one. `contracts` is injectable
 * for tests; by default the installed openvibe-contracts package.
 */
function resolve(svc, { manifestFile = null, contracts = null } = {}) {
    if (svc.lifecycle) return { lifecycle: svc.lifecycle, source: `the inventory (services.${svc.id}.lifecycle)` };
    if (manifestFile) {
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (err) { return { lifecycle: null, source: `${manifestFile} (unreadable: ${err.message})` }; }
        return { lifecycle: manifest.lifecycle || null, source: `manifest file ${path.basename(manifestFile)}` };
    }
    let lib = contracts;
    let version = lib && lib.version ? lib.version : '?';
    if (!lib) {
        try {
            lib = require('openvibe-contracts');
            version = require('openvibe-contracts/package.json').version;
        } catch (err) { return { lifecycle: null, source: `openvibe-contracts (not installed: ${err.message})` }; }
    }
    const manifest = lib.services && lib.services.get(svc.manifest);
    if (!manifest) return { lifecycle: null, source: `openvibe-contracts v${version} (no "${svc.manifest}" manifest)` };
    return { lifecycle: manifest.lifecycle || null, source: `the "${svc.manifest}" manifest in openvibe-contracts v${version}` };
}

/**
 * Every missing or malformed field -> [{ field, problem }]. `runs`: the service has units, so
 * liveness and shutdown must be real.
 */
function check(lc, { runs = false } = {}) {
    const out = [];
    const miss = (field, problem = 'is missing') => out.push({ field: `lifecycle.${field}`, problem });
    if (!isObj(lc)) { out.push({ field: 'lifecycle', problem: 'is missing' }); return out; }
    for (const part of PARTS) {
        const v = lc[part];
        if (v == null) { miss(part); continue; }
        if (!isObj(v)) { miss(part, 'must be an object'); continue; }
        if ('none' in v) {
            if (!isNone(v) || !text(v.none)) miss(`${part}.none`, 'must be the only key, with a reason');
            else if (runs && (part === 'liveness' || part === 'shutdown')) miss(part, `is none ("${v.none}"), but the service runs units`);
            continue;
        }
        if (part === 'liveness') {
            if (!text(v.endpoint)) miss('liveness.endpoint');
            else if (!v.endpoint.startsWith('/')) miss('liveness.endpoint', 'must be a path');
            if (!text(v.means)) miss('liveness.means');
        } else if (part === 'shutdown') {
            if (v.signal == null) miss('shutdown.signal');
            else if (!STOP_SIGNALS.includes(v.signal)) miss('shutdown.signal', `must be one of ${STOP_SIGNALS.join(', ')}`);
            if (v.deadlineSeconds == null) miss('shutdown.deadlineSeconds');
            else if (!(typeof v.deadlineSeconds === 'number' && v.deadlineSeconds >= 0)) miss('shutdown.deadlineSeconds', 'must be a number of seconds ≥ 0');
            if (!Array.isArray(v.drains) || !v.drains.length) miss('shutdown.drains', v.drains == null ? 'is missing' : 'must list what it drains');
            if (v.workers != null) {
                if (!isObj(v.workers)) miss('shutdown.workers', 'must be an object');
                else {
                    if (!(typeof v.workers.deadlineSeconds === 'number' && v.workers.deadlineSeconds >= 0)) miss('shutdown.workers.deadlineSeconds', v.workers.deadlineSeconds == null ? 'is missing' : 'must be a number of seconds ≥ 0');
                    if (!Array.isArray(v.workers.drains) || !v.workers.drains.length) miss('shutdown.workers.drains');
                }
            }
        } else if (part === 'startupRecovery') {
            if (!Array.isArray(v.resumes) || !v.resumes.length) miss('startupRecovery.resumes');
            else v.resumes.forEach((r, i) => {
                if (!isObj(r) || !RECOVERY_KINDS.includes(r.kind)) miss(`startupRecovery.resumes[${i}].kind`, `must be one of ${RECOVERY_KINDS.join(', ')}`);
                if (!isObj(r) || !text(r.what)) miss(`startupRecovery.resumes[${i}].what`);
            });
        } else if (part === 'rollback') {
            if (!Array.isArray(v.conditions) || !v.conditions.length) miss('rollback.conditions');
            if (!text(v.window)) miss('rollback.window');
            if (v.blockers == null) miss('rollback.blockers');
            else if (!(isNone(v.blockers) || (Array.isArray(v.blockers) && v.blockers.length && v.blockers.every(text)))) miss('rollback.blockers', 'must list blockers or be { none: reason }');
        } else if (part === 'contracts') {
            if (!text(v.range)) miss('contracts.range');
            else if (!parseRange(v.range)) miss('contracts.range', `"${v.range}" is not a version range`);
        } else if (part === 'leases') {
            if (!Array.isArray(v.claims) || !v.claims.length) miss('leases.claims');
            else v.claims.forEach((c, i) => {
                for (const k of ['what', 'holder', 'expires', 'fencing']) if (!isObj(c) || !text(c[k])) miss(`leases.claims[${i}].${k}`);
            });
        }
    }
    return out;
}

const SPAN_UNITS = {
    us: 1e-6, usec: 1e-6, ms: 1e-3, msec: 1e-3,
    s: 1, sec: 1, second: 1, seconds: 1,
    m: 60, min: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
};

/** A systemd time span -> seconds (Infinity for "infinity"), or null when it is not one. */
function parseSeconds(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (s === 'infinity') return Infinity;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    let total = 0;
    let rest = s;
    const re = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)/;
    while (rest.trim()) {
        const m = re.exec(rest);
        if (!m || !(m[2] in SPAN_UNITS)) return null;
        total += Number(m[1]) * SPAN_UNITS[m[2]];
        rest = rest.slice(m[0].length);
    }
    return Math.round(total * 1e6) / 1e6;
}

/** `TimeoutStopSec=` in a unit file's text (the last one wins, like systemd), or null. */
function unitFileTimeout(text) {
    let found = null;
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*TimeoutStopSec\s*=\s*(.*?)\s*$/.exec(line);
        if (m) found = m[1];
    }
    return found == null ? null : parseSeconds(found);
}

function signalName(value) {
    if (value == null || value === '') return null;
    if (/^\d+$/.test(String(value))) return SIGNAL_NUMBERS[Number(value)] || `signal ${value}`;
    const s = String(value).toUpperCase();
    return s.startsWith('SIG') ? s : `SIG${s}`;
}

function cmp(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** -> [{ op, v }] per alternative, or null. */
function parseRange(range) {
    const alts = String(range).split('||').map((alt) => alt.trim().split(/\s+/).map((part) => {
        const m = /^(\^|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
        return m ? { op: m[1] || '=', v: VERSION_RE.exec(m[2]).slice(1).map(Number) } : null;
    }));
    return alts.every((a) => a.every(Boolean)) ? alts : null;
}

function satisfies(version, range) {
    const m = VERSION_RE.exec(String(version || '').replace(/^v/, ''));
    const alts = parseRange(range);
    if (!m || !alts) return false;
    const v = m.slice(1).map(Number);
    return alts.some((parts) => parts.every(({ op, v: w }) => {
        const c = cmp(v, w);
        if (op === '^') return c >= 0 && (w[0] > 0 ? v[0] === w[0] : w[1] > 0 ? v[0] === 0 && v[1] === w[1] : cmp(v, w) === 0);
        if (op === '>=') return c >= 0;
        if (op === '>') return c > 0;
        if (op === '<=') return c <= 0;
        if (op === '<') return c < 0;
        return c === 0;
    }));
}

module.exports = { PARTS, RECOVERY_KINDS, resolve, check, parseSeconds, unitFileTimeout, signalName, satisfies, isNone };
