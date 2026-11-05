'use strict';
// server/inference-planner.js: the forecast, the integer nano-USD cost comparison, the hand-computed
// break-evens and the budget lock. Every expected number below is written out by hand; the test does
// not re-derive it with the implementation. It also asserts that the module has no network or spawn.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    plan, validate, parseBudget, formatUsd,
    busyMillis, warmCost, scaleToZeroCost, wholesaleCost,
} = require('../server/inference-planner');

const START = Date.parse('2026-10-05T00:00:00Z'); // Monday
const DAY = 86_400_000;

// Four identical weeks: Mon-Fri 100, Saturday 40, Sunday 20. The next 30 days start on Monday
// 2026-11-02: 5 Mon, 5 Tue, 4 Wed, 4 Thu, 4 Fri, 4 Sat, 4 Sun = 22*100 + 4*40 + 4*20 = 2,440.
function series4() {
    return Array.from({ length: 28 }, (_, i) => {
        const dow = i % 7; // 0 Monday ... 5 Saturday, 6 Sunday
        return {
            date: new Date(START + i * DAY).toISOString().slice(0, 10),
            requests: dow === 5 ? 40 : dow === 6 ? 20 : 100,
        };
    });
}

function model() {
    // 1,000 prefill tokens at 1,000 tok/s + 100 output tokens at 50 tok/s = 1 s + 2 s = 3 s busy.
    // Wholesale: 1,000 * $0.10/M = 100,000 nano + 100 * $0.40/M = 40,000 nano = 140,000 nano/request.
    return {
        id: 'qwen/qwen3-9b:q4_k_m@3f2a1c9',
        label: 'Qwen3 9B Q4',
        throughput: { prefill_tokens_per_sec: 1000, decode_tokens_per_sec: 50 },
        success_bps: 8000,
        wholesale: {
            input_nano_usd_per_million: 100000000,
            cached_read_nano_usd_per_million: 0,
            cache_write_nano_usd_per_million: 0,
            output_nano_usd_per_million: 400000000,
            per_request_nano_usd: 0,
        },
    };
}

function gpu() {
    // Warm $0.10/h => 730 h * $0.10 = $73 = 73,000,000,000 nano a month.
    // Scale-to-zero $0.20/h => 3 s = 3 * 200,000,000 / 3,600,000 = 166,666.66 -> 166,667 nano/request.
    return {
        id: 'rtx-4070-12gb',
        label: 'RTX 4070 12 GB',
        warm: { hourly_nano_usd: 100000000, storage_gb: 0, storage_nano_usd_per_gb_month: 0, egress_bytes_per_request: 0, egress_nano_usd_per_gb: 0 },
        scale_to_zero: { hourly_nano_usd: 200000000, startup_seconds: 0, requests_per_cold_start: 1, storage_gb: 0, storage_nano_usd_per_gb_month: 0, egress_bytes_per_request: 0, egress_nano_usd_per_gb: 0 },
    };
}

function input(points, overrides = {}) {
    return {
        note: 'test fixture',
        forecast: { horizon_days: 30, window_days: 28, series: points, ...(overrides.forecast || {}) },
        request: {
            input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100,
            ...(overrides.request || {}),
        },
        models: overrides.models || [model()],
        gpu_classes: overrides.gpu_classes || [gpu()],
    };
}

// ── Forecast ─────────────────────────────────────────────────────────────────────────────────────
const steady = plan(input(series4()));
assert.strictEqual(steady.forecast.method, 'moving average with day-of-week seasonality');
assert.strictEqual(steady.forecast.source.points, 28);
assert.strictEqual(steady.forecast.window.level_requests_per_day, 80);
assert.strictEqual(steady.forecast.horizon.days, 30);
assert.strictEqual(steady.forecast.horizon.start_date, '2026-11-02');
assert.strictEqual(steady.forecast.horizon.end_date, '2026-12-01');
assert.deepStrictEqual(steady.forecast.daily.slice(0, 7).map((d) => d.requests), [100, 100, 100, 100, 100, 40, 20]);
assert.strictEqual(steady.forecast.monthly.requests, 2440);
assert.strictEqual(steady.forecast.monthly.band, 0, 'an identical weekly pattern has no residual spread');
assert.strictEqual(steady.forecast.monthly.high, 2440);
assert.strictEqual(steady.forecast.monthly.low, 2440);

