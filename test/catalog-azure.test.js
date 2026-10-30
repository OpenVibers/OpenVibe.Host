'use strict';
/**
 * Microsoft Azure's retail price list in the catalog (server/catalog/mapping.js): a virtual machine carries its size,
 * its region, its price an hour and a month, and the date the price took effect is the observation time the price
 * trend (catalog_price_changes, Host #210) is dated by.
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createCatalog } = require('../server/catalog/store');
const { mapItem } = require('../server/catalog/mapping');
const { check, done } = require('./helpers/boot');
const at = '2026-10-30T12:00:00Z';

// The shape the Sources `api` adapter stores for an Azure price row (a recorded fixture: no live call here).
const item = (id, fields, time = at, title = id) => ({
    id: `itm_${'0'.repeat(26)}`, source_key: 'azure-retail-prices', category: 'hosting', kind: 'plan', identity: id,
    canonical_url: null, title, summary: null, authors: [], published_at: null, source_updated_at: null, fields, revision: 1,
    provenance: { retrieved_at: time, first_seen_at: at, content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'api@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null }, removed: null,
});
const vm = (over = {}) => ({ sku_id: 'DZH318Z08M9W/006F', sku_name: 'Standard_D8s_v5', meter_name: 'D8s v5', product_name: 'Virtual Machines Dsv5 Series', service_name: 'Virtual Machines', region: 'eastus', location: 'US East', price: 0.96, unit: '1 Hour', currency: 'USD', effective_start: '2021-11-01T00:00:00Z', tier_minimum_units: 0, ...over });

(async () => {
    const db = await testDb();
    const store = createStore(db.db, { now: () => Date.parse(at) });
    const catalog = createCatalog({ store });
    try {
        await check('an Azure virtual machine maps with its size, region, hourly and monthly price', async () => {
            const p = mapItem(item('DZH318Z08M9W/006F', vm(), at, 'Standard_D8s_v5'));
            assert.deepStrictEqual([p.provider.slug, p.provider.name, p.name, p.kind, p.locations, p.price_hourly, p.price_monthly, p.currency, p.source_url],
                ['azure', 'Microsoft Azure', 'Standard_D8s_v5', 'cloud', ['eastus'], 0.96, 700.8, 'USD', 'https://azure.microsoft.com/en-us/pricing/']);
            assert.strictEqual(p.external_id, 'DZH318Z08M9W/006F@eastus', 'the same SKU in another region is another plan');
            assert.strictEqual(p.checked_at, Date.parse('2021-11-01T00:00:00Z'), 'the effective date is the observation time');
            const spot = mapItem(item('DZH318Z08M9W/006G', vm({ meter_name: 'D8s v5 Spot', price: 0.29, sku_id: 'DZH318Z08M9W/006G' }), at, 'Standard_D8s_v5'));
            assert.strictEqual(spot.name, 'Standard_D8s_v5 (Spot)');
            const storage = mapItem(item('DZH318Z0BNZJ/00WH', { ...vm(), sku_id: 'DZH318Z0BNZJ/00WH', sku_name: 'Cold LRS', meter_name: 'Cold LRS Data Stored', product_name: 'Blob Storage', service_name: 'Storage', price: 0.0036, unit: '1 GB/Month' }, at, 'Cold LRS'));
            assert.deepStrictEqual([storage.kind, storage.name, storage.price_monthly, storage.price_hourly], ['storage', 'Cold LRS (per GB/month)', 0.0036, null]);
            assert.throws(() => mapItem(item('X', vm({ unit: '1 Day' }), at, 'x')), /unknown Azure price unit/);
        });

        await check('the plan row lands in the catalog with the effective date, and a later price is dated by its own effective date', async () => {
            await catalog.applyItem(item('DZH318Z08M9W/006F', vm(), at, 'Standard_D8s_v5'));
            const row = (await catalog.plans({ provider: 'azure' })).plans[0];
            assert.deepStrictEqual([row.provider_slug, row.name, Number(row.price_monthly), Number(row.price_hourly), row.locations, new Date(row.checked_at).toISOString()],
                ['azure', 'Standard_D8s_v5', 700.8, 0.96, ['eastus'], '2021-11-01T00:00:00.000Z']);
            // The price changes and Microsoft says the new price took effect on 2026-06-01: the change is dated then.
            await catalog.applyItem(item('DZH318Z08M9W/006F', vm({ price: 1.02, effective_start: '2026-06-01T00:00:00Z' }), '2026-10-30T12:00:00Z', 'Standard_D8s_v5'));
            const plan = await catalog.plan(row.id);
            assert.strictEqual(Number(plan.price_monthly), 744.6);
            assert.deepStrictEqual(plan.price_history.map((c) => [new Date(c.observed_at).toISOString().slice(0, 10), Number(c.price_monthly_before), Number(c.price_monthly_after)]),
                [['2026-06-01', 700.8, 744.6]]);
        });
    } finally {
        await db.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
