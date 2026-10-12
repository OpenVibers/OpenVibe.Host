'use strict';
/**
 * The hosting catalog in OpenVibe.Search: a sweep sends one host.index_document.upserted per public plan and provider
 * page (a valid search.index-document@1 the contracts declare), sends nothing for an unchanged page, and tombstones a
 * hidden plan and the plans of a hidden provider.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const staff = t.user('catalog-search-editor', { role: 'admin' });
    const events = async () => (await t.ctx.store.db.many("SELECT envelope FROM event_outbox WHERE envelope->>'event_type' LIKE 'host.index_document.%' ORDER BY id"))
        .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
    try {
        const post = async (type, body) => { const r = await t.api('POST', `/api/v1/catalog/${type}`, { as: staff, json: body }); assert.strictEqual(r.status, 201, r.text); return r.json()[type.slice(0, -1)]; };
        const patch = async (type, id, body) => { const r = await t.api('PATCH', `/api/v1/catalog/${type}/${id}`, { as: staff, json: body }); assert.strictEqual(r.status, 200, r.text); return r.json()[type.slice(0, -1)]; };
        const v = await post('providers', { slug: 'hetzner', name: 'Hetzner', homepage_url: 'https://www.hetzner.com/', description: 'German cloud servers.' });
        const plan = await post('plans', { provider_id: v.id, external_id: 'cx22', name: 'CX22', kind: 'cloud', vcpu: 2, ram_mb: 4096, disk_gb: 40, disk_type: 'nvme', bandwidth_gb: 20000, currency: 'USD', price_monthly: 4.99, source_url: 'https://www.hetzner.com/cloud/' });

        await check('a sweep sends a valid document for each public plan and provider page', async () => {
            const res = await t.ctx.catalogSearch.sweep();
            assert.deepStrictEqual([res.plan.sent, res.provider.sent], [1, 1]);
            const sent = await events();
            assert.strictEqual(sent.length, 2);
            for (const e of sent) {
                assert.deepStrictEqual(contracts.validate(`${e.event_type}@1`, e.payload).errors || [], [], e.event_type);
                assert.strictEqual(e.source, 'host');
            }
            const p = sent.find((e) => e.payload.type === 'plan').payload;
            assert.strictEqual(p.id, plan.id);
            assert.strictEqual(p.canonical_url, `${t.config.baseUrl}/catalog/plans/${plan.id}`);
            assert.match(p.title, /^Hetzner CX22: \$4\.99 a month$/);
            assert.match(p.summary, /2 vCPU · 4 GB RAM · 40 GB NVME disk · 20 TB transfer · checked \d{4}-\d{2}-\d{2}/);
            assert.deepStrictEqual(p.facets, { provider: 'hetzner', kind: 'cloud', currency: 'USD' });
            const pr = sent.find((e) => e.payload.type === 'provider').payload;
            assert.strictEqual(pr.canonical_url, `${t.config.baseUrl}/catalog/providers/hetzner`);
            assert.strictEqual(pr.summary, '1 plan from $4.99 a month');
        });

        await check('an unchanged page is not sent again', async () => {
            const res = await t.ctx.catalogSearch.sweep();
            assert.deepStrictEqual([res.plan.sent, res.provider.sent], [0, 0]);
            assert.strictEqual((await events()).length, 2);
        });

        await check('a price change re-sends the plan; hiding it sends a tombstone', async () => {
            await patch('plans', plan.id, { price_monthly: 5.49 });
            let res = await t.ctx.catalogSearch.sweep();
            assert.strictEqual(res.plan.sent, 1);
            await patch('plans', plan.id, { status: 'hidden' });
            res = await t.ctx.catalogSearch.sweep();
            const last = (await events()).filter((e) => e.payload.id === plan.id || e.subject && e.subject.id === plan.id).pop();
            assert.strictEqual(last.event_type, 'host.index_document.deleted', JSON.stringify(res));
        });

        await check('a hidden provider takes its plans and its own page out of Search', async () => {
            const other = await post('plans', { provider_id: v.id, external_id: 'cpx31', name: 'CPX31', kind: 'cloud', vcpu: 4, ram_mb: 8192, currency: 'USD', price_monthly: 15.99, source_url: 'https://www.hetzner.com/cloud/' });
            await t.ctx.catalogSearch.sweep();
            await patch('providers', v.id, { status: 'hidden' });
            await t.ctx.catalogSearch.sweep();
            const sent = await events();
            const lastFor = (id) => sent.filter((e) => (e.subject && e.subject.id === id) || e.payload.id === id).pop();
            assert.strictEqual(lastFor(other.id).event_type, 'host.index_document.deleted');
            assert.strictEqual(lastFor(v.id).event_type, 'host.index_document.deleted');
        });
    } finally {
        await t.close();
    }
    done();
})();
