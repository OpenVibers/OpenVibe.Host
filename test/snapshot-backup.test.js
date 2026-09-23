'use strict';
const assert = require('assert');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { readTarGz } = require('../lib/tar');

runTests([
    test('snapshot: units, vhost, env NAMES and sha in a tarball with no secret values', async () => {
        const host = scenario();
        host.put('/etc/systemd/system/openvibe-live.service', `[Service]\nEnvironment=NODE_ENV=production "ADMIN_TOKEN=${SECRET}" PORT=3000\nEnvironmentFile=/etc/openvibe/live.env\n`);
        host.units.get('openvibe-live.service').dropIns = ['/etc/systemd/system/openvibe-live.service.d/socket.conf'];
        host.put('/etc/systemd/system/openvibe-live.service.d/socket.conf', '[Unit]\nRequires=openvibe-live.socket\n');
        host.put('/etc/systemd/system/openvibe-live.socket', '[Socket]\nListenStream=0.0.0.0:3000\n');
        host.put('/etc/nginx/sites-available/openvibe.live.conf', 'server { server_name openvibe.live; }\n');
        const r = await host.cli('snapshot', 'live', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const res = JSON.parse(r.out);
        assert.match(res.file, /^\/var\/lib\/openvibe-host\/snapshots\/live-\d{8}-\d{6}-[0-9a-f]{12}\.tar\.gz$/);
        const entry = host.files.get(res.file);
        assert.strictEqual(entry.mode, 0o640);
        const tar = readTarGz(entry.content);
        const names = tar.map((e) => e.name);
        assert.deepStrictEqual(names, ['snapshot.json', 'env/live.env.names', 'units/openvibe-live.service', 'units/openvibe-live.service.d/socket.conf', 'units/openvibe-live.socket', 'nginx/openvibe.live.conf']);
        const all = tar.map((e) => e.content).join('\n');
        assert.ok(!all.includes(SECRET), 'a secret value leaked into the snapshot');
        assert.ok(!all.includes('ghp_FAKE_TOKEN_VALUE'), 'remote URL credentials leaked');
        const unit = tar.find((e) => e.name === 'units/openvibe-live.service').content;
        assert.match(unit, /ADMIN_TOKEN=<redacted>/);
        assert.match(unit, /NODE_ENV=production/);
        assert.strictEqual(tar.find((e) => e.name === 'env/live.env.names').content, 'JWT_SECRET\nBASE_URL\nPAYPAL_CLIENT_SECRET\nOV_OAUTH_CLIENT_SECRET\n');
        const meta = JSON.parse(tar[0].content);
        assert.strictEqual(meta.sha, host.repo('live').head);
        assert.strictEqual(meta.remote, 'https://github.com/OpenVibers/openvibe.live.git');
        assert.strictEqual(meta.manifest.id, 'live');
        assert.deepStrictEqual(meta.env.names, ['JWT_SECRET', 'BASE_URL', 'PAYPAL_CLIENT_SECRET', 'OV_OAUTH_CLIENT_SECRET']);
        assert.ok(meta.lockfiles['.']);
    }),

    test('backup: sqlite .backup of each declared database, run as the service user, into a dated directory', async () => {
        const host = scenario();
        const r = await host.cli('backup', 'media', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const res = JSON.parse(r.out);
        assert.match(res.dir, /^\/var\/backups\/openvibe\/media\/20260922-120000$/);
        assert.strictEqual(res.files[0].dest, `${res.dir}/media.db`);
        const call = host.sqliteCalls.find((c) => c.op === 'backup');
        assert.strictEqual(call.as, 'ubuntu');
        assert.strictEqual(call.db, '/opt/openvibe.media/data/media.db');
        assert.strictEqual(host.files.get(res.dir).owner, 'ubuntu', 'backup dir owned by the service user');
        const log = host.read('/var/lib/openvibe-host/backups/media.jsonl');
        assert.strictEqual(JSON.parse(log.trim()).files[0].dest, res.files[0].dest);
        // A second backup in the same second never overwrites the first.
        const again = await host.cli('backup', 'media');
        assert.notStrictEqual(again.code, 0);
    }),

    test('backup refuses a service without declared databases', async () => {
        const host = scenario();
        const r = await host.cli('backup', 'tools');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /declares no databases/);
    }),
]);
