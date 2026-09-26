'use strict';
/**
 * ovhost archive (WS-S task 6, H14): dead and backup database files are encrypted and copied off-host
 * under <prefix>-archive/, checked, listed and restored, and never deleted locally. Refused: live
 * (inventory) databases, open files, symlinks, paths outside the allowed roots, relative paths.
 * Nothing leaves the process (an in-memory S3).
 */
const assert = require('assert');
const crypto = require('crypto');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { main } = require('../lib/cli');
const { mockS3 } = require('./s3-mock');

const KEY_HEX = crypto.createHash('sha256').update('archive test key').digest('hex');
const S3_SECRET = `${SECRET}-s3`;

function archiveHost() {
    const host = scenario();
    host.put('/etc/openvibe/backup.env', [
        'BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com',
        'BACKUP_S3_BUCKET=openvibe-backups-test',
        'BACKUP_S3_PREFIX=openvibe-backups',
        'BACKUP_S3_KEY_ID=004keyid0000000000000001',
        `BACKUP_S3_SECRET="${S3_SECRET}"`,
        'BACKUP_ENCRYPTION_KEY_FILE=/etc/openvibe/backup.key',
        '',
    ].join('\n'), { mode: 0o600, owner: 'root' });
    host.put('/etc/openvibe/backup.key', `${KEY_HEX}\n`, { mode: 0o600, owner: 'root' });
    host.put('/opt/backups/old/hobostreamer.db', Buffer.from(`SQLite format 3\0 old site ${'x'.repeat(9000)}`), { owner: 'root' });
    host.put('/var/lib/openvibe-chat/live-snap-a.db', Buffer.from(`SQLite format 3\0 snapshot ${'y'.repeat(3000)}`), { owner: 'root' });
    host.put('/var/lib/openvibe-chat/in-use.db', 'SQLite format 3\0 open', { owner: 'root' });
    host.put('/etc/passwd-copy.db', 'nope', { owner: 'root' });
    host.openFiles = new Set(['/var/lib/openvibe-chat/in-use.db']);
    host.s3 = mockS3();
    host.cli = async (...argv) => {
        const lines = [];
        const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {}, s3: () => host.s3 });
        return { code, out: lines.join('\n') };
    };
    return host;
}

const noSecrets = (text) => { for (const s of [S3_SECRET, SECRET, KEY_HEX]) assert.ok(!String(text).includes(s), 'a secret value leaked'); };

runTests([
    test('push encrypts, uploads under the archive prefix, checks, records, and deletes nothing', async () => {
        const host = archiveHost();
        const r = await host.cli('archive', 'push', '/opt/backups/old/hobostreamer.db', '/var/lib/openvibe-chat/live-snap-a.db', '--note', 'H14 first pass');
        assert.strictEqual(r.code, 0, r.out);
        noSecrets(r.out);
        assert.match(r.out, /ARCHIVE ok: 2 file\(s\) at s3:\/\/openvibe-backups-test\/openvibe-backups-archive\/.+\/\d{8}-\d{6}\/.*Nothing was deleted/);
        const keys = [...host.s3.objects.keys()];
        assert.ok(keys.every((k) => k.startsWith('openvibe-backups-archive/')), 'outside the backup runs prefix (retention never prunes it)');
        const obj = keys.find((k) => k.endsWith('opt__backups__old__hobostreamer.db.ovbk'));
        assert.ok(obj, keys.join(', '));
        assert.ok(!host.s3.objects.get(obj).includes(Buffer.from('old site')), 'the bytes are encrypted');
        assert.ok(host.read('/opt/backups/old/hobostreamer.db') !== null && host.read('/var/lib/openvibe-chat/live-snap-a.db') !== null, 'the local files stay');
        const manifestKey = keys.find((k) => k.endsWith('/manifest.json'));
        const m = JSON.parse(host.s3.objects.get(manifestKey).toString('utf8'));
        assert.deepStrictEqual(m.files.map((f) => f.path), ['/opt/backups/old/hobostreamer.db', '/var/lib/openvibe-chat/live-snap-a.db']);
        assert.strictEqual(m.note, 'H14 first pass');
        assert.ok(m.hmac && m.files.every((f) => /^[0-9a-f]{64}$/.test(f.plainSha256)));
        const rec = [...host.files.keys()].find((k) => k.startsWith('/var/lib/openvibe-host/archives/'));
        assert.ok(rec, 'a local record');
        noSecrets(host.read(rec));

        const list = await host.cli('archive', 'list');
        assert.strictEqual(list.code, 0);
        assert.match(list.out, /\d{8}-\d{6}\s+2 file\(s\).*H14 first pass/);

        const st = m.stamp;
        const back = await host.cli('archive', 'restore', st, '/opt/backups/old/hobostreamer.db', '--out', '/var/lib/openvibe-restore/h14');
        assert.strictEqual(back.code, 0, back.out);
        assert.strictEqual(host.read('/var/lib/openvibe-restore/h14/hobostreamer.db'), host.read('/opt/backups/old/hobostreamer.db'), 'restored byte for byte');
        const again = await host.cli('archive', 'restore', st, '/opt/backups/old/hobostreamer.db', '--out', '/var/lib/openvibe-restore/h14');
        assert.notStrictEqual(again.code, 0, 'restore never overwrites');
    }),

    test('refusals: live databases, open files, symlinks, outside roots, relative paths; nothing uploaded', async () => {
        const host = archiveHost();
        const liveDb = Object.values(host.inv.services).flatMap((s) => s.databases.map((d) => d.path))[0];
        assert.ok(liveDb, 'the scenario declares a database');
        host.put(liveDb, 'SQLite format 3\0 live', { owner: 'ubuntu' });
        await host.exec.symlink('/opt/backups/old/hobostreamer.db', '/opt/backups/old/link.db');
        for (const [file, why] of [['/opt/backups/old/link.db', /not a regular file/], [liveDb, /inventory declares/], ['/var/lib/openvibe-chat/in-use.db', /open by a running process/], ['/etc/passwd-copy.db', /outside/], ['relative.db', /absolute/], ['/opt/backups/../etc/x.db', /normalised/], ['/opt/backups/none.db', /no such file/]]) {
            const r = await host.cli('archive', 'push', '/opt/backups/old/hobostreamer.db', file);
            assert.strictEqual(r.code, 1, `${file}: ${r.out}`);
            assert.match(r.out, why, file);
            assert.strictEqual(host.s3.objects.size, 0, `${file}: nothing is uploaded when any file is refused`);
        }
    }),
]);
