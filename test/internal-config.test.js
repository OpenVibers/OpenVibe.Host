'use strict';
/**
 * D11 owner settings: the host.inference_planner namespace and /internal/config.
 * Env pins win; host.config.manage is required; an owner change applies live; budget_nano_usd is x-danger and
 * needs X-OV-Fresh; no KEK still works; a secret-class value never leaves a summary, snapshot or history.
 */
const assert = require('assert');
const { boot, check, done, DASHBOARD } = require('./helpers/boot');

const CAP = ['host.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'sk_host_d11_toppsecret_123456';

(async () => {
    const t = await boot({ env: { HOST_INFERENCE_PLANNER: 'on', HOST_INFERENCE_BUDGET_NANO_USD: '0' } });
    const admin = () => t.network.serviceToken('network', CAP);
    try {
        await check('the summary: schema, x-danger/x-unit, the env pins, sealed:false without a KEK', async () => {
            const r = await t.api('GET', '/internal/config/host.inference_planner', { as: admin() });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().namespace, 'host.inference_planner');
            assert.strictEqual(r.json().sealed, false);
            assert.strictEqual(r.json().values.enabled, true);
            assert.deepStrictEqual(r.json().pins.enabled, { env: 'HOST_INFERENCE_PLANNER', pinned: true });
            assert.strictEqual(r.json().schema.properties.budget_nano_usd['x-danger'], true);
            assert.strictEqual(r.json().schema.properties.budget_nano_usd['x-unit'], 'nano_usd');
            assert.strictEqual(r.json().schema.properties.source.enum.join(','), 'json,ai');
        });

        await check('a service token without host.config.manage is refused', async () => {
            const token = t.network.serviceToken('other', ['host.catalog.read']);
            const r = await t.api('GET', '/internal/config/host.inference_planner', { as: token });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().code, 'capability.denied');
        });

        await check('an env-pinned key is read-only', async () => {
            const r = await t.api('POST', '/internal/config/host.inference_planner', {
                as: admin(), headers: { 'x-ov-subject': OWNER }, json: { values: { enabled: false }, reason: 'off' },
            });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.json().code, 'config.pinned_in_env');
        });
    } finally { await t.close(); }

    const live = await boot({ env: { HOST_INFERENCE_PLANNER_INPUT: require('path').join(__dirname, '..', 'workers', 'llm-inference', 'examples', 'inference-planner.example.json') } });
    const liveAdmin = () => live.network.serviceToken('network', [...CAP, 'host.catalog.manage']);
    const staff = live.user('planner-owner', { role: 'admin' });
    try {
        await check('a danger key without X-OV-Fresh is refused, with it applies live', async () => {
            const stale = await live.api('POST', '/internal/config/host.inference_planner', {
                as: liveAdmin(), headers: { 'x-ov-subject': OWNER }, json: { values: { budget_nano_usd: 500 } , reason: 'raise it' },
            });
            assert.strictEqual(stale.status, 403, stale.text.slice(0, 300));
            assert.strictEqual(stale.json().code, 'config.fresh_required');
            const fresh = await live.api('POST', '/internal/config/host.inference_planner', {
                as: liveAdmin(), headers: { 'x-ov-subject': OWNER, 'x-ov-fresh': '1' }, json: { values: { budget_nano_usd: 500, enabled: true, source: 'json' }, reason: 'owner raised the budget' },
            });
            assert.strictEqual(fresh.status, 200, fresh.text.slice(0, 300));
            assert.strictEqual(fresh.json().revision, 2);
            assert.strictEqual(live.config.inferencePlanner.enabled, true);
            assert.strictEqual(live.config.inferencePlanner.budgetNanoUsdRaw, '500');
            const page = await live.api('GET', '/api/v1/catalog/inference-planner', { as: live.network.userToken(staff) });
            assert.strictEqual(page.status, 200, page.text.slice(0, 300));
        });

        await check('with a KEK the store is sealed and boot reseals', async () => {
            const sealed = await boot({ env: { OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
            try {
                const token = sealed.network.serviceToken('network', CAP);
                const r = await sealed.api('GET', '/internal/config/host.inference_planner', { as: token });
                assert.strictEqual(r.status, 200, r.text.slice(0, 300));
                assert.strictEqual(r.json().sealed, true);
                assert.strictEqual(r.json().kek, 'k1');
            } finally { await sealed.close(); }
        });

        await check('a secret is write-only and never appears in a summary, snapshot or history', async () => {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: live.ctx.store.db, service: 'host', namespace: 'host.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret',
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        });
    } finally { await live.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