// One Monday is 120 instead of 100. Monday's mean is 105, so Monday forecasts 105 while the other
// weekdays stay 100: 5*105 + 5*100 + 12*100 + 4*40 + 4*20 = 2,465. The residuals are +15 for that
// Monday and -5 for the other three Mondays: (225 + 3*25) / (28 - 7) = 300/21 = 14.2857;
// sqrt = 3.77964; the 30-day band = ceil(1.96 * 3.77964 * sqrt(30)) = ceil(40.55) = 41.
// So the band is 2,424–2,506.
const oneOutlier = series4();
oneOutlier[0].requests = 120;
const banded = plan(input(oneOutlier));
assert.strictEqual(banded.forecast.monthly.requests, 2465);
assert.ok(Math.abs(banded.forecast.window.residual_sd_requests - 3.7796) < 1e-4);
assert.strictEqual(banded.forecast.monthly.band, 41);
assert.strictEqual(banded.forecast.monthly.low, 2424);
assert.strictEqual(banded.forecast.monthly.high, 2506);
assert.strictEqual(banded.forecast.daily[0].requests, 105, 'the next Monday follows its weekday factor');
assert.strictEqual(banded.forecast.daily[1].requests, 100);

// A 7-day window has one sample per weekday, so there is no residual degree of freedom; the band
// falls back to the window's spread around its level instead of claiming zero uncertainty.
// Spread: (5*20^2 + 40^2 + 60^2) / 6 = 7,200/6 = 1,200; sqrt = 34.641; band = ceil(1.96 *
// 34.641 * sqrt(30)) = ceil(371.9) = 372.
const sevenDayWindow = plan(input(series4(), { forecast: { window_days: 7 } }));
assert.strictEqual(sevenDayWindow.forecast.monthly.requests, 2440);
assert.strictEqual(sevenDayWindow.forecast.monthly.band, 372);

// ── Monthly costs at the forecast (2,440 requests) ───────────────────────────────────────────────
const planned = plan(input(series4()), { budgetNanoUsd: '1000000000' }); // $1/month
const candidate = planned.candidates[0];
assert.strictEqual(candidate.busy_per_request.total_ms, 3000);
assert.strictEqual(candidate.costs.forecast.requests_per_month, 2440);
assert.strictEqual(candidate.costs.forecast.warm.total_nano_usd, '73000000000');
assert.strictEqual(candidate.costs.forecast.warm.idle_burn_nano_usd, '72796666666');
assert.strictEqual(candidate.costs.forecast.scale_to_zero.total_nano_usd, '406667480');
assert.strictEqual(candidate.costs.forecast.scale_to_zero.parts_nano_usd.busy, '406667480');
assert.strictEqual(candidate.costs.forecast.wholesale.total_nano_usd, '341600000');
assert.strictEqual(candidate.costs.forecast.wholesale.parts_nano_usd.input, '100000');
assert.strictEqual(candidate.costs.forecast.wholesale.parts_nano_usd.output, '40000');
// 2,440 * 0.8 = 1,952 expected successes.
// Warm: 73,000,000,000 / 1,952 = 37,397,540.98 -> 37,397,541.
// Scale: 406,667,480 / 1,952 = 208,333.75 -> 208,334.
// Wholesale: 341,600,000 / 1,952 = 175,000 exactly.
assert.strictEqual(candidate.costs.forecast.warm.cost_per_successful_task_nano_usd, '37397541');
assert.strictEqual(candidate.costs.forecast.scale_to_zero.cost_per_successful_task_nano_usd, '208334');
assert.strictEqual(candidate.costs.forecast.wholesale.cost_per_successful_task_nano_usd, '175000');
assert.strictEqual(candidate.recommendation.mode, 'wholesale');
assert.strictEqual(candidate.recommendation.stable, true);
assert.strictEqual(candidate.recommendation.budget.status, 'within_budget');
assert.match(candidate.recommendation.reason, /Wholesale API is cheapest/);

