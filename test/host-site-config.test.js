'use strict';
/**
 * Per-site configuration (plan T12 J3, decision D4): response headers, local-only redirects and the
 * SPA fallback, stored per site (host_site_config) and applied by http/tenant.js BEFORE the
 * platform's headers. The platform's security, routing and caching headers can never be set through
 * it (on write or from a smuggled row); a redirect target is always a local path; and a config is
 * private to its site and project.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');

const EMPTY = { headers: {}, redirects: [], spa: false };

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const bob = t.user('bob');
    const staff = t.user('root', { role: 'admin' });
    const pa = await t.project(alice, 'A');
    const pb = await t.project(bob, 'B');
    const alpha = await t.site(alice, pa.id, 'alpha');
    const beta = await t.site(bob, pb.id, 'beta');
    await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA HOME', 'about.html': 'ALPHA ABOUT', 'app.3f2a9c1b.js': 'js();', '404.html': 'ALPHA NOT FOUND' });
    await t.deploy(bob, beta.id, { 'index.html': 'BETA HOME' });

    const put = (as, id, json) => t.api('PUT', `/api/v1/sites/${id}/config`, { as, json });

    await check('defaults: no row means no headers, no redirects, no SPA', async () => {
        const r = await t.api('GET', `/api/v1/sites/${alpha.id}/config`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json().config, EMPTY);
        assert.strictEqual((await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM host_site_config').get()).n, 0);
    });

    await check('the API sets, reads and resets a config', async () => {
        const set = await put(alice, alpha.id, {
            headers: { 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Language': 'en' },
            redirects: [{ from: '/old', to: '/new', status: 308 }, { from: '/moved', to: '/about.html' }],
            spa: true,
        });
        assert.strictEqual(set.status, 200, set.text);
        assert.deepStrictEqual(set.json().config.headers, { 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Language': 'en' });
        assert.deepStrictEqual(set.json().config.redirects, [{ from: '/old', to: '/new', status: 308 }, { from: '/moved', to: '/about.html', status: 301 }]);
        assert.strictEqual(set.json().config.spa, true);
        assert.deepStrictEqual((await t.api('GET', `/api/v1/sites/${alpha.id}/config`, { as: alice })).json().config, set.json().config);
        const del = await t.api('DELETE', `/api/v1/sites/${alpha.id}/config`, { as: alice });
        assert.strictEqual(del.status, 200, del.text);
        assert.deepStrictEqual(del.json().config, EMPTY);
        assert.strictEqual((await t.get('alpha.openvibe.host', '/old')).status, 404, 'reset drops the redirect');
    });

    await check('configured headers ride on 200, the 404 and the 451 after a takedown', async () => {
        assert.strictEqual((await put(alice, alpha.id, { headers: { 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Language': 'en' } })).status, 200);
        const ok = await t.get('alpha.openvibe.host', '/');
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.headers['x-frame-options'], 'SAMEORIGIN');
        assert.strictEqual(ok.headers['x-content-language'], 'en');
        assert.strictEqual(ok.headers['x-served-by'], 'OpenVibe.Host');
        const nf = await t.get('alpha.openvibe.host', '/nope.html');
        assert.strictEqual(nf.status, 404);
        assert.strictEqual(nf.text, 'ALPHA NOT FOUND');
        assert.strictEqual(nf.headers['x-frame-options'], 'SAMEORIGIN');
        const tk = await t.api('POST', `/api/v1/sites/${alpha.id}/takedown`, { as: staff, json: { reason: 'config test' } });
        assert.strictEqual(tk.status, 201, tk.text);
        const down = await t.get('alpha.openvibe.host', '/');
        assert.strictEqual(down.status, 451);
        assert.strictEqual(down.headers['x-frame-options'], 'SAMEORIGIN');
        assert.strictEqual(down.headers['clear-site-data'], '"cache", "storage"');
        assert.strictEqual((await t.api('DELETE', `/api/v1/sites/${alpha.id}/takedown`, { as: staff })).status, 200);
        assert.strictEqual((await t.get('alpha.openvibe.host', '/')).status, 200);
    });

    await check('reserved headers and header injection are refused on write', async () => {
        for (const name of ['Content-Security-Policy', 'Strict-Transport-Security', 'Set-Cookie', 'X-Forwarded-For', 'X-Forwarded-Proto', 'Cache-Control', 'Content-Type', 'X-Content-Type-Options', 'Location', 'Service-Worker-Allowed', 'Alt-Svc']) {
            const r = await put(alice, alpha.id, { headers: { [name]: 'x' } });
            assert.strictEqual(r.status, 422, `${name} → ${r.status} ${r.text}`);
            assert.strictEqual(r.json().code, 'site_config.reserved_header', name);
        }
        const inj = await put(alice, alpha.id, { headers: { 'X-Ok': 'a\r\nSet-Cookie: sid=1' } });
        assert.strictEqual(inj.status, 422);
        assert.strictEqual(inj.json().code, 'site_config.header_value');
        assert.strictEqual((await t.get('alpha.openvibe.host', '/')).headers['set-cookie'], undefined);
    });

    await check('a reserved header smuggled into the row is never served (platform headers win)', async () => {
        await t.ctx.store.db.prepare(`INSERT INTO host_site_config (site_id, headers, redirects, spa, updated_by, updated_at)
                                      VALUES (?, ?::jsonb, ?::jsonb, false, ?, ?)
                                      ON CONFLICT (site_id) DO UPDATE SET headers = EXCLUDED.headers`)
            .run(alpha.id, JSON.stringify({
                'Content-Security-Policy': 'default-src *', 'Strict-Transport-Security': 'max-age=0',
                'Set-Cookie': 'sid=1', 'X-Forwarded-For': '1.2.3.4', 'X-Custom': 'kept',
            }), JSON.stringify([]), 'test', t.clock.now());
        const r = await t.get('alpha.openvibe.host', '/');
        assert.match(r.headers['content-security-policy'], /default-src 'self'/);
        assert.ok(!/default-src \*/.test(r.headers['content-security-policy']), 'the tenant CSP cannot be replaced');
        assert.strictEqual(r.headers['strict-transport-security'], undefined);
        assert.strictEqual(r.headers['set-cookie'], undefined);
        assert.strictEqual(r.headers['x-forwarded-for'], undefined);
        assert.strictEqual(r.headers['x-custom'], 'kept', 'a non-reserved header in the same row still applies');
    });

    await check('no open redirect: a foreign target is refused on write; a local one is kept', async () => {
        for (const to of ['//evil.com', '/\\evil.com', 'https://evil.com', 'http:evil.com', '/\t/evil.com', '/%09/evil.com', '///evil.com', '/%2f%2fevil.com', '/\n/evil.com', 'javascript:alert(1)', ' //evil.com', '\\evil.com']) {
            const r = await put(alice, alpha.id, { redirects: [{ from: '/go', to }] });
            assert.strictEqual(r.status, 422, `${JSON.stringify(to)} → ${r.status} ${r.text}`);
            assert.strictEqual(r.json().code, 'site_config.redirect');
        }
        assert.strictEqual((await put(alice, alpha.id, { redirects: [{ from: 'https://evil.com/x', to: '/x' }] })).status, 422, 'a foreign "from" is refused too');
        assert.strictEqual((await put(alice, alpha.id, { redirects: [{ from: '/go', to: '/new', status: 200 }] })).status, 422, 'only 301/302/307/308');
        assert.strictEqual((await put(alice, alpha.id, { redirects: [{ from: '/old', to: '/about.html', status: 308 }] })).status, 200);
        const r = await t.get('alpha.openvibe.host', '/old');
        assert.strictEqual(r.status, 308);
        assert.strictEqual(r.headers.location, '/about.html');
    });

    await check('SPA fallback: extensionless paths serve index.html; an extension is still a 404', async () => {
        assert.strictEqual((await put(alice, alpha.id, { spa: true })).status, 200, 'spa only');
        for (const p of ['/app', '/app/dashboard', '/settings/']) {
            const r = await t.get('alpha.openvibe.host', p);
            assert.strictEqual(r.status, 200, `${p} → ${r.status}`);
            assert.strictEqual(r.text, 'ALPHA HOME');
            assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
        }
        assert.strictEqual((await t.get('alpha.openvibe.host', '/about.html')).text, 'ALPHA ABOUT', 'a real file wins');
        for (const p of ['/missing.js', '/app/missing.css', '/nope.json']) assert.strictEqual((await t.get('alpha.openvibe.host', p)).status, 404, p);
        assert.strictEqual((await put(alice, alpha.id, { spa: false })).status, 200);
        assert.strictEqual((await t.get('alpha.openvibe.host', '/app/dashboard')).status, 404, 'SPA off restores the 404');
    });

    await check('a config is private to its site and project (404 to non-members; no leak to another site)', async () => {
        assert.strictEqual((await put(alice, alpha.id, { headers: { 'X-Alpha-Secret': 'alpha-only' } })).status, 200);
        for (const [method, json] of [['GET', undefined], ['PUT', { headers: { 'X-Evil': '1' } }], ['DELETE', undefined]]) {
            const r = await t.api(method, `/api/v1/sites/${alpha.id}/config`, { as: bob, json });
            assert.strictEqual(r.status, 404, `${method} → ${r.status} ${r.text}`);
        }
        const b = await t.get('beta.openvibe.host', '/');
        assert.strictEqual(b.text, 'BETA HOME');
        assert.strictEqual(b.headers['x-alpha-secret'], undefined);
        // A service token needs host.site.config AND the acting principal's project role.
        const noCap = t.network.serviceToken('codes', ['host.site.manage']);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${alpha.id}/config`, { as: noCap, headers: { 'x-ov-subject': alice.subject } })).status, 403);
        const stranger = t.network.serviceToken('codes', ['host.site.config']);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${alpha.id}/config`, { as: stranger, headers: { 'x-ov-subject': bob.subject } })).status, 404, 'a non-member service learns nothing');
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${alpha.id}/config`, { as: stranger, headers: { 'x-ov-subject': alice.subject } })).status, 200);
    });

    await t.close();
    done();
})();
