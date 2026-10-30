'use strict';
/**
 * Price over time for plans and domain endings (server/catalog/trend.js): a step from the first observation to
 * today, one point with no change, a rise, a fall, the currency kept, the change percent, the low and the high;
 * the page's chart and summary line; the two API routes; the catalog home's "Price changes this month" rail.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { planTrend, trend } = require('../server/catalog/trend');

const DAY = 86400000;
const at = '2026-09-22T12:00:00Z';
let seq = 0;
const item = (tld, fields) => ({
    id: `itm_${String(++seq).padStart(26, '0')}`, source_key: 'porkbun-tld-pricing', category: 'hosting', kind: 'tld_price', identity: tld, canonical_url: null, title: tld,
    summary: null, authors: [], published_at: null, source_updated_at: null, fields: { special_type: null, ...fields }, revision: 1, removed: null,
    provenance: { retrieved_at: at, first_seen_at: at, content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'api@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null },
});

(async () => {
    await check('the trend maths: one observation, a rise, a fall, currency kept, the change percent', async () => {
        const t0 = Date.parse('2026-09-01T00:00:00Z');
        const one = planTrend({ price_monthly: '10', currency: 'USD', first_seen_at: t0 }, [], t0 + DAY);
        assert.deepStrictEqual([one.points.length, one.now, one.low, one.high, one.change], [1, 10, 10, 10, null]);
        const rise = planTrend({ price_monthly: '12', currency: 'USD', first_seen_at: t0 }, [
            { observed_at: t0 + 2 * DAY, currency: 'USD', price_monthly_before: '10', price_monthly_after: '12' },
        ], t0 + 3 * DAY);
        assert.deepStrictEqual([rise.points.map((p) => p.price), rise.change], [[10, 12, 12], { amount: 2, percent: 20 }]);
        assert.strictEqual(rise.points[rise.points.length - 1].at, new Date(t0 + 3 * DAY).toISOString(), 'the current price is the last point');
        const fall = planTrend({ price_monthly: '8', currency: 'EUR', first_seen_at: t0 }, [
            { observed_at: t0 + 2 * DAY, currency: 'EUR', price_monthly_before: '10', price_monthly_after: '8' },
        ], t0 + 3 * DAY);
        assert.deepStrictEqual([fall.currency, fall.change, fall.low, fall.high], ['EUR', { amount: -2, percent: -20 }, 8, 10]);
        assert.strictEqual(trend([{ at: t0, price: 5 }], 'USD').change, null, 'one price has no change');
        // A change in another currency is never compared with the plan's currency.
        assert.deepStrictEqual(planTrend({ price_monthly: '12', currency: 'USD', first_seen_at: t0 }, [
            { observed_at: t0 + 2 * DAY, currency: 'EUR', price_monthly_before: '9', price_monthly_after: '12' },
        ], t0 + 3 * DAY).points.map((p) => p.price), [12]);
    });

    const t = await boot();
    t.clock.set(Date.parse('2026-10-01T12:00:00Z'));
    const staff = t.user('trend-editor', { role: 'admin' });
    try {
        const post = async (type, body) => { const r = await t.api('POST', `/api/v1/catalog/${type}`, { as: staff, json: body }); assert.strictEqual(r.status, 201, r.text); return r.json()[type.slice(0, -1)]; };
        const patch = async (id, body) => { const r = await t.api('PATCH', `/api/v1/catalog/plans/${id}`, { as: staff, json: body }); assert.strictEqual(r.status, 200, r.text); return r.json().plan; };
        const provider = await post('providers', { slug: 'trendco', name: 'Trend Co', homepage_url: 'https://trend.test' });
        const plan = async (id, price, currency = 'USD') => await post('plans', { provider_id: provider.id, external_id: id, name: id, kind: 'vps', currency, price_monthly: price, source_url: 'https://trend.test/pricing' });
        const moved = await plan('moved', 10);
        const still = await plan('still', 5);
        const euro = await plan('euro', 20, 'EUR');

        t.clock.advance(5 * DAY);
        await patch(moved.id, { price_monthly: 12 });
        t.clock.advance(5 * DAY);
        await patch(moved.id, { price_monthly: 9 });
        await patch(euro.id, { price_monthly: 25 });

        await check("the plan's price-trend API: points, currency, now, low, high, change", async () => {
            const r = await t.api('GET', `/api/v1/catalog/plans/${moved.id}/price-trend`);
            assert.strictEqual(r.status, 200, r.text);
            const trend = r.json();
            assert.deepStrictEqual(Object.keys(trend).sort(), ['change', 'currency', 'high', 'low', 'now', 'points']);
            assert.strictEqual(trend.currency, 'USD');
            assert.deepStrictEqual([trend.now, trend.low, trend.high, trend.change], [9, 9, 12, { amount: -1, percent: -10 }]);
            assert.deepStrictEqual(trend.points.map((p) => p.price), [10, 12, 9]);
            assert.ok(trend.points.every((p) => /^\d{4}-\d\d-\d\dT/.test(p.at) && Number.isFinite(p.price)));
            const e = (await t.api('GET', `/api/v1/catalog/plans/${euro.id}/price-trend`)).json();
            assert.deepStrictEqual([e.currency, e.points.map((p) => p.price)], ['EUR', [20, 25]]);
            const none = (await t.api('GET', `/api/v1/catalog/plans/${still.id}/price-trend`)).json();
            assert.deepStrictEqual([none.points.length, none.change, none.low, none.high], [1, null, 5, 5]);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/plans/nope/price-trend')).status, 404);
        });

        await check("the plan page draws the chart, the summary line, and folds every change", async () => {
            const r = await t.api('GET', `/catalog/plans/${moved.id}`);
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /class="ovk-chart ovk-chart--line"/, 'the shared kit draws it');
            assert.match(r.text, /Monthly price over time/);
            assert.match(r.text, /Was \$10\.00 on 2026-10-\d\d, now \$9\.00 \(−10%\)/);
            assert.match(r.text, /low \$9\.00 \([^)]*\), high \$12\.00/);
            assert.match(r.text, /<details class="hc-history-fold"><summary>Every change \(2\)<\/summary>/);
            assert.match(r.text, /\/shared\/kit-data\.css\?v=/);
            assert.match(r.text, /\/shared\/kit-data-web\.js\?v=/);
            const quiet = await t.api('GET', `/catalog/plans/${still.id}`);
            assert.doesNotMatch(quiet.text, /class="ovk-chart/, 'one observation has no chart');
            assert.match(quiet.text, /No changes recorded since 2026-10-01 \(\$5\.00\)/);
        });

        await check("the catalog home's rail: this month's moves, biggest first, rose and dropped in words", async () => {
            const r = await t.api('GET', '/');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Price changes this month/);
            assert.match(r.text, /class="hc-change-word">Dropped 25%<\/span>/, 'a fall is a word, not only a colour');
            assert.match(r.text, /class="hc-change-word">Rose 25%<\/span>/, 'the EUR plan rose 25%');
            const order = [...r.text.matchAll(/class="hc-change-word">([^<]+)</g)].map((m) => m[1]);
            assert.deepStrictEqual(order.slice(0, 2).sort(), ['Dropped 25%', 'Rose 25%'], 'the two 25% moves lead');
            assert.strictEqual(order[2], 'Rose 20%');
        });

        await check('a TLD\'s registration and renewal over time, on its page and in the API', async () => {
            assert.strictEqual(await t.ctx.catalog.applyItem(item('dev', { registration: '9.00', renewal: '12.00', transfer: '9.00' })), 'applied');
            t.clock.advance(7 * DAY);
            assert.strictEqual(await t.ctx.catalog.applyItem({ ...item('dev', { registration: '8.00', renewal: '13.00', transfer: '9.00' }), provenance: { ...item('dev', {}).provenance, retrieved_at: new Date(t.clock.now()).toISOString() } }), 'applied');
            const r = await t.api('GET', '/api/v1/catalog/tlds/dev/price-trend?kind=register');
            assert.strictEqual(r.status, 200, r.text);
            const register = r.json();
            assert.deepStrictEqual([register.kind, register.currency, register.now, register.low, register.high, register.change], ['register', 'USD', 8, 8, 9, { amount: -1, percent: -11 }]);
            const renew = (await t.api('GET', '/api/v1/catalog/tlds/dev/price-trend?kind=renew')).json();
            assert.deepStrictEqual([renew.kind, renew.now, renew.high, renew.change], ['renew', 13, 13, { amount: 1, percent: 8 }]);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/tlds/dev/price-trend?kind=transfer')).status, 422);
            const page = await t.api('GET', '/catalog/domains/dev');
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Registration and renewal over time/);
            assert.match(page.text, /class="ovk-chart ovk-chart--line"/);
            assert.match(page.text, /Registration<\/strong> Was \$9\.00 on 2026-09-\d\d, now \$8\.00 \(−11%\)/);
            assert.match(page.text, /Renewal<\/strong> Was \$12\.00 on 2026-09-\d\d, now \$13\.00 \(\+8%\)/);
            assert.match(page.text, /Every change \(1\)/);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