// ── Break-even at the hand-computed points ───────────────────────────────────────────────────────
// Warm vs scale-to-zero: 73,000,000,000 / 166,667 = 437,999.12...; at 437,999 scale is still
// cheaper (72,999,979,333), at 438,000 it is 73,000,146,000, so 438,000 is the first warm month.
// Warm vs wholesale: 73,000,000,000 / 140,000 = 521,428.57; at 521,428 wholesale is 72,999,920,000,
// at 521,429 it is 73,000,060,000, so 521,429 is the first warm month.
assert.deepStrictEqual(candidate.break_even.warm_vs_scale_to_zero, { requests_per_month: '438000', cheaper_above: 'warm' });
assert.deepStrictEqual(candidate.break_even.warm_vs_wholesale, { requests_per_month: '521429', cheaper_above: 'warm' });
assert.strictEqual(candidate.break_even.capacity_requests_per_month, '876000');
const normalized = validate(input(series4()));
const busy = busyMillis(normalized.models[0], normalized.request);
const warm = (n) => warmCost(n, normalized.gpuClasses[0], busy).total;
const scale = (n) => scaleToZeroCost(n, normalized.gpuClasses[0], busy).total;
const wholesale = (n) => wholesaleCost(n, normalized.models[0], normalized.request).total;
assert.ok(warm(437999n) > scale(437999n), 'below the scale crossover warm still costs more');
assert.ok(warm(438000n) <= scale(438000n), 'at the scale crossover warm costs no more');
assert.ok(warm(521428n) > wholesale(521428n), 'below the wholesale crossover warm still costs more');
assert.ok(warm(521429n) <= wholesale(521429n), 'at the wholesale crossover warm costs no more');

// A third of the way is still wholesale; 300× the series is 732,000 requests, above both
// crossovers, so warm wins: 73,000,000,000 vs 102,480,000,000 wholesale.
const high = plan(input(series4().map((p) => ({ ...p, requests: p.requests * 300 }))), { budgetNanoUsd: '100000000000' });
assert.strictEqual(high.forecast.monthly.requests, 732000);
assert.strictEqual(high.candidates[0].recommendation.mode, 'warm');
assert.strictEqual(high.candidates[0].costs.forecast.warm.total_nano_usd, '73000000000');
assert.strictEqual(high.candidates[0].costs.forecast.wholesale.total_nano_usd, '102480000000');

// ── Integer nano-USD, beyond Number.MAX_SAFE_INTEGER ─────────────────────────────────────────────
// 730 h * 1,000,000,000,000,000 nano/h = 730,000,000,000,000,000 nano = $730,000,000 a month.
// A float would lose the units; BigInt keeps the exact integer and the output is a string.
const hugeGpu = gpu();
hugeGpu.warm.hourly_nano_usd = 1000000000000000;
const huge = plan(input(series4(), { gpu_classes: [hugeGpu] }));
assert.strictEqual(huge.candidates[0].costs.forecast.warm.total_nano_usd, '730000000000000000');
assert.ok(BigInt(huge.candidates[0].costs.forecast.warm.total_nano_usd) > BigInt(Number.MAX_SAFE_INTEGER));

