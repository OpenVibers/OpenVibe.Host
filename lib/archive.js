'use strict';
/**
 * ovhost archive (roadmap WS-S task 6, hazard H14): dead and backup database files on the host are
 * encrypted and copied off-host before anyone deletes them. This never deletes a local file: that
 * waits for the owner, with the archive's manifest in hand.
 *
 *   ovhost archive push <file>... [--note <text>]
 *        Each file must be an absolute path under ALLOWED_ROOTS, a regular file (no symlink), not
 *        open by any process (fuser -s), and not a database the inventory declares. Each is
 *        encrypted with the backup key (lib/backup-crypto.js, the same AES-256-GCM format as the
 *        nightly off-host copies) and uploaded to <prefix>-archive/<host>/<stamp>/<name>.ovbk, where
 *        <name> is the path with "/" as "__". The upload is checked by the object's size. Then a
 *        manifest.json (HMAC with the backup key) lists each original path, size, mtime and SHA-256,
 *        and a local record goes to <stateDir>/archives/<stamp>.json. The archive prefix is outside
 *        the backup runs' prefix, so backup retention never prunes it.
 *   ovhost archive list
 *        The archives off-host: stamp, file count, bytes, note.
 *   ovhost archive restore <stamp> <path> --out <dir>
 *        One file back, decrypted into a new root-only directory and checked against the manifest.
 *
 * Credentials and the key come from the backup env file (lib/offsite.js); values are never printed.
 */
const path = require('path');
const { pipeline } = require('stream/promises');
const bcrypto = require('./backup-crypto');
const offsite = require('./offsite');

const ALLOWED_ROOTS = ['/opt/', '/var/lib/', '/root/', '/srv/', '/home/'];
const NAME_RE = /^[A-Za-z0-9._-]+(__[A-Za-z0-9._-]+)*$/;
const STAMP_RE = /^\d{8}-\d{6}$/;

class ArchiveError extends Error {
    constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

const archivePrefix = (cfg, host) => `${cfg.prefix}-archive/${host}/`;
const objectName = (file) => file.replace(/^\/+/, '').split('/').join('__');
function stamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d+Z$/, ''); }

/** Why `file` may not be archived, or null. */
async function refusal(exec, inv, file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) return 'not a normalised absolute path';
    if (!ALLOWED_ROOTS.some((r) => file.startsWith(r))) return `outside ${ALLOWED_ROOTS.join(', ')}`;
    if (!NAME_RE.test(objectName(file))) return 'the path has characters an object name cannot carry';
    const declared = Object.values(inv.services || {}).flatMap((s) => (s.databases || []).map((d) => d.path || d));
    if (declared.includes(file)) return 'a database the inventory declares (a live database)';
    const st = await exec.stat(file);
    if (!st) return 'no such file';
    if (st.isSymlink || !st.isFile) return 'not a regular file';
    const inUse = await exec.run('fuser', ['-s', file], { privileged: true });
    if (inUse.code === 0) return 'open by a running process';
    if (inUse.code !== 1) return `could not tell whether it is open (fuser exited ${inUse.code})`;
    return null;
}

