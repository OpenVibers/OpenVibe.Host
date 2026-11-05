'use strict';
/**
 * The inference planner's AI demand feed (HOST_INFERENCE_PLANNER_SOURCE=ai): Host asks a fake
 * OpenVibe.AI for its aggregate series with Host's own service token, caches it ten minutes, and on a
 * failure says "demand feed unavailable" and falls back to the configured planning JSON. The source
 * flag unset keeps today's JSON behaviour and never calls AI. The planner module stays pure: every
 * fetch lives in server/inference-planner-feed.js.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { boot, check, done, makeClock } = require('./helpers/boot');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-inference-feed-'));
const aiPlan = path.join(root, 'ai-plan.json');
const jsonPlan = path.join(root, 'json-plan.json');
const DAY = 86_400_000;
const CLOCK = Date.parse('2026-09-21T12:00:00Z');       // Monday
const WEEK_START = Date.parse('2026-08-24T00:00:00Z');  // Monday, 28 days before the forecast day
const WEEK_END = '2026-09-20';

function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

function document(series, windowDays) {
    return {
        note: 'test fixture, not a quote',
        forecast: { horizon_days: 30, window_days: windowDays, series },
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
    };
}

// The same four-week shape the pure test uses: Mon-Fri 100, Saturday 40, Sunday 20. The 30 forecast
// days after 2026-09-20 start on Monday 2026-09-21 and total 2,440 requests.
const aiSeries = Array.from({ length: 28 }, (_, i) => {
    const day = iso(WEEK_START + i * DAY);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();  // 0 Sunday, 6 Saturday
    return { date: day, requests: dow === 6 ? 40 : dow === 0 ? 20 : 100 };
});
fs.writeFileSync(aiPlan, JSON.stringify(document(aiSeries, 28), null, 2));

// A deliberately different JSON demand: 14 days of 10 requests, so a fallback (or a flag-unset run) is
// 300 requests a month, never the 2,440 the AI series would make.
const jsonSeries = Array.from({ length: 14 }, (_, i) => ({ date: iso(Date.parse('2026-09-07T00:00:00Z') + i * DAY), requests: 10 }));
fs.writeFileSync(jsonPlan, JSON.stringify(document(jsonSeries, 14), null, 2));

function startAi(handler) {
    return new Promise((resolve) => {
        const tokens = [];
        const urls = [];
        const server = http.createServer((req, res) => {
            tokens.push(String(req.headers.authorization || ''));
            urls.push(req.url);
            const out = handler(req);
            res.writeHead(out.status || 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body === undefined ? out : out.body));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            tokens,
            urls,
            calls: () => tokens.length,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

/** The AI endpoint's aggregate answer: two models a day, summing to the shape above. */
function aiBody() {
    const series = [];
    for (const row of aiSeries) {
        const half = Math.floor(row.requests / 2);
        for (const model of ['model-a', 'model-b']) {
            series.push({
                day: row.date, model, provider: 'fake', model_key: model,
                requests: model === 'model-a' ? half : row.requests - half, successes: 0,
                tokens: { input: 0, cached_read: 0, cache_write: 0, output: 0 },
            });
        }
    }
    return { days: 28, from: iso(WEEK_START), to: WEEK_END, series };
}

function bearerClaims(authorization) {
    return JSON.parse(Buffer.from(String(authorization).replace(/^Bearer /, '').split('.')[1], 'base64url'));
}

