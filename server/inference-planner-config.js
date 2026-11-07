'use strict';
/**
 * The `host.inference_planner` namespace (D11 owner settings): the staff planner's switch, its demand source and
 * the monthly budget it may recommend within. The env variables stay the pins (`x-env`): while one is set it wins,
 * is read-only in the summary and a write answers 409 config.pinned_in_env.
 *
 * The same admin routes also serve the stores passed as `also` (host.data_sources, server/data-sources-config.js),
 * and POST /internal/config/:namespace/test/:key, the Setup tab's Test button, answers for the keys a `test` hook
 * knows (the owner-setup design of 2026-11-07); it is mounted before the config routes.
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
    description: 'A staff-only page that forecasts AI demand and says whether renting GPUs, buying them or staying on providers is cheaper. It only recommends; it never starts, stops or rents a GPU. Change it to switch the page on or to give it a budget.',
    type: 'object',
    additionalProperties: false,
    required: ['enabled', 'budget_nano_usd', 'source'],
    properties: {
        enabled: {
            type: 'boolean', title: 'Show the planner page', 'x-group': 'Inference planner', 'x-env': 'HOST_INFERENCE_PLANNER',
            description: 'When on, staff can open /catalog/inference and its JSON API. Off (the default) adds neither route, so the page answers Not found.',
        },
        budget_nano_usd: {
            type: ['integer', 'null'], minimum: 0, title: 'Monthly budget the planner may recommend within', 'x-group': 'Inference planner',
            'x-env': 'HOST_INFERENCE_BUDGET_NANO_USD', 'x-unit': 'nano_usd', 'x-danger': true, 'x-example': 200000000000,
            description: 'The most a month the planner may recommend spending, in billionths of a dollar (200000000000 is $200). A plan above it is marked "needs the owner\'s budget". Empty (the default) approves nothing in advance.',
        },
        source: {
            type: 'string', enum: ['json', 'ai'], title: 'Where the demand forecast comes from', 'x-group': 'Inference planner', 'x-env': 'HOST_INFERENCE_PLANNER_SOURCE',
            description: 'What the planner forecasts from. The planning document (the default) is a file staff write; AI\'s usage reads what OpenVibe.AI really served and falls back to the document only when one is set.',
            'x-enum-labels': {
                json: { label: 'The planning document', description: 'A JSON file staff write with the expected demand; nothing is measured.' },
                ai: { label: 'AI\'s real usage', description: 'OpenVibe.AI\'s served requests per model, totalled; the document is used only when AI cannot be read.' },
            },
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

async function create({ db, config, env = process.env, log = console, onActivate = null, also = [], test = null }) {
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
    const guard = capabilityGuard({ config, log });
    const router = shared.adminRoutes([store, ...also], {
        basePath: '/internal/config', requireAdmin: guard, actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) {
            app.use('/internal/config', express.json({ limit: '128kb' }));
            if (test) app.post('/internal/config/:namespace/test/:key', guard, testRoute({ test, log }));
            router.mount(app);
        },
    };
}

/** One line, at most 200 characters, with the secret replaced. */
function oneLine(text, secret) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (typeof secret === 'string' && secret.length >= 4) {
        s = s.split(secret).join('[hidden]');
        if (secret.length >= 12) s = s.split(secret.slice(0, 12)).join('[hidden]');
    }
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * The Setup tab's Test button: test(namespace, key) answers { value, source, env, run(value) } or null (no test).
 * 200 { ok, message, state, source, namespace, key, tested_at } (openvibe-shared 4.125.0's { ok, message } with more
 * beside it), 409 config.not_set when neither the panel nor the settings file has a value. Never the value itself.
 */
function testRoute({ test, log }) {
    return async function configTest(req, res) {
        const namespace = String(req.params.namespace || '');
        const key = String(req.params.key || '');
        let found = null;
        try { found = await test(namespace, key); } catch { found = null; }
        if (!found) return http.sendProblem(res, 404, 'config.test_not_found', { detail: `${namespace} has no test for ${key}`, ctx: req.ov });
        if (!found.value) return http.sendProblem(res, 409, 'config.not_set', { detail: `${key} is not set, so there is nothing to test`, ctx: req.ov });
        let out;
        try { out = await found.run(found.value); } catch (err) { out = { ok: false, message: `The test could not run: ${(err && err.message) || 'unknown error'}` }; }
        const ok = Boolean(out && out.ok);
        const from = found.source === 'env' && found.env ? ` (the value from the server's settings file, ${found.env})` : '';
        const message = oneLine(`${(out && out.message) || (ok ? 'It works.' : 'It did not work.')}${from}`, found.value);
        (log.info || log.log).call(log, `[config] test ${namespace} ${key}: ${ok ? 'connected' : 'not working'}`);
        return res.json({ ok, message, state: ok ? 'connected' : 'not_working', source: found.source || null, namespace, key, tested_at: new Date().toISOString() });
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY, oneLine };
