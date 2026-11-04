'use strict';
/**
 * The inference planner's staff surface: with HOST_INFERENCE_PLANNER off there is no page and no
 * endpoint; on, only staff see them, the page has no form or button, and the JSON says the planner
 * has no action. The planning JSON is a temp file; no provider, GPU or process is touched.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-inference-planner-'));
const fixturePath = path.join(tmp, 'plan.json');

const start = Date.parse('2026-10-05T00:00:00Z');
const series = Array.from({ length: 28 }, (_, i) => {
    const dow = i % 7; // 0 Monday ... 5 Saturday, 6 Sunday
    return {
        date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
        requests: dow === 5 ? 40 : dow === 6 ? 20 : 100,
    };
});
fs.writeFileSync(fixturePath, JSON.stringify({
    note: 'test fixture, not a quote',
    forecast: { horizon_days: 30, window_days: 28, series },
    request: { input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100 },
    models: [{
        id: 'qwen/qwen3-9b:q4_k_m@3f2a1c9',
        label: 'Qwen3 9B Q4',
        throughput: { prefill_tokens_per_sec: 1000, decode_tokens_per_sec: 50 },
        success_bps: 8000,
        wholesale: {
            input_nano_usd_per_million: 100000000, cached_read_nano_usd_per_million: 0,
            cache_write_nano_usd_per_million: 0, output_nano_usd_per_million: 400000000,
            per_request_nano_usd: 0,
        },
    }],
    gpu_classes: [{
        id: 'rtx-4070-12gb',
        label: 'RTX 4070 12 GB',
        warm: { hourly_nano_usd: 100000000, storage_gb: 0, storage_nano_usd_per_gb_month: 0, egress_bytes_per_request: 0, egress_nano_usd_per_gb: 0 },
        scale_to_zero: { hourly_nano_usd: 200000000, startup_seconds: 0, requests_per_cold_start: 1, storage_gb: 0, storage_nano_usd_per_gb_month: 0, egress_bytes_per_request: 0, egress_nano_usd_per_gb: 0 },
    }],
}, null, 2));

(async () => {
    let off;
    try {
        off = await boot({ env: { HOST_INFERENCE_PLANNER: 'off', HOST_INFERENCE_PLANNER_INPUT: fixturePath } });
        const staff = off.user('planner-editor', { role: 'admin' });
        await check('flag off: no page and no JSON endpoint', async () => {
            const page = await off.api('GET', '/catalog/inference', { session: staff });
            assert.strictEqual(page.status, 404);
            const api = await off.api('GET', '/api/v1/catalog/inference-planner', { as: staff });
            assert.strictEqual(api.status, 404);
            assert.strictEqual(api.json().code, 'route.not_found');
            assert.strictEqual(off.ctx.inferencePlanner, undefined);
        });
    } finally { await off.close(); }

    const on = await boot({ env: { HOST_INFERENCE_PLANNER: 'on', HOST_INFERENCE_PLANNER_INPUT: fixturePath, HOST_INFERENCE_BUDGET_NANO_USD: '0' } });
    const staff = on.user('planner-editor', { role: 'admin' });
    const reader = on.user('planner-reader');
    try {
        await check('staff only: a signed-in reader and an anonymous caller are refused', async () => {
            const page = await on.api('GET', '/catalog/inference', { session: reader });
            assert.strictEqual(page.status, 403);
            assert.match(page.text, /Staff access required/);
            assert.doesNotMatch(page.text, /Warm rented GPU/);
            const api = await on.api('GET', '/api/v1/catalog/inference-planner', { as: reader });
            assert.strictEqual(api.status, 403);
            assert.strictEqual(api.json().code, 'host.catalog.forbidden');
            const anon = await on.api('GET', '/api/v1/catalog/inference-planner');
            assert.strictEqual(anon.status, 403);
            assert.strictEqual(anon.json().code, 'host.catalog.forbidden');
        });

        await check('the staff page shows the forecast, the three costs, the budget lock and no action', async () => {
            const r = await on.api('GET', '/catalog/inference', { session: staff });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.text, /Inference placement planner/);
            assert.match(r.text, /2,440 requests/);
            assert.match(r.text, /uncertainty band 2,440–2,440/);
            assert.match(r.text, /Warm rented GPU/);
            assert.match(r.text, /Scale to zero/);
            assert.match(r.text, /Wholesale API/);
            assert.match(r.text, /needs the owner's budget/);
            assert.match(r.text, /never starts, stops or rents anything/);
            assert.match(r.text, /no code path/);
            assert.match(r.text, /A tie prefers wholesale/);
            assert.doesNotMatch(r.text, /<form/i);
            assert.doesNotMatch(r.text, /<button/i);
            assert.strictEqual(r.headers['cache-control'], 'private, no-store');
        });

        await check('the JSON endpoint returns exact integer nano-USD and an empty action list', async () => {
            const r = await on.api('GET', '/api/v1/catalog/inference-planner', { as: staff });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.headers['content-type'], /application\/json/);
            const p = r.json().planner;
            assert.strictEqual(p.schema, 'openvibe.inference-planner-result@1');
            assert.strictEqual(p.executes, false);
            assert.strictEqual(p.action, 'none');
            assert.deepStrictEqual(p.summary.actions, []);
            assert.strictEqual(p.forecast.monthly.requests, 2440);
            assert.strictEqual(p.candidates.length, 1);
            const c = p.candidates[0];
            assert.strictEqual(c.costs.forecast.warm.total_nano_usd, '73000000000');
            assert.strictEqual(c.costs.forecast.scale_to_zero.total_nano_usd, '406667480');
            assert.strictEqual(c.costs.forecast.wholesale.total_nano_usd, '341600000');
            assert.strictEqual(c.recommendation.mode, 'wholesale');
            assert.strictEqual(c.recommendation.budget.status, 'needs_owner_budget');
            assert.strictEqual(p.summary.needs_owner_budget, 1);
        });

        await check('a missing planning file is a 503 page and problem, not a crash', async () => {
            fs.renameSync(fixturePath, `${fixturePath}.gone`);
            const page = await on.api('GET', '/catalog/inference', { session: staff });
            assert.strictEqual(page.status, 503);
            assert.match(page.text, /planning input is unavailable/i);
            const api = await on.api('GET', '/api/v1/catalog/inference-planner', { as: staff });
            assert.strictEqual(api.status, 503);
            assert.strictEqual(api.json().code, 'host.inference_planner.unavailable');
        });
    } finally {
        await on.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
