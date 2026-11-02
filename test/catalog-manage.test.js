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
        await check('a plan states its term and renewal, and every link what it earns us (market outcomes 1, 2, 7)', async () => {
            // A staff plan with no term: the page says so rather than guessing.
            let page = await t.api('GET', `/catalog/plans/${plan.id}`);
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            assert.match(page.text, /Term not published\./);
            assert.match(page.text, /No commission: we earn nothing from this link\./, 'a homepage link says it earns nothing');
            // A 1-year term with no renewal price stated, then one with it.
            let r = await t.api('PATCH', `/api/v1/catalog/plans/${plan.id}`, { as: staff, json: { price_term: '1-year' } }); assert.strictEqual(r.status, 200, r.text);
            page = await t.api('GET', `/catalog/plans/${plan.id}`);
            assert.match(page.text, /1-year term\. Renewal price not published\./);
            r = await t.api('PATCH', `/api/v1/catalog/plans/${plan.id}`, { as: staff, json: { renewal_price: 9.5 } }); assert.strictEqual(r.status, 200, r.text);
            page = await t.api('GET', `/catalog/plans/${plan.id}`);
            assert.match(page.text, /1-year term\. Renews at \$9\.50 a month\./);
            // A term that is not one of the three is refused.
            r = await t.api('PATCH', `/api/v1/catalog/plans/${plan.id}`, { as: staff, json: { price_term: 'weekly' } }); assert.strictEqual(r.status, 422, r.text);
            r = await t.api('PATCH', `/api/v1/catalog/plans/${plan.id}`, { as: staff, json: { price_term: 'monthly', renewal_price: null } }); assert.strictEqual(r.status, 200, r.text);
            page = await t.api('GET', `/catalog/plans/${plan.id}`);
            assert.match(page.text, /Month to month\. At the provider&#39;s list price\.|Month to month\. At the provider's list price\./);
        });
        await check('staff manage form is server rendered and CSRF protected', async () => {
            const r = await t.api('GET', '/catalog/manage', { session: staff }); assert.strictEqual(r.status, 200); assert.match(r.text, /<form method="post"/); assert.match(r.text, /name="csrf"/);
            const denied = await t.api('POST', '/catalog/manage/providers', { session: staff, form: { slug: 'injected', name: 'Injected', homepage_url: 'https://example.test' } }); assert.strictEqual(denied.status, 403);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
