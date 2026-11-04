'use strict';
/**
 * Inference placement planner (PLAN.md §D ObservedPerformance, §E cost model and §G-P7).
 *
 * Pure functions only: this module reads no file, opens no socket, starts no process and has no
 * clock. The caller hands it a parsed planning document; it returns a forecast, a break-even and a
 * recommendation with its arithmetic — never an action. There is no code path here that starts,
 * stops or rents a GPU.
 *
 * D1: every price is integer nano-USD and every money expression is BigInt. Rates in the input may
 * be JSON integers or decimal strings; token counts, bytes and request counts become BigInt before
 * the multiplication. Durations (milliseconds) are planning estimates and are rounded up before
 * any money is computed.
 */

const HOURS_PER_MONTH = 730n;
const SECONDS_PER_HOUR = 3600n;
const DAY_MS = 86_400_000;
const NANO_PER_MILLION = 1_000_000n;
const NANO_PER_USD = 1_000_000_000n;
const BYTES_PER_GB = 1_000_000_000n;
const BPS = 10_000n;
const Z_95 = 1.96;
const SCHEMA = 'openvibe.inference-planner-result@1';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MODES = ['warm', 'scale_to_zero', 'wholesale'];
const LABELS = { warm: 'Warm rented GPU', scale_to_zero: 'Scale to zero', wholesale: 'Wholesale API' };
// A tie never recommends renting: wholesale first, then scale-to-zero, warm last.
const TIE_ORDER = ['wholesale', 'scale_to_zero', 'warm'];

function fail(where, message) {
    throw new Error(`${where}: ${message}`);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value, where) {
    if (value === undefined) fail(where, 'is required');
    if (!isRecord(value)) fail(where, 'must be an object');
    return value;
}

function list(value, where, { min = 1 } = {}) {
    if (value === undefined) fail(where, 'is required');
    if (!Array.isArray(value)) fail(where, 'must be an array');
    if (value.length < min) fail(where, `needs at least ${min} item${min === 1 ? '' : 's'}`);
    return value;
}

function text(value, where, { required = true, fallback = null } = {}) {
    if (value === undefined || value === null) {
        if (required) fail(where, 'is required');
        return fallback;
    }
    if (typeof value !== 'string') fail(where, 'must be a string');
    return value;
}

function integer(value, where, { min = 0n, max = null, required = true, fallback = null } = {}) {
    if (value === undefined || value === null) {
        if (required) fail(where, 'is required');
        return fallback;
    }
    let n;
    if (typeof value === 'bigint') n = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
    else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = BigInt(value.trim());
    else fail(where, 'must be an integer');
    if (n < min) fail(where, `must be >= ${min}`);
    if (max !== null && n > max) fail(where, `must be <= ${max}`);
    return n;
}

function count(value, where, opts = {}) {
    const n = Number(integer(value, where, opts));
    if (!Number.isSafeInteger(n)) fail(where, 'is too large');
    return n;
}

