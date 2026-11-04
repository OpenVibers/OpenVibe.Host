'use strict';
// scripts/inference-cost-model.js: the PLAN.md §E arithmetic on fixed, hand-computed inputs.
// Every expected number below is written out by hand in the comment above it; the test does not
// re-derive it with the implementation.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { compute, formatTable } = require('../scripts/inference-cost-model');

function close(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

// 1000 prefill tokens at 1000 tok/s + 100 output tokens at 50 tok/s = 1 s + 2 s = 3 s busy.
// Rented: occupancy 0.5 -> 6 s paid at $1.80/h = 6/3600 * 1.8 = $0.003 per request.
// 0.8 success -> $0.003 / 0.8 = $0.00375 per successful task.
// Serverless: 3 s at $3.60/h = $0.003; no startup.
// API: 1000 * $100/M = $0.1, 100 * $400/M = $0.04, per request $0.001 -> $0.141;
// $0.141 / 0.8 = $0.17625 per successful task.
const fixed = {
    note: 'test fixture',
    window: { hours: 10, requests: 100 },
    request: { input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100, success_rate: 0.8 },
    throughput: { prefill_tokens_per_sec: 1000, decode_tokens_per_sec: 50, concurrency: 1 },
    gpu: {
        hourly_usd: 1.8, occupancy: 0.5, idle_policy: 'billed', standby_hourly_usd: 0, startup_seconds: 0,
        storage_gb: 0, storage_usd_per_gb_month: 0, egress_gb_per_request: 0, egress_usd_per_gb: 0,
    },
    serverless: {
        hourly_usd: 3.6, startup_seconds: 0, requests_per_cold_start: 1,
        storage_gb: 0, storage_usd_per_gb_month: 0, egress_gb_per_request: 0, egress_usd_per_gb: 0,
    },
    api_wholesale: {
        input_usd_per_million: 100, cached_read_usd_per_million: 10, cache_write_usd_per_million: 100,
        output_usd_per_million: 400, per_request_usd: 0.001, success_rate: 0.8,
    },
};

const result = compute(fixed);
assert.strictEqual(result.rows.length, 3);
assert.deepStrictEqual(result.rows.map((row) => row.mode), ['rented-warm', 'scale-to-zero', 'api-wholesale']);
close(result.seconds.prefill, 1, 'prefill seconds');
close(result.seconds.decode, 2, 'decode seconds');
close(result.seconds.busy, 3, 'busy seconds');
close(result.seconds.rented_idle, 3, 'rented idle seconds');
close(result.rows[0].costPerRequest, 0.003, 'rented-warm per request');
close(result.rows[0].costPerSuccessfulTask, 0.00375, 'rented-warm per success');
close(result.rows[1].costPerRequest, 0.003, 'serverless per request');
close(result.rows[1].costPerSuccessfulTask, 0.00375, 'serverless per success');
close(result.rows[2].costPerRequest, 0.141, 'api per request');
close(result.rows[2].costPerSuccessfulTask, 0.17625, 'api per success');

// A full month makes storage easy: 10 GB * $1/GB-month = $10, over 1000 requests = $0.01 each.
// Busy 3 s at $3.60/h = $0.003; idle 9 s (occupancy 0.25) at standby $0.36/h = $0.0009;
// startup 36 s at $3.60/h = $0.036 / 1000 requests = $0.000036; egress 0.001 GB * $2 = $0.002.
// Rented total = 0.003 + 0.0009 + 0.000036 + 0.01 + 0.002 = 0.015936; / 0.8 = 0.01992.
// Serverless: 3 s at $7.20/h = $0.006; startup 18 s at $7.20/h / 3 requests = $0.012;
// storage 0.01 + egress 0.002 -> 0.03; / 0.8 = 0.0375.
const withOverheads = JSON.parse(JSON.stringify(fixed));
withOverheads.window = { hours: 730, requests: 1000 };
withOverheads.gpu.hourly_usd = 3.6;
withOverheads.gpu.occupancy = 0.25;
withOverheads.gpu.idle_policy = 'standby';
withOverheads.gpu.standby_hourly_usd = 0.36;
withOverheads.gpu.startup_seconds = 36;
withOverheads.gpu.storage_gb = 10;
withOverheads.gpu.storage_usd_per_gb_month = 1;
withOverheads.gpu.egress_gb_per_request = 0.001;
withOverheads.gpu.egress_usd_per_gb = 2;
withOverheads.serverless.hourly_usd = 7.2;
withOverheads.serverless.startup_seconds = 18;
withOverheads.serverless.requests_per_cold_start = 3;
withOverheads.serverless.storage_gb = 10;
withOverheads.serverless.storage_usd_per_gb_month = 1;
withOverheads.serverless.egress_gb_per_request = 0.001;
withOverheads.serverless.egress_usd_per_gb = 2;

const overheads = compute(withOverheads);
close(overheads.rows[0].costPerRequest, 0.015936, 'rented-warm with overheads');
close(overheads.rows[0].costPerSuccessfulTask, 0.01992, 'rented-warm with overheads per success');
close(overheads.rows[1].costPerRequest, 0.03, 'serverless with overheads');
close(overheads.rows[1].costPerSuccessfulTask, 0.0375, 'serverless with overheads per success');

// Cached read: 500 R and 250 W tokens. Without a measured cached-read rate, prefill is
// (1000 + 250)/1000 + 500/1000 = 1.75 s. With 5000 cached tok/s it is 1.25 + 500/5000 = 1.35 s.
const cached = JSON.parse(JSON.stringify(fixed));
cached.request.input_tokens = 1000;
cached.request.cached_read_tokens = 500;
cached.request.cache_write_tokens = 250;
cached.request.output_tokens = 100;
cached.api_wholesale.success_rate = 0.8;
const noCacheRate = compute(cached);
close(noCacheRate.seconds.prefill, 1.75, 'cached tokens at prefill rate');
// API: 1000*100/M + 500*10/M + 250*100/M + 100*400/M + 0.001 = 0.1 + 0.005 + 0.025 + 0.04 + 0.001.
close(noCacheRate.rows[2].costPerRequest, 0.171, 'api cached-read mix');
close(noCacheRate.rows[2].costPerSuccessfulTask, 0.21375, 'api cached-read mix per success');
cached.throughput.cached_read_tokens_per_sec = 5000;
const measuredCache = compute(cached);
close(measuredCache.seconds.prefill, 1.35, 'cached tokens at measured rate');

// A per-mode API success rate overrides the request success rate.
const apiSuccess = JSON.parse(JSON.stringify(fixed));
apiSuccess.api_wholesale.success_rate = 0.5;
assert.ok(Math.abs(compute(apiSuccess).rows[2].costPerSuccessfulTask - 0.282) < 1e-12);

// The failure allocation is a division by the success rate, so it is visible in both directions.
const allSuccess = JSON.parse(JSON.stringify(fixed));
allSuccess.request.success_rate = 1;
assert.ok(compute(allSuccess).rows[0].costPerSuccessfulTask === compute(allSuccess).rows[0].costPerRequest);

// Invalid inputs are refused with the field named.
for (const [label, mutate, pattern] of [
    ['occupancy zero', (x) => { x.gpu.occupancy = 0; }, /gpu\.occupancy/],
    ['success rate zero', (x) => { x.request.success_rate = 0; }, /success_rate/],
    ['negative output', (x) => { x.request.output_tokens = -1; }, /output_tokens/],
    ['missing serverless', (x) => { delete x.serverless; }, /serverless/],
    ['standby rate missing', (x) => { x.gpu.idle_policy = 'standby'; delete x.gpu.standby_hourly_usd; }, /standby_hourly_usd/],
    ['bad policy', (x) => { x.gpu.idle_policy = 'free'; }, /idle_policy/],
    ['zero prefill', (x) => { x.throughput.prefill_tokens_per_sec = 0; }, /prefill_tokens_per_sec/],
    ['fractional requests', (x) => { x.window.requests = 1.5; }, /window\.requests/],
]) {
    const bad = JSON.parse(JSON.stringify(fixed));
    mutate(bad);
    assert.throws(() => compute(bad), pattern, label);
}

// The checked-in example is clearly a placeholder and still runs through the whole model.
const examplePath = path.join(__dirname, '..', 'workers', 'llm-inference', 'examples', 'inference-cost-model.example.json');
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
assert.match(example.note, /example, not a quote/);
const exampleResult = compute(example);
assert.strictEqual(exampleResult.rows.length, 3);
for (const row of exampleResult.rows) {
    assert.ok(Number.isFinite(row.costPerRequest) && row.costPerRequest > 0, `${row.mode} per request`);
    assert.ok(Number.isFinite(row.costPerSuccessfulTask) && row.costPerSuccessfulTask > 0, `${row.mode} per success`);
}
const table = formatTable(exampleResult);
assert.match(table, /planning estimate, not a quote/);
assert.match(table, /rented-warm/);
assert.match(table, /scale-to-zero/);
assert.match(table, /api-wholesale/);

// The CLI reads the same file and prints JSON.
const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'inference-cost-model.js'), examplePath, '--json'], { encoding: 'utf8' });
const cli = JSON.parse(output);
assert.deepStrictEqual(cli.rows.map((row) => row.mode), ['rented-warm', 'scale-to-zero', 'api-wholesale']);

// The schema and the example describe the same fields; this catches drift in either direction.
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inference-cost-model.schema.json'), 'utf8'));
for (const key of ['window', 'request', 'throughput', 'gpu', 'serverless', 'api_wholesale']) {
    assert.ok(schema.properties[key], `schema property ${key}`);
    for (const field of Object.keys(example[key])) {
        assert.ok(schema.properties[key].properties[field], `schema property ${key}.${field}`);
    }
}

console.log('inference cost model: all hand-computed checks passed');
