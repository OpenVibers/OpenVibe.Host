'use strict';
/**
 * Git deploys, Phase 1 (plan T12 Stage B): a site's Git source is public provenance (repository +
 * branch) set by a maintainer; the project's own CI builds the commit and posts the output to
 * POST /api/v1/sites/:id/source/deploys with an app deployer token. Host validates the files like any
 * upload, stores a source=git deploy with an immutable host_deploy_git row and makes it the site's
 * preview; it never activates on arrival, and every refusal leaves the active deploy untouched.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');
const { site: siteTar } = require('./stageb/tar');

const SHA = 'a'.repeat(40);
const SHA256 = '0123456789abcdef'.repeat(4);
const SOURCE_KEYS = ['created_at', 'created_by', 'provider', 'ref', 'repo_url', 'site_id', 'updated_at', 'updated_by'];

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const dora = t.user('dora');
    const mallory = t.user('mallory');
    const project = await t.project(alice, 'Git');
    const site = await t.site(alice, project.id, 'gitsite');
    const other = await t.site(alice, project.id, 'unlinked');
    await t.api('PUT', `/api/v1/projects/${project.id}/members/${dora.subject}`, { as: alice, json: { role: 'deployer' } });
    const live = await t.deploy(alice, site.id, { 'index.html': 'LIVE' });
    await t.deploy(alice, other.id, { 'index.html': 'OTHER' });

    const { ids } = require('openvibe-contracts');
    const appId = ids.newId('app');
    const ci = t.network.appToken(appId, ['host.site.manage', 'host.deploy.create']);
    assert.strictEqual((await t.api('PUT', `/api/v1/projects/${project.id}/members/app:${appId}`, { as: alice, json: { role: 'deployer' } })).status, 200);

    const db = t.ctx.store.db;
    const pointers = async (id = site.id) => await db.prepare('SELECT active_deploy_id, preview_deploy_id FROM host_sites WHERE id = ?').get(id);
    const putSource = (as, body, id = site.id) => t.api('PUT', `/api/v1/sites/${id}/source`, { as, json: body });
    const ingest = (files, query, { as = ci, id = site.id } = {}) => t.api('POST', `/api/v1/sites/${id}/source/deploys?${query}`, { as, body: siteTar(files), headers: { 'content-type': 'application/gzip' } });
    const assertSource = (s) => assert.deepStrictEqual(Object.keys(s).sort(), SOURCE_KEYS, `only the allowlisted source fields: ${JSON.stringify(s)}`);

    await check('a maintainer connects a source (200); a deployer gets 403, a non-member 404, the read role can GET', async () => {
        const r = await putSource(alice, { provider: 'github', repo_url: 'https://github.com/OpenVibers/site.git', ref: 'main' });
        assert.strictEqual(r.status, 200, r.text);
        const src = r.json().source;
        assertSource(src);
        assert.deepStrictEqual([src.provider, src.repo_url, src.ref, src.site_id], ['github', 'https://github.com/OpenVibers/site', 'main', site.id]);
        const dep = await putSource(dora, { repo_url: 'https://github.com/x/y', ref: 'main' });
        assert.strictEqual(dep.status, 403, dep.text);
        assert.strictEqual(dep.json().code, 'project.role_insufficient');
        assert.strictEqual((await t.api('DELETE', `/api/v1/sites/${site.id}/source`, { as: dora })).status, 403);
        assert.strictEqual((await putSource(mallory, { repo_url: 'https://github.com/x/y', ref: 'main' })).status, 404);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${site.id}/source`, { as: mallory })).status, 404);
        const read = await t.api('GET', `/api/v1/sites/${site.id}/source`, { as: dora });
        assert.strictEqual(read.status, 200, read.text);
        assertSource(read.json().source);
        assert.strictEqual(read.json().source.ref, 'main');
    });

    await check('a bad URL, provider or ref is 422 and changes nothing', async () => {
        const bad = [
            [{ repo_url: 'http://github.com/a/b', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'git@github.com:a/b.git', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'ssh://github.com/a/b', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://user:tok@github.com/a/b', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://github.com:8443/a/b', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://github.com/a/b?x=1', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://github.com/a/b#frag', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://github.com/a/b/c', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://evil.example/a/b', ref: 'main' }, 'source.repo_url'],
            [{ repo_url: 'https://127.0.0.1/a/b', ref: 'main' }, 'source.repo_url'],
            [{ provider: 'bitbucket', repo_url: 'https://github.com/a/b', ref: 'main' }, 'source.provider'],
            [{ provider: 'gitlab', repo_url: 'https://github.com/a/b', ref: 'main' }, 'source.provider'],
            [{ repo_url: 'https://github.com/a/b', ref: '' }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: '-main' }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: 'a..b' }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: 'main~1' }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: 'x.lock' }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: 'a b' }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: 'b'.repeat(201) }, 'source.ref'],
            [{ repo_url: 'https://github.com/a/b', ref: 'main', token: 'ghp_secret' }, 'source.unknown_field'],
        ];
        for (const [body, code] of bad) {
            const r = await putSource(alice, body);
            assert.strictEqual(r.status, 422, `${JSON.stringify(body)}: ${r.status} ${r.text}`);
            assert.strictEqual(r.json().code, code, `${JSON.stringify(body)}: ${r.text}`);
            assert.ok(!r.text.includes('ghp_secret'));
        }
        const now = (await t.api('GET', `/api/v1/sites/${site.id}/source`, { as: alice })).json().source;
        assert.strictEqual(now.repo_url, 'https://github.com/OpenVibers/site');
        for (const ok of [{ repo_url: 'https://gitlab.com/g/p', ref: 'release/1.2' }, { repo_url: 'https://codeberg.org/o/r.git', ref: 'feature/x-y_z' }]) {
            const r = await putSource(alice, ok, other.id);
            assert.strictEqual(r.status, 200, r.text);
        }
        assert.strictEqual((await t.api('DELETE', `/api/v1/sites/${other.id}/source`, { as: alice })).status, 200);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${other.id}/source`, { as: alice })).json().source, null);
    });

    let git = null;
    await check('an app deployer ingests a build: source=git, provenance row, preview set, the old deploy still served', async () => {
        const created = (await t.events('host.deploy.created')).length;
        const r = await ingest({ 'index.html': 'FROM GIT' }, `ref=main&commit_sha=${SHA}`);
        assert.strictEqual(r.status, 201, r.text);
        const body = r.json();
        git = body.deploy;
        assert.strictEqual(git.source, 'git');
        assert.strictEqual(git.state, 'ready');
        assert.strictEqual(git.active, false);
        assert.strictEqual(git.created_by, `app:${appId}`);
        assert.deepStrictEqual(git.git, { provider: 'github', repo_url: 'https://github.com/OpenVibers/site', ref: 'main', commit_sha: SHA });
        assert.strictEqual(body.activated, false);
        assert.strictEqual(body.preview.deploy_id, git.id);
        const row = await db.prepare('SELECT * FROM host_deploy_git WHERE deploy_id = ?').get(git.id);
        assert.deepStrictEqual([row.provider, row.repo_url, row.ref, row.commit_sha], ['github', 'https://github.com/OpenVibers/site', 'main', SHA]);
        assert.deepStrictEqual(await pointers(), { active_deploy_id: live.id, preview_deploy_id: git.id });
        assert.strictEqual((await t.get('gitsite.openvibe.host', '/')).text, 'LIVE');
        assert.strictEqual((await t.events('host.deploy.created')).length, created + 1);
        assert.strictEqual((await t.events('host.deploy.created')).pop().payload.source, 'git');
        const listed = (await t.api('GET', `/api/v1/sites/${site.id}/deploys`, { as: dora })).json().deploys.find((d) => d.id === git.id);
        assert.strictEqual(listed.git.commit_sha, SHA);
        const one = (await t.api('GET', `/api/v1/deploys/${git.id}`, { as: dora })).json().deploy;
        assert.deepStrictEqual(Object.keys(one.git).sort(), ['commit_sha', 'provider', 'ref', 'repo_url']);
        // A user Bearer token (a deployer) may ingest too; a 64-hex SHA-256 commit id is accepted.
        const byUser = await ingest({ 'index.html': 'FROM GIT 2' }, `ref=main&commit_sha=${SHA256}`, { as: dora });
        assert.strictEqual(byUser.status, 201, byUser.text);
        assert.strictEqual(byUser.json().deploy.git.commit_sha, SHA256);
        assert.strictEqual((await pointers()).active_deploy_id, live.id);
        git = byUser.json().deploy;
    });

    await check('activate approves it: active_deploy_id flips, the preview clears, the site serves it', async () => {
        const r = await t.api('POST', `/api/v1/deploys/${git.id}/activate`, { as: ci, json: { expected_active: live.id } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(await pointers(), { active_deploy_id: git.id, preview_deploy_id: null });
        assert.strictEqual((await t.get('gitsite.openvibe.host', '/')).text, 'FROM GIT 2');
        assert.strictEqual((await t.events('host.deploy.activated')).pop().payload.deploy_id, git.id);
    });

    await check('refusals leave active_deploy_id unchanged; an invalid file is a failed deploy + host.deploy.failed', async () => {
        const before = await pointers();
        const failedBefore = (await t.events('host.deploy.failed')).length;
        const deploysBefore = (await db.prepare('SELECT COUNT(*) AS n FROM host_deploys').get()).n;

        const bad = await ingest({ 'index.html': 'x', 'shell.php': '<?php system($_GET[1]);' }, `ref=main&commit_sha=${SHA}`);
        assert.strictEqual(bad.status, 422, bad.text);
        const failed = (await t.api('GET', `/api/v1/deploys/${bad.json().deploy_id}`, { as: alice })).json().deploy;
        assert.deepStrictEqual([failed.state, failed.source], ['failed', 'git']);
        assert.strictEqual((await t.events('host.deploy.failed')).length, failedBefore + 1);
        assert.strictEqual(await db.prepare('SELECT 1 FROM host_deploy_git WHERE deploy_id = ?').get(failed.id), undefined, 'no provenance row for a refused deploy');

        const mismatch = await ingest({ 'index.html': 'x' }, `ref=dev&commit_sha=${SHA}`);
        assert.strictEqual(mismatch.status, 409, mismatch.text);
        assert.strictEqual(mismatch.json().code, 'source.ref_mismatch');
        const noRef = await ingest({ 'index.html': 'x' }, `commit_sha=${SHA}`);
        assert.strictEqual(noRef.status, 422, noRef.text);
        for (const sha of ['abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41), '']) {
            const r = await ingest({ 'index.html': 'x' }, `ref=main&commit_sha=${sha}`);
            assert.strictEqual(r.status, 422, `${sha}: ${r.text}`);
            assert.strictEqual(r.json().code, 'source.commit_sha');
        }
        const unlinked = await ingest({ 'index.html': 'x' }, `ref=main&commit_sha=${SHA}`, { id: other.id, as: alice });
        assert.strictEqual(unlinked.status, 409, unlinked.text);
        assert.strictEqual(unlinked.json().code, 'source.not_connected');
        const act = await ingest({ 'index.html': 'x' }, `ref=main&commit_sha=${SHA}&activate=1`);
        assert.strictEqual(act.status, 422, act.text);
        assert.strictEqual(act.json().code, 'source.activate');

        assert.deepStrictEqual(await pointers(), before);
        assert.strictEqual((await t.get('gitsite.openvibe.host', '/')).text, 'FROM GIT 2');
        assert.strictEqual((await pointers(other.id)).active_deploy_id, (await db.prepare('SELECT id FROM host_deploys WHERE site_id = ? AND state = \'ready\'').get(other.id)).id);
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM host_deploys').get()).n, deploysBefore + 1, 'only the invalid file left a (failed) deploy');
        assert.strictEqual((await t.events('host.deploy.failed')).length, failedBefore + 1);
    });

    await check('activate as a multipart field is refused too, and a non-member cannot ingest', async () => {
        const boundary = 'xGitBoundary';
        const tar = siteTar({ 'index.html': 'MP' });
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="activate"\r\n\r\n1\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="site.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`),
            tar, Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const before = await pointers();
        const r = await t.api('POST', `/api/v1/sites/${site.id}/source/deploys?ref=main&commit_sha=${SHA}`, { as: ci, body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json().code, 'source.activate');
        assert.strictEqual((await ingest({ 'index.html': 'x' }, `ref=main&commit_sha=${SHA}`, { as: mallory })).status, 404);
        assert.deepStrictEqual(await pointers(), before);
    });

    await check('the dashboard form (form token + origin) saves and removes a source at maintain; a deployer cannot', async () => {
        const { csrfToken } = require('../server/auth/forms');
        const origin = { origin: 'https://openvibe.host' };
        const form = (user, p, body) => t.api('POST', p, { session: user, form: { csrf: csrfToken({ formSecret: 'test-form-secret' }, { subject: user.subject }), ...body }, headers: origin });
        const saved = await form(alice, `/sites/${other.id}/source`, { repo_url: 'https://codeberg.org/o/r', ref: 'pages' });
        assert.strictEqual(saved.status, 303, saved.text);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${other.id}/source`, { as: alice })).json().source.ref, 'pages');
        const forged = await t.api('POST', `/sites/${other.id}/source`, { session: alice, form: { csrf: 'nope', repo_url: 'https://github.com/x/y', ref: 'main' }, headers: origin });
        assert.notStrictEqual(forged.status, 303);
        assert.strictEqual((await form(dora, `/sites/${other.id}/source/remove`, {})).status, 403);
        assert.strictEqual((await form(alice, `/sites/${other.id}/source/remove`, {})).status, 303);
        assert.strictEqual((await t.api('GET', `/api/v1/sites/${other.id}/source`, { as: alice })).json().source, null);
    });

    await check('host_deploy_git rows are immutable', async () => {
        await assert.rejects(db.prepare("UPDATE host_deploy_git SET commit_sha = 'b' WHERE deploy_id = ?").run(git.id), /immutable/);
        await assert.rejects(db.prepare("UPDATE host_deploy_git SET ref = 'dev' WHERE deploy_id = ?").run(git.id), /immutable/);
        assert.strictEqual((await db.prepare('SELECT commit_sha FROM host_deploy_git WHERE deploy_id = ?').get(git.id)).commit_sha, SHA256);
    });

    await t.close();
    done();
})();
