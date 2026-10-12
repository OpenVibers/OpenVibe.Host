'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    const threads = new Map();
    const communityUrl = 'https://community.stub.test';
    const fetchImpl = async (url, options = {}) => {
        if (!String(url).startsWith(communityUrl)) return await globalThis.fetch(url, options);
        const path = new URL(url).pathname;
        if (path.endsWith('/resolve')) {
            const ref = JSON.parse(options.body).ref;
            calls.push({ method: 'resolve', ref });
            const key = `${ref.service}:${ref.type}:${ref.id}`;
            if (!threads.has(key)) threads.set(key, { id: `cth_${String(threads.size + 1).padStart(22, 'a')}`, visibility: 'public', comment_count: 1 });
            return Response.json({ thread: threads.get(key), created: true }, { status: 201 });
        }
        const thread = [...threads.values()].find((row) => path.includes(row.id));
        if (options.method === 'PUT') {
            const visibility = JSON.parse(options.body).visibility;
            calls.push({ method: 'visibility', id: thread.id, visibility });
            thread.visibility = visibility;
            return Response.json({ thread });
        }
        calls.push({ method: 'read', id: thread.id });
        return Response.json({ thread, comments: [{ id: 1, display_name: 'Reader', message: 'A useful comment', created_at: '2026-10-10T12:00:00Z' }] });
    };
    const t = await boot({ env: { HOST_COMMUNITY_URL: communityUrl, OV_COMMUNITY_URL: 'https://openvibe.community' }, fetchImpl });
    const staff = t.user('catalog-discussion-editor', { role: 'admin' });
    const post = async (type, json) => {
        const r = await t.api('POST', `/api/v1/catalog/${type}`, { as: staff, json });
        assert.strictEqual(r.status, 201, r.text);
        return r.json()[type.slice(0, -1)];
    };
    try {
        const provider = await post('providers', { slug: 'discuss', name: 'Discuss', homepage_url: 'https://example.test' });
        const plan = await post('plans', { provider_id: provider.id, external_id: 'one', name: 'One', kind: 'vps', currency: 'USD', price_monthly: 5, source_url: 'https://example.test/prices' });
        const hiddenProvider = await post('providers', { slug: 'secret', name: 'Secret', homepage_url: 'https://example.test', status: 'hidden' });
        await check('public provider and plan resolve once and render Community comments', async () => {
            for (const [type, path, id] of [['provider', '/catalog/providers/discuss', provider.id], ['plan', `/catalog/plans/${plan.id}`, plan.id]]) {
                const first = await t.api('GET', path);
                const second = await t.api('GET', path);
                assert.strictEqual(first.status, 200, first.text);
                assert.strictEqual(second.status, 200, second.text);
                assert.match(first.text, /Discussion/);
                assert.match(first.text, /A useful comment/);
                assert.match(first.text, /Join the discussion on OpenVibe.Community/);
                assert.strictEqual(calls.filter((x) => x.method === 'resolve' && x.ref.type === type).length, 1);
                assert.deepStrictEqual(Object.fromEntries(Object.entries(calls.find((x) => x.method === 'resolve' && x.ref.type === type).ref).filter(([k]) => k !== 'label')), { service: 'host', type, id });
            }
        });
        await check('provider hiding follows commit, while rollback calls nothing', async () => {
            const before = calls.length;
            await assert.rejects(t.ctx.store.db.tx(async () => {
                await t.ctx.catalog.save('providers', { status: 'hidden' }, provider.id, staff.subject);
                throw new Error('rollback');
            }), /rollback/);
            await t.ctx.catalog.discussionIdle();
            assert.strictEqual(calls.length, before);
            const r = await t.api('PATCH', `/api/v1/catalog/providers/${provider.id}`, { as: staff, json: { status: 'hidden' } });
            assert.strictEqual(r.status, 200, r.text);
            await t.ctx.catalog.discussionIdle();
            assert.ok(calls.some((x) => x.method === 'visibility' && x.visibility === 'hidden' && x.id === threads.get(`host:provider:${provider.id}`).id));
            assert.strictEqual((await t.api('GET', '/catalog/providers/discuss')).status, 404);
            assert.strictEqual(calls.filter((x) => x.method === 'resolve').length, 2);
        });
        await check('hidden provider has no page and never resolves a thread', async () => {
            assert.strictEqual((await t.api('GET', '/catalog/providers/secret')).status, 404);
            assert.strictEqual(calls.filter((x) => x.method === 'resolve' && x.ref.id === hiddenProvider.id).length, 0);
        });
        await check('restoring provider reopens provider and plan threads; gone plan hides its thread', async () => {
            let r = await t.api('PATCH', `/api/v1/catalog/providers/${provider.id}`, { as: staff, json: { status: 'active' } });
            assert.strictEqual(r.status, 200, r.text);
            await t.ctx.catalog.discussionIdle();
            assert.strictEqual(threads.get(`host:provider:${provider.id}`).visibility, 'public');
            assert.strictEqual(threads.get(`host:plan:${plan.id}`).visibility, 'public');
            r = await t.api('PATCH', `/api/v1/catalog/plans/${plan.id}`, { as: staff, json: { status: 'gone' } });
            assert.strictEqual(r.status, 200, r.text);
            await t.ctx.catalog.discussionIdle();
            assert.strictEqual(threads.get(`host:plan:${plan.id}`).visibility, 'hidden');
            assert.strictEqual((await t.api('GET', `/catalog/plans/${plan.id}`)).status, 404);
        });
    } finally { await t.close(); }
    const off = await boot();
    try {
        const p = await (async () => { const r = await off.api('POST', '/api/v1/catalog/providers', { as: off.user('catalog-off-editor', { role: 'admin' }), json: { slug: 'off', name: 'Off', homepage_url: 'https://example.test' } }); return r.json().provider; })();
        await check('unset Community URL renders no Discussion and creates no thread', async () => {
            const r = await off.api('GET', '/catalog/providers/off');
            assert.strictEqual(r.status, 200);
            assert.doesNotMatch(r.text, /<h2[^>]*>Discussion/);
            assert.strictEqual(await off.ctx.store.discussion.get(`provider:${p.id}`), null);
        });
        await check('hidden provider returns 404 before any thread resolution', async () => {
            await off.ctx.catalog.save('providers', { status: 'hidden' }, p.id, 'test');
            assert.strictEqual((await off.api('GET', '/catalog/providers/off')).status, 404);
            assert.strictEqual(await off.ctx.store.discussion.get(`provider:${p.id}`), null);
        });
    } finally { await off.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
