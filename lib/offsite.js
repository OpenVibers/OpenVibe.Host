'use strict';
/**
 * Off-host copies of `ovhost backup --all` runs: every backed-up database is encrypted on the host
 * (lib/backup-crypto.js, AES-256-GCM with a key that stays on the host) and uploaded to S3-compatible
 * object storage (Backblaze B2 in production, the same API Media uses). Nothing is uploaded in the
 * clear except the run manifest, which holds names, sizes and hashes, never data or secrets, and
 * carries an HMAC made with the backup key.
 *
 * Configuration comes from a root-only env file (default /etc/openvibe/backup.env):
 *
 *   BACKUP_S3_ENDPOINT            https://s3.<region>.backblazeb2.com (any S3-compatible endpoint)
 *   BACKUP_S3_BUCKET              bucket name
 *   BACKUP_S3_PREFIX              key prefix, default openvibe-backups
 *   BACKUP_S3_KEY_ID              access key id (B2: application key id)
 *   BACKUP_S3_SECRET              secret access key (B2: application key)
 *   BACKUP_ENCRYPTION_KEY_FILE    root-only file with the 32-byte key as 64 hex characters
 *   BACKUP_S3_REGION              optional; derived from a B2 endpoint, else us-east-1
 *   BACKUP_S3_FORCE_PATH_STYLE    optional, default 1 (B2 needs path-style)
 *   BACKUP_OFFSITE_RETENTION_DAYS optional, default 30
 *   BACKUP_OFFSITE_PRUNE          optional, default 1; 0 when a bucket lifecycle rule does it
 *
 * This file is the only place in ovhost that reads env VALUES, and only these names. Values are
 * never logged, printed, stored or put in an error message.
 *
 * Object layout: <prefix>/<host>/<run>/<service>/<file>.ovbk and <prefix>/<host>/<run>/manifest.json.
 */
const path = require('path');
const { pipeline } = require('stream/promises');
const bcrypto = require('./backup-crypto');
const { STAMP_RE, parseStamp } = require('./retention');

const DEFAULT_ENV_FILE = '/etc/openvibe/backup.env';
const DEFAULT_PREFIX = 'openvibe-backups';
const DEFAULT_RESTORE_DIR = '/var/lib/openvibe-restore';
const PART_SIZE = 64 * 1024 * 1024;
const MIN_KEEP_RUNS = 7;
const PREFIX_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

class OffsiteError extends Error {
    constructor(message, exitCode = 2) { super(message); this.exitCode = exitCode; }
}

/** KEY=value lines → { BACKUP_*: value }. Quotes are stripped; other names are ignored. */
function parseValues(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(LINE_RE);
        if (!m || !m[1].startsWith('BACKUP_')) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '');
        out[m[1]] = v;
    }
    return out;
}

/** A root-owned file nobody else can read or write (when ovhost runs as root). */
async function checkPrivateFile(exec, file, what) {
    const st = await exec.stat(file);
    if (!st || !st.isFile) throw new OffsiteError(`${what} ${file} not found`, 1);
    if (await exec.isRoot()) {
        if (st.uid !== 0) throw new OffsiteError(`${what} ${file} must be owned by root`, 1);
        if (st.mode & 0o077) throw new OffsiteError(`${what} ${file} must not be readable or writable by group or others (chmod 0600)`, 1);
    }
}

