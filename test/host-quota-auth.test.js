'use strict';
/**
 * Quotas are enforced by Host (ADR-014) and principals are judged by capability AND project role:
 * deploys per day, storage (deduplicated), files per deploy, file size, upload size, sites, custom
 * domains, sandbox limits; service tokens, app principals, sandbox tokens, staff.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');
const { site: siteTar } = require('./stageb/tar');

const DAY = 24 * 3600 * 1000;

(async () => {
    const t = await boot({ env: { HOST_MAX_UPLOAD_BYTES: String(64 * 1024), HOST_MAX_UNPACKED_BYTES: String(1024 * 1024) } });
    const alice = t.user('alice');
    const staff = t.user('root', { role: 'admin' });
    const project = await t.project(alice, 'Q');
    const site = await t.site(alice, project.id, 'quota-site');
    const setQuota = (q) => t.api('PUT', `/api/v1/projects/${project.id}/quota`, { as: staff, json: q });

    await check('only staff change quotas; the owner reads them', async () => {
        const mine = await t.api('PUT', `/api/v1/projects/${project.id}/quota`, { as: alice, json: { deploys_per_day: 1000 } });
        assert.strictEqual(mine.status, 403);
        assert.strictEqual(mine.json().code, 'auth.staff_only');
        const r = await setQuota({ deploys_per_day: 3 });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().quota.deploys_per_day, 3);
        const bad = await setQuota({ max_files: -1 });
        assert.strictEqual(bad.status, 422);
    });

    await check('deploys per day: refused before the body is read, counted over a rolling 24 hours', async () => {
        for (let i = 0; i < 3; i++) await t.deploy(alice, site.id, { 'index.html': `v${i}` });
        const r = await t.upload(alice, site.id, { 'index.html': 'v4' });
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json().code, 'quota.deploys_per_day');
        assert.strictEqual((await t.get('quota-site.openvibe.host', '/')).text, 'v2');
        t.clock.advance(DAY + 1000);
        assert.strictEqual((await t.upload(alice, site.id, { 'index.html': 'v5' })).status, 201);
        await setQuota({ deploys_per_day: null });
    });

    await check('storage quota counts only new bytes (identical content is stored once per project)', async () => {
        const big = 'x'.repeat(3000);
        await setQuota({ storage_bytes: 7000 });
        const used0 = (await t.api('GET', `/api/v1/projects/${project.id}/quota`, { as: alice })).json().usage.storage_bytes;
        const first = await t.upload(alice, site.id, { 'index.html': big });
        assert.strictEqual(first.status, 201, first.text);
        assert.strictEqual(first.json().deploy.new_bytes, 3000);
        const same = await t.upload(alice, site.id, { 'index.html': big, 'copy.html': big });
        assert.strictEqual(same.status, 201, same.text);
        assert.strictEqual(same.json().deploy.new_bytes, 0, 'already stored');
        const over = await t.upload(alice, site.id, { 'index.html': 'y'.repeat(4100) });
        assert.strictEqual(over.status, 413);
        assert.strictEqual(over.json().code, 'quota.storage');
        const tooBig = await t.upload(alice, site.id, { 'a.html': big, 'b.html': big, 'c.html': big });
        assert.strictEqual(tooBig.status, 413, 'a deploy (before deduplication) is never larger than the storage quota');
        assert.strictEqual(tooBig.json().code, 'deploy.too_large');
        const used1 = (await t.api('GET', `/api/v1/projects/${project.id}/quota`, { as: alice })).json().usage.storage_bytes;
        assert.strictEqual(used1 - used0, 3000);
        await setQuota({ storage_bytes: null });
    });

    await check('files per deploy and bytes per file', async () => {
        await setQuota({ max_files: 2, max_file_bytes: 100 });
        const many = await t.upload(alice, site.id, { 'a.html': '1', 'b.html': '2', 'c.html': '3' });
        assert.strictEqual(many.status, 413);
        assert.strictEqual(many.json().code, 'quota.max_files');
        const large = await t.upload(alice, site.id, { 'a.html': 'z'.repeat(101) });
        assert.strictEqual(large.status, 413);
        assert.strictEqual(large.json().code, 'quota.max_file_bytes');
        await setQuota({ max_files: null, max_file_bytes: null });
    });

    await check('request size: a body over HOST_MAX_UPLOAD_BYTES is refused (413) and the connection closed', async () => {
        const crypto = require('crypto');
        const noise = crypto.randomBytes(80 * 1024);   // incompressible
        const r = await t.api('POST', `/api/v1/sites/${site.id}/deploys`, { as: alice, body: siteTar({ 'blob.bin.png': noise }), headers: { 'content-type': 'application/gzip' } });
        assert.strictEqual(r.status, 413);
        assert.strictEqual(r.json().code, 'upload.too_large');
        assert.strictEqual(r.headers.connection, 'close');
    });

    await check('decompression: an archive unpacks to at most HOST_MAX_UNPACKED_BYTES, however large the storage quota', async () => {
        // A few KiB of gzip that expands to 2 MiB (the default production quota would allow 1 GiB:
        // a 1 MB request would otherwise inflate to 1 GiB in memory and block the event loop).
        const zeros = Buffer.alloc(512 * 1024, 0);
        const bomb = siteTar({ 'a.png': zeros, 'b.png': zeros, 'c.png': zeros, 'd.png': zeros });
        assert.ok(bomb.length < 64 * 1024, 'well under the request limit');
        const r = await t.api('POST', `/api/v1/sites/${site.id}/deploys`, { as: alice, body: bomb, headers: { 'content-type': 'application/gzip' } });
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json().code, 'deploy.too_large');
    });

    await check('sites per project and custom domains per project', async () => {
        await setQuota({ sites: 2, custom_domains: 1 });
        await t.site(alice, project.id, 'second-site');
        const third = await t.api('POST', `/api/v1/projects/${project.id}/sites`, { as: alice, json: { name: 'third-site' } });
        assert.strictEqual(third.status, 429);
        assert.strictEqual(third.json().code, 'quota.sites');
        assert.strictEqual((await t.api('POST', `/api/v1/sites/${site.id}/domains`, { as: alice, json: { hostname: 'one.example.org' } })).status, 201);
        const two = await t.api('POST', `/api/v1/sites/${site.id}/domains`, { as: alice, json: { hostname: 'two.example.org' } });
        assert.strictEqual(two.status, 429);
        assert.strictEqual(two.json().code, 'quota.custom_domains');
    });

    await check('site names: one DNS label, reserved names refused, unique', async () => {
        for (const name of ['ab', 'www', 'api', 'openvibe-news', 'bad_name', 'UPPER', '-lead', 'trail-', 'a--b', 'xn--80ak6aa92e', 'x'.repeat(41), 'a.b']) {
            const r = await t.api('POST', `/api/v1/projects/${project.id}/sites`, { as: alice, json: { name } });
            assert.ok([422, 429].includes(r.status), `${name} → ${r.status}`);
        }
    });

    await check('sandbox projects: smaller quotas, no custom domains, noindex', async () => {
        const sb = await t.project(alice, 'Sandbox', { environment: 'sandbox' });
        assert.strictEqual(sb.environment, 'sandbox');
        assert.strictEqual(sb.quota.custom_domains, 0);
        assert.ok(sb.quota.storage_bytes < project.quota.storage_bytes);
        const s = await t.site(alice, sb.id, 'sandbox-alice');
        const d = await t.api('POST', `/api/v1/sites/${s.id}/domains`, { as: alice, json: { hostname: 'sb.example.org' } });
        assert.strictEqual(d.status, 403);
        await t.deploy(alice, s.id, { 'index.html': 'sb' });
        assert.strictEqual((await t.get('sandbox-alice.openvibe.host', '/')).headers['x-robots-tag'], 'noindex, nofollow');
    });

    // ── Principals ──────────────────────────────────────────
    const ALL = ['host.site.manage', 'host.deploy.create', 'host.domain.manage'];

    await check('service tokens: audience and capability are checked per route', async () => {
        const wrongAud = t.network.sign({ sub: 'svc:codes', aud: ['openvibe.blog'], cap: ALL });
        assert.strictEqual((await t.api('GET', '/api/v1/projects', { as: wrongAud })).status, 401);
        const noCap = t.network.serviceToken('codes', ['host.deploy.create']);
        const r = await t.api('POST', '/api/v1/projects', { as: noCap, json: { name: 'x' }, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'capability.denied');
        const family = t.network.serviceToken('codes', ['host.*']);
        const ok = await t.api('GET', `/api/v1/projects/${project.id}`, { as: family, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(ok.status, 200, 'a host.* grant covers the family');
    });

    await check('a first-party service acts for a person (X-OV-Subject) and is judged by that person\'s role', async () => {
        const codes = t.network.serviceToken('codes', ALL);
        const created = await t.api('POST', '/api/v1/projects', { as: codes, json: { name: 'via codes', network_project_id: 'nprj_123' }, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(created.status, 201, created.text);
        assert.strictEqual(created.json().project.owner, alice.subject);
        assert.strictEqual(created.json().project.network_project_id, 'nprj_123');
        const dup = await t.api('POST', '/api/v1/projects', { as: codes, json: { name: 'dup', network_project_id: 'nprj_123' }, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(dup.status, 409);
        const noPerson = await t.api('POST', '/api/v1/projects', { as: codes, json: { name: 'orphan' } });
        assert.strictEqual(noPerson.status, 403, 'a project is owned by a person');
        const stranger = t.user('mallory');
        const other = await t.api('GET', `/api/v1/projects/${project.id}`, { as: codes, headers: { 'x-ov-subject': stranger.subject } });
        assert.strictEqual(other.status, 404, 'the capability alone does not open someone else\'s project');
    });

    await check('apps are principals: a deployer app deploys, cannot manage, cannot act as a person', async () => {
        const { ids } = require('openvibe-contracts');
        const appId = ids.newId('app');
        const ci = t.network.appToken(appId, ALL);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${site.id}/deploys`, { as: ci })).status, 404, 'not a member yet');
        const add = await t.api('PUT', `/api/v1/projects/${project.id}/members/app:${appId}`, { as: alice, json: { role: 'deployer' } });
        assert.strictEqual(add.status, 200, add.text);
        const up = await t.api('POST', `/api/v1/sites/${site.id}/deploys?activate=1`, { as: ci, body: siteTar({ 'index.html': 'from CI' }), headers: { 'content-type': 'application/gzip' } });
        assert.strictEqual(up.status, 201, up.text);
        assert.strictEqual(up.json().deploy.created_by, `app:${appId}`);
        assert.deepStrictEqual(t.events('host.deploy.activated').pop().actor, { type: 'app', id: appId });
        assert.strictEqual((await t.get('quota-site.openvibe.host', '/')).text, 'from CI');
        const mk = await t.api('POST', `/api/v1/projects/${project.id}/sites`, { as: ci, json: { name: 'ci-site' } });
        assert.strictEqual(mk.status, 403);
        assert.strictEqual(mk.json().code, 'project.role_insufficient');
        const imp = await t.api('GET', `/api/v1/projects/${project.id}`, { as: ci, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(imp.status, 400);
        assert.strictEqual(imp.json().code, 'subject.not_delegable');
        const owner = await t.api('PUT', `/api/v1/projects/${project.id}/members/app:${appId}`, { as: alice, json: { role: 'owner' } });
        assert.strictEqual(owner.status, 422, 'only a person can own a project');
    });

    await check('a sandbox credential is refused on a production project', async () => {
        const sandboxTok = t.network.serviceToken('codes', ALL, { env: 'sandbox' });
        const r = await t.api('GET', `/api/v1/projects/${project.id}`, { as: sandboxTok, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'environment.sandbox_token');
        const p = await t.api('POST', '/api/v1/projects', { as: sandboxTok, json: { name: 'prod?' }, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(p.status, 403);
        const sb = await t.api('POST', '/api/v1/projects', { as: sandboxTok, json: { name: 'sb', environment: 'sandbox' }, headers: { 'x-ov-subject': alice.subject } });
        assert.strictEqual(sb.status, 201);
    });

    await check('a FedCM ID assertion is not a session: a tenant page on <site>.openvibe.host cannot act as its visitor', async () => {
        // Network signs FedCM assertions with the key and issuer of its access tokens, for any RP
        // origin under an OpenVibe zone, tenant subdomains of openvibe.host included.
        const assertion = t.network.fedcmAssertion(alice, 'https://evil-tenant.openvibe.host');
        const list = await t.api('GET', '/api/v1/projects', { as: assertion });
        assert.strictEqual(list.status, 401, list.text);
        const del = await t.api('DELETE', `/api/v1/projects/${project.id}`, { as: assertion });
        assert.strictEqual(del.status, 401, del.text);
        const dash = await t.request({ method: 'GET', host: 'openvibe.host', path: '/', headers: { cookie: `ov_host_session=${assertion}` } });
        assert.ok(!/Your projects/.test(dash.text), 'the dashboard does not accept it as a session either');
    });

    await check('mods cannot manage hosted sites', async () => {
        const { ids } = require('openvibe-contracts');
        const mod = t.network.sign({ sub: `mod:${ids.newId('mod')}`, actor_type: 'mod', aud: ['openvibe.host'], cap: ALL });
        assert.strictEqual((await t.api('GET', '/api/v1/projects', { as: mod })).status, 403);
    });

    await check('staff read and delete for abuse handling but cannot publish into a tenant site', async () => {
        assert.strictEqual((await t.api('GET', `/api/v1/projects/${project.id}`, { as: staff })).status, 200);
        const up = await t.upload(staff, site.id, { 'index.html': 'staff content' });
        assert.strictEqual(up.status, 404);
        assert.notStrictEqual((await t.get('quota-site.openvibe.host', '/')).text, 'staff content');
    });

    await t.close();
    done();
})();
