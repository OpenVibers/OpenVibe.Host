'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key the key file is served at /<key>.txt as text/plain on every host, and a tenant
 * site whose active deploy appears, changes or goes away pings the engines with the site's page and
 * its sitemap. A ready deploy that is not active (a draft) never pings; a sandbox site (noindex) never
 * pings.
 */
const assert = require('assert');
const { boot, check, done, DASHBOARD } = require('./stageb/boot');

const KEY = 'k'.repeat(32);

/** A spy in place of the module's HTTP send: records every pingSoon batch (the repo's test pattern). */
function makeSpy() {
    const pings = [];
    return {
        pings,
        module: {
            enabled: true,
            keyFile: (_req, _res, next) => next(),
            pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
            ping: async () => ({ sent: 0, status: 0 }),
            flush: async () => ({ sent: 0, status: 0 }),
        },
    };
}

(async () => {
    const off = await boot();
    await check('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.ctx.indexnow.enabled, false);
        const res = await off.get(DASHBOARD, `/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    });
    await off.close();

    const on = await boot({ env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers text/plain with the key (dashboard and tenant hosts)', async () => {
        assert.strictEqual(on.ctx.indexnow.enabled, true);
        const dash = await on.get(DASHBOARD, `/${KEY}.txt`);
        assert.strictEqual(dash.status, 200, dash.text);
        assert.match(dash.headers['content-type'], /text\/plain/);
        assert.strictEqual(dash.text, KEY);
        const tenant = await on.get('anything.openvibe.host', `/${KEY}.txt`);
        assert.strictEqual(tenant.status, 200, tenant.text);
        assert.strictEqual(tenant.text, KEY);
    });
    await on.close();

    const s = makeSpy();
    const t = await boot({ indexnow: s.module });
    const alice = t.user('alice', { display_name: 'Alice' });
    const project = await t.project(alice, 'Widgets');
    const site = await t.site(alice, project.id, 'widgets');
    const origin = 'https://widgets.openvibe.host';
    let deploy;

    await check('a ready deploy that is not active (a draft) never pings', async () => {
        const r = await t.upload(alice, site.id, { 'index.html': '<h1>Widgets</h1>' }, { activate: false });
        assert.strictEqual(r.status, 201, r.text);
        deploy = r.json().deploy;
        assert.deepStrictEqual(s.pings, []);
    });

    await check('activating the deploy pings the site page and the sitemap', async () => {
        const r = await t.api('POST', `/api/v1/deploys/${deploy.id}/activate`, { as: alice, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.json().changed, r.text);
        assert.ok(s.pings.includes(`${origin}/`), JSON.stringify(s.pings));
        assert.ok(s.pings.includes(`${origin}/sitemap.xml`), JSON.stringify(s.pings));
    });

    await check('a rollback pings the page and the sitemap again', async () => {
        const r2 = await t.upload(alice, site.id, { 'index.html': '<h1>Widgets v2</h1>' }, { activate: true });
        assert.strictEqual(r2.status, 201, r2.text);
        s.pings.length = 0;
        const rb = await t.api('POST', `/api/v1/sites/${site.id}/rollback`, { as: alice, json: {} });
        assert.strictEqual(rb.status, 200, rb.text);
        assert.strictEqual(rb.json().changed, true);
        assert.ok(s.pings.includes(`${origin}/`), JSON.stringify(s.pings));
        assert.ok(s.pings.includes(`${origin}/sitemap.xml`), JSON.stringify(s.pings));
    });

    await check('deleting the site pings the page and the sitemap again', async () => {
        s.pings.length = 0;
        const r = await t.api('DELETE', `/api/v1/sites/${site.id}`, { as: alice, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(s.pings.includes(`${origin}/`), JSON.stringify(s.pings));
        assert.ok(s.pings.includes(`${origin}/sitemap.xml`), JSON.stringify(s.pings));
    });

    await check('a sandbox site (noindex) never pings, even when it activates', async () => {
        const sandboxProject = await t.project(alice, 'Sandbox', { environment: 'sandbox' });
        const sandboxSite = await t.site(alice, sandboxProject.id, 'playground');
        s.pings.length = 0;
        const r = await t.upload(alice, sandboxSite.id, { 'index.html': '<h1>Play</h1>' }, { activate: true });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(s.pings, []);
    });
    await t.close();

    done();
})().catch((err) => { console.error(err); process.exit(1); });
