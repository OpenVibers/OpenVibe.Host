'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
(async () => {
    const t = await boot();
    const staff = t.user('catalog-editor', { role: 'admin' });
    const reader = t.user('catalog-reader');
    try {
        let provider, plan, promo;
        await check('staff creates and edits providers, plans and promos', async () => {
            let r = await t.api('POST', '/api/v1/catalog/providers', { as: staff, json: { slug: 'example', name: 'Example', homepage_url: 'https://example.test' } });
            assert.strictEqual(r.status, 201, r.text); provider = r.json().provider;
            r = await t.api('PATCH', `/api/v1/catalog/providers/${provider.id}`, { as: staff, json: { description: 'Official' } }); assert.strictEqual(r.json().provider.description, 'Official');
            r = await t.api('POST', '/api/v1/catalog/plans', { as: staff, json: { provider_id: provider.id, external_id: 'small', name: 'Small', kind: 'vps', currency: 'USD', price_monthly: 5, source_url: 'https://example.test/pricing' } }); assert.strictEqual(r.status, 201, r.text); plan = r.json().plan;
            r = await t.api('PATCH', `/api/v1/catalog/plans/${plan.id}`, { as: staff, json: { price_monthly: 6 } }); assert.strictEqual(r.status, 200, r.text);
            r = await t.api('POST', '/api/v1/catalog/promos', { as: staff, json: { provider_id: provider.id, title: 'Credit', url: 'https://example.test/promo' } }); assert.strictEqual(r.status, 201, r.text); promo = r.json().promo;
            r = await t.api('PATCH', `/api/v1/catalog/promos/${promo.id}`, { as: staff, json: { details: 'New accounts' } }); assert.strictEqual(r.json().promo.details, 'New accounts');
        });
        await check('non-staff forbidden; invalid and unsourced plans refused', async () => {
            const deny = await t.api('POST', '/api/v1/catalog/providers', { as: reader, json: { slug: 'bad' } }); assert.strictEqual(deny.status, 403); assert.strictEqual(deny.json().code, 'host.catalog.forbidden');
            const bad = await t.api('POST', '/api/v1/catalog/plans', { as: staff, json: { provider_id: provider.id, name: 'No source', external_id: 'bad', kind: 'vps', currency: 'USD', price_monthly: 1 } }); assert.strictEqual(bad.status, 422); assert.strictEqual(bad.json().code, 'host.catalog.invalid');
            const unknown = await t.api('PATCH', '/api/v1/catalog/promos/hpr_00000000000000000000000000', { as: staff, json: { title: 'x' } }); assert.strictEqual(unknown.status, 404); assert.strictEqual(unknown.json().code, 'host.catalog.not_found');
        });
        await check('staff manage form is server rendered and CSRF protected', async () => {
            const r = await t.api('GET', '/catalog/manage', { session: staff }); assert.strictEqual(r.status, 200); assert.match(r.text, /<form method="post"/); assert.match(r.text, /name="csrf"/);
            const denied = await t.api('POST', '/catalog/manage/providers', { session: staff, form: { slug: 'injected', name: 'Injected', homepage_url: 'https://example.test' } }); assert.strictEqual(denied.status, 403);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
