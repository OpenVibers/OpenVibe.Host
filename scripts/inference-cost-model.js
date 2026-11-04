#!/usr/bin/env node
'use strict';
/**
 * Inference cost model (PLAN.md §E): cost per request and cost per successful task for
 *
 *   rented-warm        one GPU kept for the billing window; idle time is allocated
 *   scale-to-zero      serverless per-second execution plus a cold start
 *   api-wholesale      per-token wholesale API rates, all-in (no storage or egress line)
 *
 * The inputs are a planning estimate, not a quote. This script never reads a provider API and
 * never invents a benchmark: every number comes from the JSON file the operator passes in.
 * Customer liability is Billing's integer nano-USD ledger (D1); this script uses floats only
 * for forecast arithmetic and says so in its output.
 *
 *   node scripts/inference-cost-model.js [input.json] [--json]
 *
 * The default input is the clearly labelled example in
 * workers/llm-inference/examples/inference-cost-model.example.json.
 */
const fs = require('fs');
const path = require('path');

const HOURS_PER_MONTH = 730;

function fail(where, message) {
    throw new Error(`${where}: ${message}`);
}

function object(input, key) {
    const value = input[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(key, 'must be an object');
    return value;
}

function number(input, where, key, { required = true, min = 0, max = Infinity, integer = false, fallback } = {}) {
    const value = input == null ? undefined : input[key];
    if (value === undefined || value === null) {
        if (!required) return fallback;
        fail(where, 'is required');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'must be a finite number');
    if (integer && !Number.isInteger(value)) fail(where, 'must be an integer');
    if (value < min) fail(where, `must be >= ${min}`);
    if (value > max) fail(where, `must be <= ${max}`);
    return value;
}

function rate(input, key, fallback) {
    return number(input, key, key, { min: 0, required: fallback === undefined, fallback });
}

/**
 * Validate an input document against workers/llm-inference/... and
 * scripts/inference-cost-model.schema.json. Throws on the first problem.
 */
function validate(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('input: must be a JSON object');

    const window = object(input, 'window');
    number(window, 'window.hours', 'hours', { min: Number.MIN_VALUE });
    number(window, 'window.requests', 'requests', { min: 1, integer: true });

    const request = object(input, 'request');
    for (const key of ['input_tokens', 'cached_read_tokens', 'cache_write_tokens', 'output_tokens']) {
        number(request, `request.${key}`, key, { min: 0, integer: true });
    }
    number(request, 'request.success_rate', 'success_rate', { min: Number.MIN_VALUE, max: 1 });

    const throughput = object(input, 'throughput');
    number(throughput, 'throughput.prefill_tokens_per_sec', 'prefill_tokens_per_sec', { min: Number.MIN_VALUE });
    number(throughput, 'throughput.decode_tokens_per_sec', 'decode_tokens_per_sec', { min: Number.MIN_VALUE });
    number(throughput, 'throughput.cached_read_tokens_per_sec', 'cached_read_tokens_per_sec', {
        required: false, min: Number.MIN_VALUE, fallback: throughput.prefill_tokens_per_sec,
    });
    number(throughput, 'throughput.concurrency', 'concurrency', { required: false, min: 1, integer: true, fallback: 1 });

    const gpu = object(input, 'gpu');
    number(gpu, 'gpu.hourly_usd', 'hourly_usd', { min: 0 });
    number(gpu, 'gpu.occupancy', 'occupancy', { min: Number.MIN_VALUE, max: 1 });
    const policy = gpu.idle_policy;
    if (!['billed', 'standby', 'stopped'].includes(policy)) fail('gpu.idle_policy', "must be 'billed', 'standby' or 'stopped'");
    number(gpu, 'gpu.standby_hourly_usd', 'standby_hourly_usd', { required: policy === 'standby', min: 0, fallback: 0 });
    number(gpu, 'gpu.startup_seconds', 'startup_seconds', { min: 0 });
    number(gpu, 'gpu.storage_gb', 'storage_gb', { min: 0 });
    number(gpu, 'gpu.storage_usd_per_gb_month', 'storage_usd_per_gb_month', { min: 0 });
    number(gpu, 'gpu.egress_gb_per_request', 'egress_gb_per_request', { min: 0 });
    number(gpu, 'gpu.egress_usd_per_gb', 'egress_usd_per_gb', { min: 0 });

    const serverless = object(input, 'serverless');
    number(serverless, 'serverless.hourly_usd', 'hourly_usd', { min: 0 });
    number(serverless, 'serverless.startup_seconds', 'startup_seconds', { min: 0 });
    number(serverless, 'serverless.requests_per_cold_start', 'requests_per_cold_start', { min: 1, fallback: 1, required: false });
    number(serverless, 'serverless.storage_gb', 'storage_gb', { min: 0 });
    number(serverless, 'serverless.storage_usd_per_gb_month', 'storage_usd_per_gb_month', { min: 0 });
    number(serverless, 'serverless.egress_gb_per_request', 'egress_gb_per_request', { min: 0 });
    number(serverless, 'serverless.egress_usd_per_gb', 'egress_usd_per_gb', { min: 0 });

    const api = object(input, 'api_wholesale');
    for (const key of ['input_usd_per_million', 'cached_read_usd_per_million', 'cache_write_usd_per_million', 'output_usd_per_million', 'per_request_usd']) {
        number(api, `api_wholesale.${key}`, key, { min: 0 });
    }
    number(api, 'api_wholesale.success_rate', 'success_rate', { required: false, min: Number.MIN_VALUE, max: 1, fallback: request.success_rate });

    return input;
}

function storagePerRequest(section, window) {
    return section.storage_gb * section.storage_usd_per_gb_month * (window.hours / HOURS_PER_MONTH) / window.requests;
}

function egressPerRequest(section) {
    return section.egress_gb_per_request * section.egress_usd_per_gb;
}

function round(value) {
    // Strip binary noise from the report without pretending the estimate is exact.
    return Number(value.toPrecision(12));
}

/**
 * Compute the three deployment costs. Every returned amount is USD.
 *
 * Prompt seconds: fresh input + cache-write tokens run at prefill throughput; cached-read tokens
 * run at the measured cached-read throughput when one is supplied, otherwise (conservatively) at
 * prefill throughput. Decode seconds: output tokens / decode throughput.
 *
 * rented-warm: steady-state busy seconds / occupancy are billed (the rest is idle), idle at the
 * policy's rate, plus one startup per window. scale-to-zero: busy + startup/requests_per_cold_start at the serverless
 * hourly rate, no idle. api-wholesale: rate * tokens / 1e6 + per-request fee.
 *
 * Cost per successful task divides the per-request cost by the success rate (expected attempts).
 */
function compute(raw) {
    const input = validate(raw);
    const { window, request, throughput, gpu, serverless, api_wholesale: api } = input;

    const cachedTps = throughput.cached_read_tokens_per_sec === undefined
        ? throughput.prefill_tokens_per_sec
        : throughput.cached_read_tokens_per_sec;
    const prefillSeconds = (request.input_tokens + request.cache_write_tokens) / throughput.prefill_tokens_per_sec
        + request.cached_read_tokens / cachedTps;
    const decodeSeconds = request.output_tokens / throughput.decode_tokens_per_sec;
    const busySeconds = prefillSeconds + decodeSeconds;

    // rented-warm
    const idleSeconds = busySeconds * ((1 - gpu.occupancy) / gpu.occupancy);
    const idleHourly = gpu.idle_policy === 'billed'
        ? gpu.hourly_usd
        : gpu.idle_policy === 'standby' ? gpu.standby_hourly_usd : 0;
    const rentedParts = {
        gpu_busy: busySeconds * gpu.hourly_usd / 3600,
        gpu_idle: idleSeconds * idleHourly / 3600,
        startup: gpu.startup_seconds * gpu.hourly_usd / 3600 / window.requests,
        storage: storagePerRequest(gpu, window),
        egress: egressPerRequest(gpu),
    };
    const rentedPerRequest = Object.values(rentedParts).reduce((sum, value) => sum + value, 0);

    // scale-to-zero serverless
    const coldStartsPerRequest = 1 / serverless.requests_per_cold_start;
    const serverlessParts = {
        gpu_execution: busySeconds * serverless.hourly_usd / 3600,
        startup: serverless.startup_seconds * serverless.hourly_usd / 3600 * coldStartsPerRequest,
        storage: storagePerRequest(serverless, window),
        egress: egressPerRequest(serverless),
    };
    const serverlessPerRequest = Object.values(serverlessParts).reduce((sum, value) => sum + value, 0);

    // wholesale API: all-in rates, no owned storage or egress
    const apiParts = {
        input: request.input_tokens * api.input_usd_per_million / 1e6,
        cached_read: request.cached_read_tokens * api.cached_read_usd_per_million / 1e6,
        cache_write: request.cache_write_tokens * api.cache_write_usd_per_million / 1e6,
        output: request.output_tokens * api.output_usd_per_million / 1e6,
        per_request: api.per_request_usd,
    };
    const apiPerRequest = Object.values(apiParts).reduce((sum, value) => sum + value, 0);

    const rows = [
        { mode: 'rented-warm', costPerRequest: rentedPerRequest, successRate: request.success_rate, parts: rentedParts },
        { mode: 'scale-to-zero', costPerRequest: serverlessPerRequest, successRate: request.success_rate, parts: serverlessParts },
        { mode: 'api-wholesale', costPerRequest: apiPerRequest, successRate: api.success_rate, parts: apiParts },
    ].map((row) => ({
        ...row,
        costPerRequest: round(row.costPerRequest),
        costPerSuccessfulTask: round(row.costPerRequest / row.successRate),
        parts: Object.fromEntries(Object.entries(row.parts).map(([key, value]) => [key, round(value)])),
    }));

    return {
        schema: 'openvibe.inference-cost-model-result@1',
        note: 'Planning estimate only, not a quote. Billing settles in integer nano-USD (D1); these are floats.',
        inputNote: typeof input.note === 'string' ? input.note : null,
        window: { hours: window.hours, requests: window.requests },
        request: {
            input_tokens: request.input_tokens,
            cached_read_tokens: request.cached_read_tokens,
            cache_write_tokens: request.cache_write_tokens,
            output_tokens: request.output_tokens,
            success_rate: request.success_rate,
        },
        seconds: {
            prefill: round(prefillSeconds),
            decode: round(decodeSeconds),
            busy: round(busySeconds),
            rented_idle: round(idleSeconds),
            concurrency: throughput.concurrency === undefined ? 1 : throughput.concurrency,
        },
        rows,
    };
}

function money(value) {
    if (value === 0) return '$0';
    if (value < 1e-6) return `$${value.toExponential(2)}`;
    return `$${value.toFixed(6)}`;
}

function formatTable(result) {
    const r = result.request;
    const lines = [
        'Inference cost model — planning estimate, not a quote',
        `Window:        ${result.window.hours} h, ${result.window.requests} requests`,
        `Request mix:   I=${r.input_tokens} R=${r.cached_read_tokens} W=${r.cache_write_tokens} O=${r.output_tokens} tokens, success ${(r.success_rate * 100).toFixed(2)}%`,
        `Throughput:    ${result.seconds.prefill} s prefill + ${result.seconds.decode} s decode = ${result.seconds.busy} s GPU-busy per request (concurrency ${result.seconds.concurrency})`,
        '',
        'Mode             $/request      $/successful task  success',
    ];
    for (const row of result.rows) {
        lines.push(`${row.mode.padEnd(16)} ${money(row.costPerRequest).padStart(13)} ${money(row.costPerSuccessfulTask).padStart(18)}  ${(row.successRate * 100).toFixed(2)}%`);
    }
    lines.push('', 'Breakdown (USD per request):');
    for (const row of result.rows) {
        const parts = Object.entries(row.parts).map(([key, value]) => `${key}=${money(value)}`).join('  ');
        lines.push(`  ${row.mode.padEnd(16)} ${parts}`);
    }
    if (result.inputNote) lines.push('', `Input note: ${result.inputNote}`);
    lines.push('', 'Floats are for forecasting only; Billing settles in integer nano-USD. Verify every rate and measured throughput before quoting.');
    return lines.join('\n');
}

function usage() {
    return [
        'Usage: node scripts/inference-cost-model.js [input.json] [--json]',
        '',
        '  input.json   defaults to workers/llm-inference/examples/inference-cost-model.example.json',
        '  --json       print the computed result as JSON instead of a table',
        '',
        'The input schema is scripts/inference-cost-model.schema.json.',
    ].join('\n');
}

function main(argv) {
    let file = null;
    let asJson = false;
    for (const arg of argv) {
        if (arg === '--json') asJson = true;
        else if (arg === '--help' || arg === '-h') { console.log(usage()); return 0; }
        else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}\n${usage()}`);
        else if (file) throw new Error(`only one input file is accepted\n${usage()}`);
        else file = arg;
    }
    if (!file) file = path.join(__dirname, '..', 'workers', 'llm-inference', 'examples', 'inference-cost-model.example.json');
    const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const result = compute(input);
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.log(formatTable(result));
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`inference-cost-model: ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = { compute, validate, formatTable, money, HOURS_PER_MONTH };