function positive(value, where, { required = true, fallback = null } = {}) {
    if (value === undefined || value === null) {
        if (required) fail(where, 'is required');
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(where, 'must be a positive number');
    return value;
}

function nonNegative(value, where, { required = true, fallback = null } = {}) {
    if (value === undefined || value === null) {
        if (required) fail(where, 'is required');
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(where, 'must be a non-negative number');
    return value;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDate(value, where) {
    const m = DATE_RE.exec(value);
    if (!m) fail(where, 'must be a calendar date (YYYY-MM-DD)');
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const ms = Date.UTC(year, month - 1, day);
    const d = new Date(ms);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) fail(where, 'is not a real calendar date');
    return ms;
}

function isoDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function round(value, digits = 0) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function validateForecast(value) {
    const f = record(value, 'forecast');
    if (f.series === undefined) fail('forecast.series', 'is required');
    const rows = list(f.series, 'forecast.series', { min: 14 });
    const points = rows.map((row, i) => {
        const where = `forecast.series[${i}]`;
        const p = record(row, where);
        const date = text(p.date, `${where}.date`);
        const ms = parseDate(date, `${where}.date`);
        const requests = count(p.requests, `${where}.requests`, { min: 0n, max: 1_000_000_000n });
        return { date, ms, requests, dow: new Date(ms).getUTCDay() };
    });
    points.sort((a, b) => a.ms - b.ms);
    for (let i = 1; i < points.length; i += 1) {
        if (points[i].ms === points[i - 1].ms) fail(`forecast.series[${i}].date`, 'duplicates an earlier date');
        if (points[i].ms !== points[i - 1].ms + DAY_MS) fail(`forecast.series[${i}].date`, 'every point must be the next calendar day');
    }
    const horizonDays = count(f.horizon_days, 'forecast.horizon_days', { min: 1n, max: 365n, required: false, fallback: 30n });
    const windowDays = count(f.window_days, 'forecast.window_days', { min: 7n, max: BigInt(points.length), required: false, fallback: 28n });
    return { horizonDays, windowDays, points };
}

function validateRequest(value) {
    const r = record(value, 'request');
    const token = (key) => integer(r[key], `request.${key}`, { min: 0n, max: 1_000_000_000n });
    return {
        inputTokens: token('input_tokens'),
        cachedReadTokens: token('cached_read_tokens'),
        cacheWriteTokens: token('cache_write_tokens'),
        outputTokens: token('output_tokens'),
    };
}

function validateModel(value, i) {
    const where = `models[${i}]`;
    const m = record(value, where);
    const id = text(m.id, `${where}.id`).trim();
    if (!id) fail(`${where}.id`, 'must not be empty');
    const label = text(m.label, `${where}.label`, { required: false, fallback: id });
    const t = record(m.throughput, `${where}.throughput`);
    const prefill = positive(t.prefill_tokens_per_sec, `${where}.throughput.prefill_tokens_per_sec`);
    const decode = positive(t.decode_tokens_per_sec, `${where}.throughput.decode_tokens_per_sec`);
    const cached = positive(t.cached_read_tokens_per_sec, `${where}.throughput.cached_read_tokens_per_sec`, { required: false, fallback: prefill });
    const concurrency = count(t.concurrency, `${where}.throughput.concurrency`, { min: 1n, max: 1024n, required: false, fallback: 1n });
    const successBps = count(m.success_bps, `${where}.success_bps`, { min: 1n, max: 10000n });
    const w = record(m.wholesale, `${where}.wholesale`);
    const rate = (key) => integer(w[key], `${where}.wholesale.${key}`, { min: 0n });
    return {
        id,
        label,
        throughput: { prefillTokensPerSec: prefill, decodeTokensPerSec: decode, cachedReadTokensPerSec: cached, concurrency },
        successBps,
        wholesale: {
            inputNanoPerMillion: rate('input_nano_usd_per_million'),
            cachedReadNanoPerMillion: rate('cached_read_nano_usd_per_million'),
            cacheWriteNanoPerMillion: rate('cache_write_nano_usd_per_million'),
            outputNanoPerMillion: rate('output_nano_usd_per_million'),
            perRequestNano: rate('per_request_nano_usd'),
            successBps: count(w.success_bps, `${where}.wholesale.success_bps`, { min: 1n, max: 10000n, required: false, fallback: BigInt(successBps) }),
        },
    };
}

function validateGpuSection(value, where) {
    const s = record(value, where);
    return {
        storageGb: integer(s.storage_gb, `${where}.storage_gb`, { min: 0n }),
        storageNanoPerGbMonth: integer(s.storage_nano_usd_per_gb_month, `${where}.storage_nano_usd_per_gb_month`, { min: 0n }),
        egressBytesPerRequest: integer(s.egress_bytes_per_request, `${where}.egress_bytes_per_request`, { min: 0n }),
        egressNanoPerGb: integer(s.egress_nano_usd_per_gb, `${where}.egress_nano_usd_per_gb`, { min: 0n }),
    };
}

function validateGpuClass(value, i) {
    const where = `gpu_classes[${i}]`;
    const g = record(value, where);
    const id = text(g.id, `${where}.id`).trim();
    if (!id) fail(`${where}.id`, 'must not be empty');
    const label = text(g.label, `${where}.label`, { required: false, fallback: id });
    const warm = validateGpuSection(g.warm, `${where}.warm`);
    warm.hourlyNanoUsd = integer(g.warm.hourly_nano_usd, `${where}.warm.hourly_nano_usd`, { min: 0n });
    const scale = validateGpuSection(g.scale_to_zero, `${where}.scale_to_zero`);
    scale.hourlyNanoUsd = integer(g.scale_to_zero.hourly_nano_usd, `${where}.scale_to_zero.hourly_nano_usd`, { min: 0n });
    scale.startupSeconds = nonNegative(g.scale_to_zero.startup_seconds, `${where}.scale_to_zero.startup_seconds`);
    scale.requestsPerColdStart = integer(g.scale_to_zero.requests_per_cold_start, `${where}.scale_to_zero.requests_per_cold_start`, { min: 1n });
    return { id, label, warm, scaleToZero: scale };
}

function unique(rows, kind) {
    const seen = new Set();
    for (const row of rows) {
        if (seen.has(row.id)) fail(`${kind}.id`, `'${row.id}' is listed twice`);
        seen.add(row.id);
    }
    return rows;
}

/** Validate and normalise a planning document. Throws on the first problem, naming its field. */
function validate(input) {
    if (!isRecord(input)) fail('input', 'must be a JSON object');
    const note = text(input.note, 'note', { required: false, fallback: null });
    return {
        note,
        forecast: validateForecast(input.forecast),
        request: validateRequest(input.request),
        models: unique(list(input.models, 'models').map(validateModel), 'models'),
        gpuClasses: unique(list(input.gpu_classes, 'gpu_classes').map(validateGpuClass), 'gpu_classes'),
    };
}

/**
 * Forecast the next `horizon_days` daily request counts.
 *
 * Level = the mean of the trailing `window_days` counts. Day-of-week factor = that weekday's mean
 * in the same window / the level. A future day is level × its weekday factor, rounded to a whole
 * request. The band is ±1.96 × the pooled residual standard deviation × √horizon (daily residuals
 * are assumed independent; the band is a planning aid, not a guarantee).
 */
function forecast(input) {
    const { horizonDays, windowDays, points } = input;
    const window = points.slice(-windowDays);
    const level = window.reduce((sum, p) => sum + p.requests, 0) / window.length;
    const sums = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
    for (const p of window) {
        sums[p.dow].sum += p.requests;
        sums[p.dow].count += 1;
    }
    const means = sums.map((s) => (s.count ? s.sum / s.count : level));
    const factors = means.map((m) => (level > 0 ? m / level : 1));
    const last = points[points.length - 1];
    const days = [];
    let total = 0;
    for (let i = 1; i <= horizonDays; i += 1) {
        const ms = last.ms + i * DAY_MS;
        const dow = new Date(ms).getUTCDay();
        const requests = Math.round(level * factors[dow]);
        total += requests;
        days.push({ date: isoDate(ms), weekday: WEEKDAYS[dow], requests, factor: round(factors[dow], 4) });
    }
    let sumSquares = 0;
    for (const p of window) {
        const residual = p.requests - means[p.dow];
        sumSquares += residual * residual;
    }
    const degrees = windowDays - 7;
    // With a 7-day window each weekday has one observation, so there is no residual degree of
    // freedom; fall back to the window's spread around its level instead of claiming zero error.
    const spread = degrees > 0
        ? sumSquares / degrees
        : window.reduce((sum, p) => sum + (p.requests - level) ** 2, 0) / Math.max(1, window.length - 1);
    const sd = Math.sqrt(spread);
    const band = Math.ceil(Z_95 * sd * Math.sqrt(horizonDays));
    return {
        method: 'moving average with day-of-week seasonality',
        explanation: 'Level is the mean of the trailing window; each weekday factor is that weekday\'s mean in the window divided by the level; a future day is level × its factor, rounded to a whole request. The band is ±1.96 × the pooled residual standard deviation × √horizon, assuming independent daily residuals; a 7-day window has no residual degree of freedom and uses its spread around the level instead.',
        source: { points: points.length, first_date: points[0].date, last_date: last.date },
        window: {
            start_date: window[0].date,
            end_date: window[window.length - 1].date,
            days: window.length,
            level_requests_per_day: round(level, 4),
            residual_sd_requests: round(sd, 4),
            weekday_factors: Object.fromEntries(WEEKDAYS.map((name, dow) => [name, round(factors[dow], 4)])),
        },
        horizon: { days: horizonDays, start_date: days[0].date, end_date: days[days.length - 1].date },
        monthly: {
            requests: total,
            band,
            low: Math.max(0, total - band),
            high: total + band,
            band_bps: total > 0 ? Math.round((band / total) * 10000) : 0,
        },
        daily: days,
    };
}

function parseBudget(value) {
    const raw = value === undefined || value === null ? '' : String(value).trim();
    if (raw === '') return { nano: 0n, raw, configured: false, valid: true };
    if (!/^\d+$/.test(raw)) return { nano: 0n, raw, configured: true, valid: false };
    return { nano: BigInt(raw), raw, configured: true, valid: true };
}

function ceilDiv(a, b) {
    if (b <= 0n) throw new Error('internal: division by a non-positive BigInt');
    return (a + b - 1n) / b;
}

function storageMonthly(section) {
    return section.storageGb * section.storageNanoPerGbMonth;
}

function egressPerRequest(section) {
    if (section.egressBytesPerRequest === 0n || section.egressNanoPerGb === 0n) return 0n;
    return ceilDiv(section.egressBytesPerRequest * section.egressNanoPerGb, BYTES_PER_GB);
}

/** Prompt and decode time per request, rounded up to whole milliseconds. */
function busyMillis(model, request) {
    const t = model.throughput;
    const prefillTokens = request.inputTokens + request.cacheWriteTokens;
    const prefill = prefillTokens === 0n ? 0 : Math.ceil(Number(prefillTokens) * 1000 / t.prefillTokensPerSec);
    const cachedRead = request.cachedReadTokens === 0n ? 0 : Math.ceil(Number(request.cachedReadTokens) * 1000 / t.cachedReadTokensPerSec);
    const decode = request.outputTokens === 0n ? 0 : Math.ceil(Number(request.outputTokens) * 1000 / t.decodeTokensPerSec);
    return { prefill, cached_read: cachedRead, decode, total: prefill + cachedRead + decode, concurrency: t.concurrency };
}

/**
 * Warm: one GPU-month (730 h) at the class's hourly rate for each GPU the busy time needs, plus
 * storage and egress. The idle burn is the rental minus the value of the busy GPU time at the same
 * rate; it is informational and already inside `gpu_rental`.
 */
function warmCost(requests, gpuClass, busy) {
    const n = BigInt(requests);
    const busyMs = BigInt(busy.total);
    const gpuMs = n * busyMs;
    const monthMs = HOURS_PER_MONTH * SECONDS_PER_HOUR * 1000n;
    const neededGpus = ceilDiv(gpuMs, monthMs);
    const gpuCount = neededGpus > 0n ? neededGpus : 1n;
    const gpuRental = gpuCount * HOURS_PER_MONTH * gpuClass.warm.hourlyNanoUsd;
    const busyValue = ceilDiv(gpuMs * gpuClass.warm.hourlyNanoUsd, 1000n * SECONDS_PER_HOUR);
    const storage = storageMonthly(gpuClass.warm);
    const egress = n * egressPerRequest(gpuClass.warm);
    return {
        mode: 'warm',
        total: gpuRental + storage + egress,
        parts: { gpu_rental: gpuRental, storage, egress },
        idleBurn: gpuRental - busyValue,
        gpuCount,
        occupancyBps: gpuMs > 0n ? Number((gpuMs * BPS) / (gpuCount * monthMs)) : 0,
    };
}

/**
 * Scale to zero: busy milliseconds at the serverless hourly rate, a cold start every
 * `requests_per_cold_start` requests at `startup_seconds`, storage and egress. Idle costs nothing.
 */
function scaleToZeroCost(requests, gpuClass, busy) {
    const n = BigInt(requests);
    const section = gpuClass.scaleToZero;
    const busyPerRequest = ceilDiv(BigInt(busy.total) * section.hourlyNanoUsd, 1000n * SECONDS_PER_HOUR);
    const busyCost = n * busyPerRequest;
    const coldStarts = ceilDiv(n, section.requestsPerColdStart);
    const startupMs = BigInt(Math.round(section.startupSeconds * 1000));
    const coldStartCost = ceilDiv(coldStarts * startupMs * section.hourlyNanoUsd, 1000n * SECONDS_PER_HOUR);
    const storage = storageMonthly(section);
    const egress = n * egressPerRequest(section);
    return {
        mode: 'scale_to_zero',
        total: busyCost + coldStartCost + storage + egress,
        parts: { busy: busyCost, cold_start: coldStartCost, storage, egress },
        idleBurn: 0n,
        coldStarts,
        perRequestBusy: busyPerRequest,
    };
}

/** Wholesale: input, cached read, cache write and output at per-million rates, plus the fee. */
function wholesaleCost(requests, model, request) {
    const n = BigInt(requests);
    const w = model.wholesale;
    const parts = {
        input: ceilDiv(request.inputTokens * w.inputNanoPerMillion, NANO_PER_MILLION),
        cached_read: ceilDiv(request.cachedReadTokens * w.cachedReadNanoPerMillion, NANO_PER_MILLION),
        cache_write: ceilDiv(request.cacheWriteTokens * w.cacheWriteNanoPerMillion, NANO_PER_MILLION),
        output: ceilDiv(request.outputTokens * w.outputNanoPerMillion, NANO_PER_MILLION),
        per_request: w.perRequestNano,
    };
    const perRequest = Object.values(parts).reduce((sum, value) => sum + value, 0n);
    return { mode: 'wholesale', total: n * perRequest, parts, idleBurn: 0n, perRequest };
}

function successOf(total, requests, successBps) {
    const tasks = (BigInt(requests) * BigInt(successBps)) / BPS;
    return { tasks, cost: tasks > 0n ? ceilDiv(total, tasks) : null };
}

function serializeCost(cost, requests, successBps) {
    const n = BigInt(requests);
    const perRequest = cost.mode === 'wholesale' ? cost.perRequest : (n > 0n ? ceilDiv(cost.total, n) : 0n);
    const success = successOf(cost.total, n, successBps);
    const out = {
        total_nano_usd: cost.total.toString(),
        per_request_nano_usd: perRequest.toString(),
        parts_nano_usd: Object.fromEntries(Object.entries(cost.parts).map(([key, value]) => [key, value.toString()])),
        idle_burn_nano_usd: cost.idleBurn.toString(),
        expected_successful_tasks: success.tasks.toString(),
        cost_per_successful_task_nano_usd: success.cost === null ? null : success.cost.toString(),
    };
    if (cost.gpuCount !== undefined) {
        out.gpu_count = cost.gpuCount.toString();
        out.occupancy_bps = cost.occupancyBps;
    }
    if (cost.coldStarts !== undefined) out.cold_starts = cost.coldStarts.toString();
    return out;
}

function costsAt(requests, model, gpuClass, request, busy) {
    return {
        warm: warmCost(requests, gpuClass, busy),
        scale_to_zero: scaleToZeroCost(requests, gpuClass, busy),
        wholesale: wholesaleCost(requests, model, request),
    };
}

function serializeCosts(costs, requests, model) {
    return {
        requests_per_month: requests,
        warm: serializeCost(costs.warm, requests, model.successBps),
        scale_to_zero: serializeCost(costs.scale_to_zero, requests, model.successBps),
        wholesale: serializeCost(costs.wholesale, requests, model.wholesale.successBps),
    };
}

function chooseMode(costs) {
    let best = TIE_ORDER[0];
    for (const mode of TIE_ORDER.slice(1)) {
        if (costs[mode].total < costs[best].total) best = mode;
    }
    return best;
}

function formatUsd(nano, digits = 2) {
    const n = BigInt(nano);
    const negative = n < 0n;
    const abs = negative ? -n : n;
    const scale = 10n ** BigInt(9 - digits);
    const rounded = (abs + scale / 2n) / scale;
    const unit = 10n ** BigInt(digits);
    const whole = rounded / unit;
    const fraction = (rounded % unit).toString().padStart(digits, '0');
    return `${negative ? '-' : ''}$${whole}.${fraction}`;
}

function moneyText(nano) {
    const abs = BigInt(nano) < 0n ? -BigInt(nano) : BigInt(nano);
    return formatUsd(nano, abs > 0n && abs < 1_000_000n ? 6 : 2);
}

function oneGpuCapacity(busy) {
    if (busy.total <= 0) return 1_000_000_000n;
    const monthMs = HOURS_PER_MONTH * SECONDS_PER_HOUR * 1000n;
    const capacity = monthMs / BigInt(busy.total);
    return capacity > 0n ? capacity : 1n;
}

/**
 * The smallest whole request count per month at which `a` costs no more than `b`, within one warm
 * GPU's monthly busy time. Both cost curves are non-decreasing and the gap only widens after the
 * threshold, so a binary search is exact. `null` means there is no break-even in that range.
 */
function firstAtMost(a, b, max) {
    if (a(0n) <= b(0n)) return 0n;
    if (!(a(max) <= b(max))) return null;
    let low = 0n;
    let high = max;
    while (low + 1n < high) {
        const mid = (low + high) / 2n;
        if (a(mid) <= b(mid)) high = mid;
        else low = mid;
    }
    return high;
}

function breakEven(model, gpuClass, request, busy) {
    const max = oneGpuCapacity(busy);
    const warm = (n) => warmCost(n, gpuClass, busy).total;
    const scale = (n) => scaleToZeroCost(n, gpuClass, busy).total;
    const wholesale = (n) => wholesaleCost(n, model, request).total;
    const pair = (fn) => {
        const at = fn();
        return at === null ? null : { requests_per_month: at.toString(), cheaper_above: 'warm' };
    };
    return {
        basis: 'within one warm GPU\'s monthly busy time',
        capacity_requests_per_month: max.toString(),
        warm_vs_scale_to_zero: pair(() => firstAtMost(warm, scale, max)),
        warm_vs_wholesale: pair(() => firstAtMost(warm, wholesale, max)),
    };
}

function reasonFor(mode, otherMode, atForecast, atHigh, stable, budget, needsOwnerBudget, recommendedHigh) {
    const parts = [];
    if (stable) {
        parts.push(`${LABELS[mode]} is cheapest at the forecast and at the high band (${moneyText(atForecast[mode].total)}/month).`);
    } else {
        parts.push(`${LABELS[mode]} is cheapest at the forecast (${moneyText(atForecast[mode].total)}/month), but ${LABELS[otherMode]} is cheapest at the high band (${moneyText(atHigh[otherMode].total)}/month); the choice depends on demand.`);
    }
    if (mode === 'warm') parts.push(`Its idle burn is ${moneyText(atForecast.warm.idleBurn)}/month at the forecast.`);
    else if (mode === 'scale_to_zero') parts.push(`Its cold-start cost is ${moneyText(atForecast.scale_to_zero.parts.cold_start)}/month at the forecast; idle time is free.`);
    else parts.push('No GPU is rented and no idle burn is paid.');
    if (needsOwnerBudget) {
        parts.push(`Needs the owner's budget: ${moneyText(recommendedHigh)}/month at the high band is above the configured ${moneyText(budget.nano)}/month.`);
    } else {
        parts.push(`Within the configured ${moneyText(budget.nano)}/month budget.`);
    }
    if (!budget.valid) parts.push('HOST_INFERENCE_BUDGET_NANO_USD is not a non-negative integer; it is treated as 0.');
    return parts.join(' ');
}

function planCandidate(model, gpuClass, request, forecastResult, budget) {
    const busy = busyMillis(model, request);
    const forecastRequests = forecastResult.monthly.requests;
    const highRequests = forecastResult.monthly.high;
    const atForecast = costsAt(forecastRequests, model, gpuClass, request, busy);
    const atHigh = costsAt(highRequests, model, gpuClass, request, busy);
    const mode = chooseMode(atForecast);
    const highMode = chooseMode(atHigh);
    const recommendedForecast = atForecast[mode].total;
    const recommendedHigh = atHigh[mode].total;
    const exceedsForecast = recommendedForecast > budget.nano;
    const exceedsHighBand = recommendedHigh > budget.nano;
    const needsOwnerBudget = exceedsForecast || exceedsHighBand;
    const stable = mode === highMode;
    return {
        model: { id: model.id, label: model.label },
        gpu_class: { id: gpuClass.id, label: gpuClass.label },
        busy_per_request: { prefill_ms: busy.prefill, cached_read_ms: busy.cached_read, decode_ms: busy.decode, total_ms: busy.total, concurrency: busy.concurrency },
        costs: {
            forecast: serializeCosts(atForecast, forecastRequests, model),
            high_band: serializeCosts(atHigh, highRequests, model),
        },
        break_even: breakEven(model, gpuClass, request, busy),
        recommendation: {
            mode,
            label: LABELS[mode],
            reason: reasonFor(mode, highMode, atForecast, atHigh, stable, budget, needsOwnerBudget, recommendedHigh),
            stable,
            forecast_nano_usd: recommendedForecast.toString(),
            high_band_nano_usd: recommendedHigh.toString(),
            budget: {
                status: needsOwnerBudget ? 'needs_owner_budget' : 'within_budget',
                budget_nano_usd: budget.nano.toString(),
                exceeds_forecast: exceedsForecast,
                exceeds_high_band: exceedsHighBand,
            },
        },
    };
}

/**
 * Build the whole plan. `options.budgetNanoUsd` is read from HOST_INFERENCE_BUDGET_NANO_USD by the
 * caller; an unset value is 0, an invalid value is also 0 (fail safe) and is reported as invalid.
 * Nothing here acts on the recommendation.
 */
function plan(input, options = {}) {
    const normalized = validate(input);
    const budget = parseBudget(options.budgetNanoUsd);
    const forecastResult = forecast(normalized.forecast);
    const candidates = [];
    for (const model of normalized.models) {
        for (const gpuClass of normalized.gpuClasses) {
            candidates.push(planCandidate(model, gpuClass, normalized.request, forecastResult, budget));
        }
    }
    return {
        schema: SCHEMA,
        executes: false,
        action: 'none',
        note: normalized.note,
        forecast: forecastResult,
        budget: {
            env: 'HOST_INFERENCE_BUDGET_NANO_USD',
            configured_nano_usd: budget.nano.toString(),
            configured: budget.configured,
            valid: budget.valid,
            unset_means_zero: true,
        },
        candidates,
        summary: {
            candidates: candidates.length,
            needs_owner_budget: candidates.filter((c) => c.recommendation.budget.status === 'needs_owner_budget').length,
            stable_recommendations: candidates.filter((c) => c.recommendation.stable).length,
            modes: MODES,
            actions: [],
        },
    };
}

module.exports = {
    plan,
    validate,
    forecast,
    parseBudget,
    formatUsd,
    busyMillis,
    warmCost,
    scaleToZeroCost,
    wholesaleCost,
    HOURS_PER_MONTH,
    SCHEMA,
};
