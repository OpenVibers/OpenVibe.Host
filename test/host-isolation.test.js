'use strict';
/**
 * Wave 21 exit criterion: "a hosted static project cannot read another tenant's objects".
 * Path tricks, encoded traversal, Host header tricks, absolute-form targets, shared content, the API,
 * cross-origin reads from a tenant page (no CORS grant anywhere), existence oracles (ETag, Range),
 * delegated service tokens, app principals and the dashboard: a tenant only ever reaches its own
 * site, deploys and domains.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./stageb/boot');

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const bob = t.user('bob');
    const pa = await t.project(alice, 'A');
    const pb = await t.project(bob, 'B');
    const alpha = await t.site(alice, pa.id, 'alpha');
    const beta = await t.site(bob, pb.id, 'beta');
    const SHARED = 'same bytes in both projects';
    const da = await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA HOME', 'shared.txt': SHARED });
    const db = await t.deploy(bob, beta.id, { 'index.html': 'BETA HOME', 'secret.html': 'BETA SECRET', 'dir/inner.html': 'BETA INNER', 'shared.txt': SHARED });
    const betaFiles = (await t.api('GET', `/api/v1/deploys/${db.id}`, { as: bob })).json().deploy.files;
    const secretSha = betaFiles.find((f) => f.path === 'secret.html').sha256;
    const leaks = (r) => /BETA/.test(r.text);

    await check('each site serves only its own deploy', async () => {
        assert.strictEqual((await t.get('alpha.openvibe.host', '/')).text, 'ALPHA HOME');
        assert.strictEqual((await t.get('beta.openvibe.host', '/')).text, 'BETA HOME');
        assert.strictEqual((await t.get('alpha.openvibe.host', '/secret.html')).status, 404);
    });

    await check('path tricks on alpha never reach beta\'s files or anyone\'s object store', async () => {
        const targets = [
            '/../secret.html', '/../beta/secret.html', '/%2e%2e/secret.html', '/%2E%2E%2Fsecret.html', '/..%2fsecret.html', '/..%2Fbeta%2Fsecret.html',
            '/.%2e/secret.html', '/%252e%252e/secret.html', '//beta.openvibe.host/secret.html', '/./secret.html', '/dir/../secret.html',
            '/%00secret.html', '/secret.html%00.html', '/..\\secret.html', '/%5c..%5csecret.html', '/.well-known/../secret.html',
            `/projects/${pb.id}/${secretSha.slice(0, 2)}/${secretSha}`, `/${secretSha}`, `/objects/projects/${pb.id}/${secretSha.slice(0, 2)}/${secretSha}`,
            `/../../objects/projects/${pb.id}/${secretSha.slice(0, 2)}/${secretSha}`, `/%2e%2e/%2e%2e/objects/projects/${pb.id}/${secretSha.slice(0, 2)}/${secretSha}`,
            '/dir/inner.html', '/host.db', '/../host.db', '/%2e%2e/host.db',
        ];
        for (const p of targets) {
            const r = await t.get('alpha.openvibe.host', p);
            assert.ok(!leaks(r), `${p} leaked: ${r.status} ${r.text.slice(0, 80)}`);
            assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
            assert.ok(!r.body.includes(Buffer.from('SQLite format')), `${p} returned the database`);
        }
    });

    await check('Host header tricks resolve to exactly one site or to "unknown host"', async () => {
        const cases = [
            ['ALPHA.OPENVIBE.HOST', 'ALPHA HOME'], ['alpha.openvibe.host.', 'ALPHA HOME'], ['alpha.openvibe.host:443', 'ALPHA HOME'],
            ['beta.alpha.openvibe.host', null], ['alpha.beta.openvibe.host', null], ['alpha.openvibe.host.evil.example', null],
            ['alpha.openvibe.host@beta.openvibe.host', null], ['alpha.openvibe.host:80:beta', null], ['alpha.openvibe.host/beta', null],
            ['beta', null], ['openvibe.host.beta', null], ['-beta.openvibe.host', null], ['%62eta.openvibe.host', null], ['', null],
        ];
        for (const [host, want] of cases) {
            const r = await t.get(host, '/secret.html');
            assert.ok(!leaks(r), `Host ${JSON.stringify(host)} leaked beta`);
            if (want) { const home = await t.get(host, '/'); assert.strictEqual(home.text, want, host); }
        }
        const dash = await t.get('openvibe.host', '/secret.html');
        assert.ok(!leaks(dash), 'the dashboard host does not serve tenant files');
    });

    await check('an absolute-form request target must match the Host header', async () => {
        const r = await t.get('alpha.openvibe.host', 'http://beta.openvibe.host/secret.html');
        assert.strictEqual(r.status, 400);
        assert.ok(!leaks(r));
        const ok = await t.get('beta.openvibe.host', 'http://beta.openvibe.host/secret.html');
        assert.strictEqual(ok.text, 'BETA SECRET', 'a consistent absolute-form request is fine');
    });

    await check('tenant hosts never reach the API, auth, metrics or readiness', async () => {
        for (const p of ['/api/v1/projects', '/api/ready', '/metrics', '/auth/login', '/release.json', '/css/host.css']) {
            const r = await t.get('alpha.openvibe.host', p, { as: bob });
            assert.strictEqual(r.status, 404, p);
            assert.ok(!/projects|"ready"|http_requests_total|oauth/.test(r.text), `${p} leaked: ${r.text.slice(0, 100)}`);
        }
    });

    await check('identical bytes are stored per project: deleting one project\'s copy never breaks the other', async () => {
        const sha = betaFiles.find((f) => f.path === 'shared.txt').sha256;
        const root = path.join(t.dir, 'objects', 'projects');
        assert.ok(fs.existsSync(path.join(root, pa.id, sha.slice(0, 2), sha)));
        assert.ok(fs.existsSync(path.join(root, pb.id, sha.slice(0, 2), sha)));
        const d2 = await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA 2' });
        assert.ok(d2.active);
        const del = await t.api('DELETE', `/api/v1/deploys/${da.id}`, { as: alice });
        assert.strictEqual(del.status, 200, del.text);
        assert.ok(!fs.existsSync(path.join(root, pa.id, sha.slice(0, 2), sha)), 'alice\'s copy is gone');
        assert.strictEqual((await t.get('beta.openvibe.host', '/shared.txt')).text, SHARED, 'bob\'s copy still serves');
    });

    await check('the API hides other tenants\' projects, sites, deploys and domains (404, not 403)', async () => {
        const dom = await t.api('POST', `/api/v1/sites/${beta.id}/domains`, { as: bob, json: { hostname: 'www.beta-example.org' } });
        const domainId = dom.json().domain.id;
        const probes = [
            ['GET', `/api/v1/projects/${pb.id}`], ['GET', `/api/v1/projects/${pb.id}/sites`], ['GET', `/api/v1/projects/${pb.id}/quota`],
            ['POST', `/api/v1/projects/${pb.id}/sites`, { name: 'hijack' }], ['DELETE', `/api/v1/projects/${pb.id}`],
            ['GET', `/api/v1/sites/${beta.id}`], ['DELETE', `/api/v1/sites/${beta.id}`], ['GET', `/api/v1/sites/${beta.id}/deploys`],
            ['POST', `/api/v1/sites/${beta.id}/rollback`, {}], ['GET', `/api/v1/deploys/${db.id}`], ['GET', `/api/v1/deploys/${db.id}/log`],
            ['POST', `/api/v1/deploys/${db.id}/activate`, {}], ['DELETE', `/api/v1/deploys/${db.id}`], ['GET', `/api/v1/sites/${beta.id}/domains`],
            ['POST', `/api/v1/sites/${beta.id}/domains`, { hostname: 'x.example.org' }], ['POST', `/api/v1/domains/${domainId}/verify`], ['DELETE', `/api/v1/domains/${domainId}`],
            ['PUT', `/api/v1/projects/${pb.id}/members/${alice.subject}`, { role: 'owner' }],
        ];
        for (const [method, p, json] of probes) {
            const r = await t.api(method, p, { as: alice, json });
            assert.strictEqual(r.status, 404, `${method} ${p} → ${r.status} ${r.text}`);
            assert.ok(!/BETA|beta-example/.test(r.text));
        }
        const up = await t.upload(alice, beta.id, { 'index.html': 'PWNED' });
        assert.strictEqual(up.status, 404);
        assert.strictEqual((await t.get('beta.openvibe.host', '/')).text, 'BETA HOME');
        const list = (await t.api('GET', '/api/v1/projects', { as: alice })).json().projects.map((p) => p.id);
        assert.deepStrictEqual(list, [pa.id]);
    });

    await check('a tenant cannot point its own site at another tenant\'s deploy', async () => {
        const r = await t.api('POST', `/api/v1/sites/${alpha.id}/rollback`, { as: alice, json: { deploy_id: db.id } });
        assert.strictEqual(r.status, 404);
        assert.ok(!leaks(await t.get('alpha.openvibe.host', '/')));
    });

    await check('the API ignores cookies: a session cookie alone is anonymous (tenant pages are same-site)', async () => {
        const r = await t.api('POST', '/api/v1/projects', { session: alice, json: { name: 'csrf' } });
        assert.strictEqual(r.status, 401);
        const g = await t.api('GET', `/api/v1/projects/${pa.id}`, { session: alice });
        assert.strictEqual(g.status, 401);
    });

    await check('a garbage bearer token is refused, not treated as anonymous', async () => {
        const r = await t.api('GET', '/api/v1/projects', { as: 'not-a-jwt' });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.headers['content-type'], 'application/problem+json');
    });

    await check('a tenant page\'s scripts cannot read another tenant\'s files: no CORS grant on tenant responses, preflights refused', async () => {
        for (const origin of ['https://alpha.openvibe.host', 'null', 'https://evil.example']) {
            const r = await t.get('beta.openvibe.host', '/secret.html', { headers: { origin } });
            assert.strictEqual(r.status, 200);
            for (const h of Object.keys(r.headers)) assert.ok(!h.startsWith('access-control-'), `beta answered ${origin} with ${h}`);
            const pre = await t.request({ method: 'OPTIONS', host: 'beta.openvibe.host', path: '/secret.html', headers: { origin, 'access-control-request-method': 'GET' } });
            assert.strictEqual(pre.status, 405);
            assert.ok(!Object.keys(pre.headers).some((h) => h.startsWith('access-control-')));
        }
        assert.strictEqual((await t.get('beta.openvibe.host', '/secret.html')).headers['cross-origin-opener-policy'], 'same-origin');
    });

    await check('the Host API grants CORS to no tenant origin (a tenant page cannot call it from a visitor\'s browser)', async () => {
        for (const origin of ['https://alpha.openvibe.host', 'https://beta.openvibe.host', 'https://openvibe.host.evil.example']) {
            const r = await t.api('GET', '/api/v1/projects', { as: bob, headers: { origin } });
            assert.strictEqual(r.headers['access-control-allow-origin'], undefined, origin);
            const pre = await t.request({ method: 'OPTIONS', host: 'openvibe.host', path: '/api/v1/projects', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
            assert.strictEqual(pre.headers['access-control-allow-origin'], undefined, `preflight from ${origin}`);
        }
    });

    await check('no existence oracle: another tenant\'s sha256 as If-None-Match or a Range on alpha is still a 404', async () => {
        const r = await t.get('alpha.openvibe.host', '/secret.html', { headers: { 'if-none-match': `"${secretSha}"` } });
        assert.strictEqual(r.status, 404);
        const r2 = await t.get('alpha.openvibe.host', `/${secretSha}`, { headers: { 'if-none-match': `"${secretSha}"`, range: 'bytes=0-3' } });
        assert.strictEqual(r2.status, 404);
        assert.ok(!leaks(r) && !leaks(r2));
    });

    await check('delegation and app principals stay inside their own project', async () => {
        const codes = t.network.serviceToken('codes', ['host.site.manage', 'host.deploy.create', 'host.domain.manage']);
        for (const p of [`/api/v1/projects/${pb.id}`, `/api/v1/deploys/${db.id}`, `/api/v1/deploys/${db.id}/log`, `/api/v1/sites/${beta.id}/deploys`]) {
            const r = await t.api('GET', p, { as: codes, headers: { 'x-ov-subject': alice.subject } });
            assert.strictEqual(r.status, 404, `svc:codes for alice → ${p} ${r.status}`);
            assert.ok(!leaks(r) && !r.text.includes(secretSha));
        }
        const ci = t.network.appToken('app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', ['host.deploy.create', 'host.site.manage']);
        const add = await t.api('PUT', `/api/v1/projects/${pa.id}/members/app:app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3`, { as: alice, json: { role: 'deployer' } });
        assert.strictEqual(add.status, 200, add.text);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${alpha.id}/deploys`, { as: ci })).status, 200, 'the app reads its own project');
        for (const p of [`/api/v1/deploys/${db.id}`, `/api/v1/sites/${beta.id}/deploys`]) assert.strictEqual((await t.api('GET', p, { as: ci })).status, 404, p);
        const up = await t.api('POST', `/api/v1/sites/${beta.id}/deploys?activate=1`, { as: ci, body: require('./stageb/tar').site({ 'index.html': 'PWNED' }), headers: { 'content-type': 'application/gzip' } });
        assert.strictEqual(up.status, 404);
        // X-OV-Subject is honoured for first-party services only: an app cannot borrow bob's identity.
        const borrow = await t.api('GET', `/api/v1/deploys/${db.id}`, { as: ci, headers: { 'x-ov-subject': bob.subject } });
        assert.strictEqual(borrow.status, 400);
        assert.strictEqual(borrow.json().code, 'subject.not_delegable');
        assert.ok(!leaks(borrow));
        assert.strictEqual((await t.get('beta.openvibe.host', '/')).text, 'BETA HOME');
    });

    await check('the dashboard (cookie session) shows a non-member nothing of another tenant: no names, files or hashes', async () => {
        for (const p of [`/projects/${pb.id}`, `/sites/${beta.id}`, `/deploys/${db.id}`]) {
            const r = await t.api('GET', p, { session: alice });
            assert.strictEqual(r.status, 404, `${p} → ${r.status}`);
            assert.ok(!/secret\.html|BETA|beta-example/.test(r.text) && !r.text.includes(secretSha), `${p} leaked`);
        }
    });

    await t.close();
    done();
})();
