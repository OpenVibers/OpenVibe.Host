'use strict';
/**
 * Tenant sitemap.xml and robots.txt when the deploy ships none: the generated sitemap lists the
 * manifest's HTML pages (index → the directory URL, the error page left out) on the host the request
 * came in on, so a verified custom domain gets its own copy under its own name; robots welcomes
 * crawlers to a production site and keeps a sandbox out (Disallow: /). A file the tenant uploaded at
 * either path always wins. Neither generated body carries a secret, and both say how to cache them.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');

const HOST = 'widgets.openvibe.host';
const CUSTOM = 'www.widgets-example.org';

(async () => {
    const t = await boot();
    const alice = t.user('alice', { display_name: 'Alice' });
    const project = await t.project(alice, 'Widgets');
    const site = await t.site(alice, project.id, 'widgets');
    const origin = `https://${HOST}`;

    await t.deploy(alice, site.id, {
        'index.html': '<h1>Home</h1>',
        'about.html': '<h1>About</h1>',
        'docs/index.html': '<h1>Docs</h1>',
        '404.html': '<h1>Gone</h1>',
        'style.css': 'body{}',
        'notes.txt': 'hi',
    }, { activate: true });

    await check('a generated sitemap lists the manifest HTML paths on this host (index → /, 404 left out)', async () => {
        const r = await t.get(HOST, '/sitemap.xml');
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.headers['content-type'], /application\/xml/);
        const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        assert.deepStrictEqual([...new Set(locs)].sort(), [`${origin}/`, `${origin}/about.html`, `${origin}/docs/`].sort());
    });

    await check('a generated robots.txt welcomes crawlers and names the sitemap', async () => {
        const r = await t.get(HOST, '/robots.txt');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers['content-type'], /text\/plain/);
        assert.match(r.text, /^User-agent: \*\nAllow: \/\n/);
        assert.ok(r.text.includes(`Sitemap: ${origin}/sitemap.xml`), r.text);
    });

    await check('a verified custom domain serves its own generated sitemap under its own name', async () => {
        const add = await t.api('POST', `/api/v1/sites/${site.id}/domains`, { as: alice, json: { hostname: CUSTOM } });
        assert.strictEqual(add.status, 201, add.text);
        const dom = add.json().domain;
        t.dns.set(`_openvibe-host.${CUSTOM}`, [dom.instructions.verification.value]);
        const v = await t.api('POST', `/api/v1/domains/${dom.id}/verify`, { as: alice });
        assert.strictEqual(v.json().domain.status, 'verified', v.text);
        const r = await t.get(CUSTOM, '/sitemap.xml');
        assert.strictEqual(r.status, 200, r.text);
        const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        assert.deepStrictEqual([...new Set(locs)].sort(), [`https://${CUSTOM}/`, `https://${CUSTOM}/about.html`, `https://${CUSTOM}/docs/`].sort());
        const rb = await t.get(CUSTOM, '/robots.txt');
        assert.ok(rb.text.includes(`Sitemap: https://${CUSTOM}/sitemap.xml`), rb.text);
    });

    await check("the tenant's own sitemap.xml and robots.txt win", async () => {
        await t.deploy(alice, site.id, {
            'index.html': '<h1>Home</h1>',
            'sitemap.xml': '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://example.com/own</loc></url></urlset>',
            'robots.txt': 'User-agent: *\nDisallow: /private\n',
        }, { activate: true });
        const sm = await t.get(HOST, '/sitemap.xml');
        assert.strictEqual(sm.status, 200);
        assert.match(sm.headers['content-type'], /application\/xml/);
        assert.ok(sm.text.includes('https://example.com/own'), sm.text);
        assert.ok(!sm.text.includes('/about.html'), sm.text);
        const rb = await t.get(HOST, '/robots.txt');
        assert.strictEqual(rb.text, 'User-agent: *\nDisallow: /private\n');
        assert.match(rb.headers['content-type'], /text\/plain/);
    });

    await check('a sandbox site generates Disallow: / (and stays noindex)', async () => {
        const sandbox = await t.project(alice, 'Sandbox', { environment: 'sandbox' });
        const sb = await t.site(alice, sandbox.id, 'playground');
        await t.deploy(alice, sb.id, { 'index.html': '<h1>Play</h1>' }, { activate: true });
        const r = await t.get(`${sb.name}.openvibe.host`, '/robots.txt');
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.text, /^User-agent: \*\nDisallow: \/\n*$/);
        assert.ok(!r.text.includes('Sitemap'), r.text);
        assert.strictEqual(r.headers['x-robots-tag'], 'noindex, nofollow');
    });

    await check('generated files are cacheable, answer HEAD, and never carry a secret', async () => {
        await t.deploy(alice, site.id, { 'index.html': '<h1>Home</h1>', 'about.html': '<h1>About</h1>' }, { activate: true });
        const sm = await t.get(HOST, '/sitemap.xml');
        const rb = await t.get(HOST, '/robots.txt');
        assert.match(sm.headers['cache-control'], /max-age=/);
        assert.match(rb.headers['cache-control'], /max-age=/);
        const head = await t.get(HOST, '/sitemap.xml', { method: 'HEAD' });
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.text, '');
        for (const r of [sm, rb]) {
            for (const secretish of [t.SECRET, '_openvibe-host', 'openvibe-host-verification', 'prj_', 'site_', 'dpl_', 'dom_']) {
                assert.ok(!r.text.includes(secretish), `${secretish} in ${r.text}`);
            }
            assert.strictEqual(r.headers['set-cookie'], undefined);
            assert.match(r.headers['content-security-policy'], /default-src 'self'/);
        }
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
