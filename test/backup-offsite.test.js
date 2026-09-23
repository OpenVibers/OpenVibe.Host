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

const DAY = 86400000;
const KEY_HEX = crypto.createHash('sha256').update('test backup key').digest('hex');
const S3_SECRET = `${SECRET}-s3`;

/** An in-memory S3 that records every command it is sent. */
function mockS3({ pageSize = 1000 } = {}) {
    const objects = new Map();
    const uploads = new Map();
    const sent = [];
    let seq = 0;
    const s3 = {
        objects,
        sent,
        failPut: null, // (key) -> true to fail that PutObject/UploadPart
        async send(cmd) {
            const name = cmd.constructor.name;
            const i = cmd.input;
            sent.push({ name, input: { ...i, Body: i.Body ? `<${Buffer.byteLength(i.Body)} bytes>` : undefined } });
            switch (name) {
            case 'PutObjectCommand':
                if (s3.failPut && s3.failPut(i.Key)) throw new Error('503 SlowDown');
                assert.strictEqual(i.ContentLength, i.Body.length);
                objects.set(i.Key, Buffer.from(i.Body));
                return { ETag: '"put"' };
            case 'CreateMultipartUploadCommand': { const id = `up-${++seq}`; uploads.set(id, { key: i.Key, parts: new Map() }); return { UploadId: id }; }
            case 'UploadPartCommand':
                if (s3.failPut && s3.failPut(i.Key)) throw new Error('503 SlowDown');
                uploads.get(i.UploadId).parts.set(i.PartNumber, Buffer.from(i.Body));
                return { ETag: `"p${i.PartNumber}"` };
            case 'CompleteMultipartUploadCommand': {
                const u = uploads.get(i.UploadId);
                const nums = i.MultipartUpload.Parts.map((p) => p.PartNumber);
                assert.deepStrictEqual(nums, [...u.parts.keys()].sort((a, b) => a - b));
                objects.set(u.key, Buffer.concat(nums.map((n) => u.parts.get(n))));
                uploads.delete(i.UploadId);
                return {};
            }
            case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
            case 'ListObjectsV2Command': {
                const keys = [...objects.keys()].filter((k) => k.startsWith(i.Prefix || '')).sort();
                const start = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
                const size = Math.min(pageSize, i.MaxKeys || 1000);
                const page = keys.slice(start, start + size);
                const more = start + size < keys.length;
                return { Contents: page.map((k) => ({ Key: k, Size: objects.get(k).length })), IsTruncated: more, NextContinuationToken: more ? String(start + size) : undefined };
            }
            case 'GetObjectCommand': {
                const o = objects.get(i.Key);
                if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
                const pieces = [];
                for (let k = 0; k < o.length; k += 1000) pieces.push(o.subarray(k, k + 1000));
                return { Body: Readable.from(pieces) };
            }
            case 'DeleteObjectCommand': objects.delete(i.Key); return {};
            default: throw new Error(`mock S3: unexpected ${name}`);
            }
        },
    };
    return s3;
}