async function loadConfig(exec, { file = null, env = {} } = {}) {
    if (!(await exec.isRoot())) throw new OffsiteError('off-host backups run as root (the backup env file and the key are root-only): use sudo', 1);
    const f = file || env.OVHOST_BACKUP_ENV || DEFAULT_ENV_FILE;
    if (!path.isAbsolute(f)) throw new OffsiteError('the backup env file must be an absolute path', 1);
    await checkPrivateFile(exec, f, 'backup env file');
    const v = parseValues(await exec.readFile(f, { privileged: true }));
    const missing = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET', 'BACKUP_ENCRYPTION_KEY_FILE'].filter((n) => !v[n]);
    if (missing.length) throw new OffsiteError(`${f} is missing or has empty: ${missing.join(', ')}`, 1);
    let endpoint;
    try { endpoint = new URL(v.BACKUP_S3_ENDPOINT); } catch { throw new OffsiteError('BACKUP_S3_ENDPOINT is not a URL', 1); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw new OffsiteError('BACKUP_S3_ENDPOINT must be https:// (plain http only on loopback)', 1);
    if (endpoint.username || endpoint.password) throw new OffsiteError('BACKUP_S3_ENDPOINT must not carry credentials; use BACKUP_S3_KEY_ID and BACKUP_S3_SECRET', 1);
    const b2 = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(endpoint.hostname);
    const prefix = (v.BACKUP_S3_PREFIX || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
    if (!PREFIX_RE.test(prefix)) throw new OffsiteError('BACKUP_S3_PREFIX may only use letters, digits, . _ - and /', 1);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v.BACKUP_S3_BUCKET)) throw new OffsiteError('BACKUP_S3_BUCKET is not a bucket name', 1);
    const keyFile = v.BACKUP_ENCRYPTION_KEY_FILE;
    if (!path.isAbsolute(keyFile)) throw new OffsiteError('BACKUP_ENCRYPTION_KEY_FILE must be an absolute path', 1);
    const days = v.BACKUP_OFFSITE_RETENTION_DAYS ? Number(v.BACKUP_OFFSITE_RETENTION_DAYS) : 30;
    if (!(Number.isInteger(days) && days >= 1)) throw new OffsiteError('BACKUP_OFFSITE_RETENTION_DAYS must be a whole number of days', 1);
    const cfg = {
        envFile: f,
        endpoint: endpoint.origin,
        region: v.BACKUP_S3_REGION || (b2 ? b2[1] : 'us-east-1'),
        bucket: v.BACKUP_S3_BUCKET,
        prefix,
        forcePathStyle: !['0', 'false', 'no'].includes(String(v.BACKUP_S3_FORCE_PATH_STYLE || '1').toLowerCase()),
        keyFile,
        retentionDays: days,
        prune: !['0', 'false', 'no'].includes(String(v.BACKUP_OFFSITE_PRUNE || '1').toLowerCase()),
    };
    // Credentials are not enumerable: JSON.stringify(cfg) and util.inspect never show them.
    Object.defineProperty(cfg, 'credentials', { value: { accessKeyId: v.BACKUP_S3_KEY_ID, secretAccessKey: v.BACKUP_S3_SECRET }, enumerable: false });
    return cfg;
}

async function loadKey(exec, cfg) {
    await checkPrivateFile(exec, cfg.keyFile, 'encryption key file');
    try { return bcrypto.parseKey(await exec.readFile(cfg.keyFile, { privileged: true })); } catch (err) { throw new OffsiteError(err.message, 1); }
}

/** The real S3 client (@aws-sdk/client-s3). Tests pass their own { send(command) }. */
function createClient(cfg) {
    const { S3Client } = require('@aws-sdk/client-s3');
    return new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle,
        credentials: cfg.credentials,
        maxAttempts: 5,
        // Checksums only where S3 requires them: every object is already authenticated by GCM and
        // by the SHA-256 in the manifest, and not every S3-compatible store takes the newer headers.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
}

function S3() { return require('@aws-sdk/client-s3'); }

/** Where a run lives: <prefix>/<host>/<run>/. */
function runPrefix(cfg, host, run) { return `${cfg.prefix}/${host}/${run}/`; }

function describe(cfg) {
    return { endpoint: cfg.endpoint, bucket: cfg.bucket, prefix: cfg.prefix, retentionDays: cfg.retentionDays, prune: cfg.prune };
}

/**
 * Upload an async iterable of Buffers. One PutObject when it is smaller than one part, else a
 * multipart upload in parts of exactly `partSize` (the last one shorter), aborted on failure so no
 * orphaned parts are billed. Memory use is about one part.
 */
async function uploadIterable(client, bucket, key, source, { partSize = PART_SIZE, contentType = 'application/octet-stream' } = {}) {
    const s3 = S3();
    let pending = [];
    let pendingLen = 0;
    let uploadId = null;
    const parts = [];
    const sendPart = async (buf) => {
        const PartNumber = parts.length + 1;
        const r = await client.send(new s3.UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber, Body: buf, ContentLength: buf.length }));
        parts.push({ ETag: r && r.ETag, PartNumber });
    };
    try {
        for await (const chunk of source) {
            pending.push(chunk);
            pendingLen += chunk.length;
            while (pendingLen >= partSize) {
                // Every part but the last is exactly partSize.
                const all = Buffer.concat(pending);
                const buf = all.subarray(0, partSize);
                pending = [all.subarray(partSize)];
                pendingLen = all.length - partSize;
                if (!uploadId) {
                    const r = await client.send(new s3.CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
                    uploadId = r && r.UploadId;
                    if (!uploadId) throw new Error('CreateMultipartUpload returned no UploadId');
                }
                await sendPart(buf);
            }
        }
        const rest = Buffer.concat(pending);
        if (!uploadId) {
            await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: rest, ContentLength: rest.length, ContentType: contentType }));
            return { parts: 1 };
        }
        if (rest.length) await sendPart(rest);
        await client.send(new s3.CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
        return { parts: parts.length };
    } catch (err) {
        if (uploadId) {
            try { await client.send(new s3.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })); } catch { /* the original error matters more */ }
        }
        throw err;
    }
}

