'use strict';
/**
 * Preview deploys (plan T12 J4, decision D5). Uploading a deploy with ?preview=1 stores it with
 * source 'preview' and makes it the site's live preview (host_sites.preview_deploy_id) WITHOUT
 * activating it: the public site keeps serving its active deploy. A preview is served only on the
 * dashboard host, at /preview/<deploy-id>/…, only to a member of the deploy's project, always
 * noindex and never cached by a shared cache; it is never pinged to IndexNow and never appears in
 * the site's sitemap. It stops being served when it expires, when the site deploys or rolls back,
 * or when the preview is deleted, and it can only reach its own project's objects.
 */
const assert = require('assert');
const { boot, check, done, DASHBOARD } = require('./stageb/boot');
const { PREVIEW_TTL_MS } = require('../server/domain/deploys');

/** A spy in place of IndexNow's HTTP send: records every pingSoon batch (the repo's test pattern). */
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
    const s = makeSpy();
    const t = await boot({ indexnow: s.module });
    const alice = t.user('alice');
    const bob = t.user('bob');
    const pa = await t.project(alice, 'A');
    const pb = await t.project(bob, 'B');
    const alpha = await t.site(alice, pa.id, 'alpha');
    const beta = await t.site(bob, pb.id, 'beta');
    await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA LIVE', 'about.html': 'ALPHA ABOUT' });
    await t.deploy(bob, beta.id, { 'index.html': 'BETA LIVE', 'secret.txt': 'BETA SECRET' });
    s.pings.length = 0;

    const preview = (id, p = '/') => `/preview/${id}${p}`;
    const asMember = (id, p, user) => t.get(DASHBOARD, preview(id, p), { session: user });
    let pv = null;

    await check('a preview is stored as source=preview, points the site at it, and never goes active', async () => {
        const r = await t.upload(alice, alpha.id, { 'index.html': 'ALPHA PREVIEW', 'about.html': 'PREVIEW ABOUT' }, { activate: false, query: 'preview=1' });
        assert.strictEqual(r.status, 201, r.text);
        const body = r.json();
        pv = body.deploy;
        assert.strictEqual(pv.source, 'preview');
        assert.strictEqual(body.activated, false, 'a preview is never activated');
        assert.ok(body.preview && body.preview.deploy_id === pv.id, r.text);
        assert.ok(body.preview.expires_at > t.clock.now());
        const pub = await t.get('alpha.openvibe.host', '/');
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.text, 'ALPHA LIVE', 'the public site keeps serving its active deploy');
        assert.ok(!s.pings.some((u) => u.includes('/preview/')), 'a preview is never pinged');
    });

    await check('a member views the preview on the dashboard: 200, noindex, no-store, no cookie', async () => {
        const r = await asMember(pv.id, '/', alice);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.text, 'ALPHA PREVIEW');
        assert.strictEqual(r.headers['x-robots-tag'], 'noindex, nofollow');
        assert.match(r.headers['cache-control'], /no-store/);
        assert.strictEqual(r.headers['set-cookie'], undefined);
        assert.strictEqual(r.headers['x-openvibe-deploy'], pv.id);
        // Tenant content on the dashboard's own origin is sandboxed into an opaque origin: it can
        // never act as openvibe.host (no allow-same-origin, never the dashboard's own CSP).
        assert.match(r.headers['content-security-policy'], /sandbox /);
        assert.ok(!r.headers['content-security-policy'].includes('allow-same-origin'), 'the preview must not keep the dashboard origin');
        assert.ok(r.headers['content-security-policy'].startsWith("default-src 'none'"), 'not the dashboard CSP');
        const file = await asMember(pv.id, '/about.html', alice);
        assert.strictEqual(file.status, 200);
        assert.strictEqual(file.text, 'PREVIEW ABOUT');
        const head = await t.get(DASHBOARD, preview(pv.id), { method: 'HEAD', session: alice });
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.text, '');
    });

    await check('non-members and signed-out callers cannot view a preview', async () => {
        assert.strictEqual((await asMember(pv.id, '/', bob)).status, 404, 'another project member must not see it');
        assert.strictEqual((await t.get(DASHBOARD, preview(pv.id))).status, 404, 'signed out must not see it');
        assert.strictEqual((await t.get(DASHBOARD, preview(pv.id), { as: bob })).status, 404, 'a bearer token is not a dashboard session');
        assert.strictEqual((await asMember('dpl_00000000000000000000000000', '/', alice)).status, 404);
        assert.strictEqual((await asMember('not-an-id', '/', alice)).status, 404);
    });

    await check('a preview is never served on a public tenant host', async () => {
        for (const host of ['alpha.openvibe.host', 'beta.openvibe.host']) {
            const r = await t.get(host, preview(pv.id));
            assert.strictEqual(r.status, 404, `${host} → ${r.status}`);
            assert.ok(!r.text.includes('ALPHA PREVIEW'), host);
        }
    });

    await check('isolation: another project\'s preview and another project\'s files are unreachable', async () => {
        const b = await t.upload(bob, beta.id, { 'index.html': 'BETA PREVIEW' }, { activate: false, query: 'preview=1' });
        assert.strictEqual(b.status, 201, b.text);
        const bpv = b.json().deploy;
        assert.strictEqual((await asMember(bpv.id, '/', alice)).status, 404, 'alice is not on beta');
        assert.strictEqual((await asMember(bpv.id, '/', bob)).status, 200);
        assert.strictEqual((await asMember(pv.id, '/secret.txt', alice)).status, 404, 'alpha cannot read beta\'s same-named file');
        for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/a%2fb', '/%00']) {
            assert.strictEqual((await asMember(pv.id, p, alice)).status, 404, p);
        }
    });

    await check('a rollback makes the live preview vanish', async () => {
        await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA LIVE 2' });
        const r = await t.upload(alice, alpha.id, { 'index.html': 'ALPHA PREVIEW 2' }, { activate: false, query: 'preview=1' });
        const p2 = r.json().deploy;
        assert.strictEqual((await asMember(p2.id, '/', alice)).status, 200);
        const rb = await t.api('POST', `/api/v1/sites/${alpha.id}/rollback`, { as: alice, json: {} });
        assert.strictEqual(rb.status, 200, rb.text);
        assert.strictEqual((await asMember(p2.id, '/', alice)).status, 404, 'a rollback supersedes the preview');
    });

    await check('an expired preview vanishes', async () => {
        const r = await t.upload(alice, alpha.id, { 'index.html': 'ALPHA PREVIEW 3' }, { activate: false, query: 'preview=1' });
        const p3 = r.json().deploy;
        assert.strictEqual((await asMember(p3.id, '/', alice)).status, 200);
        t.clock.advance(PREVIEW_TTL_MS + 1000);
        assert.strictEqual((await asMember(p3.id, '/', alice)).status, 404, 'an expired preview is not served');
    });

    await check('deleting the preview deploy makes it vanish', async () => {
        const r = await t.upload(alice, alpha.id, { 'index.html': 'ALPHA PREVIEW 4' }, { activate: false, query: 'preview=1' });
        const p4 = r.json().deploy;
        assert.strictEqual((await asMember(p4.id, '/', alice)).status, 200);
        const del = await t.api('DELETE', `/api/v1/deploys/${p4.id}`, { as: alice, json: {} });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual((await asMember(p4.id, '/', alice)).status, 404, 'a deleted preview is not served');
    });

    await check('a preview is never listed in the sitemap and never pinged', async () => {
        const r = await t.upload(alice, alpha.id, { 'index.html': 'ALPHA PREVIEW 5', 'page.html': 'PAGE' }, { activate: false, query: 'preview=1' });
        const p5 = r.json().deploy;
        assert.strictEqual((await asMember(p5.id, '/page.html', alice)).status, 200);
        s.pings.length = 0;
        const sm = await t.get('alpha.openvibe.host', '/sitemap.xml');
        assert.strictEqual(sm.status, 200, sm.text);
        assert.ok(!sm.text.includes('/preview/'), 'the sitemap never lists a preview URL');
        assert.ok(!sm.text.includes(p5.id), 'the sitemap never names a preview deploy');
        assert.ok(!sm.text.includes('ALPHA PREVIEW'), 'the sitemap cannot leak draft content');
        assert.deepStrictEqual(s.pings, [], 'viewing a preview pings nothing');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
