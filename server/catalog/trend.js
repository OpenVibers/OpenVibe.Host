'use strict';
/**
 * Price over time from the catalog's append-only observations (migrations/0005 and 0011), shared by a plan's page,
 * a TLD's page and the two price-trend API routes.
 *
 * A trend is the step a price held: every point starts when the price was first seen or changed, and the current
 * price is always the last point at `now`. A price is never interpolated and two currencies are never compared: only
 * the observation rows in the price's own currency count.
 *
 *   trend(points, currency) → { points: [{ at, price }], currency, now, low, high, change }
 *     points  oldest first, `at` an ISO date-time, `price` a number
 *     now     the current price (the last point's price)
 *     low/high the lowest and highest price in the points (a tie goes to the earliest)
 *     change  { amount, percent } | null (null with one observation); percent is a whole number, null at a
 *             first price of 0
 */

const round4 = (n) => Math.round(n * 10000) / 10000;
const finite = (n) => Number.isFinite(Number(n)) ? Number(n) : null;
const at = (ms) => new Date(Number(ms)).toISOString();

function trend(points, currency) {
    const clean = (points || [])
        .map((p) => ({ at: Number(p.at), price: finite(p.price) }))
        .filter((p) => Number.isFinite(p.at) && p.price != null)
        .sort((a, b) => a.at - b.at);
    // One price per moment, the last written wins (a first_seen_at that equals a change's time is the change).
    const byTime = [];
    for (const p of clean) {
        if (byTime.length && byTime[byTime.length - 1].at === p.at) byTime[byTime.length - 1] = p;
        else byTime.push(p);
    }
    if (!byTime.length) return null;
    const first = byTime[0];
    const last = byTime[byTime.length - 1];
    // Ties go to the earliest moment: "lowest since" is when it was first that low.
    const low = byTime.reduce((a, p) => (p.price < a.price ? p : a));
    const high = byTime.reduce((a, p) => (p.price > a.price ? p : a));
    const amount = round4(last.price - first.price);
    return {
        points: byTime.map((p) => ({ at: at(p.at), price: round4(p.price) })),
        currency: currency || null,
        now: round4(last.price),
        low: round4(low.price),
        high: round4(high.price),
        change: byTime.length > 1 ? {
            amount,
            percent: first.price > 0 ? Math.round((amount / first.price) * 100) : null,
        } : null,
    };
}

/**
 * A plan's price over time: the price first seen at first_seen_at, every catalog_price_changes row in the plan's
 * current currency, and the current price at `now`. Changes rows may arrive newest first (the store's query) or in
 * any order. With no change the plan has one observation.
 */
function planTrend(plan, changes, now) {
    if (!plan) return null;
    const currency = plan.currency || null;
    const current = finite(plan.price_monthly);
    if (current == null) return null;
    const rows = (changes || [])
        .filter((c) => (c.currency || null) === (currency || null) && finite(c.observed_at) != null)
        .sort((a, b) => Number(a.observed_at) - Number(b.observed_at));
    const firstAt = finite(plan.first_seen_at) ?? finite(plan.checked_at) ?? now;
    const points = [];
    if (rows.length) {
        const before = finite(rows[0].price_monthly_before);
        if (before != null) points.push({ at: firstAt, price: before });
        for (const c of rows) {
            const after = finite(c.price_monthly_after);
            if (after != null) points.push({ at: Number(c.observed_at), price: after });
        }
    } else {
        points.push({ at: firstAt, price: current });
    }
    // The current price is always the last point once there is a change, even when the last change was weeks
    // ago; with no change at all the plan has exactly one observation and no chart.
    if (rows.length) {
        const end = Math.max(Number(now) || 0, ...points.map((p) => p.at));
        const last = points[points.length - 1];
        if (!last || last.at !== end || last.price !== current) points.push({ at: end, price: current });
    }
    return trend(points, currency);
}

// ── TLDs ──────────────────────────────────────────────────────────────────────
// A TLD's page shows the cheapest registration and renewal at any registrar. Each registrar's price is a step
// function rebuilt from its own first sighting and change rows; the market's cheapest price at a moment is the
// lowest of those steps. A price that appears after the TLD was first seen joins at the moment it appears.

/** One registrar's step function for `field`, from its first sighting, changes and current value. */
function registrarSteps(row, changes, field) {
    const rows = (changes || [])
        .filter((c) => c.price_id === row.id && (c.currency || null) === (row.currency || null))
        .sort((a, b) => Number(a.observed_at) - Number(b.observed_at));
    const steps = [];
    if (rows.length) {
        const before = finite(rows[0][`${field}_before`]);
        if (before != null) steps.push({ at: Number(row.first_seen_at), value: before });
        for (const c of rows) steps.push({ at: Number(c.observed_at), value: finite(c[`${field}_after`]) });
    } else {
        const value = finite(row[field]);
        if (value != null) steps.push({ at: Number(row.first_seen_at), value });
    }
    // The current value still holds at `now`.
    if (steps.length) steps.push({ at: Number(row.checked_at), value: finite(row[field]) });
    return steps;
}

const stepAt = (steps, time) => {
    let value = null;
    for (const s of steps) {
        if (s.at > time) break;
        value = s.value;
    }
    return value;
};

/** Turn a market value function into step points: the value before each change and the new value at it. */
function marketSteps(events, valueAt, now) {
    const points = [];
    for (const t of events) {
        if (t === events[0]) {
            const v = valueAt(t);
            if (v != null) points.push({ at: t, value: v });
            continue;
        }
        const before = valueAt(t - 1);
        const after = valueAt(t);
        if (before === after) continue;
        if (before != null) points.push({ at: t - 1, value: before });
        if (after != null) points.push({ at: t, value: after });
    }
    const last = points[points.length - 1];
    const current = valueAt(now);
    if (current != null && (!last || last.at < now)) points.push({ at: now, value: current });
    return points;
}

/**
 * The cheapest registration and renewal over time for one TLD.
 * → { currency, register: trend, renew: trend } (a field nobody ever priced is null).
 */
function tldTrend(rows, changes, now) {
    const prices = (rows || []).filter((r) => (r.currency || null) === 'USD');
    if (!prices.length) return null;
    const timelines = prices.map((row) => ({
        register: registrarSteps(row, changes, 'register'),
        renew: registrarSteps(row, changes, 'renew'),
    }));
    const times = [...new Set([
        ...prices.map((r) => Number(r.first_seen_at)),
        ...(changes || []).map((c) => Number(c.observed_at)),
        Number(now),
    ].filter(Number.isFinite))].sort((a, b) => a - b);
    const market = (field) => {
        const valueAt = (t) => {
            const values = prices.map((_row, i) => stepAt(timelines[i][field], t)).filter((v) => v != null);
            return values.length ? Math.min(...values) : null;
        };
        return marketSteps(times, valueAt, Number(now));
    };
    const register = market('register');
    const renew = market('renew');
    return {
        currency: 'USD',
        register: register.length ? trend(register.map((p) => ({ at: p.at, price: p.value })), 'USD') : null,
        renew: renew.length ? trend(renew.map((p) => ({ at: p.at, price: p.value })), 'USD') : null,
    };
}

module.exports = { trend, planTrend, tldTrend };
