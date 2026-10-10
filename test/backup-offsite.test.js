'use strict';
/**
 * ovhost backup --all, retention, permissions, the off-host copy (encryption + a mocked S3 client)
 * and restore-download, all against the fake host. No S3 request leaves the process.
 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { main } = require('../lib/cli');
const bcrypto = require('../lib/backup-crypto');
const retention = require('../lib/retention');
const offsite = require('../lib/offsite');
const { normalise } = require('../lib/inventory');
const { mockS3 } = require('./s3-mock');
const { readTarGz } = require('../lib/tar');

const DAY = 86400000;
const KEY_HEX = crypto.createHash('sha256').update('test backup key').digest('hex');
const S3_SECRET = `${SECRET}-s3`;
const TENANT_BLOB = 'tenant object bytes\n';

/** The standard fake host plus AI (two databases) and OpenRestream (not deployed), a backup env and key. */
function backupHost({ envMode = 0o600, keyMode = 0o600, envOwner = 'root', env = null } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.ai = { repo: '/opt/openvibe.ai', units: [], databases: [{ name: 'ai', engine: 'postgresql', database: 'ov_ai' }, { name: 'ai-extra', engine: 'postgresql', database: 'ov_ai_extra' }] };
    doc.services.openre = { repo: '/opt/openre', units: [], databases: [{ name: 'openre', engine: 'postgresql', database: 'ov_openre' }] };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    for (const db of ['ov_ai', 'ov_ai_extra', 'ov_openre']) host.pgDatabases.add(db);
    host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 3600 } }];
    host.put('/etc/openvibe/backup.env', env || [
        '# off-host backups',
        'BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com',
        'BACKUP_S3_BUCKET=openvibe-backups-test',
        'BACKUP_S3_PREFIX=openvibe-backups',
        'BACKUP_S3_KEY_ID=004keyid0000000000000001',
        `BACKUP_S3_SECRET="${S3_SECRET}"`,
        'BACKUP_ENCRYPTION_KEY_FILE=/etc/openvibe/backup.key',
        '',
    ].join('\n'), { mode: envMode, owner: envOwner });
    host.put('/etc/openvibe/backup.key', `${KEY_HEX}\n`, { mode: keyMode, owner: 'root' });
    host.s3 = mockS3();
    host.s3Configs = [];
    host.cli = async (...argv) => {
        const lines = [];
        const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {}, s3: (cfg) => { host.s3Configs.push(cfg); return host.s3; } });
        return { code, out: lines.join('\n') };
    };
    return host;
}

function dirsOf(host, dir) {
    return [...host.files.keys()].filter((k) => path.dirname(k) === dir).map((k) => path.basename(k)).sort();
}

/** backupHost plus a PostgreSQL-only service "trade" and a fresh pgBackRest differential. */
function pgOffsiteHost({ dumpContent = null } = {}) {
    const host = backupHost();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.trade = { repo: '/opt/openvibe.trade', units: [], databases: [{ name: 'trade', engine: 'postgresql', database: 'ov_trade' }] };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    host.pgDatabases.add('ov_trade');
    host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 3600 } }];
    if (dumpContent) host.dumpContent = dumpContent;
    return host;
}

function noSecrets(text, what) {
    for (const s of [S3_SECRET, SECRET, KEY_HEX]) assert.ok(!String(text).includes(s), `${what} leaked a secret value`);
}

/** backupHost plus a service "host" on PostgreSQL with a declared content-addressed object directory. */
function objectsHost() {
    const host = backupHost();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.host = {
        repo: '/opt/openvibe.host',
        units: [],
        databases: [{ name: 'host', engine: 'postgresql', database: 'ov_host' }],
        objects: [{ name: 'objects', path: '/var/lib/openvibe-host-api/objects' }],
    };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    host.pgDatabases.add('ov_host');
    host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 3600 } }];
    host.tenantSha = crypto.createHash('sha256').update(TENANT_BLOB).digest('hex');
    host.put(`/var/lib/openvibe-host-api/objects/projects/prj_1/${host.tenantSha.slice(0, 2)}/${host.tenantSha}`, TENANT_BLOB, { owner: 'ubuntu', mode: 0o644 });
    return host;
}

