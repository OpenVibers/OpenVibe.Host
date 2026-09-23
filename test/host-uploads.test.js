'use strict';
/**
 * Upload validation: path traversal, links and special files, hidden files, server-side code,
 * credentials, bad archives and gzip bombs are refused as a whole. A refused upload is a failed
 * deploy with a log and host.deploy.failed; nothing is stored and the active deploy is unchanged.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { boot, check, done } = require('./stageb/boot');
const { tarball } = require('./stageb/tar');

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const project = await t.project(alice, 'A');
    const site = await t.site(alice, project.id, 'uploads');
    const good = await t.deploy(alice, site.id, { 'index.html': 'GOOD' });
    const projectDir = path.join(t.dir, 'objects', 'projects', project.id);
    const countObjects = () => fs.readdirSync(projectDir).flatMap((d) => fs.readdirSync(path.join(projectDir, d))).length;
    let baseline = countObjects();

    async function refused(entries, code, { gzip = true, raw = null, contentType } = {}) {
        const before = t.events('host.deploy.failed').length;
        const r = await t.api('POST', `/api/v1/sites/${site.id}/deploys?activate=1`, { as: alice, body: raw || tarball(entries, { gzip }), headers: { 'content-type': contentType || 'application/gzip' } });
        assert.ok([413, 422].includes(r.status), `${code}: status ${r.status} ${r.text}`);
        const body = r.json();
        assert.strictEqual(body.code, code, `expected ${code}, got ${body.code}: ${body.detail}`);
        assert.match(body.deploy_id, /^dpl_/);
        assert.ok(body.log.some((l) => /deploy refused/.test(l)));
        const failed = (await t.api('GET', `/api/v1/deploys/${body.deploy_id}`, { as: alice })).json().deploy;
        assert.strictEqual(failed.state, 'failed');
        assert.strictEqual(failed.failure_code, code);
        assert.strictEqual(failed.file_count, 0);
        assert.strictEqual(t.events('host.deploy.failed').length, before + 1);
        assert.strictEqual((await t.get('uploads.openvibe.host', '/')).text, 'GOOD', 'the active deploy is unchanged');
        assert.strictEqual(countObjects(), baseline, 'nothing was stored');
        return body;
    }

    await check('path traversal in names: "..", absolute, embedded, backslash, pax and GNU long-name overrides', async () => {
        await refused([{ name: '../evil.html', content: 'x' }], 'deploy.path_traversal');
        await refused([{ name: '/etc/passwd', content: 'x' }], 'deploy.path_traversal');
        await refused([{ name: 'a/../../b.html', content: 'x' }], 'deploy.path_traversal');
        await refused([{ name: 'ok.html', content: 'x' }, { name: 'sub/./x.html', content: 'x' }], 'deploy.path_traversal');
        await refused([{ name: '..\\..\\evil.html', content: 'x' }], 'deploy.invalid_path');
        await refused([{ name: 'innocent.html', content: 'x', pax: { path: '../../etc/cron.d/x.html' } }], 'deploy.path_traversal');
        await refused([{ name: 'innocent.html', content: 'x', longName: `${'a'.repeat(120)}/../../../evil.html` }], 'deploy.path_traversal');
        await refused([{ name: 'a//b.html', content: 'x' }], 'deploy.invalid_path');
        await refused([{ name: 'café.html', content: 'x' }], 'deploy.invalid_path');
    });

    await check('symbolic links, hard links, devices and FIFOs are refused, never followed or skipped', async () => {
        await refused([{ name: 'index.html', content: 'x' }, { name: 'passwd.html', type: '2', linkname: '/etc/passwd' }], 'deploy.link_refused');
        await refused([{ name: 'up.html', type: '2', linkname: '../../host.db' }], 'deploy.link_refused');
        await refused([{ name: 'index.html', content: 'x' }, { name: 'hard.html', type: '1', linkname: 'index.html' }], 'deploy.link_refused');
        await refused([{ name: 'tty.html', type: '3' }], 'deploy.special_file_refused');
        await refused([{ name: 'disk.html', type: '4' }], 'deploy.special_file_refused');
        await refused([{ name: 'pipe.html', type: '6' }], 'deploy.special_file_refused');
        await refused([{ name: 'x.html', content: 'x', pax: { linkpath: '/etc/passwd' } }], 'deploy.link_refused');
    });

    await check('hidden files, server-side code, credentials and unknown types are refused with a reason', async () => {
        const env = await refused([{ name: 'index.html', content: 'x' }, { name: '.env', content: 'API_KEY=sk_live_should_never_be_served' }], 'deploy.invalid_path');
        assert.match(env.detail, /hidden file/);
        await refused([{ name: '.git/config', content: '[core]' }], 'deploy.invalid_path');
        const php = await refused([{ name: 'index.php', content: '<?php system($_GET["c"]); ?>' }], 'deploy.file_refused');
        assert.match(php.detail, /never runs anything/);
        await refused([{ name: 'cgi-bin/run.cgi', content: '#!/bin/sh' }], 'deploy.file_refused');
        await refused([{ name: 'page.shtml', content: '<!--#exec cmd="id" -->' }], 'deploy.file_refused');
        await refused([{ name: 'deploy.sh', content: 'rm -rf /' }], 'deploy.file_refused');
        await refused([{ name: 'server.key', content: '-----BEGIN PRIVATE KEY-----' }], 'deploy.file_refused');
        await refused([{ name: 'config.env', content: 'SECRET=1' }], 'deploy.file_refused');
        await refused([{ name: 'tool.exe', content: 'MZ' }], 'deploy.file_refused');
        await refused([{ name: 'thing.xyz', content: '?' }], 'deploy.type_not_allowed');
        const ok = await t.upload(alice, site.id, { '.well-known/security.txt': 'Contact: mailto:x@example.org', 'index.html': 'GOOD2' }, { activate: false });
        assert.strictEqual(ok.status, 201, '.well-known/ is published');
        baseline = countObjects();
    });

    await check('duplicates, file/directory conflicts, empty uploads and broken archives', async () => {
        await refused([{ name: 'a.html', content: '1' }, { name: './a.html', content: '2' }], 'deploy.duplicate_path');
        await refused([{ name: 'docs', content: '1' }, { name: 'docs/index.html', content: '2' }], 'deploy.path_conflict');
        await refused([], 'deploy.empty');
        await refused(null, 'archive.corrupt', { raw: Buffer.from('this is not an archive at all, not even close'.repeat(20)) });
        await refused(null, 'archive.corrupt', { raw: Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage')]) });
        const tar = tarball([{ name: 'a.html', content: 'x'.repeat(2000) }], { gzip: false });
        await refused(null, 'archive.corrupt', { raw: zlib.gzipSync(tar.subarray(0, 1200)) });
        const corrupt = Buffer.from(tarball([{ name: 'a.html', content: 'x' }], { gzip: false }));
        corrupt[10] ^= 0xff;   // breaks the header checksum
        await refused(null, 'archive.corrupt', { raw: corrupt, contentType: 'application/x-tar' });
    });

    await check('a gzip bomb stops at the project limit instead of filling memory', async () => {
        await t.api('PUT', `/api/v1/projects/${project.id}/quota`, { as: t.user('staff', { role: 'admin' }), json: { storage_bytes: 1024 * 1024 } });
        const bomb = tarball([{ name: 'zeros.txt', content: Buffer.alloc(40 * 1024 * 1024, 0) }]);
        assert.ok(bomb.length < 100 * 1024, 'a small upload');
        const body = await refused(null, 'deploy.too_large', { raw: bomb });
        assert.match(body.detail, /expands beyond|add up to/);
        await t.api('PUT', `/api/v1/projects/${project.id}/quota`, { as: t.user('staff2', { role: 'admin' }), json: { storage_bytes: null } });
    });

    await check('multipart filenames go through the same rules', async () => {
        const boundary = 'xxBOUNDARYxx';
        const part = (filename, content) => `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/html\r\n\r\n${content}\r\n`;
        for (const [name, code] of [['../../escape.html', 'deploy.path_traversal'], ['/etc/x.html', 'deploy.path_traversal'], ['.htaccess', 'deploy.invalid_path'], ['shell.php', 'deploy.file_refused']]) {
            const body = part('index.html', 'x') + part(name, 'y') + `--${boundary}--\r\n`;
            const r = await t.api('POST', `/api/v1/sites/${site.id}/deploys`, { as: alice, body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
            assert.strictEqual(r.status, 422, `${name}: ${r.text}`);
            assert.strictEqual(r.json().code, code, name);
        }
        const wrong = await t.api('POST', `/api/v1/sites/${site.id}/deploys`, { as: alice, body: 'x', headers: { 'content-type': 'text/plain' } });
        assert.strictEqual(wrong.status, 415);
    });

    await check('the failed deploys and their logs are visible to the owner; the good deploy is still active', async () => {
        const list = (await t.api('GET', `/api/v1/sites/${site.id}/deploys?limit=100`, { as: alice })).json();
        assert.strictEqual(list.active_deploy_id, good.id);
        assert.ok(list.deploys.filter((d) => d.state === 'failed').length >= 25);
        const one = list.deploys.find((d) => d.failure_code === 'deploy.link_refused');
        const log = (await t.api('GET', `/api/v1/deploys/${one.id}/log`, { as: alice })).json().log;
        assert.ok(log.some((l) => l.level === 'error' && /link/.test(l.message)));
        for (const e of t.events('host.deploy.failed')) assert.ok(!JSON.stringify(e).includes('sk_live'), 'no file contents in events');
    });

    await t.close();
    done();
})();
