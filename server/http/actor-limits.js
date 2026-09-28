/**
 * Per-actor limits on the dashboard's and the API's writes (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * A signed-in person (req.viewer.kind === 'user') is counted by subject; a service token by its principal (a service
 * here manages its own projects, not other people's). Anonymous callers and reads are not counted: the per-address
 * limits in app.js stay. Every write takes HOST_LIMITS_MINUTE / HOST_LIMITS_HOUR (120 and 3000); deploy uploads
 * (stored and unpacked), domain verification (DNS lookups) and project creation have tighter numbers on top. Past a
 * limit: 429 problem+json `rate_limited` with Retry-After before the route runs, logged and counted in
 * host_rate_limited_total{limit,window}. Counters live in this process.
 */
'use strict';

const { createActorLimiter, createValkeyLimitStore } = require('openvibe-sdk/limits');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

/** [name, method regex, path regex (relative to the router), { minute, hour }]; the first match wins. */
const ROUTES = [
    ['host.deploy.upload', /^POST$/, /^\/sites\/[^/]+\/deploys\/?$/, { minute: 10, hour: 100 }],
    ['host.domain.verify', /^POST$/, /^\/domains\/[^/]+\/verify$/, { minute: 10, hour: 100 }],
    ['host.project.create', /^POST$/, /^\/projects\/?$/, { minute: 5, hour: 30 }],
];

function createHostActorLimits({ env = process.env, registry = null, now, valkey = null } = {}) {
    // HOST_ACTOR_LIMITS=off: a rollback lever (and what the Stage B suites use: they deploy dozens of times a minute).
    if (/^(off|0|false)$/i.test(String(env.HOST_ACTOR_LIMITS || ''))) return function noLimits(req, res, next) { next(); };
    const refused = registry && typeof registry.counter === 'function'
        ? registry.counter({ name: 'host_rate_limited_total', help: 'Writes refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const actor = (req) => {
        const v = req.viewer;
        if (!v) return null;
        if (v.kind === 'user' && v.subject) return `user:${v.subject}`;
        if (v.kind === 'service' && v.claims && v.claims.sub) return String(v.claims.sub);
        return null;
    };
    const limits = createActorLimiter({
        limits: { minute: num(env.HOST_LIMITS_MINUTE, 120), hour: num(env.HOST_LIMITS_HOUR, 3000) },
        actor,
        ...(now ? { now } : {}),
        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            console.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    const write = limits('host.write');
    const named = ROUTES.map(([name, method, pathRe, own]) => ({ method, pathRe, mw: limits(name, own) }));
    const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    return function hostActorLimits(req, res, next) {
        if (!WRITE.has(req.method)) return next();
        const own = named.find((r) => r.method.test(req.method) && r.pathRe.test(req.path));
        return write(req, res, (err) => (err ? next(err) : own ? own.mw(req, res, next) : next()));
    };
}

module.exports = { createHostActorLimits, ROUTES };