async function decrypt(key, buf) {
    const chunks = [];
    await pipeline(Readable.from([buf]), bcrypto.createDecryptStream(key), async (src) => { for await (const c of src) chunks.push(c); });
    return Buffer.concat(chunks);
}

async function encrypt(key, buf, opts) {
    const chunks = [];
    const pieces = [];
    for (let i = 0; i < buf.length; i += 777) pieces.push(buf.subarray(i, i + 777));
    await pipeline(Readable.from(pieces), bcrypto.createEncryptStream(key, opts), async (src) => { for await (const c of src) chunks.push(c); });
    return Buffer.concat(chunks);
}

runTests([
    // ── encryption ─────────────────────────────────────────────────────────────
    test('encryption: round trip at every chunk boundary; sizes match encryptedSize()', async () => {
        const key = crypto.randomBytes(32);
        const C = 4096;
        for (const n of [0, 1, C - 1, C, C + 1, 3 * C, 3 * C + 17]) {
            const plain = crypto.randomBytes(n);
            const enc = await encrypt(key, plain, { chunkSize: C });
            assert.strictEqual(enc.length, bcrypto.encryptedSize(n, C), `size for ${n}`);
            assert.strictEqual(enc.subarray(0, 8).toString(), 'OVBKAES1');
            assert.ok(n < 64 || !enc.includes(plain.subarray(0, 64)), 'plaintext visible in ciphertext');
            assert.ok((await decrypt(key, enc)).equals(plain), `round trip for ${n}`);
        }
        // Two encryptions of the same file differ (a fresh salt per file).
        const p = Buffer.from('same');
        assert.ok(!(await encrypt(key, p)).equals(await encrypt(key, p)));
    }),

    test('encryption: tampering, truncation, appended data, a header edit and another key all fail', async () => {
        const key = crypto.randomBytes(32);
        const C = 1024;
        const plain = crypto.randomBytes(3 * C + 100);
        const enc = await encrypt(key, plain, { chunkSize: C });
        const flip = Buffer.from(enc); flip[bcrypto.HEADER_LEN + C + 5] ^= 1;
        await assert.rejects(decrypt(key, flip), /failed authentication/);
        // Cut exactly after the second whole chunk: the last one left lacks the final flag.
        await assert.rejects(decrypt(key, enc.subarray(0, bcrypto.HEADER_LEN + 2 * (C + 16))), /failed authentication/);
        await assert.rejects(decrypt(key, enc.subarray(0, enc.length - 1)), /failed authentication/);
        await assert.rejects(decrypt(key, enc.subarray(0, 20)), /truncated/);
        await assert.rejects(decrypt(key, Buffer.concat([enc, enc.subarray(bcrypto.HEADER_LEN)])), /failed authentication/);
        const hdr = Buffer.from(enc); hdr[20] ^= 1; // the salt
        await assert.rejects(decrypt(key, hdr), /failed authentication/);
        await assert.rejects(decrypt(crypto.randomBytes(32), enc), /another key/);
        assert.ok((await decrypt(key, enc)).equals(plain));
    }),

    test('encryption key file: 64 hex characters or base64; errors never echo the text', () => {
        const k = crypto.randomBytes(32);
        assert.ok(bcrypto.parseKey(`${k.toString('hex')}\n`).equals(k));
        assert.ok(bcrypto.parseKey(k.toString('base64')).equals(k));
        assert.throws(() => bcrypto.parseKey('hunter2-not-a-key'), (err) => !err.message.includes('hunter2') && /64 hex/.test(err.message));
        assert.match(bcrypto.keyId(k), /^[0-9a-f]{16}$/);
    }),

    // ── retention ──────────────────────────────────────────────────────────────
    test('retention policy: newest per day for 7 days, newest per ISO week for 4 weeks', () => {
        const stamps = [];
        for (let d = 0; d < 60; d++) {
            const t = Date.parse('2026-08-01T03:30:00Z') + d * DAY;
            stamps.push(new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15));
            stamps.push(new Date(t + 3600000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)); // a second backup that day
        }
        const kept = [...retention.keep(stamps, { daily: 7, weekly: 4 })].sort();
        // Last day 2026-09-29 (Tue). Days 09-23..09-29; weeks W40 (09-29), W39 (09-27), W38 (09-20), W37 (09-13).
        assert.deepStrictEqual(kept, ['20260913-043000', '20260920-043000', '20260923-043000', '20260924-043000', '20260925-043000', '20260926-043000', '20260927-043000', '20260928-043000', '20260929-043000']);
        assert.strictEqual(retention.isoWeek(Date.parse('2021-01-03T00:00:00Z')), '2020-W53');
        assert.deepStrictEqual([...retention.keep(['junk', '20260101-000000'])], ['20260101-000000']);
    }),

    test('PostgreSQL dump copies are root-only and staging is emptied', async () => {
        const host = backupHost();
        host.ensureDir('/var/backups/openvibe/live', 'ubuntu', 0o750);
        const r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 0, r.out);
        for (const [file, entry] of host.files) {
            if (!file.startsWith('/var/backups/openvibe/')) continue;
            assert.deepStrictEqual([entry.owner, entry.mode], ['root', entry.type === 'dir' ? 0o700 : 0o600], file);
        }
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe.staging'), []);
        assert.ok(host.dumps.every((d) => d.as === 'postgres'));
        const restored = await host.cli('restore-download', 'ai', 'latest');
        assert.strictEqual(restored.code, 0, restored.out);
        for (const file of ['ai.dump', 'ai-extra.dump']) assert.strictEqual(host.files.get(`/var/lib/openvibe-restore/ai-20260922-120000/${file}`).mode, 0o600);
    }),

    test('a failed PostgreSQL dump does not prevent another service from backing up', async () => {
        const host = backupHost();
        const orig = host.exec.run;
        host.exec.run = async (cmd, args, opts) => cmd === 'pg_dump' && args.includes('ov_media')
            ? { code: 1, stdout: '', stderr: 'simulated pg_dump failure' } : orig(cmd, args, opts);
        const r = await host.cli('backup', '--all', '--json');
        assert.strictEqual(r.code, 2, r.out);
        const summary = JSON.parse(r.out);
        assert.deepStrictEqual(summary.services.map((x) => [x.service, x.status]), [['live', 'ok'], ['media', 'failed'], ['ai', 'ok'], ['openre', 'ok']]);
        assert.ok(host.files.has('/var/backups/openvibe/ai/20260922-120000/ai-extra.dump'));
    }),

    // ── off-host upload ────────────────────────────────────────────────────────
    test('--offsite: every copy encrypted and uploaded; manifest with HMAC; no secret anywhere', async () => {
        const host = backupHost();
        const r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 0, r.out);
        const base = 'openvibe-backups/fake-host/20260922-120000/';
        assert.deepStrictEqual([...host.s3.objects.keys()].sort(), [`${base}ai/ai-extra.dump.ovbk`, `${base}ai/ai.dump.ovbk`, `${base}live/live.dump.ovbk`, `${base}manifest.json`, `${base}media/media.dump.ovbk`, `${base}openre/openre.dump.ovbk`]);
        const key = Buffer.from(KEY_HEX, 'hex');
        for (const [k, v] of host.s3.objects) {
            if (k.endsWith('manifest.json')) continue;
            assert.ok(!v.includes('copy of'), `${k} is not encrypted`);
            const plain = await decrypt(key, v);
            const svc = k.split('/')[3];
            const file = path.basename(k, '.ovbk');
            assert.ok(plain.equals(Buffer.from(host.files.get(`/var/backups/openvibe/${svc}/20260922-120000/${file}`).content)), `${k} round trip`);
        }
        const m = JSON.parse(host.s3.objects.get(`${base}manifest.json`));
        assert.strictEqual(m.hmac, bcrypto.hmacManifest(key, JSON.stringify((({ hmac, ...rest }) => rest)(m))));
        assert.strictEqual(m.keyId, bcrypto.keyId(key));
        assert.deepStrictEqual(Object.keys(m.services), ['live', 'media', 'ai', 'openre']);
        // Only PutObject for small files; path-style B2 endpoint and region from the endpoint.
        assert.ok(host.s3.sent.filter((c) => /Put/.test(c.name)).every((c) => c.input.Bucket === 'openvibe-backups-test'));
        const cfg = host.s3Configs[0];
        assert.deepStrictEqual([cfg.endpoint, cfg.region, cfg.forcePathStyle, cfg.credentials.accessKeyId], ['https://s3.us-west-004.backblazeb2.com', 'us-west-004', true, '004keyid0000000000000001']);
        assert.strictEqual(cfg.credentials.secretAccessKey, S3_SECRET);
        noSecrets(JSON.stringify(cfg), 'the config object');
        noSecrets(r.out, 'CLI output');
        noSecrets(host.read('/var/lib/openvibe-host/backup-runs/20260922-120000.json'), 'the run summary');
        noSecrets(JSON.stringify(host.s3.sent), 'S3 requests');
        noSecrets(host.s3.objects.get(`${base}manifest.json`), 'the manifest');
        const summary = JSON.parse(host.read('/var/lib/openvibe-host/backup-runs/20260922-120000.json'));
        assert.strictEqual(summary.offsite.ok, true);
        assert.strictEqual(summary.offsite.uploaded.length, 5);
        assert.strictEqual(summary.offsite.location, base);
    }),

    test('large files go up as a multipart upload; a failed part aborts it', async () => {
        const host = backupHost();
        const big = crypto.randomBytes(300 * 1024);
        host.dumpContent = (db) => db === 'ov_live' ? Buffer.concat([Buffer.from('pg_dump -Fc'), big]) : Buffer.from(`pg_dump -Fc of ${db}`);
        await host.cli('backup', '--all');
        const summary = await require('../lib/commands/backup').readRun(host.exec, host.inv, null);
        const cfg = await offsite.loadConfig(host.exec, {});
        const ctx = { exec: host.exec, inv: host.inv, log: () => {} };
        const res = await offsite.push(ctx, summary, { cfg, client: host.s3, partSize: 64 * 1024, chunkSize: 16 * 1024 });
        assert.strictEqual(res.ok, true);
        const live = res.uploaded.find((u) => u.service === 'live');
        assert.strictEqual(live.parts, Math.ceil(live.cipherBytes / (64 * 1024)));
        const partSizes = host.s3.sent.filter((c) => c.name === 'UploadPartCommand').map((c) => c.input.Body);
        assert.ok(partSizes.slice(0, -1).every((b) => b === `<${64 * 1024} bytes>`), 'every part but the last is exactly partSize');
        assert.strictEqual(live.cipherBytes, bcrypto.encryptedSize(big.length + 11, 16 * 1024));
        assert.ok((await decrypt(Buffer.from(KEY_HEX, 'hex'), host.s3.objects.get(live.object))).equals(Buffer.concat([Buffer.from('pg_dump -Fc'), big])));
        assert.ok(host.s3.sent.some((c) => c.name === 'CompleteMultipartUploadCommand'));

        const s3 = mockS3();
        let n = 0;
        s3.failPut = () => ++n === 3;
        await assert.rejects(offsite.uploadIterable(s3, 'b', 'k', [crypto.randomBytes(200 * 1024)], { partSize: 64 * 1024 }), /SlowDown/);
        assert.ok(s3.sent.some((c) => c.name === 'AbortMultipartUploadCommand'));
        assert.strictEqual(s3.objects.size, 0);
    }),

    test('--offsite: a declared object directory is archived, encrypted, uploaded and recorded in the manifest', async () => {
        const host = objectsHost();
        const r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 0, r.out);
        // The archive is an ordinary root-only copy in the local backup...
        const local = host.files.get('/var/backups/openvibe/host/20260922-120000/objects.tar.gz');
        assert.deepStrictEqual([local.owner, local.mode], ['root', 0o600]);
        // ...and an encrypted object off-host, under the same rules as every other file.
        const base = 'openvibe-backups/fake-host/20260922-120000/';
        const key = `${base}host/objects.tar.gz.ovbk`;
        assert.ok(host.s3.objects.has(key), [...host.s3.objects.keys()].join('\n'));
        const enc = host.s3.objects.get(key);
        assert.ok(!enc.includes('tenant object'), 'the archive is not encrypted');
        const plain = await decrypt(Buffer.from(KEY_HEX, 'hex'), enc);
        const entries = readTarGz(plain);
        assert.deepStrictEqual(entries.map((e) => e.name), [`projects/prj_1/${host.tenantSha.slice(0, 2)}/${host.tenantSha}`]);
        assert.strictEqual(entries[0].content, TENANT_BLOB);
        const m = JSON.parse(host.s3.objects.get(`${base}manifest.json`));
        const f = m.services.host.files.find((x) => x.file === 'objects.tar.gz');
        assert.deepStrictEqual([f.kind, f.name], ['objects', 'objects']);
        assert.strictEqual(f.plainSha256, crypto.createHash('sha256').update(plain).digest('hex'));
        noSecrets(host.s3.objects.get(`${base}manifest.json`), 'the manifest');
        noSecrets(JSON.stringify(host.s3.sent), 'S3 requests');
        noSecrets(r.out, 'CLI output');
    }),

    test('an object archive is written only after root has taken the staging directory over', async () => {
        const host = objectsHost();
        const r = await host.cli('backup', 'host');
        assert.strictEqual(r.code, 0, r.out);
        const tarCall = host.calls.find((c) => c.cmd === 'tar' && c.args.some((a) => String(a).endsWith('objects.tar.gz')));
        assert.ok(tarCall, 'the object directory was tarred');
        assert.strictEqual(tarCall.privileged, true);
        const stage = path.dirname(tarCall.args[1]);
        const lockAt = host.calls.findIndex((c) => c.cmd === 'chown' && c.args[c.args.length - 1] === stage && c.args.includes('root:root'));
        const chmodAt = host.calls.findIndex((c) => c.cmd === 'chmod' && c.args[c.args.length - 1] === stage && c.args.includes('0700'));
        const tarAt = host.calls.indexOf(tarCall);
        assert.ok(lockAt >= 0 && chmodAt >= 0, 'root locked the staging directory down');
        assert.ok(lockAt < tarAt && chmodAt < tarAt, 'root owned the stage before tar opened the archive');
    }),

    test('a tar warning for transient scratch under the store is accepted, and the scratch excluded', async () => {
        const host = objectsHost();
        host.put('/var/lib/openvibe-host-api/objects/tmp/aaaaaaaaaaaa.part', 'half-written upload', { owner: 'ubuntu', mode: 0o644 });
        host.onTar = (args) => (String(args[0]).includes('c') ? { code: 1, stderr: 'tar: ./tmp/aaaaaaaaaaaa.part: file changed as we read it\n' } : undefined);
        const r = await host.cli('backup', 'host', '--json');
        host.onTar = null;
        assert.strictEqual(r.code, 0, r.out);
        const rec = JSON.parse(r.out);
        const f = rec.files.find((x) => x.kind === 'objects');
        assert.ok(f && !f.error, JSON.stringify(f));
        assert.ok(Number.isFinite(f.sourceBytes) && f.sourceBytes > 0, 'the source size was recorded for the drill');
        const tarCall = host.calls.find((c) => c.cmd === 'tar' && c.args.some((a) => String(a).endsWith('.tar.gz')));
        assert.ok(tarCall.args.includes('--exclude=./tmp'), tarCall.args.join(' '));
        const names = readTarGz(host.files.get(`${rec.dir}/objects.tar.gz`).content).map((e) => e.name);
        assert.ok(!names.some((n) => n.startsWith('tmp/')), `scratch was archived: ${names.join(', ')}`);
        assert.ok(names.length >= 1, 'the tenant blob is still archived');
    }),

    test('a genuine tar failure still fails the backup', async () => {
        const host = objectsHost();
        host.onTar = (args) => (String(args[0]).includes('c') ? { code: 2, stderr: 'tar: ./projects: Cannot open: Permission denied\n' } : undefined);
        const r = await host.cli('backup', 'host');
        host.onTar = null;
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /Permission denied/);
    }),

    test('an object directory is not archived when the staging filesystem has no room', async () => {
        const host = objectsHost();
        host.statfsFree = 1024;
        const r = await host.cli('backup', 'host');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /not enough free space under \/var\/backups\/openvibe\.staging/);
        assert.ok(!host.calls.some((c) => c.cmd === 'tar'), 'nothing was tarred');
    }),

    test('off-host retention: runs older than 30 days are deleted, the newest 7 always stay, and nothing is pruned after a failed upload', async () => {
        const host = backupHost();
        const put = (run) => {
            host.s3.objects.set(`openvibe-backups/fake-host/${run}/live/live.dump.ovbk`, Buffer.from('x'));
            host.s3.objects.set(`openvibe-backups/fake-host/${run}/manifest.json`, Buffer.from('{}'));
        };
        // Ten runs 35..44 days old, one 5 days old; another host's and a stray object are never touched.
        for (let d = 35; d < 45; d++) put(require('../lib/commands/backup').stamp(Date.parse('2026-09-22T12:00:00Z') - d * DAY));
        put('20260917-120000');
        host.s3.objects.set('openvibe-backups/other-host/20200101-000000/manifest.json', Buffer.from('{}'));
        host.s3.objects.set('openvibe-backups/fake-host/README', Buffer.from('keep'));

        // A failed upload: no pruning at all.
        host.s3.failPut = (k) => k.endsWith('media.dump.ovbk');
        const bad = await host.cli('backup', '--all', '--offsite', '--json');
        assert.strictEqual(bad.code, 2);
        const badSummary = JSON.parse(bad.out);
        assert.strictEqual(badSummary.offsite.ok, false);
        assert.match(badSummary.offsite.failures[0].error, /SlowDown/);
        assert.deepStrictEqual(badSummary.offsite.pruned, []);
        // Eleven old runs, README, the other host's run and this partial run: all still there.
        assert.strictEqual(new Set([...host.s3.objects.keys()].map((k) => k.split('/')[2])).size, 14);

        // offsite push re-uploads that run; now it is complete and old runs go.
        host.s3.failPut = null;
        const again = await host.cli('offsite', 'push', '--run', '20260922-120000');
        assert.strictEqual(again.code, 0, again.out);
        const runs = [...new Set([...host.s3.objects.keys()].filter((k) => k.startsWith('openvibe-backups/fake-host/2')).map((k) => k.split('/')[2]))].sort();
        // Newest 7 with a manifest: this run, 09-17, and the five youngest of the old ones (35..39 days).
        assert.deepStrictEqual(runs, ['20260814-120000', '20260815-120000', '20260816-120000', '20260817-120000', '20260818-120000', '20260917-120000', '20260922-120000']);
        assert.ok(host.s3.objects.has('openvibe-backups/other-host/20200101-000000/manifest.json'));
        assert.ok(host.s3.objects.has('openvibe-backups/fake-host/README'));
        const summary = JSON.parse(host.read('/var/lib/openvibe-host/backup-runs/20260922-120000.json'));
        assert.strictEqual(summary.offsite.ok, true);
        assert.strictEqual(summary.offsite.pruned.length, 5);
    }),

    test('offsite list and check; paginated listings', async () => {
        const host = backupHost();
        host.s3 = mockS3({ pageSize: 2 });
        await host.cli('backup', '--all', '--offsite');
        host.advance(DAY);
        host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 3600 } }];
        await host.cli('backup', '--all', '--offsite', '--logical');
        const l = await host.cli('offsite', 'list', 'live', '--json');
        assert.strictEqual(l.code, 0, l.out);
        assert.deepStrictEqual(JSON.parse(l.out).map((x) => [x.run, x.objects, x.manifest]), [['20260923-120000', 6, true], ['20260922-120000', 6, true]]);
        const c = await host.cli('offsite', 'check');
        assert.strictEqual(c.code, 0, c.out);
        assert.match(c.out, /s3:\/\/openvibe-backups-test\/openvibe-backups\/fake-host\/ .*region us-west-004.*key id [0-9a-f]{16}; retention 30 days/);
        noSecrets(c.out, 'offsite check');
    }),

    // ── restore-download ───────────────────────────────────────────────────────
    test('restore-download: verified, decrypted copies in a new directory; never overwrites; never near a live database', async () => {
        const host = backupHost();
        await host.cli('backup', '--all', '--offsite');
        const original = host.files.get('/var/backups/openvibe/live/20260922-120000/live.dump').content;
        const r = await host.cli('restore-download', 'live', '20260922-120000');
        assert.strictEqual(r.code, 0, r.out);
        const dest = '/var/lib/openvibe-restore/live-20260922-120000/live.dump';
        assert.ok(Buffer.from(host.files.get(dest).content).equals(Buffer.from(original)));
        assert.match(r.out, /pg_restore --list ok/);
        assert.ok(host.calls.some((c) => c.cmd === 'pg_restore' && c.args.includes('--list')));

        const again = await host.cli('restore-download', 'live', '20260922-120000');
        assert.strictEqual(again.code, 1);
        assert.match(again.out, /not empty; restore-download never overwrites/);
        for (const out of ['/opt/openvibe.live/data', '/opt/openvibe.live', '/opt', '/var/backups/openvibe/live/x']) {
            const bad = await host.cli('restore-download', 'live', 'latest', '--out', out);
            assert.strictEqual(bad.code, 1, out);
            assert.match(bad.out, /refusing --out/, out);
        }
        const other = await host.cli('restore-download', 'live', 'latest', '--out', '/root/restore-test', '--json');
        assert.strictEqual(other.code, 0, other.out);
        assert.strictEqual(JSON.parse(other.out).files[0].sha256, crypto.createHash('sha256').update(original).digest('hex'));
    }),

    test('restore-download refuses a tampered object, a forged manifest and a run that lacks the service', async () => {
        const host = backupHost();
        await host.cli('backup', '--all', '--offsite');
        const base = 'openvibe-backups/fake-host/20260922-120000/';
        const obj = Buffer.from(host.s3.objects.get(`${base}media/media.dump.ovbk`));
        obj[obj.length - 20] ^= 1;
        host.s3.objects.set(`${base}media/media.dump.ovbk`, obj);
        const t = await host.cli('restore-download', 'media', 'latest');
        assert.strictEqual(t.code, 2);
        assert.match(t.out, /failed authentication/);
        assert.strictEqual(host.files.has('/var/lib/openvibe-restore/media-20260922-120000/media.dump'), false, 'a bad copy is removed');

        // Swapping two encrypted files is caught by the manifest's hashes.
        host.s3.objects.set(`${base}ai/ai.dump.ovbk`, host.s3.objects.get(`${base}ai/ai-extra.dump.ovbk`));
        const sw = await host.cli('restore-download', 'ai', 'latest', '--out', '/root/r-ai');
        assert.strictEqual(sw.code, 2);
        assert.match(sw.out, /does not match the manifest/);

        const m = JSON.parse(host.s3.objects.get(`${base}manifest.json`));
        m.services.live.files[0].plainSha256 = '0'.repeat(64);
        host.s3.objects.set(`${base}manifest.json`, Buffer.from(JSON.stringify(m)));
        const f = await host.cli('restore-download', 'live', 'latest', '--out', '/root/r-live');
        assert.strictEqual(f.code, 2);
        assert.match(f.out, /failed its HMAC check/);

    }),

    test('restore-download: a PostgreSQL .dump is verified with pg_restore --list; a corrupt one is refused', async () => {
        const host = pgOffsiteHost();
        const r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok([...host.s3.objects.keys()].some((k) => k.endsWith('/trade/trade.dump.ovbk')), 'the pg_dump archive was uploaded');

        const d = await host.cli('restore-download', 'trade', 'latest');
        assert.strictEqual(d.code, 0, d.out);
        const dest = '/var/lib/openvibe-restore/trade-20260922-120000/trade.dump';
        assert.ok(host.files.has(dest));
        assert.match(d.out, /pg_restore --list ok/);
        // --list only reads the file, so root checks the root-only copy itself, not as postgres.
        assert.ok(host.calls.some((c) => c.cmd === 'pg_restore' && c.args.includes('--list') && c.args.includes(dest) && c.as === null));
        assert.deepStrictEqual([host.files.get(dest).owner, host.files.get(dest).mode], ['root', 0o600]);

        // A dump that is not a pg_dump archive: the manifest hashes match, so only pg_restore --list refuses it.
        const bad = pgOffsiteHost({ dumpContent: () => 'this is not a pg_dump archive' });
        await bad.cli('backup', '--all', '--offsite');
        const refused = await bad.cli('restore-download', 'trade', 'latest');
        assert.strictEqual(refused.code, 2, refused.out);
        assert.match(refused.out, /pg_restore --list .* failed|text format dump/);
    }),

    test('restore-download: an object archive is written without a database check and never over the live object directory', async () => {
        const host = objectsHost();
        await host.cli('backup', '--all', '--offsite');
        const near = await host.cli('restore-download', 'host', 'latest', '--out', '/var/lib/openvibe-host-api/objects');
        assert.strictEqual(near.code, 1, near.out);
        assert.match(near.out, /refusing --out: .*object directory/);
        const r = await host.cli('restore-download', 'host', 'latest', '--out', '/root/r-host', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const rec = JSON.parse(r.out);
        const f = rec.files.find((x) => x.file.endsWith('objects.tar.gz'));
        assert.deepStrictEqual([f.kind, f.check], ['objects', null], 'an object archive is checked by a drill');
        assert.ok(host.files.has('/root/r-host/objects.tar.gz'));
        assert.ok(rec.files.some((x) => x.file.endsWith('host.dump') && x.kind === 'database'), 'the database is still checked');
    }),

    // ── configuration ──────────────────────────────────────────────────────────
    test('config: root-only env file and key; missing names listed by name; not root refused; no value ever printed', async () => {
        let host = backupHost({ envMode: 0o644 });
        let r = await host.cli('offsite', 'check');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /backup env file \/etc\/openvibe\/backup.env must not be readable or writable by group or others/);

        host = backupHost({ envOwner: 'ubuntu' });
        r = await host.cli('offsite', 'check');
        assert.match(r.out, /must be owned by root/);

        host = backupHost({ keyMode: 0o640 });
        r = await host.cli('offsite', 'check');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /encryption key file \/etc\/openvibe\/backup.key must not be readable/);

        host = backupHost({ env: `BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com\nBACKUP_S3_SECRET=${S3_SECRET}\nBACKUP_S3_KEY_ID=\n` });
        r = await host.cli('offsite', 'check');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /missing or has empty: BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_ENCRYPTION_KEY_FILE/);
        noSecrets(r.out, 'a config error');

        host = backupHost({ env: `BACKUP_S3_ENDPOINT=http://${S3_SECRET}.example.com\nBACKUP_S3_BUCKET=b-ok\nBACKUP_S3_KEY_ID=k\nBACKUP_S3_SECRET=${S3_SECRET}\nBACKUP_ENCRYPTION_KEY_FILE=/etc/openvibe/backup.key\n` });
        r = await host.cli('offsite', 'check');
        assert.match(r.out, /must be https/);
        noSecrets(r.out, 'an endpoint error');

        // A broken off-host config still leaves every local backup made, and fails the run.
        host = backupHost({ keyMode: 0o644 });
        r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /OFFSITE\s+FAILED: encryption key file/);
        assert.ok(host.files.has('/var/backups/openvibe/live/20260922-120000/live.dump'));

        const { createFakeHost } = require('./fake-host');
        const plain = createFakeHost({ root: false, user: 'ubuntu' });
        const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
        plain.put('/etc/openvibe/host.json', JSON.stringify(doc), { owner: 'ubuntu' });
        const lines = [];
        const code = await main(['restore-download', 'live', 'latest'], { exec: plain.exec, out: (s) => lines.push(s), env: {}, s3: () => mockS3() });
        assert.strictEqual(code, 1);
        assert.match(lines.join('\n'), /run as root/);
    }),

    test('usage: backup --all takes no service; restore-download needs a run; bad --run is refused', async () => {
        const host = backupHost();
        assert.strictEqual((await host.cli('backup', 'live', '--all')).code, 1);
        assert.strictEqual((await host.cli('restore-download', 'live')).code, 1);
        assert.strictEqual((await host.cli('offsite', 'push', '--run', '../etc')).code, 2);
        assert.strictEqual((await host.cli('offsite', 'push')).code, 1, 'no run recorded yet');
        assert.strictEqual((await host.cli('backup', '--all', '--keep-daily', '0')).code, 1);
    }),
]);