async function listAll(client, bucket, prefix) {
    const s3 = S3();
    const out = [];
    let token;
    do {
        const r = await client.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of (r && r.Contents) || []) out.push({ key: o.Key, size: o.Size || 0, lastModified: o.LastModified || null });
        token = r && r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
}

/** Runs stored off-host for a host: [{ run, objects, bytes, manifest, services }], newest first. */
async function listRuns(client, cfg, host) {
    const base = `${cfg.prefix}/${host}/`;
    const runs = new Map();
    for (const o of await listAll(client, cfg.bucket, base)) {
        const rest = o.key.slice(base.length).split('/');
        if (!STAMP_RE.test(rest[0])) continue;
        const r = runs.get(rest[0]) || { run: rest[0], objects: 0, bytes: 0, manifest: false, services: new Set(), keys: [] };
        r.objects += 1;
        r.bytes += o.size;
        r.keys.push(o.key);
        if (rest.length === 2 && rest[1] === 'manifest.json') r.manifest = true;
        if (rest.length === 3) r.services.add(rest[1]);
        runs.set(rest[0], r);
    }
    return [...runs.values()].sort((a, b) => (a.run < b.run ? 1 : -1)).map((r) => ({ ...r, services: [...r.services].sort() }));
}

async function hostName(exec, inv, override) {
    const h = override || inv.host || await exec.hostname();
    if (!SEGMENT_RE.test(h)) throw new OffsiteError(`host name ${JSON.stringify(h)} cannot be used in an object key`, 1);
    return h;
}

function manifestBody(m) {
    const { hmac, ...rest } = m;
    return JSON.stringify(rest);
}

/**
 * Encrypt and upload every database copy a backup run made. Returns the `offsite` section of the
 * run summary. Remote runs older than the retention are pruned only after a run that uploaded
 * everything, and the newest MIN_KEEP_RUNS runs are always kept, so failing uploads never let the
 * last good copies age out.
 */
async function push(ctx, summary, { cfg, client, partSize = PART_SIZE, chunkSize } = {}) {
    const { exec, inv, log } = ctx;
    const master = await loadKey(exec, cfg);
    const host = await hostName(exec, inv, summary.host);
    const base = runPrefix(cfg, host, summary.run);
    const result = { ok: true, ...describe(cfg), run: summary.run, host, location: base, keyId: bcrypto.keyId(master), uploaded: [], failures: [], pruned: [], manifest: null };
    const manifest = { format: 'openvibe-backup-manifest/1', encryption: 'OVBKAES1', host, run: summary.run, createdAt: new Date(exec.now()).toISOString(), keyId: result.keyId, services: {} };
    for (const svc of summary.services || []) {
        for (const f of svc.files || []) {
            if (!f.dest || f.error) continue;
            const name = path.basename(f.dest);
            if (!SEGMENT_RE.test(svc.service) || !SEGMENT_RE.test(name)) { result.failures.push({ service: svc.service, file: name, error: 'unsafe name' }); continue; }
            const key = `${base}${svc.service}/${name}.ovbk`;
            const plain = bcrypto.createDigestTap();
            const cipher = bcrypto.createDigestTap();
            const t0 = exec.now();
            try {
                let up = null;
                await pipeline(exec.readStream(f.dest), plain, bcrypto.createEncryptStream(master, chunkSize ? { chunkSize } : {}), cipher, async (source) => { up = await uploadIterable(client, cfg.bucket, key, source, { partSize }); });
                const p = plain.result();
                const c = cipher.result();
                const entry = { service: svc.service, name: f.name, file: name, object: key, source: f.source || null, plainBytes: p.bytes, plainSha256: p.sha256, cipherBytes: c.bytes, cipherSha256: c.sha256, parts: up.parts, seconds: Math.round((exec.now() - t0) / 1000) };
                result.uploaded.push(entry);
                (manifest.services[svc.service] = manifest.services[svc.service] || { files: [] }).files.push(entry);
                log(`uploaded ${f.dest} → s3://${cfg.bucket}/${key} (${c.bytes} bytes encrypted)`);
            } catch (err) {
                result.failures.push({ service: svc.service, file: name, error: err.message });
                log(`✗ upload ${f.dest}: ${err.message}`);
            }
        }
    }
    manifest.failures = result.failures;
    manifest.hmac = bcrypto.hmacManifest(master, manifestBody(manifest));
    const manifestKey = `${base}manifest.json`;
    try {
        const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
        await uploadIterable(client, cfg.bucket, manifestKey, [body], { contentType: 'application/json' });
        result.manifest = manifestKey;
    } catch (err) {
        result.failures.push({ file: 'manifest.json', error: err.message });
    }
    result.ok = result.failures.length === 0;
    if (result.ok && cfg.prune) {
        try { result.pruned = await pruneRemote(ctx, { cfg, client, host, current: summary.run }); } catch (err) {
            result.ok = false;
            result.failures.push({ file: '(prune)', error: err.message });
        }
    } else if (!result.ok) log('off-host prune skipped: this run did not upload everything');
    return result;
}

