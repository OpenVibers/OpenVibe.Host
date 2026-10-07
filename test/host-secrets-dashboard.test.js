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
const { cookieNames } = require('../server/auth/sso');

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
        const events = JSON.stringify(await t.events());
        assert.ok(!events.includes('sk_live') && !events.includes(SECRET));
    });

    await check('the signed-out home page is server-rendered with the shared chrome and useful without JavaScript', async () => {
        const r = await t.api('GET', '/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<script src="\/shared\/navbar\.js\?v=[0-9a-f]{12}" defer>/);
        assert.match(r.text, /<noscript><nav aria-label="Site"/);
        assert.match(r.text, /id="ov-footer"/);
        assert.match(r.text, /Sign in with OpenVibe/);
        assert.match(r.text, /nothing you upload is ever executed/);
        // The limits table is the one /limits.json serves (limitsOf(config)), never a second copy.
        assert.match(r.text, /id="limits"/);
        assert.match(r.text, /Files in one deploy/);
        assert.match(r.text, /href="\/shared\/showcase\.css\?v=[0-9a-f]{12}"/);
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

    await check('the dashboard session is Host\'s own cookie; a forged ov_token is not a session', async () => {
        // openvibe-sdk/sso keeps its session in ov_token (the shared navbar reads it); Host trusts only its own cookie.
        const forged = 'not.a.jwt';
        const r = await t.api('GET', '/', { headers: { cookie: `ov_token=${forged}` } });
        assert.match(r.text, /Sign in with OpenVibe/);
        const me = await t.api('GET', '/auth/me', { headers: { cookie: `ov_token=${forged}` } });
        assert.strictEqual(me.status, 401);
        // /api/v1 never reads a cookie: only a Bearer token authenticates.
        const api = await t.api('GET', '/api/v1/projects', { headers: { cookie: `ov_token=${t.network.userToken(alice)}` } });
        assert.strictEqual(api.status, 401);
    });

    const SESSION = cookieNames(t.config).session;   // ov_host_session here (COOKIE_SECURE=false); __Host- in production
    const mallory = t.user('mallory');
    const malloryProjects = async () => (await t.api('GET', '/api/v1/projects', { as: mallory })).json().projects.length;
    const setCookies = (r) => [].concat(r.headers['set-cookie'] || []);
    const cookieValue = (r, name) => { const c = setCookies(r).find((x) => x.startsWith(`${name}=`)); return c === undefined ? undefined : decodeURIComponent(c.slice(name.length + 1).split(';')[0]); };

    await check('cookie tossing: a planted, validly signed ov_token of another user is not a session, alone or next to a real one', async () => {
        // A tenant page on <site>.openvibe.host can set ov_token=<its owner's token>; Domain=openvibe.host; Path=/<longer path>:
        // the browser sends it first. It verifies, and it is still ignored.
        const planted = `ov_token=${t.network.userToken(mallory)}`;
        const alone = await t.api('GET', '/', { headers: { cookie: planted } });
        assert.match(alone.text, /Sign in with OpenVibe/);
        assert.strictEqual((await t.api('GET', '/auth/me', { headers: { cookie: planted } })).status, 401);
        const csrf = csrfToken({ formSecret: 'test-form-secret' }, { subject: mallory.subject });
        const post = await t.api('POST', '/projects', { form: { csrf, name: 'Tossed', environment: 'production' }, headers: { cookie: planted, origin: ORIGIN } });
        assert.ok(!/\/projects\/prj_/.test(post.headers.location || ''), post.text);
        assert.strictEqual(await malloryProjects(), 0);

        const both = await t.api('GET', '/', { session: alice, headers: { cookie: planted } });
        assert.match(both.text, /Your projects/);
        assert.ok(!/mallory/.test(both.text), 'the page is alice\'s, not mallory\'s');
        const me = await t.api('GET', '/auth/me', { session: alice, headers: { cookie: planted } });
        assert.strictEqual(me.json().user.subject_id, alice.subject);
        const csrfA = csrfToken({ formSecret: 'test-form-secret' }, { subject: alice.subject });
        const asAlice = await t.api('POST', '/projects', { session: alice, form: { csrf: csrfA, name: 'Tossed but mine', environment: 'production' }, headers: { cookie: planted, origin: ORIGIN } });
        assert.strictEqual(asAlice.status, 303, asAlice.text);
        assert.strictEqual(await malloryProjects(), 0, 'nothing lands in mallory\'s account');
        const mine = (await t.api('GET', '/api/v1/projects', { as: alice })).json().projects;
        assert.ok(mine.some((p) => p.name === 'Tossed but mine'));
        for (const p of mine.filter((x) => x.name === 'Tossed but mine')) await t.api('DELETE', `/api/v1/projects/${p.id}`, { as: alice });
    });

    await check('sign-in issues the HttpOnly session cookie; a planted OAuth state cannot finish another account\'s sign-in', async () => {
        const login = await t.api('GET', '/auth/login');
        assert.strictEqual(login.status, 302);
        const state = new URL(login.headers.location).searchParams.get('state');
        assert.strictEqual(cookieValue(login, 'ov_host_flow'), state);
        const flow = `ov_host_flow=${state}; ov_oauth_state=${state}; ov_oauth_verifier=${cookieValue(login, 'ov_oauth_verifier')}`;
        const cb = await t.api('GET', `/auth/callback?code=${t.network.issueCode(alice)}&state=${state}`, { headers: { cookie: flow } });
        assert.strictEqual(cb.status, 302, cb.text);
        const set = setCookies(cb).find((c) => c.startsWith(`${SESSION}=`));
        assert.match(set, /; Path=\/;/);
        assert.match(set, /; HttpOnly/);
        assert.match(set, /; SameSite=Lax/);
        assert.ok(!/Domain=/i.test(set), set);
        const dash = await t.api('GET', '/', { headers: { cookie: `${SESSION}=${cookieValue(cb, SESSION)}` } });
        assert.match(dash.text, /Your projects/);

        // Mallory starts a sign-in of her own, plants her state and verifier (Path=/auth/callback) and sends alice to the callback.
        const theirs = await t.api('GET', '/auth/login');
        const s2 = new URL(theirs.headers.location).searchParams.get('state');
        const tossed = `ov_oauth_state=${s2}; ov_oauth_verifier=${cookieValue(theirs, 'ov_oauth_verifier')}`;
        for (const cookie of [tossed, `${tossed}; ov_host_flow=${state}`]) {
            const r = await t.api('GET', `/auth/callback?code=${t.network.issueCode(mallory)}&state=${s2}`, { headers: { cookie } });
            assert.strictEqual(r.status, 400, r.text);
            assert.strictEqual(cookieValue(r, SESSION), undefined);
        }
    });

    await check('refresh renews the session of the same account only; sign-out clears it', async () => {
        const session = `${SESSION}=${t.network.userToken(alice)}`;
        const ok = await t.api('POST', '/auth/refresh', { headers: { cookie: `${session}; ov_refresh=${t.network.refreshToken(alice)}` } });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(require('openvibe-sdk/sso').decodeJwtPayload(cookieValue(ok, SESSION)).subject_id, alice.subject);
        // A planted ov_refresh of mallory's (Path=/auth/refresh), next to alice's session or alone, never becomes a session.
        for (const cookie of [`${session}; ov_refresh=${t.network.refreshToken(mallory)}`, `ov_refresh=${t.network.refreshToken(mallory)}`]) {
            const r = await t.api('POST', '/auth/refresh', { headers: { cookie } });
            assert.strictEqual(r.status, 401, r.text);
            assert.strictEqual(cookieValue(r, SESSION), undefined);
            assert.strictEqual(cookieValue(r, 'ov_token'), undefined);
            assert.strictEqual(cookieValue(r, 'ov_refresh'), undefined);
        }
        const out = await t.api('GET', '/auth/logout', { headers: { cookie: session } });
        assert.strictEqual(out.status, 302);
        assert.strictEqual(cookieValue(out, SESSION), '');
        assert.match(setCookies(out).find((c) => c.startsWith(`${SESSION}=`)), /Expires=Thu, 01 Jan 1970/);
    });

    await check('in production the session cookie is __Host- prefixed and Secure', async () => {
        assert.deepStrictEqual(cookieNames({ cookies: { secure: true } }), { session: '__Host-ov_host_session', flow: '__Host-ov_host_flow' });
        // The guard around a stand-in SDK router whose callback writes ov_token, as setSession does.
        const express = require('express');
        const app = express();
        app.use(require('cookie-parser')());
        const auth = { router: (ex) => ex.Router().get('/callback', (_req, res) => { res.cookie('ov_token', 'tok', {}); res.send('ok'); }) };
        app.use('/auth', require('../server/auth/sso').createHostSession({ auth, config: { cookies: { secure: true } } }).router(express));
        const srv = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
        try {
            const r = await fetch(`http://127.0.0.1:${srv.address().port}/auth/callback?state=s1`, { headers: { cookie: '__Host-ov_host_flow=s1' } });
            assert.strictEqual(r.status, 200);
            const set = r.headers.getSetCookie().find((c) => c.startsWith('__Host-ov_host_session='));
            assert.match(set, /^__Host-ov_host_session=tok; Max-Age=\d+; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/);
        } finally { await new Promise((resolve) => srv.close(resolve)); }
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
        // "Preview only": the site keeps its active deploy; the site page links the member to the private preview.
        assert.match(sitePage.text, /name="mode" value="preview"/);
        const pv = await t.api('POST', `/sites/${siteId}/deploys`, { session: alice, body: part('csrf', null, csrf) + part('strip', null, 'folder') + part('mode', null, 'preview') + part('files', 'site/index.html', 'DASH PREVIEW') + `--${boundary}--\r\n`, headers: { origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` } });
        assert.strictEqual(pv.status, 303, pv.text);
        assert.match(decodeURIComponent(pv.headers.location), /Deployed as a preview/);
        const pvId = pv.headers.location.match(/\/deploys\/(dpl_[0-9A-Z]+)/)[1];
        assert.strictEqual((await t.get('dash-site.openvibe.host', '/')).text, 'DASH OK', 'a preview never goes live');
        const withPreview = await t.api('GET', `/sites/${siteId}`, { session: alice });
        assert.ok(withPreview.text.includes(`href="/preview/${pvId}/"`), 'the site page links the live preview');
        assert.match(withPreview.text, /<strong class="preview">preview<\/strong>/);
        const seen = await t.api('GET', `/preview/${pvId}/`, { session: alice });
        assert.strictEqual(seen.status, 200, seen.text);
        assert.strictEqual(seen.text, 'DASH PREVIEW');
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