async function push(ctx, files, { cfg, client, note = '' } = {}) {
    const { exec, inv, log } = ctx;
    if (!files.length) throw new ArchiveError('name at least one file');
    const unique = [...new Set(files)];
    const problems = [];
    for (const f of unique) { const why = await refusal(exec, inv, f); if (why) problems.push(`${f}: ${why}`); }
    if (problems.length) throw new ArchiveError(`refusing (nothing uploaded):\n  ${problems.join('\n  ')}`);
    const master = await offsite.loadKey(exec, cfg);
    const host = await offsite.hostName(exec, inv);
    const st = stamp(exec.now());
    const base = `${archivePrefix(cfg, host)}${st}/`;
    const manifest = { format: 'openvibe-archive-manifest/1', encryption: 'OVBKAES1', host, stamp: st, createdAt: new Date(exec.now()).toISOString(), keyId: bcrypto.keyId(master), note: String(note || '').slice(0, 300), files: [] };
    const failures = [];
    for (const file of unique) {
        const key = `${base}${objectName(file)}.ovbk`;
        const plain = bcrypto.createDigestTap();
        const cipher = bcrypto.createDigestTap();
        try {
            const s = await exec.stat(file);
            await pipeline(exec.readStream(file), plain, bcrypto.createEncryptStream(master), cipher, async (source) => { await offsite.uploadIterable(client, cfg.bucket, key, source); });
            const p = plain.result(); const c = cipher.result();
            const listed = (await offsite.listAll(client, cfg.bucket, key)).find((o) => o.key === key);
            if (!listed || Number(listed.size) !== c.bytes) throw new Error(`the stored object is ${listed ? listed.size : 'missing'}, expected ${c.bytes} bytes`);
            manifest.files.push({ path: file, object: key, mtime: s.mtime ? new Date(s.mtime).toISOString() : null, plainBytes: p.bytes, plainSha256: p.sha256, cipherBytes: c.bytes, cipherSha256: c.sha256 });
            log(`archived ${file} → s3://${cfg.bucket}/${key} (${p.bytes} bytes, ${c.bytes} encrypted)`);
        } catch (err) {
            failures.push({ path: file, error: err.message });
            log(`✗ ${file}: ${err.message}`);
        }
    }
    manifest.failures = failures;
    const { hmac, ...rest } = manifest; void hmac;
    manifest.hmac = bcrypto.hmacManifest(master, JSON.stringify(rest));
    await offsite.uploadIterable(client, cfg.bucket, `${base}manifest.json`, [Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)], { contentType: 'application/json' });
    const record = { stamp: st, host, location: `s3://${cfg.bucket}/${base}`, note: manifest.note, files: manifest.files.map(({ path: p, plainBytes, plainSha256 }) => ({ path: p, plainBytes, plainSha256 })), failures };
    const dir = path.join(inv.stateDir, 'archives');
    await exec.mkdir(dir, { owner: 'root', mode: 0o700 });
    await exec.writeFile(path.join(dir, `${st}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ok: failures.length === 0, ...record };
}

async function readManifest(client, cfg, master, host, st) {
    const chunks = [];
    for await (const c of await offsite.getObjectStream(client, cfg.bucket, `${archivePrefix(cfg, host)}${st}/manifest.json`)) chunks.push(c);
    const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { hmac, ...rest } = m;
    if (hmac !== bcrypto.hmacManifest(master, JSON.stringify(rest))) throw new ArchiveError(`archive ${st}: the manifest's HMAC does not match this host's backup key`, 2);
    return m;
}

async function list(ctx, { cfg, client }) {
    const { exec, inv } = ctx;
    const master = await offsite.loadKey(exec, cfg);
    const host = await offsite.hostName(exec, inv);
    const stamps = [...new Set((await offsite.listAll(client, cfg.bucket, archivePrefix(cfg, host))).map((o) => o.key.slice(archivePrefix(cfg, host).length).split('/')[0]).filter((s) => STAMP_RE.test(s)))].sort().reverse();
    const out = [];
    for (const st of stamps) {
        try {
            const m = await readManifest(client, cfg, master, host, st);
            out.push({ stamp: st, files: m.files.length, plainBytes: m.files.reduce((a, f) => a + f.plainBytes, 0), failures: (m.failures || []).length, note: m.note || '' });
        } catch (err) { out.push({ stamp: st, error: err.message }); }
    }
    return out;
}

async function restore(ctx, st, file, { cfg, client, out }) {
    const { exec, inv } = ctx;
    if (!STAMP_RE.test(String(st || ''))) throw new ArchiveError('<stamp> looks like 20260926-101500');
    if (!out || !path.isAbsolute(out)) throw new ArchiveError('--out must be an absolute path');
    const master = await offsite.loadKey(exec, cfg);
    const host = await offsite.hostName(exec, inv);
    const m = await readManifest(client, cfg, master, host, st);
    const f = m.files.find((x) => x.path === file);
    if (!f) throw new ArchiveError(`archive ${st} has no ${file}`);
    if (f.object !== `${archivePrefix(cfg, host)}${st}/${objectName(file)}.ovbk`) throw new ArchiveError('the manifest names an unexpected object', 2);
    if (await exec.stat(out)) throw new ArchiveError(`${out} already exists; restore never overwrites`);
    await exec.mkdir(out, { owner: 'root', mode: 0o700 });
    const dest = path.join(out, path.basename(file));
    const plain = bcrypto.createDigestTap(); const cipher = bcrypto.createDigestTap();
    await pipeline(await offsite.getObjectStream(client, cfg.bucket, f.object), cipher, bcrypto.createDecryptStream(master), plain, exec.writeStream(dest, { mode: 0o600 }));
    const p = plain.result(); const c = cipher.result();
    if (p.sha256 !== f.plainSha256 || c.sha256 !== f.cipherSha256 || p.bytes !== f.plainBytes) {
        await exec.removeFile(dest);
        throw new ArchiveError(`${file}: the download does not match the manifest`, 2);
    }
    return { file: dest, bytes: p.bytes, sha256: p.sha256 };
}

module.exports = { push, list, restore, refusal, objectName, ArchiveError, ALLOWED_ROOTS };