async function pruneRemote(ctx, { cfg, client, host, current }) {
    const { exec, log } = ctx;
    const cutoff = exec.now() - cfg.retentionDays * 86400000;
    const runs = await listRuns(client, cfg, host);
    const protectedRuns = new Set(runs.filter((r) => r.manifest).slice(0, MIN_KEEP_RUNS).map((r) => r.run));
    protectedRuns.add(current);
    const s3 = S3();
    const pruned = [];
    for (const r of runs) {
        if (protectedRuns.has(r.run)) continue;
        const at = parseStamp(r.run);
        if (at === null || at >= cutoff) continue;
        for (const key of r.keys) {
            if (!key.startsWith(runPrefix(cfg, host, r.run))) continue;
            await client.send(new s3.DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
        }
        pruned.push(r.run);
        log(`pruned off-host run ${r.run} (${r.objects} objects)`);
    }
    return pruned;
}

async function getObjectStream(client, bucket, key) {
    const r = await client.send(new (S3().GetObjectCommand)({ Bucket: bucket, Key: key }));
    if (!r || !r.Body) throw new Error(`empty response for ${key}`);
    return r.Body;
}

async function readManifest(client, cfg, master, host, run) {
    const key = `${runPrefix(cfg, host, run)}manifest.json`;
    let text = '';
    const body = await getObjectStream(client, cfg.bucket, key);
    for await (const c of body) text += Buffer.isBuffer(c) ? c.toString('utf8') : String(c);
    let m;
    try { m = JSON.parse(text); } catch { throw new OffsiteError(`${key} is not JSON`); }
    if (!m || m.hmac !== bcrypto.hmacManifest(master, manifestBody(m))) throw new OffsiteError(`${key} failed its HMAC check: it was altered, or it was made with another key (this host's key id ${bcrypto.keyId(master)}, manifest says ${m && m.keyId})`);
    if (m.run !== run || m.host !== host) throw new OffsiteError(`${key} describes ${m.host}/${m.run}, not ${host}/${run}`);
    return m;
}

/** Directories restore-download must never write into: anything holding a declared database. */
function unsafeOut(inv, out) {
    for (const svc of Object.values(inv.services)) {
        for (const db of svc.databases) {
            const dir = path.dirname(db.path);
            if (out === dir || db.path.startsWith(`${out}/`) || out.startsWith(`${dir}/`)) return `${out} holds or sits inside ${svc.id}'s database directory ${dir}`;
        }
        if (out === svc.repo || out.startsWith(`${svc.repo}/`) || svc.repo.startsWith(`${out}/`)) return `${out} overlaps ${svc.id}'s checkout ${svc.repo}`;
    }
    for (const d of [inv.backupDir, inv.stateDir]) if (out === d || d.startsWith(`${out}/`) || out.startsWith(`${d}/`)) return `${out} overlaps ${d}`;
    return null;
}

/**
 * Download one service's databases from an off-host run, verify and decrypt them into a new
 * directory (root:root 0700, files 0600), and quick_check each. It never touches a live database: the directory
 * must not exist yet (or be empty), must not overlap any service's checkout or database directory,
 * and every file is created exclusively. Putting a copy in place is a separate, manual step.
 */
async function restoreDownload(ctx, id, runArg, { cfg, client, out = null, host: hostArg = null } = {}) {
    const { exec, inv, log } = ctx;
    if (!SEGMENT_RE.test(id)) throw new OffsiteError(`bad service name ${JSON.stringify(id)}`, 1);
    const master = await loadKey(exec, cfg);
    const host = await hostName(exec, inv, hostArg);
    let run = runArg;
    if (!run || run === 'latest') {
        const runs = (await listRuns(client, cfg, host)).filter((r) => r.manifest && r.services.includes(id));
        if (!runs.length) throw new OffsiteError(`no off-host run of ${id} under s3://${cfg.bucket}/${cfg.prefix}/${host}/`, 1);
        run = runs[0].run;
    }
    if (!STAMP_RE.test(run)) throw new OffsiteError(`<run> must be a run id such as 20260923-033000, or latest (got ${JSON.stringify(run)})`, 1);
    const manifest = await readManifest(client, cfg, master, host, run);
    const files = ((manifest.services[id] || {}).files) || [];
    if (!files.length) throw new OffsiteError(`run ${run} has no files for ${id} (it has: ${Object.keys(manifest.services).join(', ') || 'none'})`, 1);
    const dir = path.normalize(out || path.join(DEFAULT_RESTORE_DIR, `${id}-${run}`));
    if (!path.isAbsolute(dir)) throw new OffsiteError('--out must be an absolute path', 1);
    const why = unsafeOut(inv, dir);
    if (why) throw new OffsiteError(`refusing --out: ${why}`, 1);
    const existing = await exec.readdir(dir);
    if (existing && existing.length) throw new OffsiteError(`${dir} already exists and is not empty; restore-download never overwrites`, 1);
    if (!existing && await exec.stat(dir)) throw new OffsiteError(`${dir} exists and is not a directory`, 1);
    const { lockDown } = require('./commands/backup');
    if (!out) { await exec.mkdir(DEFAULT_RESTORE_DIR, { owner: 'root', mode: 0o700 }); await lockDown(exec, DEFAULT_RESTORE_DIR, 0o700); }
    await exec.mkdir(dir, { owner: 'root', mode: 0o700 });
    await lockDown(exec, dir, 0o700);
    const record = { service: id, host, run, dir, keyId: manifest.keyId, files: [] };
    for (const f of files) {
        if (!SEGMENT_RE.test(f.file || '') || f.object !== `${runPrefix(cfg, host, run)}${id}/${f.file}.ovbk`) throw new OffsiteError(`manifest entry ${JSON.stringify(f.file)} has an unexpected name or object key`);
        const dest = path.join(dir, f.file);
        const cipher = bcrypto.createDigestTap();
        const plain = bcrypto.createDigestTap();
        log(`downloading s3://${cfg.bucket}/${f.object} → ${dest}`);
        try {
            await pipeline(await getObjectStream(client, cfg.bucket, f.object), cipher, bcrypto.createDecryptStream(master), plain, exec.writeStream(dest, { mode: 0o600 }));
        } catch (err) {
            await exec.removeFile(dest);
            throw new OffsiteError(`${f.file}: ${err.message}`);
        }
        const c = cipher.result();
        const p = plain.result();
        if (c.sha256 !== f.cipherSha256 || p.sha256 !== f.plainSha256 || p.bytes !== f.plainBytes) {
            await exec.removeFile(dest);
            throw new OffsiteError(`${f.file}: the download does not match the manifest's hashes`);
        }
        let check;
        try {
            const rows = await exec.sqlite(dest, 'PRAGMA quick_check');
            check = rows && rows[0] ? String(Object.values(rows[0])[0]) : 'no answer';
        } catch (err) { check = `error: ${err.message}`; }
        record.files.push({ name: f.name, file: dest, source: f.source, bytes: p.bytes, sha256: p.sha256, quickCheck: check });
        if (check !== 'ok') throw new OffsiteError(`${dest}: quick_check = ${check}`);
    }
    return record;
}

/** Configuration, key and bucket access, without uploading anything. */
async function check(ctx, { cfg, client }) {
    const { exec, inv } = ctx;
    const master = await loadKey(exec, cfg);
    const host = await hostName(exec, inv);
    const s3 = S3();
    await client.send(new s3.ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `${cfg.prefix}/${host}/`, MaxKeys: 1 }));
    return { ok: true, ...describe(cfg), region: cfg.region, host, keyId: bcrypto.keyId(master) };
}

module.exports = {
    loadConfig,
    loadKey,
    listAll,
    getObjectStream,
    createClient,
    push,
    pruneRemote,
    listRuns,
    restoreDownload,
    check,
    uploadIterable,
    parseValues,
    hostName,
    OffsiteError,
    DEFAULT_ENV_FILE,
    PART_SIZE,
    MIN_KEEP_RUNS,
};
