'use strict';
/**
 * "Deployment secrets never appear in public project state" (Wave 21 exit criterion), and the
 * server-rendered dashboard: shared chrome, forms without JavaScript, CSRF that holds even though
 * tenant sites are same-site, planted cookies ignored, readiness/release/metrics.
 */
const assert = require('assert');
const { boot, check, done, SECRET } = require('./stageb/boot');
const { tarball } = require('./stageb/tar');
const { csrfToken } = require('../server/auth/forms');

const ORIGIN = 'https://openvibe.host';

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const staff = t.user('ops', { role: 'admin' });
    const bodies = [];
    const keep = (r) => { bodies.push(r.text); return r; };

    await check('no project, site, deploy, domain, quota or log response carries a secret or environment value', async () => {
        const p = keep(await t.api('POST', '/api/v1/projects', { as: alice, json: { name: 'Secrets' } })).json().project;
        const s = keep(await t.api('POST', `/api/v1/projects/${p.id}/sites`, { as: alice, json: { name: 'secret-test' } })).json().site;
        const d = keep(await t.upload(alice, s.id, { 'index.html': 'hi', 'app.9f8e7d6c.js': 'x' })).json().deploy;
        const bad = keep(await t.api('POST', `/api/v1/sites/${s.id}/deploys`, { as: alice, body: tarball([{ name: 'index.html', content: 'x' }, { name: '.env', content: 'STRIPE_SECRET_KEY=sk_live_TOPSECRET123\nDATABASE_URL=postgres://u:p@h/db' }]), headers: { 'content-type': 'application/gzip' } }));
        assert.strictEqual(bad.status, 422);
        keep(await t.api('POST', `/api/v1/sites/${s.id}/domains`, { as: alice, json: { hostname: 'www.secret-example.org' } }));
        for (const pth of [`/api/v1/projects`, `/api/v1/projects/${p.id}`, `/api/v1/projects/${p.id}/quota`, `/api/v1/sites/${s.id}`, `/api/v1/sites/${s.id}/deploys`,
            `/api/v1/deploys/${d.id}`, `/api/v1/deploys/${d.id}/log`, `/api/v1/deploys/${bad.json().deploy_id}/log`, `/api/v1/sites/${s.id}/domains`]) {
            keep(await t.api('GET', pth, { as: alice }));
        }
        keep(await t.api('GET', `/api/v1/projects/${p.id}`, { as: staff }));
        for (const pth of ['/api/ready', '/release.json', '/api/health']) keep(await t.api('GET', pth));
        keep(await t.api('GET', '/', { session: alice }));
        keep(await t.api('GET', `/projects/${p.id}`, { session: alice }));
        keep(await t.api('GET', `/sites/${s.id}`, { session: alice }));
        keep(await t.api('GET', `/deploys/${d.id}`, { session: alice }));
        keep(await t.api('GET', `/deploys/${bad.json().deploy_id}`, { session: alice }));
        const all = bodies.join('\n');
        for (const needle of [SECRET, 'test-form-secret', 'sk_live_TOPSECRET123', 'postgres://', 'client_secret', 'OV_OAUTH_CLIENT_SECRET', 'HOST_FORM_SECRET', 'BEGIN PRIVATE', 'privkey', 'password']) {
            assert.ok(!all.includes(needle), `a response contains ${needle}`);
        }
        const deployKeys = Object.keys(d).sort();
        assert.deepStrictEqual(deployKeys, ['active', 'created_at', 'created_by', 'failure_code', 'file_count', 'id', 'log', 'manifest_sha256', 'new_bytes', 'project_id', 'site_id', 'source', 'state', 'total_bytes'].sort());
        const events = JSON.stringify(t.events());
        assert.ok(!events.includes('sk_live') && !events.includes(SECRET));
    });

    await check('the signed-out home page is server-rendered with the shared chrome and useful without JavaScript', async () => {
        const r = await t.api('GET', '/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<script src="\/shared\/navbar\.js\?v=[0-9a-f]{12}" defer>/);
        assert.match(r.text, /<noscript><nav aria-label="Site"/);
        assert.match(r.text, /id="ov-footer"/);
        assert.match(r.text, /Sign in with OpenVibe/);
        assert.match(r.text, /Stage C\) are not available/);
        assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
        // Release notifications: release-watch's EventSource on the Events realtime stream (openvibe-shared 1.17).
        assert.match(r.headers['content-security-policy'], /connect-src 'self' https:\/\/openvibe\.network https:\/\/events\.openvibe\.network;/);
        assert.strictEqual(r.headers['x-frame-options'], 'DENY');
        assert.strictEqual(r.headers['cache-control'], 'private, no-store');
        // The public front page is indexable, with a canonical URL; nothing behind sign-in is.
        assert.match(r.text, /<meta name="robots" content="index, follow">/);
        assert.match(r.text, /<link rel="canonical" href="https:\/\/openvibe\.host\/">/);
        const signedIn = await t.api('GET', '/', { session: alice });
        assert.match(signedIn.text, /<meta name="robots" content="noindex, nofollow">/);
        assert.ok(!/rel="canonical"/.test(signedIn.text));
        const withQuery = await t.api('GET', '/?notice=hi');
        assert.match(withQuery.text, /<meta name="robots" content="noindex, nofollow">/);
    });

    await check('robots.txt and sitemap.xml: the front page and the legal pages only; tenant sites keep their own', async () => {
        const robots = await t.api('GET', '/robots.txt');
        assert.strictEqual(robots.status, 200);
        assert.strictEqual(robots.text, 'User-agent: *\nAllow: /$\nAllow: /terms$\nAllow: /privacy$\nAllow: /dmca$\nDisallow: /\n\nSitemap: https://openvibe.host/sitemap.xml\n');
        const map = await t.api('GET', '/sitemap.xml');
        assert.strictEqual(map.status, 200);
        assert.match(map.headers['content-type'], /application\/xml/);
        const locs = [...map.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        assert.deepStrictEqual(locs, ['https://openvibe.host/', 'https://openvibe.host/terms', 'https://openvibe.host/privacy', 'https://openvibe.host/dmca']);
        for (const p of ['/terms', '/privacy', '/dmca']) assert.strictEqual((await t.api('GET', p)).status, 200, p);
    });

    await check('a planted ov_token cookie (e.g. set by a tenant subdomain) is not a session', async () => {
        const r = await t.api('GET', '/', { headers: { cookie: `ov_token=${t.network.userToken(alice)}` } });
        assert.match(r.text, /Sign in with OpenVibe/);
        const me = await t.api('GET', '/auth/me', { headers: { cookie: `ov_token=${t.network.userToken(alice)}` } });
        assert.strictEqual(me.status, 401);
    });

    let projectId, siteId;
    await check('forms: create a project and a site (Origin + form token), then upload a folder and see the log', async () => {
        const csrf = csrfToken({ formSecret: 'test-form-secret' }, { subject: alice.subject });
        const p = await t.api('POST', '/projects', { session: alice, form: { csrf, name: 'Dash project', environment: 'production' }, headers: { origin: ORIGIN } });
        assert.strictEqual(p.status, 303, p.text);
        projectId = p.headers.location.match(/\/projects\/(prj_[0-9A-Z]+)/)[1];
        const page = await t.api('GET', `/projects/${projectId}`, { session: alice });
        assert.match(page.text, /Dash project/);
        assert.match(page.text, /Deploys in the last 24 h/);
        const s = await t.api('POST', `/projects/${projectId}/sites`, { session: alice, form: { csrf, name: 'dash-site' }, headers: { origin: ORIGIN } });
        assert.strictEqual(s.status, 303, s.text);
        siteId = s.headers.location.match(/\/sites\/(site_[0-9A-Z]+)/)[1];
        const boundary = 'dashBOUNDARY';
        const part = (name, filename, content) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n\r\n${content}\r\n`;
        const body = part('csrf', null, csrf) + part('strip', null, 'folder') + part('activate', null, '1') + part('files', 'site/index.html', 'DASH OK') + `--${boundary}--\r\n`;
        const up = await t.api('POST', `/sites/${siteId}/deploys`, { session: alice, body, headers: { origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` } });
        assert.strictEqual(up.status, 303, up.text);
        assert.match(up.headers.location, /^\/deploys\/dpl_/);
        const log = await t.api('GET', up.headers.location.split('?')[0], { session: alice });
        assert.match(log.text, /Upload log/);
        assert.match(log.text, /nothing was executed/);
        assert.strictEqual((await t.get('dash-site.openvibe.host', '/')).text, 'DASH OK');
        const sitePage = await t.api('GET', `/sites/${siteId}`, { session: alice });
        assert.match(sitePage.text, /Upload a deploy/);
        assert.match(sitePage.text, /webkitdirectory/);
        const bad = await t.api('POST', `/sites/${siteId}/deploys`, { session: alice, body: part('csrf', null, csrf) + part('files', 'x.php', '<?php') + `--${boundary}--\r\n`, headers: { origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` } });
        assert.strictEqual(bad.status, 303);
        assert.match(decodeURIComponent(bad.headers.location), /Upload refused/);
    });

    await check('forms: domain instructions, rollback, and refusal of cross-origin posts even with a valid token', async () => {
        const csrf = csrfToken({ formSecret: 'test-form-secret' }, { subject: alice.subject });
        const d = await t.api('POST', `/sites/${siteId}/domains`, { session: alice, form: { csrf, hostname: 'www.dash-example.org' }, headers: { origin: ORIGIN } });
        assert.strictEqual(d.status, 303, d.text);
        const page = await t.api('GET', `/sites/${siteId}`, { session: alice });
        assert.match(page.text, /_openvibe-host\.www\.dash-example\.org/);
        assert.match(page.text, /openvibe-host-verification=[0-9a-f]{40}/);
        assert.match(page.text, /pending: not served/);
        const tenant = await t.api('POST', `/sites/${siteId}/domains`, { session: alice, form: { csrf, hostname: 'evil.example.org' }, headers: { origin: 'https://attacker.openvibe.host' } });
        assert.strictEqual(tenant.status, 403, 'a tenant page on the same site cannot drive the dashboard');
        const noToken = await t.api('POST', `/sites/${siteId}/domains`, { session: alice, form: { hostname: 'evil.example.org' }, headers: { origin: ORIGIN } });
        assert.strictEqual(noToken.status, 403);
        const noOrigin = await t.api('POST', `/sites/${siteId}/domains`, { session: alice, form: { csrf, hostname: 'evil.example.org' } });
        assert.strictEqual(noOrigin.status, 403);
        const anon = await t.api('POST', '/projects', { form: { name: 'x' }, headers: { origin: ORIGIN } });
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.location, /^\/auth\/login/);
    });

    await check('machine endpoints: /api/ready is truthful, /release.json, /metrics only for direct loopback', async () => {
        const ready = await t.api('GET', '/api/ready');
        assert.strictEqual(ready.status, 200, ready.text);
        const body = ready.json();
        assert.strictEqual(body.ready, true);
        const names = body.checks.map ? body.checks.map((c) => c.name) : Object.keys(body.checks);
        for (const n of ['db', 'storage', 'network_jwks', 'events_relay', 'domain_checks']) assert.ok(names.includes(n), n);
        assert.match(ready.text, /relay off/);
        const rel = await t.api('GET', '/release.json');
        assert.strictEqual(rel.json().service, 'host');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        const m = await t.api('GET', '/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total\{method="GET",route="tenant_site"/);
        assert.match(m.text, /host_sites \d+/);
        const proxied = await t.api('GET', '/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.strictEqual(proxied.status, 404);
        const unknown = await t.get('nothing.example.net', '/');
        assert.strictEqual(unknown.status, 404);
        assert.match(unknown.text, /Unknown host/);
    });

    await t.close();
    done();
})();
