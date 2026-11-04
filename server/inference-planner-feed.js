'use strict';
/**
 * The demand half of the inference planner: OpenVibe.AI's aggregate usage series
 * (`GET /api/v1/usage/series`, capability ai.usage.read) turned into the planner's daily request
 * series. The planner itself stays pure (server/inference-planner.js): this module is the only I/O
 * on the AI path, and the planning JSON remains the only I/O on the default JSON path.
 *
 * The feed is cached for ten minutes: a successful series is reused without another call, and a
 * failed refresh is reported as unavailable (the caller may then fall back to a configured JSON
 * input). No caller id, prompt or answer is read or kept: the endpoint returns aggregates only.
 */
const { serviceAuth } = require('openvibe-contracts');

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

class DemandFeedError extends Error {
    constructor(message) { super(message); this.name = 'DemandFeedError'; }
}

function dayOf(value) {
    if (typeof value !== 'string') return null;
    const m = DATE_RE.exec(value);
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(ms);
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
    return value;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * `body` is the AI endpoint's answer ({ days, from, to, series: [{ day, requests, … }] }). Rows are
 * summed across models: the planner forecasts one demand curve, not a model per candidate. Missing
 * days in the window are zero-demand days (AI sends only rows that have usage).
 */
function seriesOf(body, { days, now }) {
    if (!body || !Array.isArray(body.series)) throw new DemandFeedError('the usage feed did not return a series');
    const totals = new Map();
    for (const row of body.series) {
        if (!row || typeof row !== 'object') throw new DemandFeedError('a usage feed row is not an object');
        const day = dayOf(row.day);
        if (!day) throw new DemandFeedError('a usage feed row has no UTC day');
        const requests = row.requests === undefined ? 0 : Number(row.requests);
        if (!Number.isSafeInteger(requests) || requests < 0) throw new DemandFeedError(`the usage feed's requests on ${day} is not a non-negative integer`);
        totals.set(day, (totals.get(day) || 0) + requests);
    }
    const to = dayOf(body.to) || isoDay(now);
    const requestedFrom = dayOf(body.from);
    if (!requestedFrom) throw new DemandFeedError('the usage feed did not return its window');
    // Never trust a window longer than configured: keep its last `days` days. It must still cover the
    // planner's 14-day minimum, or there is no honest forecast to make.
    const from = isoDay(Math.max(Date.parse(`${requestedFrom}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS));
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
    if (span < 14) throw new DemandFeedError(`the usage feed covers ${span} day${span === 1 ? '' : 's'}; the planner needs at least 14`);
    if (span > 90) throw new DemandFeedError('the usage feed covers more than 90 days');
    const series = [];
    for (let i = 0; i < span; i++) {
        const date = isoDay(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS);
        series.push({ date, requests: totals.get(date) || 0 });
    }
    return { days: span, from, to, series };
}

function createDemandFeed({ config, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console }) {
    const planner = config.inferencePlanner;
    const cacheMs = planner.cacheMs;
    let tokens = null;
    let cached = null;        // { at, value }
    let inflight = null;

    function tokenClient() {
        if (tokens) return tokens;
        if (!config.oauth.clientSecret) throw new DemandFeedError('HOST_INFERENCE_PLANNER_SOURCE=ai needs OV_OAUTH_CLIENT_SECRET for Host\'s service token');
        tokens = serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: planner.aiAudience,
            scope: planner.aiCapability,
            fetchImpl,
            timeoutMs: planner.timeoutMs,
        });
        return tokens;
    }

    async function fetchSeries() {
        const url = `${planner.aiUrl}/api/v1/usage/series?days=${planner.days}`;
        let res;
        try {
            res = await fetchImpl(url, {
                headers: { Accept: 'application/json', ...(await tokenClient().authHeaders()) },
                signal: AbortSignal.timeout(planner.timeoutMs),
            });
        } catch (err) {
            throw new DemandFeedError(`the usage feed is unreachable: ${err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new DemandFeedError(`the usage feed answered ${res.status}`);
        const value = seriesOf(body, { days: planner.days, now: clock.now() });
        return { ...value, fetched_at: new Date(clock.now()).toISOString() };
    }

    async function current() {
        if (cached && clock.now() - cached.at < cacheMs) return cached.value;
        if (!inflight) {
            inflight = fetchSeries()
                .then((value) => { cached = { at: clock.now(), value }; return value; })
                .finally(() => { inflight = null; });
        }
        return inflight;
    }

    return { current };
}

module.exports = { createDemandFeed, seriesOf, DemandFeedError, DAY_MS };
