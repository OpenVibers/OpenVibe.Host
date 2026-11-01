'use strict';
/**
 * What a stored price means in the catalog (server/catalog/pricing.js): a per-GB storage rate is not a monthly
 * server price, and a price last checked over a year ago is stale. Neither is the cheapest plan, neither is a
 * provider's "from" price, and both are shown as what they are (a rate per GB, a stale price).
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createCatalog } = require('../server/catalog/store');
const render = require('../server/render/catalog');
const { check, done } = require('./helpers/boot');

const NOW = Date.parse('2026-11-01T00:00:00Z');
const YEAR = 365 * 86400000;

(async () => {
    const db = await testDb();
    const store = createStore(db.db, { now: () => NOW });
    const catalog = createCatalog({ store });
    try {
        const provider = await catalog.save('providers', { slug: 'azure', name: 'Microsoft Azure', homepage_url: 'https://azure.microsoft.com/' }, null, 'tester');
        const plan = async (over) => await catalog.save('plans', {
            provider_id: provider.id, external_id: over.external_id, name: over.name, kind: over.kind || 'cloud',
            currency: 'USD', price_monthly: over.price_monthly, source_url: 'https://azure.microsoft.com/en-us/pricing/',
            vcpu: over.vcpu == null ? null : over.vcpu, ram_mb: over.ram_mb == null ? null : over.ram_mb,
            disk_gb: over.disk_gb == null ? null : over.disk_gb, checked_at: over.checked_at == null ? NOW : over.checked_at,
        }, null, 'tester');

        const fresh = await plan({ external_id: 'fresh', name: 'Standard_D2s_v5', price_monthly: 5, vcpu: 2, ram_mb: 8192, disk_gb: 64 });
        const stale = await plan({ external_id: 'stale', name: 'Standard_D1s_v5', price_monthly: 1, vcpu: 1, ram_mb: 2048, disk_gb: 32, checked_at: NOW - (YEAR + 86400000) });
        const rate = await plan({ external_id: 'rate', name: 'Archive LRS (per GB/month)', kind: 'storage', price_monthly: 0.001 });
        const unpriced = await plan({ external_id: 'unpriced', name: 'Free tier', price_monthly: 0 });

        await check('a price list puts the fresh monthly prices first and the rates and the stale price last', async () => {
            const rows = (await catalog.plans({ provider: 'azure' })).plans;
            assert.deepStrictEqual(rows.map((x) => x.external_id), ['fresh', 'stale', 'unpriced', 'rate']);
            const listed = (await catalog.providers('azure')).plans;
            assert.deepStrictEqual(listed.map((x) => x.external_id), ['fresh', 'stale', 'unpriced', 'rate']);
            assert.strictEqual(rows[0].stale, false);
            assert.strictEqual(rows[1].stale, true, 'a price checked over a year ago is stale');
            assert.strictEqual(rows[3].price_unit, 'per_gb_month', 'a per-GB rate is not a monthly price');
        });

        await check("a provider's from price is the cheapest fresh monthly price, not a rate per GB and not a stale price", async () => {
            const summary = await catalog.providerSummary();
            assert.strictEqual(summary.find((x) => x.slug === 'azure').from_price, 5);
        });

        await check('the provider page shows the from price, the rate per GB and the stale price', async () => {
            const html = render.provider(await catalog.providers('azure'), null, '', NOW);
            assert.ok(html.includes('from <strong>$5.00</strong>/mo'), 'the from price is the fresh monthly price');
            assert.ok(!html.includes('$0.00</span><span class="hc-per">/mo</span>'), 'no rate per GB reads as a monthly price');
            assert.ok(html.includes('$0.0010'), 'the rate is shown as the rate it is');
            assert.ok(html.includes('/GB/month'), 'the rate is shown per GB');
            assert.ok(html.includes('2025-10-31, <span class="hc-stale"'), 'a stale price is marked as stale');
            assert.ok(html.includes('not counted in the price above'), 'the page says what is not counted');
        });

        await check('a plan page shows a rate per GB as a rate and marks a stale price', async () => {
            const ratePage = render.plan(await catalog.plan(rate.id), null, { now: NOW });
            assert.ok(ratePage.includes('$0.0010'), 'the rate is the stored rate');
            assert.ok(ratePage.includes('/GB/month'), 'the rate is a rate per GB');
            assert.ok(!ratePage.includes('$0.00</span>'), 'a rate never reads as a monthly price');
            const stalePage = render.plan(await catalog.plan(stale.id), null, { now: NOW });
            assert.ok(stalePage.includes('Checked <strong>2025-10-31</strong>, <span class="hc-stale"'), 'the price is marked as stale');
            assert.ok(stalePage.includes('not counted as a cheapest plan'));
        });
    } finally {
        await db.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
