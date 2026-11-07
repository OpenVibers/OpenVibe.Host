'use strict';
/**
 * Owner inputs (the owner-setup design of 2026-11-07): the hosting providers' read-only tokens in `host.data_sources`,
 * listed by the admin panel's Setup tab under Data sources.
 *
 * Proves: the fields carry x-owner-input, titles and 30+ character descriptions, and every field of both Host
 * namespaces does (the planner's choice has labelled options); the price feed uses the panel's sealed token when set
 * and the environment's otherwise, at use time, and brings DigitalOcean's and Hetzner's plans into the comparison;
 * the test hook answers in one line and never carries the token, not even when the provider echoes it; no log line
 * carries a token.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { lintSchema } = require('./helpers/lint-schema');
const { mapItem } = require('../server/catalog/mapping');

const CAP = ['host.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const ENV_DO = 'dop_v1_madeupENVtokenFROMTHESETTINGSFILE0000000000000000001';
const PANEL_DO = 'dop_v1_madeupPANELtokenNEVERSHOWNANYWHERE00000000000000002';
const BAD_HZ = 'madeupHETZNERtokenTHEPROVIDERECHOESBACK000000000000000003';
const GOOD_HZ = 'madeupHETZNERtokenTHATWORKS0000000000000000000000000004';
const SECRETS = [ENV_DO, PANEL_DO, BAD_HZ, GOOD_HZ];

const calls = [];
async function fakeFetch(url, init = {}) {
    const u = String(url);
    if (!u.startsWith('https://api.digitalocean.com/') && !u.startsWith('https://api.hetzner.cloud/')) return globalThis.fetch(url, init);
    const auth = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    calls.push({ url: u, auth });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('https://api.digitalocean.com/')) {
        if (auth !== `Bearer ${ENV_DO}` && auth !== `Bearer ${PANEL_DO}`) return json(401, { id: 'unauthorized', message: 'Unable to authenticate you' });
        if (u === 'https://api.digitalocean.com/v2/account') return json(200, { account: { status: 'active', email: 'owner@example.test' } });
        if (u.startsWith('https://api.digitalocean.com/v2/sizes')) {
            return json(200, { sizes: [
                { slug: 's-1vcpu-1gb', description: 'Basic', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_monthly: 6, price_hourly: 0.00893, regions: ['nyc1', 'sfo3'], available: true },
                { slug: 's-2vcpu-4gb-amd', description: 'Premium AMD', memory: 4096, vcpus: 2, disk: 80, transfer: 4, price_monthly: 28, price_hourly: 0.04167, regions: ['nyc3'], available: true },
                { slug: 'gone-1', description: 'Basic', memory: 512, vcpus: 1, disk: 10, transfer: 0.5, price_monthly: 4, price_hourly: 0.006, regions: [], available: false },
            ], links: {}, meta: { total: 3 } });
        }
        return json(404, { message: 'not here' });
    }
    if (auth !== `Bearer ${GOOD_HZ}`) return json(401, { error: { code: 'unauthorized', message: `invalid token ${auth.replace(/^Bearer /, '')}` } });
    return json(200, { server_types: [
        { name: 'cx22', description: 'CX22', cores: 2, memory: 4, disk: 40, cpu_type: 'shared', storage_type: 'local', architecture: 'x86', deprecated: false,
            prices: [{ location: 'fsn1', price_hourly: { net: '0.0060000000', gross: '0.0071' }, price_monthly: { net: '3.7900000000', gross: '4.51' }, included_traffic: 21990232555520 },
                { location: 'ash', price_hourly: { net: '0.0080000000', gross: '0.0080' }, price_monthly: { net: '4.9900000000', gross: '4.99' }, included_traffic: 1099511627776 }] },
        { name: 'cx11', description: 'CX11', cores: 1, memory: 2, disk: 20, cpu_type: 'shared', storage_type: 'local', deprecated: true, prices: [] },
    ], meta: { pagination: { page: 1, per_page: 50, next_page: null, total_entries: 2 } } });
}

(async () => {
    const lines = [];
    const log = { log: (...a) => lines.push(a.join(' ')), info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    const consoleLines = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(original)) console[k] = (...a) => { consoleLines.push(a.join(' ')); original[k](...a); };
    const t = await boot({ env: { OV_CONFIG_KEKS: `k1:${KEK}`, OV_CONFIG_KEK_CURRENT: 'k1', HOST_DIGITALOCEAN_TOKEN: ENV_DO }, fetchImpl: fakeFetch, log });
    const admin = () => t.network.serviceToken('network', CAP);
    const cfg = (method, p, json) => t.api(method, p, { as: admin(), headers: { 'x-ov-subject': OWNER, 'x-ov-fresh': '1' }, ...(json ? { json } : {}) });
    const test = (key) => cfg('POST', `/internal/config/host.data_sources/test/${key}`);
    const ds = t.ctx ? t.ctx.dataSources : null;
    try {
        await check('every field of both Host namespaces has a title, a 30+ character description and labelled options', async () => {
            const r = await cfg('GET', '/internal/config');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.deepStrictEqual(r.json().namespaces.map((n) => n.namespace), ['host.inference_planner', 'host.data_sources']);
            for (const ns of r.json().namespaces) assert.deepStrictEqual(lintSchema(ns.schema), [], `${ns.namespace}: ${lintSchema(ns.schema).join('; ')}`);
            const planner = r.json().namespaces[0].schema.properties.source['x-enum-labels'];
            assert.deepStrictEqual(Object.keys(planner), ['json', 'ai']);
        });

        await check('the two tokens are owner inputs under Data sources, each required for its provider and tested', async () => {
            const p = (await cfg('GET', '/internal/config/host.data_sources')).json().schema.properties;
            assert.deepStrictEqual([p['digitalocean.token']['x-owner-input'].group, p['digitalocean.token']['x-owner-input'].test, p['digitalocean.token']['x-required-for']],
                ['data-sources', true, 'DigitalOcean in the hosting comparison']);
            assert.deepStrictEqual([p['hetzner.token']['x-owner-input'].group, p['hetzner.token']['x-owner-input'].test, p['hetzner.token']['x-required-for']],
                ['data-sources', true, 'Hetzner in the hosting comparison']);
            assert.strictEqual(p['digitalocean.token']['x-owner-input'].get_it_at, 'https://cloud.digitalocean.com/account/api/tokens');
        });

        await check('without a panel token the settings file is used and tested; without either, 409 config.not_set', async () => {
            const r = await test('digitalocean.token');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.deepStrictEqual([r.json().ok, r.json().state, r.json().source], [true, 'connected', 'env']);
            assert.strictEqual(r.json().message, "DigitalOcean accepted the token (the account is active); its Droplet prices can be read. (the value from the server's settings file, HOST_DIGITALOCEAN_TOKEN)");
            const none = await test('hetzner.token');
            assert.deepStrictEqual([none.status, none.json().code], [409, 'config.not_set']);
        });

        await check('a panel token is sealed, write-only and wins at use time; the feed brings the plans in', async () => {
            const put = await cfg('PUT', '/internal/config/host.data_sources/secrets/digitalocean.token', { value: PANEL_DO, reason: 'setup' });
            assert.strictEqual(put.status, 200, put.text.slice(0, 300));
            assert.ok(!put.text.includes(PANEL_DO));
            const carried = await cfg('POST', '/internal/config/host.data_sources', { values: { 'hetzner.token': GOOD_HZ }, reason: 'not here' });
            assert.deepStrictEqual([carried.status, carried.json().code], [422, 'config.secret_write_only']);
            const r = await test('digitalocean.token');
            assert.deepStrictEqual([r.json().ok, r.json().source], [true, 'vault']);
            const put2 = await cfg('PUT', '/internal/config/host.data_sources/secrets/hetzner.token', { value: GOOD_HZ, reason: 'setup' });
            assert.strictEqual(put2.status, 200, put2.text.slice(0, 300));
            const before = calls.length;
            const report = await t.ctx.keyedFeeds.pull();
            assert.deepStrictEqual(report, { digitalocean: { applied: 2, held: 0 }, hetzner: { applied: 1, held: 0 } });
            assert.ok(calls.slice(before).filter((c) => c.url.includes('digitalocean')).every((c) => c.auth === `Bearer ${PANEL_DO}`), 'the feed used the panel token');
            const dO = (await t.ctx.catalog.plans({ provider: 'digitalocean' })).plans;
            assert.deepStrictEqual(dO.map((p) => p.name).sort(), ['Basic · 1 vCPU, 1 GB', 'Premium AMD · 2 vCPU, 4 GB']);
            const hz = (await t.ctx.catalog.plans({ provider: 'hetzner', currency: 'EUR' })).plans;
            assert.deepStrictEqual([hz.length, hz[0].currency, Number(hz[0].price_monthly), hz[0].locations], [1, 'EUR', 3.79, ['fsn1', 'ash']]);
            const row = await t.ctx.store.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'host.data_sources' AND state = 'active'").get();
            assert.ok(!row.values_json.includes(PANEL_DO) && !row.values_json.includes(GOOD_HZ), 'sealed at rest');
        });

        await check('the mappers keep the providers\' own numbers', async () => {
            const it = (key, id, fields, title = id) => ({ id: `host:${key}:${id}`, source_key: key, category: 'hosting', identity: id, title, fields, provenance: { retrieved_at: '2026-11-07T00:00:00Z', first_seen_at: '2026-11-07T00:00:00Z' } });
            const d = mapItem(it('digitalocean-sizes', 's-1vcpu-1gb', { description: 'Basic', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_monthly: 6, price_hourly: 0.00893, regions: ['nyc1'] }));
            assert.deepStrictEqual([d.provider.slug, d.ram_mb, d.disk_gb, d.disk_type, d.bandwidth_gb, d.price_monthly, d.currency], ['digitalocean', 1024, 25, 'ssd', 1000, 6, 'USD']);
            assert.throws(() => mapItem(it('hetzner-server-types', 'x', { prices: [] })), /missing monthly price/);
        });

        await check('a refused token is Not working in one line, and the echoed token never comes back', async () => {
            await cfg('PUT', '/internal/config/host.data_sources/secrets/hetzner.token', { value: BAD_HZ, reason: 'wrong one' });
            const r = await test('hetzner.token');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.deepStrictEqual([r.json().ok, r.json().state], [false, 'not_working']);
            assert.match(r.json().message, /^Hetzner Cloud refused the token \(401\): invalid token \[hidden\]/);
            assert.ok(!r.text.includes(BAD_HZ) && !r.text.includes(BAD_HZ.slice(0, 12)));
            const report = await t.ctx.keyedFeeds.pull();
            assert.match(report.hetzner.error, /^Hetzner Cloud refused the token \(401\)/);
            assert.ok(!JSON.stringify(report).includes(BAD_HZ), 'the feed\'s report never carries the token');
        });

        await check('removing the panel token falls back to the settings file', async () => {
            const del = await cfg('DELETE', '/internal/config/host.data_sources/secrets/digitalocean.token', { reason: 'back to env' });
            assert.strictEqual(del.status, 200, del.text.slice(0, 300));
            assert.deepStrictEqual(t.ctx.dataSources.token('digitalocean'), { value: ENV_DO, source: 'env', env: 'HOST_DIGITALOCEAN_TOKEN' });
        });

        await check('the test hook is guarded and answers only for keys with a test', async () => {
            const denied = await t.api('POST', '/internal/config/host.data_sources/test/hetzner.token', { as: t.network.serviceToken('other', ['host.catalog.read']) });
            assert.strictEqual(denied.status, 403);
            const none = await cfg('POST', '/internal/config/host.inference_planner/test/enabled');
            assert.deepStrictEqual([none.status, none.json().code], [404, 'config.test_not_found']);
        });

        await check('no log line or console line carries a token', async () => {
            for (const k of Object.keys(original)) console[k] = original[k];
            for (const s of SECRETS) {
                assert.ok(lines.every((l) => !l.includes(s)), `a log line carries ${s.slice(0, 14)}…`);
                assert.ok(consoleLines.every((l) => !l.includes(s)), `a console line carries ${s.slice(0, 14)}…`);
            }
            assert.ok(lines.some((l) => /\[config\] test host\.data_sources hetzner\.token: not working/.test(l)), 'the outcome is logged without the token');
            assert.ok(lines.some((l) => /\[Host\] hetzner prices: Hetzner Cloud refused the token \(401\): invalid token \[hidden\]/.test(l)));
        });
        void ds;
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
