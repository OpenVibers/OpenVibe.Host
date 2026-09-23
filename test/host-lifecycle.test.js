'use strict';
/**
 * Stage B end to end: project → site → deploy (tar.gz and multipart) → served by Host header with
 * the right headers → activate / roll back → logs and events.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    let project, site, d1, d2;

    await check('a signed-in person creates a project (prj_ id, owner, production quotas) and a site with its default domain', async () => {
        project = await t.project(alice, 'Alice site');
        assert.match(project.id, /^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(project.owner, alice.subject);
        assert.strictEqual(project.environment, 'production');
        assert.strictEqual(project.role, 'owner');
        assert.strictEqual(project.quota.deploys_per_day, 50);
        site = await t.site(alice, project.id, 'alice');
        assert.match(site.id, /^site_/);
        assert.strictEqual(site.hostname, 'alice.openvibe.host');
        assert.strictEqual(site.url, 'https://alice.openvibe.host');
        const r = await t.api('GET', `/api/v1/sites/${site.id}`, { as: alice });
        assert.deepStrictEqual(r.json().domains.map((d) => [d.hostname, d.kind, d.status]), [['alice.openvibe.host', 'default', 'verified']]);
    });

    await check('before any deploy the site answers with its own 404', async () => {
        const r = await t.get('alice.openvibe.host', '/');
        assert.strictEqual(r.status, 404);
        assert.match(r.text, /has not published anything yet/);
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    });

    await check('a tar.gz deploy is validated, stored content-addressed, activated and served with correct headers', async () => {
        const r = await t.upload(alice, site.id, {
            'index.html': '<!doctype html><h1>v1</h1>', 'about/index.html': '<p>about</p>', 'assets/app.3f2a9c1b.js': 'console.log(1)',
            'style.css': 'body{}', 'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', '404.html': '<h1>custom 404 v1</h1>', 'CNAME': 'alice.example',
        });
        assert.strictEqual(r.status, 201, r.text);
        const body = r.json();
        d1 = body.deploy;
        assert.match(d1.id, /^dpl_/);
        assert.strictEqual(d1.state, 'ready');
        assert.strictEqual(d1.active, true);
        assert.strictEqual(body.activated, true);
        assert.strictEqual(d1.file_count, 7);
        assert.match(d1.manifest_sha256, /^[0-9a-f]{64}$/);
        assert.ok(d1.log.some((l) => /nothing was executed/.test(l.message)));
        const page = await t.get('alice.openvibe.host', '/');
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.text, '<!doctype html><h1>v1</h1>');
        assert.strictEqual(page.headers['content-type'], 'text/html; charset=utf-8');
        assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');
        assert.match(page.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
        assert.match(page.headers['content-security-policy'], /object-src 'none'/);
        assert.strictEqual(page.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.match(page.headers.etag, /^"[0-9a-f]{64}"$/);
        assert.strictEqual(page.headers['set-cookie'], undefined, 'tenant responses never set cookies');
        assert.strictEqual(page.headers['x-openvibe-deploy'], d1.id);
        const js = await t.get('alice.openvibe.host', '/assets/app.3f2a9c1b.js');
        assert.strictEqual(js.headers['content-type'], 'text/javascript; charset=utf-8');
        assert.strictEqual(js.headers['cache-control'], 'public, max-age=31536000, immutable');
        const svg = await t.get('alice.openvibe.host', '/img/logo.svg');
        assert.strictEqual(svg.headers['content-type'], 'image/svg+xml');
        const cname = await t.get('alice.openvibe.host', '/CNAME');
        assert.strictEqual(cname.headers['content-type'], 'text/plain; charset=utf-8');
    });

    await check('ETag revalidation (304), HEAD, byte ranges, directory index and redirect, custom 404, 405', async () => {
        const first = await t.get('alice.openvibe.host', '/style.css');
        const again = await t.get('alice.openvibe.host', '/style.css', { headers: { 'if-none-match': first.headers.etag } });
        assert.strictEqual(again.status, 304);
        assert.strictEqual(again.body.length, 0);
        const head = await t.get('alice.openvibe.host', '/style.css', { method: 'HEAD' });
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers['content-length'], '6');
        const range = await t.get('alice.openvibe.host', '/style.css', { headers: { range: 'bytes=0-3' } });
        assert.strictEqual(range.status, 206);
        assert.strictEqual(range.text, 'body');
        assert.strictEqual(range.headers['content-range'], 'bytes 0-3/6');
        const bad = await t.get('alice.openvibe.host', '/style.css', { headers: { range: 'bytes=10-20' } });
        assert.strictEqual(bad.status, 416);
        const redirect = await t.get('alice.openvibe.host', '/about?x=1');
        assert.strictEqual(redirect.status, 301);
        assert.strictEqual(redirect.headers.location, '/about/?x=1');
        const about = await t.get('alice.openvibe.host', '/about/');
        assert.strictEqual(about.text, '<p>about</p>');
        const missing = await t.get('alice.openvibe.host', '/nope.html');
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.text, '<h1>custom 404 v1</h1>', 'the deploy\'s own 404.html');
        assert.match(missing.headers['content-security-policy'], /default-src 'self'/);
        const post = await t.get('alice.openvibe.host', '/', { method: 'POST', body: 'x' });
        assert.strictEqual(post.status, 405);
        assert.strictEqual(post.headers.allow, 'GET, HEAD');
    });

    await check('a second deploy (not activated) leaves the site unchanged; activate switches; rollback goes back', async () => {
        d2 = await t.deploy(alice, site.id, { 'index.html': '<h1>v2</h1>', '404.html': 'v2 404' }, { activate: false });
        assert.strictEqual(d2.active, false);
        assert.strictEqual((await t.get('alice.openvibe.host', '/')).text, '<!doctype html><h1>v1</h1>');
        const a = await t.api('POST', `/api/v1/deploys/${d2.id}/activate`, { as: alice, json: {} });
        assert.strictEqual(a.status, 200, a.text);
        assert.deepStrictEqual(a.json(), { active_deploy_id: d2.id, previous_deploy_id: d1.id, changed: true });
        assert.strictEqual((await t.get('alice.openvibe.host', '/')).text, '<h1>v2</h1>');
        assert.strictEqual((await t.get('alice.openvibe.host', '/style.css')).status, 404, 'files of the old deploy are gone from the site');
        const rb = await t.api('POST', `/api/v1/sites/${site.id}/rollback`, { as: alice, json: {} });
        assert.strictEqual(rb.status, 200, rb.text);
        assert.strictEqual(rb.json().active_deploy_id, d1.id);
        assert.strictEqual((await t.get('alice.openvibe.host', '/')).text, '<!doctype html><h1>v1</h1>');
        const rb2 = await t.api('POST', `/api/v1/sites/${site.id}/rollback`, { as: alice, json: { deploy_id: d2.id } });
        assert.strictEqual(rb2.json().active_deploy_id, d2.id);
        const list = (await t.api('GET', `/api/v1/sites/${site.id}/deploys`, { as: alice })).json();
        assert.strictEqual(list.active_deploy_id, d2.id);
        assert.deepStrictEqual(list.deploys.map((d) => d.id), [d2.id, d1.id]);
        assert.deepStrictEqual(list.activations.map((a2) => a2.kind), ['rollback', 'rollback', 'activate', 'activate']);
    });

    await check('multipart files upload with a browser folder name stripped, and a subfolder root', async () => {
        const boundary = '----hostboundary';
        const part = (name, filename, content) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n${filename ? 'Content-Type: application/octet-stream\r\n' : ''}\r\n${content}\r\n`;
        const body = part('strip', null, 'folder') + part('files', 'mysite/index.html', '<h1>v3</h1>') + part('files', 'mysite/css/a.css', 'a{}') + `--${boundary}--\r\n`;
        const r = await t.api('POST', `/api/v1/sites/${site.id}/deploys?activate=1`, { as: alice, body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().deploy.source, 'files');
        assert.ok(r.json().deploy.log.some((l) => /removed the uploaded folder name "mysite\/"/.test(l.message)));
        assert.strictEqual((await t.get('alice.openvibe.host', '/css/a.css')).text, 'a{}');
        const rooted = await t.upload(alice, site.id, { 'README.md': 'x', 'dist/index.html': '<h1>dist</h1>' }, { query: 'root=dist' });
        assert.strictEqual(rooted.status, 201, rooted.text);
        assert.strictEqual(rooted.json().deploy.file_count, 1);
        assert.strictEqual((await t.get('alice.openvibe.host', '/')).text, '<h1>dist</h1>');
    });

    await check('the deploy record: files with sha256 and type, and the upload log', async () => {
        const r = await t.api('GET', `/api/v1/deploys/${d1.id}`, { as: alice });
        const files = r.json().deploy.files;
        assert.ok(files.find((f) => f.path === 'about/index.html' && /^[0-9a-f]{64}$/.test(f.sha256) && f.content_type === 'text/html; charset=utf-8'));
        const log = await t.api('GET', `/api/v1/deploys/${d1.id}/log`, { as: alice });
        assert.ok(log.json().log.some((l) => /validated 7 files/.test(l.message)));
    });

    await check('events: created/activated in the outbox with valid envelopes and no file contents', async () => {
        const contracts = require('openvibe-contracts');
        const created = t.events('host.deploy.created');
        const activated = t.events('host.deploy.activated');
        assert.ok(created.length >= 4);
        assert.ok(activated.some((e) => e.payload.rollback === true));
        for (const e of [...created, ...activated]) {
            const v = contracts.validate('events.event-envelope@1', e);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.strictEqual(e.source, 'host');
            assert.deepStrictEqual(e.actor, { type: 'user', id: alice.subject });
            assert.ok(!JSON.stringify(e).includes('<h1>'));
        }
    });

    await check('deleting: the active deploy is refused; an old one is removed with its unshared objects', async () => {
        const list = (await t.api('GET', `/api/v1/sites/${site.id}/deploys`, { as: alice })).json();
        const active = list.active_deploy_id;
        const refused = await t.api('DELETE', `/api/v1/deploys/${active}`, { as: alice });
        assert.strictEqual(refused.status, 409);
        assert.strictEqual(refused.json().code, 'deploy.active');
        const before = (await t.api('GET', `/api/v1/projects/${project.id}/quota`, { as: alice })).json().usage.storage_bytes;
        const del = await t.api('DELETE', `/api/v1/deploys/${d1.id}`, { as: alice });
        assert.strictEqual(del.status, 200, del.text);
        assert.ok(del.json().objects_removed > 0);
        const after = (await t.api('GET', `/api/v1/projects/${project.id}/quota`, { as: alice })).json().usage.storage_bytes;
        assert.ok(after < before);
        assert.strictEqual((await t.api('GET', `/api/v1/deploys/${d1.id}`, { as: alice })).status, 404);
        const rb = await t.api('POST', `/api/v1/sites/${site.id}/rollback`, { as: alice, json: { deploy_id: d1.id } });
        assert.strictEqual(rb.status, 404, 'a deleted deploy cannot come back');
    });

    await check('deleting the site stops serving at once and frees the name only for its own project for 30 days', async () => {
        const del = await t.api('DELETE', `/api/v1/sites/${site.id}`, { as: alice });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual((await t.get('alice.openvibe.host', '/')).status, 404);
        assert.match((await t.get('alice.openvibe.host', '/')).text, /Unknown host/);
        const bob = t.user('bob');
        const bp = await t.project(bob, 'Bob');
        const taken = await t.api('POST', `/api/v1/projects/${bp.id}/sites`, { as: bob, json: { name: 'alice' } });
        assert.strictEqual(taken.status, 409);
        assert.strictEqual(taken.json().code, 'site.name_held');
        const mine = await t.api('POST', `/api/v1/projects/${project.id}/sites`, { as: alice, json: { name: 'alice' } });
        assert.strictEqual(mine.status, 201);
    });

    await t.close();
    done();
})();
