'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { renderPage } = require('../server/render/layout');
const catalogRender = require('../server/render/catalog');

(async () => {
    const t = await boot();
    try {
        await check('old pages answer 410 with the Space link', async () => {
            for (const path of ['/hosting', '/projects', '/sites/site_123', '/deploys/dpl_123', '/preview/dpl_123']) {
                const r = await t.api('GET', path);
                assert.strictEqual(r.status, 410, path);
                assert.match(r.text, /https:\/\/openvibe\.space/);
                assert.match(r.text, /Static hosting moved/);
            }
            const tenant = await t.get('old.openvibe.host', '/index.html');
            assert.strictEqual(tenant.status, 410);
            assert.match(tenant.text, /https:\/\/openvibe\.space/);
        });
        await check('old APIs answer 410 problem JSON', async () => {
            for (const path of ['/api/v1/projects', '/api/v1/sites/site_123/deploys', '/api/v1/domains/dom_123/verify', '/api/v1/resources']) {
                const r = await t.api('POST', path);
                assert.strictEqual(r.status, 410, path);
                assert.strictEqual(r.json().code, 'host.moved_to_space');
                assert.strictEqual(r.json().url, 'https://openvibe.space');
            }
        });
        await check('navigation has no static hosting entry', async () => {
            const html = renderPage({ title: 'Catalog', body: '<p>Catalog</p>', config: t.config, path: '/' });
            assert.doesNotMatch(html, /Static hosting/);
            assert.match(html, /Compare/);
        });
        await check('front page has one Space link', async () => {
            const body = catalogRender.front({ plans: [], providers: [], promos: [], stats: { lastChecked: null } });
            assert.match(body, /Want to host a site with OpenVibe/);
            assert.strictEqual((body.match(/https:\/\/openvibe\.space/g) || []).length, 1);
            const r = await t.api('GET', '/');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /https:\/\/openvibe\.space/);
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
