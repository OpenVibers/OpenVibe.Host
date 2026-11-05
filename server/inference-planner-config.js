'use strict';
/**
 * The `host.inference_planner` namespace (D11 owner settings): the staff planner's switch, its demand source and
 * the monthly budget it may recommend within. The env variables stay the pins (`x-env`): while one is set it wins,
 * is read-only in the summary and a write answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by host.config.manage (Network's service token
 * only). actor is the owner Network names in X-OV-Subject. budget_nano_usd is x-danger (a recommendation above it
 * needs the owner's budget), so changing it needs X-OV-Fresh: 1. Every activation writes one audit line with the
 * actor and the keys, never a value.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const shared = require('openvibe-shared/config');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const { http, ids } = contracts;

const SERVICE = 'host';
const NAMESPACE = 'host.inference_planner';
const CAPABILITY = 'host.config.manage';
const AUDIENCE = 'openvibe.host';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Inference placement planner',
    description: 'The staff-only forecast and break-even page and JSON API. The planner recommends; it never starts, stops or rents a GPU.',
    type: 'object',
    additionalProperties: false,
    required: ['enabled', 'budget_nano_usd', 'source'],
    properties: {
        enabled: {
            type: 'boolean', title: 'Planner page and API', 'x-group': 'Inference planner', 'x-env': 'HOST_INFERENCE_PLANNER',
            description: 'Serve /catalog/inference and /api/v1/catalog/inference-planner to staff. Off adds no route.',
        },
        budget_nano_usd: {
            type: ['integer', 'null'], minimum: 0, title: 'Monthly budget', 'x-group': 'Inference planner',
            'x-env': 'HOST_INFERENCE_BUDGET_NANO_USD', 'x-unit': 'nano_usd', 'x-danger': true,
            description: 'Integer nano-USD a month. A recommendation at the forecast or the high band above it is marked "needs the owner\'s budget"; null means unset (0, nothing pre-approved).',
        },
        source: {
            type: 'string', enum: ['json', 'ai'], title: 'Demand source', 'x-group': 'Inference planner', 'x-env': 'HOST_INFERENCE_PLANNER_SOURCE',
            description: 'json reads the configured planning document; ai reads OpenVibe.AI\'s aggregate usage series and falls back only to a configured JSON input.',
        },
    },
};
const DEFAULTS = Object.freeze({ enabled: false, budget_nano_usd: null, source: 'json' });

function bearer(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function capabilityGuard({ config, log }) {
    return async function guard(req, res, next) {
        try {
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a Network service token is required', ctx: req.ov });
            const r = await verifyServiceToken(token, {
                jwks: `${config.networkInternalUrl || config.networkUrl}/api/.well-known/jwks`,
                issuer: config.networkUrl, audience: AUDIENCE, contracts, log,
            });
            if (!r.ok) return http.sendProblem(res, r.code === 'token.unavailable' ? 503 : 401, r.code || 'token.invalid', { detail: r.reason || 'the token does not verify', ctx: req.ov });
            const sub = String((r.claims && r.claims.sub) || '');
            if (!sub.startsWith('svc:')) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Host configuration`, ctx: req.ov });
            const decision = contracts.capabilities.check(r.claims, CAPABILITY);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = r.claims;
            return next();
        } catch (err) {
            log.error(`[config] host.inference_planner guard failed: ${(err && err.message) || err}`);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'the configuration request failed', ctx: req.ov });
        }
    };
}

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

const requireFresh = (req) => String((req.headers && req.headers['x-ov-fresh']) || '') === '1';

async function create({ db, config, env = process.env, log = console, onActivate = null }) {
    // The shared store's boolean pin reads true/1; Host's env has always said "on". Normalise the pin value, not the
    // name: the summary still reports HOST_INFERENCE_PLANNER.
    const storeEnv = { ...env };
    if (/^(on|yes|true|1)$/i.test(String(storeEnv.HOST_INFERENCE_PLANNER || ''))) storeEnv.HOST_INFERENCE_PLANNER = '1';
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env: storeEnv, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${keys.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ config, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) { app.use('/internal/config', express.json({ limit: '128kb' })); router.mount(app); },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };
