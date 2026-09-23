'use strict';
/**
 * Abuse controls (docs/threat-review.md): staff takedowns stop serving at once and keep the content
 * for review; members cannot publish, switch or delete around a takedown; certificate-validation
 * paths cannot be published; uploads are validated a few at a time, so concurrent uploads cannot
 * exhaust memory; fingerprinted assets leave a shared CDN within the hour.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot, check, done } = require('./stageb/boot');
const { site: siteTar } = require('./stageb/tar');

(async () => {
    const t = await boot({ env: { HOST_MAX_CONCURRENT_UPLOADS: '1' } });
    const alice = t.user('alice');
    const staff = t.user('root', { role: 'admin' });
    const pa = await t.project(alice, 'A');
    const alpha = await t.site(alice, pa.id, 'alpha');
    const other = await t.site(alice, pa.id, 'other');
    const d1 = await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA ONE', 'app.3f2a9c1b.js': 'js();' });
    const d2 = await t.deploy(alice, alpha.id, { 'index.html': 'ALPHA TWO' });
    await t.deploy(alice, other.id, { 'index.html': 'OTHER' });
    const dom = await t.api('POST', `/api/v1/sites/${alpha.id}/domains`, { as: alice, json: { hostname: 'www.alpha-example.org' } });
    const domain = dom.json().domain;
    t.dns.set("_openvibe-host.www.alpha-example.org", [domain.instructions.verification.value]);
    assert.strictEqual((await t.api('POST', `/api/v1/domains/${domain.id}/verify`, { as: alice })).json().domain.status, 'verified');
    const objectsOf = (p) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else out.push(e.name); } }; walk(path.join(t.dir, 'objects', 'projects', p)); return out.sort(); };

    await check('fingerprinted assets: immutable for browsers, at most an hour at a shared CDN', async () => {
        const r = await t.get('alpha.openvibe.host', '/app.3f2a9c1b.js');
        await t.api('POST', `/api/v1/deploys/${d1.id}/activate`, { as: alice });
        const r1 = await t.get('alpha.openvibe.host', '/app.3f2a9c1b.js');
        assert.strictEqual(r.status, 404, 'not in the active deploy yet');
        assert.strictEqual(r1.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.strictEqual(r1.headers['cdn-cache-control'], 'public, max-age=3600');
        assert.strictEqual((await t.get('alpha.openvibe.host', '/')).headers['cdn-cache-control'], undefined);
        await t.api('POST', `/api/v1/deploys/${d2.id}/activate`, { as: alice });
    });

    await check('only staff take a site down; members and strangers cannot', async () => {
        const mine = await t.api('POST', `/api/v1/sites/${alpha.id}/takedown`, { as: alice, json: { reason: 'self' } });
        assert.strictEqual(mine.status, 403);
        assert.strictEqual(mine.json().code, 'auth.staff_only');
        const stranger = await t.api('POST', `/api/v1/sites/${alpha.id}/takedown`, { as: t.user('mallory'), json: { reason: 'x' } });
        assert.strictEqual(stranger.status, 404, 'a stranger learns nothing');
        const noReason = await t.api('POST', `/api/v1/sites/${alpha.id}/takedown`, { as: staff, json: {} });
        assert.strictEqual(noReason.status, 422);
    });

    const objectsBefore = objectsOf(pa.id);
    await check('a takedown stops the default and custom domains at once (451, no tenant bytes) and keeps everything', async () => {
        const r = await t.api('POST', `/api/v1/sites/${alpha.id}/takedown`, { as: staff, json: { reason: 'phishing report #42' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().takedown.reason, 'phishing report #42');
        for (const host of ['alpha.openvibe.host', 'www.alpha-example.org']) {
            for (const p of ['/', '/index.html', '/app.3f2a9c1b.js', '/404.html', '/missing']) {
                const g = await t.get(host, p);
                assert.strictEqual(g.status, 451, `${host}${p}`);
                assert.ok(!/ALPHA|js\(\)/.test(g.text), 'no tenant content');
                assert.strictEqual(g.headers['cache-control'], 'no-store');
                assert.strictEqual(g.headers.etag, undefined);
            }
        }
        assert.strictEqual((await t.get('other.openvibe.host', '/')).text, 'OTHER', 'a site-level takedown leaves the project\'s other sites up');
        assert.deepStrictEqual(objectsOf(pa.id), objectsBefore, 'every object kept');
        const files = await t.api('GET', `/api/v1/deploys/${d1.id}`, { as: staff });
        assert.strictEqual(files.json().deploy.files.length, 2, 'file rows kept for review');
        assert.strictEqual((await t.api('POST', `/api/v1/sites/${alpha.id}/takedown`, { as: staff, json: { reason: 'again' } })).status, 409);
    });

    await check('members see the takedown and why, and cannot publish, switch or delete around it', async () => {
        const s = await t.api('GET', `/api/v1/sites/${alpha.id}`, { as: alice });
        assert.deepStrictEqual([s.json().site.takedown.scope, s.json().site.takedown.reason], ['site', 'phishing report #42']);
        const up = await t.upload(alice, alpha.id, { 'index.html': 'EVADE' });
        assert.strictEqual(up.status, 403);
        assert.strictEqual(up.json().code, 'site.taken_down');
        for (const [method, p, json] of [
            ['POST', `/api/v1/deploys/${d1.id}/activate`, {}], ['POST', `/api/v1/sites/${alpha.id}/rollback`, {}],
            ['DELETE', `/api/v1/deploys/${d1.id}`], ['DELETE', `/api/v1/sites/${alpha.id}`], ['DELETE', `/api/v1/projects/${pa.id}`],
        ]) {
            const r = await t.api(method, p, { as: alice, json });
            assert.ok([403, 409].includes(r.status), `${method} ${p} → ${r.status} ${r.text}`);
            assert.strictEqual(r.json().code, 'site.taken_down');
        }
        const page = await t.api('GET', `/sites/${alpha.id}`, { session: alice });
        assert.match(page.text, /taken down by OpenVibe staff: phishing report #42/);
        assert.deepStrictEqual(objectsOf(pa.id), objectsBefore);
    });

    await check('staff lift a takedown: the same content serves again; members only lift nothing', async () => {
        assert.strictEqual((await t.api('DELETE', `/api/v1/sites/${alpha.id}/takedown`, { as: alice })).status, 403);
        const r = await t.api('DELETE', `/api/v1/sites/${alpha.id}/takedown`, { as: staff, json: { note: 'reviewed: false positive' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual((await t.get('alpha.openvibe.host', '/')).text, 'ALPHA TWO');
        assert.strictEqual((await t.get('www.alpha-example.org', '/')).text, 'ALPHA TWO');
        assert.strictEqual((await t.api('DELETE', `/api/v1/sites/${alpha.id}/takedown`, { as: staff })).status, 404);
        const rows = t.ctx.store.db.prepare('SELECT target_kind, reason, lifted_at IS NOT NULL AS lifted, lift_note FROM host_takedowns').all();
        assert.deepStrictEqual(rows, [{ target_kind: 'site', reason: 'phishing report #42', lifted: 1, lift_note: 'reviewed: false positive' }], 'the history is kept');
    });

    await check('a project takedown covers every site of the project; staff can still delete', async () => {
        const r = await t.api('POST', `/api/v1/projects/${pa.id}/takedown`, { as: staff, json: { reason: 'spam network' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await t.get('alpha.openvibe.host', '/')).status, 451);
        assert.strictEqual((await t.get('other.openvibe.host', '/')).status, 451);
        const p = await t.api('GET', `/api/v1/projects/${pa.id}`, { as: alice });
        assert.strictEqual(p.json().project.takedown.scope, 'project');
        assert.strictEqual(p.json().sites[0].takedown.scope, 'project');
        const list = await t.api('GET', '/api/v1/projects', { as: alice });
        assert.strictEqual(list.json().projects[0].takedown.reason, 'spam network');
        assert.strictEqual((await t.upload(alice, other.id, { 'index.html': 'x' })).status, 403);
        const del = await t.api('DELETE', `/api/v1/sites/${other.id}`, { as: staff });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual((await t.get('other.openvibe.host', '/')).status, 404);
    });

    await check('certificate-validation paths are never published (no tenant can get a certificate for its host name)', async () => {
        const pb = await t.project(alice, 'B');
        const beta = await t.site(alice, pb.id, 'beta');
        for (const p of ['.well-known/acme-challenge/token123', '.well-known/pki-validation/fileauth.txt', '.well-known/ACME-CHALLENGE/x']) {
            const r = await t.upload(alice, beta.id, { 'index.html': 'B', [p]: 'proof' });
            assert.strictEqual(r.status, 422, `${p} → ${r.status}`);
            assert.ok(r.json().log.some((l) => /reserved/.test(l)), r.text);
        }
        await t.deploy(alice, beta.id, { 'index.html': 'B', '.well-known/security.txt': 'Contact: mailto:x@example.org' });
        assert.strictEqual((await t.get('beta.openvibe.host', '/.well-known/security.txt')).status, 200, 'other .well-known files still publish');
        assert.strictEqual((await t.get('beta.openvibe.host', '/.well-known/acme-challenge/token123')).status, 404);
    });

    await check('uploads are validated a few at a time: a second concurrent upload gets 503 + Retry-After and is not a failed deploy', async () => {
        const pc = await t.project(alice, 'C');
        const gamma = await t.site(alice, pc.id, 'gamma');
        const body = siteTar({ 'index.html': 'GAMMA' });
        const failedBefore = t.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM host_deploys WHERE state = 'failed'").get().n;
        // The first upload sends its headers and half its body, then waits.
        let firstResponse;
        let finish;
        const first = new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST', path: `/api/v1/sites/${gamma.id}/deploys?activate=1`, headers: { host: 'openvibe.host', authorization: `Bearer ${t.network.userToken(alice)}`, 'content-type': 'application/gzip', 'content-length': body.length } }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => { firstResponse = { status: res.statusCode, text: Buffer.concat(chunks).toString() }; resolve(); });
            });
            req.write(body.subarray(0, Math.floor(body.length / 2)));
            finish = () => req.end(body.subarray(Math.floor(body.length / 2)));
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(t.ctx.uploadGate.inFlight, 1);
        const second = await t.upload(alice, gamma.id, { 'index.html': 'SECOND' });
        assert.strictEqual(second.status, 503, second.text);
        assert.strictEqual(second.json().code, 'upload.busy');
        assert.strictEqual(second.headers['retry-after'], '30');
        finish();
        await first;
        assert.strictEqual(firstResponse.status, 201, firstResponse.text);
        assert.strictEqual(t.ctx.uploadGate.inFlight, 0, 'the slot is released');
        assert.strictEqual(t.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM host_deploys WHERE state = 'failed'").get().n, failedBefore, 'a busy refusal is not the tenant\'s failed deploy');
        const third = await t.upload(alice, gamma.id, { 'index.html': 'THIRD' });
        assert.strictEqual(third.status, 201, third.text);
        // A refused upload releases its slot too.
        const bad = await t.upload(alice, gamma.id, { '../x.html': 'no' });
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(t.ctx.uploadGate.inFlight, 0);
    });

    await t.close();
    done();
})();
