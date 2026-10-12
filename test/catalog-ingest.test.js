'use strict';
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createCatalog } = require('../server/catalog/store');
const { createCatalogIngest } = require('../server/catalog/ingest');
const { mapItem } = require('../server/catalog/mapping');
const accountData = require('../server/catalog/account-data');
const { check, done } = require('./stageb/boot');
const at = '2026-10-11T12:00:00Z';
// The shape the Sources `api` adapter stores: the plan id as identity, Linode's label as title, the mapped extras flat in fields.
const item = (key, id, fields, time = at, title = id) => ({ id: `itm_${'0'.repeat(26)}`, source_key: key, category: 'hosting', kind: 'plan', identity: id, canonical_url: null, title, summary: null, authors: [], published_at: null, source_updated_at: null, fields, revision: 1, provenance: { retrieved_at: time, first_seen_at: at, content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'api@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null }, removed: null });
(async () => {
    const db = await testDb();
    const store = createStore(db.db, { now: () => Date.parse(at) });
    const catalog = createCatalog({ store });
    try {
        await check('Vultr and Linode API fields map without invented values', async () => {
            const v = mapItem(item('vultr-plans', 'vc2-1c-1gb', { vcpu_count: 1, ram: 1024, disk: 25, bandwidth: 1000, monthly_cost: 5, hourly_cost: 0.007, type: 'vc2' }));
            assert.strictEqual(v.kind, 'cloud'); assert.strictEqual(v.disk_type, 'ssd'); assert.strictEqual(v.currency, 'USD'); assert.strictEqual(v.ram_mb, 1024);
            const linode = { vcpus: 1, memory: 2048, disk: 51200, transfer: 2000, price_monthly: 12, price_hourly: 0.018, class: 'standard' };
            const l = mapItem(item('linode-types', 'g6-standard-1', linode, at, 'Linode 2 GB'));
            assert.strictEqual(l.external_id, 'g6-standard-1'); assert.strictEqual(l.name, 'Linode 2 GB');
            await catalog.applyItem(item('linode-types', 'g6-standard-1', linode, at, 'Linode 2 GB'));
            assert.strictEqual((await catalog.plans()).plans[0].provider_slug, 'linode');
            assert.strictEqual(l.disk_gb, 50); assert.strictEqual(l.ram_mb, 2048); assert.strictEqual(l.disk_type, null);
            assert.strictEqual(mapItem(item('vultr-plans', 'vdc-1', { monthly_cost: 50, type: 'vdc' })).kind, 'dedicated');
            assert.strictEqual(mapItem(item('vultr-plans', 'vhf-1', { monthly_cost: 10, type: 'vhf' })).disk_type, 'nvme');
        });
        await check('an AWS Lightsail bundle maps from the price list text, with its monthly price from 744 hours', async () => {
            const ls = { usagetype: 'USE1-BundleUsage:0.5GB', vcpu: '2', memory: '0.5GB', storage: '20GB', transfer: '1TB', location: 'US East (N. Virginia)', region: 'us-east-1', price_hourly: '0.0067200000', price_unit: 'Hrs' };
            const p = mapItem(item('aws-lightsail-bundles', '8E4A4X47ZPXKB2KD', ls, at, ls.usagetype));
            assert.deepStrictEqual([p.provider.slug, p.name, p.kind, p.vcpu, p.ram_mb, p.disk_gb, p.disk_type, p.bandwidth_gb, p.price_monthly, p.price_hourly, p.ipv4, p.locations],
                ['aws-lightsail', 'General purpose 0.5 GB', 'vps', 2, 512, 20, 'ssd', 1000, 5, 0.00672, 1, ['US East (N. Virginia)']]);
            const v6 = mapItem(item('aws-lightsail-bundles', 'SKU2', { ...ls, usagetype: 'USE1-ComputeOptimizedBundleUsage:8GB_IPv6', memory: '8GB', price_hourly: '0.1075300000' }));
            assert.deepStrictEqual([v6.name, v6.ipv4, v6.ram_mb, v6.price_monthly], ['Compute-optimized 8 GB (IPv6 only)', 0, 8192, 80]);
            assert.throws(() => mapItem(item('aws-lightsail-bundles', 'SKU3', { ...ls, price_unit: 'Quantity' })), /not hourly/);
            assert.throws(() => mapItem(item('aws-lightsail-bundles', 'SKU4', { ...ls, memory: 'lots' })), /size in GB or TB/);
            await catalog.applyItem(item('aws-lightsail-bundles', '8E4A4X47ZPXKB2KD', ls, at, ls.usagetype));
            const row = (await catalog.plans({ provider: 'aws-lightsail' })).plans[0];
            assert.deepStrictEqual([row.name, Number(row.price_monthly), row.ipv4, row.locations], ['General purpose 0.5 GB', 5, 1, ['US East (N. Virginia)']]);
        });
        await check('upsert preserves first seen and records only a changed price', async () => {
            const raw = { vcpu_count: 1, ram: 1024, disk: 25, bandwidth: 1000, monthly_cost: 5, hourly_cost: 0.007, type: 'vc2' };
            await catalog.applyItem(item('vultr-plans', 'vc2-1c-1gb', raw));
            await catalog.applyItem(item('vultr-plans', 'vc2-1c-1gb', { ...raw, monthly_cost: 6 }, '2026-10-12T12:00:00Z'));
            await catalog.applyItem(item('vultr-plans', 'vc2-1c-1gb', { ...raw, monthly_cost: 6 }, '2026-10-13T12:00:00Z'));
            const p = (await catalog.plans({ provider: 'vultr' })).plans[0];
            assert.strictEqual(Number(p.price_monthly), 6);
            assert.strictEqual(p.first_seen_at, Date.parse(at));
            assert.strictEqual(p.unmetered, null); assert.strictEqual(p.locations, null);
            assert.strictEqual(p.last_seen_at, Date.parse('2026-10-13T12:00:00Z'));
            assert.strictEqual((await catalog.plan(p.id)).price_history.length, 1);
        });
        await check('staff alone marks a missing Sources plan gone', async () => {
            const p = (await catalog.plans()).plans.find((x) => x.external_id === 'vc2-1c-1gb');
            await catalog.save('plans', { status: 'gone' }, p.id, 'usr_staff');
            assert.strictEqual((await catalog.plans()).plans.some((x) => x.id === p.id), false);
        });
        await check('signed sources.item.updated delivery is consumed once', async () => {
            const sourceItem = item('vultr-plans', 'event-plan', { monthly_cost: 7, type: 'vc2' });
            const enabled = createCatalogIngest({ config: { catalog: { ingest: true, sourcesUrl: 'https://sources.test', webhookSecrets: ['test-secret'] } }, store, catalog, source: { getItem: async () => ({ item: sourceItem }) } });
            const event = { event_id: `evt_${'0'.repeat(26)}`, event_type: 'sources.item.updated', version: 1, source: 'sources', actor: { type: 'service', id: 'sources' }, timestamp: at, visibility: 'internal', subject: { type: 'item', id: sourceItem.id }, payload: { category: 'hosting', item_id: sourceItem.id } };
            const raw = Buffer.from(JSON.stringify({ event, seq: 1 }));
            const headers = signDeliveryHeaders(raw, 'test-secret');
            const first = await enabled.consume(raw, headers);
            assert.strictEqual(first.status, 200); assert.strictEqual(first.outcome, 'applied');
            assert.strictEqual((await enabled.consume(raw, headers)).duplicate, true);
        });
        await check('0005 tables and append-only price history migrated', async () => {
            const tables = await db.db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'catalog_%'").all();
            assert.ok(tables.some((x) => x.table_name === 'catalog_price_changes'));
            const h = await db.db.prepare('SELECT plan_id, observed_at FROM catalog_price_changes LIMIT 1').get();
            await assert.rejects(db.db.prepare('DELETE FROM catalog_price_changes WHERE plan_id = ? AND observed_at = ?').run(h.plan_id, h.observed_at), /immutable/);
        });
        await check('ADR-033 export and erase keep shared rows but remove attribution', async () => {
            const p = await catalog.save('providers', { slug: 'staff', name: 'Staff', homepage_url: 'https://staff.test' }, null, 'usr_1');
            assert.strictEqual((await accountData.exportFor(db.db, 'usr_1')).catalog_providers.length, 1);
            assert.strictEqual((await accountData.eraseFor(db.db, 'usr_1')).catalog_providers, 1);
            assert.strictEqual((await catalog.get('providers', p.id)).created_by, null);
        });
        await check('unknown source is held and ingest off consumes nothing', async () => {
            assert.strictEqual(await catalog.applyItem(item('unknown-host', 'x', { monthly_cost: 1 })), 'hold');
            const off = createCatalogIngest({ config: { catalog: { ingest: false, sourcesUrl: '' } }, store, catalog });
            assert.deepStrictEqual(await off.pull(), { disabled: true });
            assert.strictEqual((await off.consume('', {})).status, 503);
            const on = createCatalogIngest({ config: { catalog: { ingest: true, sourcesUrl: 'https://sources.test', webhookSecrets: [] } }, store, catalog, source: { listItems: async () => ({ items: [item('unrecognised-key', 'x', { monthly_cost: 1 })], next_after: 1, more: false }) } });
            const result = await on.pull();
            assert.strictEqual(result.unknown, 1); assert.strictEqual(result.after, 1);
        });
    } finally { await db.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