/** The standard fake host plus AI (two databases) and OpenRe (not deployed), a backup env and key. */
function backupHost({ envMode = 0o600, keyMode = 0o600, envOwner = 'root', env = null } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.ai = { repo: '/opt/openvibe.ai', units: [], databases: [{ name: 'ai', path: '/var/lib/openvibe-ai/ai.db' }, { name: 'ai-extra', path: '/var/lib/openvibe-ai/extra.db' }] };
    doc.services.openre = { repo: '/opt/openre', units: [], databases: [{ name: 'openre', path: '/var/lib/openre/openre.db' }] };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    host.put('/var/lib/openvibe-ai/ai.db', 'sqlite', { owner: 'ubuntu' });
    host.put('/var/lib/openvibe-ai/extra.db', 'sqlite', { owner: 'ubuntu' });
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
    // Distinct content per database, so a restore can be compared byte for byte.
    host.backupContent = (db) => Buffer.from(`SQLite format 3\0 copy of ${db} ${'x'.repeat(5000)}`);
    host.sqliteHandler = (db, sql) => (/quick_check/.test(sql) ? [{ quick_check: 'ok' }] : [{ n: 0 }]);
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

function noSecrets(text, what) {
    for (const s of [S3_SECRET, SECRET, KEY_HEX]) assert.ok(!String(text).includes(s), `${what} leaked a secret value`);
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

    test('backup --all prunes to 7 daily + 4 weekly per service; failing days never age out good backups', async () => {
        const host = backupHost();
        // A directory ovhost did not record is never touched.
        host.put('/var/backups/openvibe/live/20200101-000000/live.db', 'operator copy', { owner: 'root', mode: 0o600 });
        for (let d = 0; d < 40; d++) {
            const r = await host.cli('backup', '--all');
            assert.strictEqual(r.code, 0, r.out);
            host.advance(DAY);
        }
        // 40 daily runs from 2026-09-22 12:00 to 2026-10-31 12:00.
        const expected = ['20200101-000000', '20261011-120000', '20261018-120000', '20261025-120000', '20261026-120000', '20261027-120000', '20261028-120000', '20261029-120000', '20261030-120000', '20261031-120000'];
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/live'), expected);
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/media'), expected.slice(1));

        // Live fails for 20 days: nothing of Live is pruned, the others carry on.
        host.onSqliteBackup = (db) => (db.includes('openvibe.live') ? new Error('database disk image is malformed') : null);
        for (let d = 0; d < 20; d++) {
            const r = await host.cli('backup', '--all');
            assert.strictEqual(r.code, 2);
            host.advance(DAY);
        }
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/live'), expected);
        assert.strictEqual(dirsOf(host, '/var/backups/openvibe/media').length, 9);
        assert.ok(dirsOf(host, '/var/backups/openvibe/media').includes('20261119-120000'));
    }),

    test('a partly failed backup is kept until a newer good one exists, then pruned; drills skip it', async () => {
        const host = backupHost();
        await host.cli('backup', '--all');
        host.advance(DAY);
        host.onSqliteBackup = (db) => (db.endsWith('extra.db') ? new Error('disk I/O error') : null);
        const bad = await host.cli('backup', '--all', '--json');
        assert.strictEqual(bad.code, 2);
        const s = JSON.parse(bad.out);
        const ai = s.services.find((x) => x.service === 'ai');
        assert.strictEqual(ai.status, 'failed');
        assert.match(ai.error, /ai-extra: disk I\/O error/);
        assert.deepStrictEqual(dirsOf(host, ai.dir), ['ai.db'], 'the good half is kept');
        const log = host.read('/var/lib/openvibe-host/backups/ai.jsonl').trim().split('\n').map((l) => JSON.parse(l));
        assert.strictEqual(log[log.length - 1].ok, false);
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/ai'), ['20260922-120000', '20260923-120000']);
        host.onSqliteBackup = null;
        host.advance(DAY);
        await host.cli('backup', '--all');
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/ai'), ['20260922-120000', '20260924-120000'], 'the failed one went once a newer good one existed');
    }),

    // ── failure isolation and the summary ─────────────────────────────────────
    test('one failing service never stops the others; exit code 2; JSON summary per run', async () => {
        const host = backupHost();
        host.onSqliteBackup = (db) => (db.includes('openvibe.media') ? new Error('SQLITE_BUSY: database is locked') : null);
        const r = await host.cli('backup', '--all');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /FAILED\s+media\s+media: SQLITE_BUSY/);
        assert.match(r.out, /OK\s+live\s+1 file\(s\)/);
        assert.match(r.out, /OK\s+ai\s+2 file\(s\)/);
        assert.match(r.out, /SKIPPED\s+openre\s+no database found/);
        const summary = JSON.parse(host.read('/var/lib/openvibe-host/backup-runs/20260922-120000.json'));
        assert.strictEqual(summary.ok, false);
        assert.deepStrictEqual(summary.services.map((x) => [x.service, x.status]), [['live', 'ok'], ['media', 'failed'], ['ai', 'ok'], ['openre', 'skipped']]);
        assert.deepStrictEqual(summary.retention, { daily: 7, weekly: 4 });
        // The services after the failing one were still backed up.
        assert.ok(host.files.has('/var/backups/openvibe/ai/20260922-120000/ai-extra.db'));
        assert.strictEqual(host.files.has('/var/backups/openvibe/openre'), true);
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/openre'), [], 'no empty backup directory is left behind');
        assert.strictEqual(host.files.has('/var/lib/openvibe-host/locks/_backup-all.lock'), false, 'lock released');
        const ok = await (host.advance(1000), host.cli('backup', '--all', '--json'));
        host.onSqliteBackup = null;
        assert.strictEqual(JSON.parse(ok.out).ok, false);
        host.advance(1000);
        assert.strictEqual((await host.cli('backup', '--all')).code, 0);
    }),

    test('permissions: backup directories root 0700, copies root 0600, no -wal/-shm; old service-owned directories are locked down', async () => {
        const host = backupHost();
        host.ensureDir('/var/backups/openvibe/live', 'ubuntu', 0o750);
        // The worker leaves a side file behind: it is not kept.
        host.onSqliteBackup = (db, dest) => { host.put(`${dest}-wal`, 'wal', { owner: 'ubuntu', mode: 0o644 }); return null; };
        const r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 0, r.out);
        let dirs = 0;
        let files = 0;
        for (const [p, e] of host.files) {
            if (p !== '/var/backups/openvibe' && !p.startsWith('/var/backups/openvibe/')) continue;
            if (e.type === 'dir') { dirs += 1; assert.deepStrictEqual([e.owner, e.mode], ['root', 0o700], p); }
            else { files += 1; assert.deepStrictEqual([e.owner, e.mode], ['root', 0o600], p); assert.ok(!/-(wal|shm|journal)$/.test(p), `${p} left behind`); }
        }
        assert.ok(dirs >= 8 && files === 4, `${dirs} dirs, ${files} files`);
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe.staging'), [], 'staging emptied');
        assert.deepStrictEqual([host.files.get('/var/backups/openvibe.staging').owner, host.files.get('/var/backups/openvibe.staging').mode], ['root', 0o711]);
        // The worker still ran as the service user, into a directory it owned at the time.
        assert.ok(host.sqliteCalls.filter((c) => c.op === 'backup').every((c) => c.as === 'ubuntu' && c.dest.startsWith('/var/backups/openvibe.staging/')));

        // restore-download: a root-only directory, 0600 files.
        const d = await host.cli('restore-download', 'ai', 'latest');
        assert.strictEqual(d.code, 0, d.out);
        for (const p of ['/var/lib/openvibe-restore', '/var/lib/openvibe-restore/ai-20260922-120000']) assert.deepStrictEqual([host.files.get(p).owner, host.files.get(p).mode], ['root', 0o700], p);
        for (const f of ['ai.db', 'ai-extra.db']) {
            const e = host.files.get(`/var/lib/openvibe-restore/ai-20260922-120000/${f}`);
            assert.deepStrictEqual([e.owner, e.mode], ['root', 0o600], f);
        }
    }),

    test('a copy that is a link is refused, not chowned', async () => {
        const host = backupHost();
        // The service user hard-links its "copy" to some other file before root takes it over.
        const orig = host.exec.sqliteBackup;
        host.exec.sqliteBackup = async (db, dest, o) => { await orig(db, dest, o); host.files.get(dest).nlink = 2; };
        const r = await host.cli('backup', 'live');
        host.exec.sqliteBackup = orig;
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /not a plain file/);
        assert.ok(!host.calls.some((c) => (c.cmd === 'chown' || c.cmd === 'chmod') && String(c.args[c.args.length - 1]).endsWith('live.db')), 'a linked copy is never chowned');
        assert.deepStrictEqual(dirsOf(host, '/var/backups/openvibe/live'), [], 'and never moved into the backups');
    }),

    // ── off-host upload ────────────────────────────────────────────────────────
    test('--offsite: every copy encrypted and uploaded; manifest with HMAC; no secret anywhere', async () => {
        const host = backupHost();
        const r = await host.cli('backup', '--all', '--offsite');
        assert.strictEqual(r.code, 0, r.out);
        const base = 'openvibe-backups/fake-host/20260922-120000/';
        assert.deepStrictEqual([...host.s3.objects.keys()].sort(), [`${base}ai/ai-extra.db.ovbk`, `${base}ai/ai.db.ovbk`, `${base}live/live.db.ovbk`, `${base}manifest.json`, `${base}media/media.db.ovbk`]);
        const key = Buffer.from(KEY_HEX, 'hex');
        for (const [k, v] of host.s3.objects) {
            if (k.endsWith('manifest.json')) continue;
            assert.ok(!v.includes('copy of'), `${k} is not encrypted`);
            const plain = await decrypt(key, v);
            const svc = k.split('/')[3];
            const file = path.basename(k, '.ovbk');
            assert.ok(plain.equals(host.files.get(`/var/backups/openvibe/${svc}/20260922-120000/${file}`).content), `${k} round trip`);
        }
        const m = JSON.parse(host.s3.objects.get(`${base}manifest.json`));
        assert.strictEqual(m.hmac, bcrypto.hmacManifest(key, JSON.stringify((({ hmac, ...rest }) => rest)(m))));
        assert.strictEqual(m.keyId, bcrypto.keyId(key));
        assert.deepStrictEqual(Object.keys(m.services), ['live', 'media', 'ai']);
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
        assert.strictEqual(summary.offsite.uploaded.length, 4);
        assert.strictEqual(summary.offsite.location, base);
    }),

    test('large files go up as a multipart upload; a failed part aborts it', async () => {
        const host = backupHost();
        const big = crypto.randomBytes(300 * 1024);
        host.backupContent = (db) => (db.includes('openvibe.live') ? big : Buffer.from('small'));
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
        assert.strictEqual(live.cipherBytes, bcrypto.encryptedSize(big.length, 16 * 1024));
        assert.ok((await decrypt(Buffer.from(KEY_HEX, 'hex'), host.s3.objects.get(live.object))).equals(big));
        assert.ok(host.s3.sent.some((c) => c.name === 'CompleteMultipartUploadCommand'));

        const s3 = mockS3();
        let n = 0;
        s3.failPut = () => ++n === 3;
        await assert.rejects(offsite.uploadIterable(s3, 'b', 'k', [crypto.randomBytes(200 * 1024)], { partSize: 64 * 1024 }), /SlowDown/);
        assert.ok(s3.sent.some((c) => c.name === 'AbortMultipartUploadCommand'));
        assert.strictEqual(s3.objects.size, 0);
    }),

    test('off-host retention: runs older than 30 days are deleted, the newest 7 always stay, and nothing is pruned after a failed upload', async () => {
        const host = backupHost();
        const put = (run) => {
            host.s3.objects.set(`openvibe-backups/fake-host/${run}/live/live.db.ovbk`, Buffer.from('x'));
            host.s3.objects.set(`openvibe-backups/fake-host/${run}/manifest.json`, Buffer.from('{}'));
        };
        // Ten runs 35..44 days old, one 5 days old; another host's and a stray object are never touched.
        for (let d = 35; d < 45; d++) put(require('../lib/commands/backup').stamp(Date.parse('2026-09-22T12:00:00Z') - d * DAY));
        put('20260917-120000');
        host.s3.objects.set('openvibe-backups/other-host/20200101-000000/manifest.json', Buffer.from('{}'));
        host.s3.objects.set('openvibe-backups/fake-host/README', Buffer.from('keep'));

        // A failed upload: no pruning at all.
        host.s3.failPut = (k) => k.endsWith('media.db.ovbk');
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
        await host.cli('backup', '--all', '--offsite');
        const l = await host.cli('offsite', 'list', 'live', '--json');
        assert.strictEqual(l.code, 0, l.out);
        assert.deepStrictEqual(JSON.parse(l.out).map((x) => [x.run, x.objects, x.manifest]), [['20260923-120000', 5, true], ['20260922-120000', 5, true]]);
        const c = await host.cli('offsite', 'check');
        assert.strictEqual(c.code, 0, c.out);
        assert.match(c.out, /s3:\/\/openvibe-backups-test\/openvibe-backups\/fake-host\/ .*region us-west-004.*key id [0-9a-f]{16}; retention 30 days/);
        noSecrets(c.out, 'offsite check');
    }),

    // ── restore-download ───────────────────────────────────────────────────────
    test('restore-download: verified, decrypted copies in a new directory; never overwrites; never near a live database', async () => {
        const host = backupHost();
        await host.cli('backup', '--all', '--offsite');
        const original = host.files.get('/var/backups/openvibe/live/20260922-120000/live.db').content;
        const r = await host.cli('restore-download', 'live', '20260922-120000');
        assert.strictEqual(r.code, 0, r.out);
        const dest = '/var/lib/openvibe-restore/live-20260922-120000/live.db';
        assert.ok(host.files.get(dest).content.equals(original));
        assert.match(r.out, /quick_check ok/);
        assert.ok(host.sqliteCalls.some((c) => c.db === dest && /quick_check/.test(c.sql)));
        // The live database was never written.
        assert.strictEqual(host.read('/opt/openvibe.live/data/live.db'), 'sqlite');

        const again = await host.cli('restore-download', 'live', '20260922-120000');
        assert.strictEqual(again.code, 1);
        assert.match(again.out, /not empty; restore-download never overwrites/);
        for (const out of ['/opt/openvibe.live/data', '/opt/openvibe.live', '/opt', '/var/lib/openvibe-ai', '/var/backups/openvibe/live/x']) {
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
        const obj = Buffer.from(host.s3.objects.get(`${base}media/media.db.ovbk`));
        obj[obj.length - 20] ^= 1;
        host.s3.objects.set(`${base}media/media.db.ovbk`, obj);
        const t = await host.cli('restore-download', 'media', 'latest');
        assert.strictEqual(t.code, 2);
        assert.match(t.out, /failed authentication/);
        assert.strictEqual(host.files.has('/var/lib/openvibe-restore/media-20260922-120000/media.db'), false, 'a bad copy is removed');

        // Swapping two encrypted files is caught by the manifest's hashes.
        host.s3.objects.set(`${base}ai/ai.db.ovbk`, host.s3.objects.get(`${base}ai/ai-extra.db.ovbk`));
        const sw = await host.cli('restore-download', 'ai', 'latest', '--out', '/root/r-ai');
        assert.strictEqual(sw.code, 2);
        assert.match(sw.out, /does not match the manifest/);

        const m = JSON.parse(host.s3.objects.get(`${base}manifest.json`));
        m.services.live.files[0].plainSha256 = '0'.repeat(64);
        host.s3.objects.set(`${base}manifest.json`, Buffer.from(JSON.stringify(m)));
        const f = await host.cli('restore-download', 'live', 'latest', '--out', '/root/r-live');
        assert.strictEqual(f.code, 2);
        assert.match(f.out, /failed its HMAC check/);

        const none = await host.cli('restore-download', 'openre', 'latest');
        assert.strictEqual(none.code, 1);
        assert.match(none.out, /no off-host run of openre/);
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
        assert.ok(host.files.has('/var/backups/openvibe/live/20260922-120000/live.db'));

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
