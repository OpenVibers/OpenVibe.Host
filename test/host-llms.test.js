'use strict';
/**
 * /llms.txt and /llms-full.txt (openvibe-shared/seo, llmstxt.org) list Host's own public pages only:
 * text/plain, cached like the sitemap, never a customer site, a preview URL, /internal or the dashboard.
 * Host's own pages come through openvibe-shared/shell, so the public front page keeps its title,
 * canonical and robots and now carries the shell's markers (the runtime boot, the Open Graph head).
 */
const assert = require('assert');
const { boot, check, done, DASHBOARD } = require('./stageb/boot');

(async () => {
    const t = await boot();
    const alice = t.user('alice', { display_name: 'Alice' });
    const project = await t.project(alice, 'Widgets');
    const site = await t.site(alice, project.id, 'widgets');
    await t.deploy(alice, site.id, { 'index.html': '<h1>Widgets</h1>' }, { activate: true });
    const sitemap = await t.get(DASHBOARD, '/sitemap.xml');

    for (const file of ['/llms.txt', '/llms-full.txt']) {
        await check(`${file} is 200 text/plain, cached like the sitemap, and lists only Host's public pages`, async () => {
            const r = await t.get(DASHBOARD, file);
            assert.strictEqual(r.status, 200, r.text);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.strictEqual(r.headers['cache-control'], sitemap.headers['cache-control']);
            assert.match(r.text, /^# OpenVibe\.Host/);
            const urls = new Set([...r.text.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0]));
            for (const url of urls) assert.match(url, /^https:\/\/openvibe\.host\//, `${url} is not a Host page`);
            for (const page of ['/', '/updates', '/terms', '/privacy', '/dmca']) assert.ok(urls.has(`https://openvibe.host${page}`), `${page} missing`);
            for (const hidden of ['widgets', 'Widgets', 'alice', 'preview', '/internal', '/api/', '/projects', '/sites/', '/auth/']) {
                assert.ok(!r.text.includes(hidden), `${hidden} in ${file}`);
            }
        });
    }

    await check('/llms-full.txt carries a description of each public page and stays within 512 KiB', async () => {
        const r = await t.get(DASHBOARD, '/llms-full.txt');
        assert.match(r.text, /## Public pages/);
        assert.match(r.text, /immutable artifact/);
        assert.ok(Buffer.byteLength(r.text) <= 512 * 1024);
    });

    await check("the public front page goes through the shell: title, canonical, robots and the shell's markers", async () => {
        const r = await t.api('GET', '/');
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.text, /^<!doctype html>/i);
        assert.match(r.text, /<title>OpenVibe\.Host<\/title>/);
        assert.match(r.text, /<link rel="canonical" href="https:\/\/openvibe\.host\/">/);
        assert.match(r.text, /<meta name="robots" content="index, follow">/);
        assert.match(r.text, /<meta property="og:site_name" content="OpenVibe\.Host">/);
        assert.match(r.text, /<script src="\/shared\/web-runtime\.js\?v=[0-9a-f]+" defer><\/script>/);
        assert.match(r.text, /OVWebRuntime\.create\(/);
        assert.match(r.text, /<main id="main" class="page">/);
    });

    await check('the updates page keeps its suffixed title and canonical; a private page stays noindex without one', async () => {
        const u = await t.api('GET', '/updates');
        assert.match(u.text, /<title>What shipped on OpenVibe\.Host · OpenVibe\.Host<\/title>/);
        assert.match(u.text, /<link rel="canonical" href="https:\/\/openvibe\.host\/updates">/);
        const nf = await t.api('GET', '/no-such-page');
        assert.strictEqual(nf.status, 404);
        assert.match(nf.text, /<meta name="robots" content="noindex, nofollow">/);
        assert.ok(!/rel="canonical"/.test(nf.text));
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