// ── Budget lock ──────────────────────────────────────────────────────────────────────────────────
const unset = plan(input(series4()));
assert.strictEqual(unset.budget.configured, false);
assert.strictEqual(unset.budget.valid, true);
assert.strictEqual(unset.budget.configured_nano_usd, '0');
assert.strictEqual(unset.candidates[0].recommendation.budget.status, 'needs_owner_budget');
assert.match(unset.candidates[0].recommendation.reason, /Needs the owner's budget/);

const invalid = plan(input(series4()), { budgetNanoUsd: '1.5' });
assert.strictEqual(invalid.budget.valid, false);
assert.strictEqual(invalid.budget.configured, true);
assert.strictEqual(invalid.budget.configured_nano_usd, '0');
assert.strictEqual(invalid.candidates[0].recommendation.budget.status, 'needs_owner_budget');
assert.match(invalid.candidates[0].recommendation.reason, /not a non-negative integer/);

// The high band can cross the budget even when the forecast does not: 2,465 * 140,000 =
// 345,100,000 wholesale at the forecast and 2,506 * 140,000 = 350,840,000 at the high band. A
// $0.348 budget passes the forecast and fails the high band, so it needs the owner's budget.
const highBudget = plan(input(oneOutlier), { budgetNanoUsd: '348000000' });
const highRecommendation = highBudget.candidates[0].recommendation;
assert.strictEqual(highRecommendation.mode, 'wholesale');
assert.strictEqual(highRecommendation.budget.exceeds_forecast, false);
assert.strictEqual(highRecommendation.budget.exceeds_high_band, true);
assert.strictEqual(highRecommendation.budget.status, 'needs_owner_budget');

// A tie never recommends a rental: with zero-price modes the tie order is wholesale, scale, warm.
const freeModel = model();
freeModel.wholesale = { input_nano_usd_per_million: 0, cached_read_nano_usd_per_million: 0, cache_write_nano_usd_per_million: 0, output_nano_usd_per_million: 0, per_request_nano_usd: 0 };
const freeGpu = gpu();
freeGpu.warm.hourly_nano_usd = 0;
freeGpu.scale_to_zero.hourly_nano_usd = 0;
const free = plan(input(series4(), { models: [freeModel], gpu_classes: [freeGpu] }));
assert.strictEqual(free.candidates[0].recommendation.mode, 'wholesale');

// ── Validation names the field ──────────────────────────────────────────────────────────────────
for (const [label, bad, pattern] of [
    ['non-consecutive dates', (() => { const s = series4(); s.splice(10, 1); return input(s); })(), /forecast\.series\[10\]\.date: every point must be the next calendar day/],
    ['window longer than series', input(series4(), { forecast: { window_days: 29 } }), /forecast\.window_days: must be <= 28/],
    ['success rate zero', input(series4(), { models: [{ ...model(), success_bps: 0 }] }), /models\[0\]\.success_bps: must be >= 1/],
    ['negative tokens', input(series4(), { request: { output_tokens: -1 } }), /request\.output_tokens: must be >= 0/],
    ['zero throughput', input(series4(), { models: [{ ...model(), throughput: { prefill_tokens_per_sec: 0, decode_tokens_per_sec: 50 } }] }), /models\[0\]\.throughput\.prefill_tokens_per_sec: must be a positive number/],
    ['duplicate model id', input(series4(), { models: [model(), model()] }), /models\.id: 'qwen\/qwen3-9b:q4_k_m@3f2a1c9' is listed twice/],
    ['missing gpu class', (() => { const x = input(series4()); delete x.gpu_classes; return x; })(), /gpu_classes: is required/],
]) {
    assert.throws(() => plan(bad), pattern, label);
}

// ── parseBudget and formatUsd ────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseBudget(''), { nano: 0n, raw: '', configured: false, valid: true });
assert.deepStrictEqual(parseBudget('42'), { nano: 42n, raw: '42', configured: true, valid: true });
assert.deepStrictEqual(parseBudget('-1'), { nano: 0n, raw: '-1', configured: true, valid: false });
assert.strictEqual(formatUsd('73000000000'), '$73.00');
assert.strictEqual(formatUsd('341600000'), '$0.34');
assert.strictEqual(formatUsd('999999', 6), '$0.001000');
assert.strictEqual(formatUsd('0'), '$0.00');

// ── The checked-in example and its schema ────────────────────────────────────────────────────────
const examplePath = path.join(__dirname, '..', 'workers', 'llm-inference', 'examples', 'inference-planner.example.json');
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
assert.match(example.note, /example, not a quote/);
const examplePlan = plan(example);
assert.strictEqual(examplePlan.candidates.length, example.models.length * example.gpu_classes.length);
assert.strictEqual(examplePlan.summary.actions.length, 0);
assert.strictEqual(examplePlan.action, 'none');
assert.strictEqual(examplePlan.executes, false);
for (const c of examplePlan.candidates) {
    assert.match(c.costs.forecast.warm.total_nano_usd, /^\d+$/);
    assert.match(c.costs.high_band.wholesale.total_nano_usd, /^\d+$/);
    assert.ok(c.recommendation.reason.length > 0);
}
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inference-planner.schema.json'), 'utf8'));
for (const key of ['forecast', 'request', 'models', 'gpu_classes']) assert.ok(schema.properties[key], `schema property ${key}`);
assert.ok(schema.$defs.nanoUsd, 'schema defines integer nano-USD');
for (const key of Object.keys(example)) {
    if (key === '$schema') continue;
    assert.ok(schema.properties[key], `schema property ${key}`);
}

// ── No network, no process spawn, no clock ──────────────────────────────────────────────────────
const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'inference-planner.js'), 'utf8');
assert.doesNotMatch(source, /require\(\s*['"](?:fs|child_process|http|https|net|tls|dns|dgram|cluster|worker_threads)['"]\s*\)/);
assert.doesNotMatch(source, /child_process/);
assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execFile|execSync|fork)\s*\(/);
assert.doesNotMatch(source, /\bfetch\s*\(/);
assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|setImmediate)\s*\(/);
assert.doesNotMatch(source, /process\.(?:spawn|exec|fork)\b/);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('the planner must not call fetch'); };
try {
    plan(input(series4()));
} finally {
    globalThis.fetch = originalFetch;
}

console.log('inference planner: forecast, integer costs, break-evens and budget checks passed');