(async () => {
    // 1. A fake AI: Host's service token, the aggregate series, and the ten-minute cache.
    const ai = await startAi(() => ({ body: aiBody() }));
    const clock = makeClock(CLOCK);
    const on = await boot({ clock, env: {
        HOST_INFERENCE_PLANNER: 'on', HOST_INFERENCE_PLANNER_SOURCE: 'ai', HOST_INFERENCE_PLANNER_INPUT: aiPlan,
        HOST_INFERENCE_BUDGET_NANO_USD: '0', OV_AI_INTERNAL_URL: ai.url,
    } });
    const staff = on.user('planner-editor', { role: 'admin' });
    try {
        await check('the AI feed builds the series with Host\'s ai.usage.read token', async () => {
            const r = await on.api('GET', '/catalog/inference', { session: staff });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.text, /Demand: OpenVibe\.AI/);
            assert.match(r.text, /aggregate usage series, 28 days \(2026-08-24 to 2026-09-20\)/);
            assert.match(r.text, /2,440 requests/);
            assert.strictEqual(ai.calls(), 1, 'one feed call');
            assert.strictEqual(ai.urls[0], '/api/v1/usage/series?days=28', 'the aggregate endpoint and the configured window');
            const claims = bearerClaims(ai.tokens[0]);
            assert.ok(claims.aud.includes('openvibe.ai'), 'audience openvibe.ai');
            assert.ok(claims.cap.includes('ai.usage.read'), 'capability ai.usage.read');
            assert.strictEqual(claims.sub, 'svc:host', 'Host\'s own service token');
            const json = await on.api('GET', '/api/v1/catalog/inference-planner', { as: staff });
            assert.strictEqual(json.status, 200);
            assert.deepStrictEqual(json.json().planner.demand, { source: 'ai', from: '2026-08-24', to: '2026-09-20', days: 28, fetched_at: new Date(CLOCK).toISOString() });
        });

        await check('the series is cached for ten minutes', async () => {
            const before = ai.calls();
            const again = await on.api('GET', '/api/v1/catalog/inference-planner', { as: staff });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(ai.calls(), before, 'a second read inside ten minutes makes no call');
            clock.advance(10 * 60 * 1000 + 1000);
            const refreshed = await on.api('GET', '/api/v1/catalog/inference-planner', { as: staff });
            assert.strictEqual(refreshed.status, 200);
            assert.strictEqual(ai.calls(), before + 1, 'an expired cache asks again');
        });
    } finally { await on.close(); await ai.close(); }

    // 2. The feed fails and a configured JSON input is the fallback.
    const down = await startAi(() => ({ status: 503, body: { code: 'ai.not_found' } }));
    const fallback = await boot({ env: {
        HOST_INFERENCE_PLANNER: 'on', HOST_INFERENCE_PLANNER_SOURCE: 'ai', HOST_INFERENCE_PLANNER_INPUT: jsonPlan,
        HOST_INFERENCE_BUDGET_NANO_USD: '0', OV_AI_INTERNAL_URL: down.url,
    } });
    const fallbackStaff = fallback.user('planner-editor', { role: 'admin' });
    try {
        await check('a failure says demand feed unavailable and falls back to the configured JSON', async () => {
            const r = await fallback.api('GET', '/catalog/inference', { session: fallbackStaff });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.text, /demand feed unavailable/);
            assert.match(r.text, /using the configured planning JSON instead/);
            assert.match(r.text, /300 requests/, 'the JSON series, not the AI series');
            const json = await fallback.api('GET', '/api/v1/catalog/inference-planner', { as: fallbackStaff });
            assert.strictEqual(json.status, 200);
            assert.strictEqual(json.json().planner.demand.source, 'json');
            assert.strictEqual(json.json().planner.demand.fallback, true);
            assert.match(json.json().planner.demand.warning, /demand feed unavailable/);
        });
    } finally { await fallback.close(); await down.close(); }

    // 3. The feed fails and no JSON input is configured: no silent example fallback, just unavailable.
    const down2 = await startAi(() => ({ status: 503, body: { code: 'ai.not_found' } }));
    const noFallback = await boot({ env: {
        HOST_INFERENCE_PLANNER: 'on', HOST_INFERENCE_PLANNER_SOURCE: 'ai',
        HOST_INFERENCE_BUDGET_NANO_USD: '0', OV_AI_INTERNAL_URL: down2.url,
    } });
    try {
        await check('a failure with no configured JSON input is unavailable, never the bundled example', async () => {
            const r = await noFallback.api('GET', '/catalog/inference', { session: noFallback.user('planner-editor', { role: 'admin' }) });
            assert.strictEqual(r.status, 503);
            assert.match(r.text, /demand feed unavailable/);
            const json = await noFallback.api('GET', '/api/v1/catalog/inference-planner', { as: noFallback.user('planner-editor', { role: 'admin' }) });
            assert.strictEqual(json.status, 503);
            assert.strictEqual(json.json().code, 'host.inference_planner.unavailable');
        });
    } finally { await noFallback.close(); await down2.close(); }

    // 4. The source flag unset keeps today's JSON behaviour, and AI is never called.
    const never = await startAi(() => ({ body: aiBody() }));
    const off = await boot({ env: {
        HOST_INFERENCE_PLANNER: 'on', HOST_INFERENCE_PLANNER_INPUT: jsonPlan,
        HOST_INFERENCE_BUDGET_NANO_USD: '0', OV_AI_INTERNAL_URL: never.url,
    } });
    try {
        await check('source unset: the JSON series, no demand feed call', async () => {
            assert.strictEqual(off.config.inferencePlanner.source, 'json');
            const r = await off.api('GET', '/catalog/inference', { session: off.user('planner-editor', { role: 'admin' }) });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Demand: the configured planning JSON/);
            assert.match(r.text, /300 requests/);
            assert.strictEqual(never.calls(), 0, 'no AI call on the default path');
        });
    } finally { await off.close(); await never.close(); }

    fs.rmSync(root, { recursive: true, force: true });
    done();
})();
