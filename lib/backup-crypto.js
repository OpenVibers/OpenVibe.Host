'use strict';
/**
 * Encryption for off-host backups: AES-256-GCM in fixed-size chunks, with Node crypto only.
 *
 * The master key is 32 random bytes kept in a root-only file on the host (64 hex characters, or
 * base64). It never leaves the host and is never printed; `keyId()` is a non-secret fingerprint
 * that names it in manifests and logs.
 *
 * File format OVBKAES1 (integers big-endian; also documented in docs/backups.md):
 *
 *   header   52 bytes
 *     0   8  magic "OVBKAES1"
 *     8   4  chunk size C (plaintext bytes per chunk; ovhost writes 1 MiB, readers accept up to 64 MiB)
 *    12  32  salt: random per file
 *    44   8  key id: HMAC-SHA256(master, "openvibe-backup key-id v1")[0..8]
 *   chunks   each: ciphertext (C bytes; the final chunk 0..C bytes) || 16-byte GCM tag
 *
 *   file key = HKDF-SHA256(master, salt, info "openvibe-backup v1 file key", 32 bytes)
 *   nonce_i  = 11-byte big-endian chunk index i || 1 byte final flag (1 on the last chunk, else 0)
 *   AAD      = the 52 header bytes, for every chunk
 *
 * A fresh salt gives every file its own key, so the counter nonces never repeat under one key.
 * The final flag makes truncation at a chunk boundary detectable, and the header in the AAD makes
 * any edit to it (chunk size, salt, key id) fail authentication. The final chunk is always written,
 * even when it is empty, so a file always ends with a flagged chunk.
 */
const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('OVBKAES1', 'ascii');
const HEADER_LEN = 52;
const TAG_LEN = 16;
const DEFAULT_CHUNK = 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;

class BackupCryptoError extends Error {}

/** Parse a key file's text: 64 hex characters or base64 of 32 bytes. The error never echoes it. */
function parseKey(text) {
    const t = String(text == null ? '' : text).trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
    if (/^[A-Za-z0-9+/]{43}=?$/.test(t)) {
        const b = Buffer.from(t, 'base64');
        if (b.length === 32) return b;
    }
    throw new BackupCryptoError('the encryption key file must hold 32 random bytes as 64 hex characters (openssl rand -hex 32)');
}

function keyId(master) {
    return crypto.createHmac('sha256', master).update('openvibe-backup key-id v1').digest().subarray(0, 8).toString('hex');
}

function fileKey(master, salt) {
    return Buffer.from(crypto.hkdfSync('sha256', master, salt, 'openvibe-backup v1 file key', 32));
}

/** A key for authenticating run manifests, separate from every file key. */
function manifestKey(master) {
    return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'openvibe-backup v1 manifest', 32));
}

function nonce(index, final) {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(BigInt(index), 3);
    n[11] = final ? 1 : 0;
    return n;
}

function header(master, chunkSize, salt) {
    const h = Buffer.alloc(HEADER_LEN);
    MAGIC.copy(h, 0);
    h.writeUInt32BE(chunkSize, 8);
    salt.copy(h, 12);
    Buffer.from(keyId(master), 'hex').copy(h, 44);
    return h;
}

/** Ciphertext size for a plaintext of `plainBytes`. */
function encryptedSize(plainBytes, chunkSize = DEFAULT_CHUNK) {
    const chunks = Math.max(1, Math.ceil(plainBytes / chunkSize));
    return HEADER_LEN + plainBytes + chunks * TAG_LEN;
}

function sealChunk(key, aad, index, final, plain) {
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce(index, final));
    c.setAAD(aad);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function openChunk(key, aad, index, final, sealed) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(index, final));
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    try {
        return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
    } catch {
        throw new BackupCryptoError(`chunk ${index} failed authentication: the file was altered, truncated or encrypted with another key`);
    }
}

function createEncryptStream(master, { chunkSize = DEFAULT_CHUNK, salt = crypto.randomBytes(32) } = {}) {
    if (!Buffer.isBuffer(master) || master.length !== 32) throw new BackupCryptoError('the master key must be 32 bytes');
    if (!(Number.isInteger(chunkSize) && chunkSize >= 1 && chunkSize <= MAX_CHUNK)) throw new BackupCryptoError('bad chunk size');
    const aad = header(master, chunkSize, salt);
    const key = fileKey(master, salt);
    let buf = Buffer.alloc(0);
    let index = 0;
    let started = false;
    return new Transform({
        transform(chunk, _enc, cb) {
            if (!started) { this.push(aad); started = true; }
            buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
            // Only emit a chunk when more data follows it, so the last one can carry the final flag.
            while (buf.length > chunkSize) {
                this.push(sealChunk(key, aad, index++, false, buf.subarray(0, chunkSize)));
                buf = buf.subarray(chunkSize);
            }
            cb();
        },
        flush(cb) {
            if (!started) this.push(aad);
            this.push(sealChunk(key, aad, index++, true, buf));
            buf = Buffer.alloc(0);
            cb();
        },
    });
}

function createDecryptStream(master) {
    if (!Buffer.isBuffer(master) || master.length !== 32) throw new BackupCryptoError('the master key must be 32 bytes');
    let buf = Buffer.alloc(0);
    let aad = null;
    let key = null;
    let sealedLen = 0;
    let index = 0;
    function readHeader() {
        const h = buf.subarray(0, HEADER_LEN);
        if (!h.subarray(0, 8).equals(MAGIC)) throw new BackupCryptoError('not an OpenVibe backup file (bad magic)');
        const chunkSize = h.readUInt32BE(8);
        if (!(chunkSize >= 1 && chunkSize <= MAX_CHUNK)) throw new BackupCryptoError('bad chunk size in header');
        if (h.subarray(44, 52).toString('hex') !== keyId(master)) throw new BackupCryptoError(`encrypted with another key (key id ${h.subarray(44, 52).toString('hex')}, this host's key is ${keyId(master)})`);
        aad = Buffer.from(h);
        key = fileKey(master, h.subarray(12, 44));
        sealedLen = chunkSize + TAG_LEN;
        buf = buf.subarray(HEADER_LEN);
    }
    return new Transform({
        transform(chunk, _enc, cb) {
            try {
                buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
                if (!aad) { if (buf.length < HEADER_LEN) return cb(); readHeader(); }
                while (buf.length > sealedLen) {
                    this.push(openChunk(key, aad, index++, false, buf.subarray(0, sealedLen)));
                    buf = buf.subarray(sealedLen);
                }
                cb();
            } catch (err) { cb(err); }
        },
        flush(cb) {
            try {
                if (!aad) throw new BackupCryptoError('truncated: no complete header');
                if (buf.length < TAG_LEN) throw new BackupCryptoError('truncated: the final chunk is missing');
                this.push(openChunk(key, aad, index++, true, buf));
                cb();
            } catch (err) { cb(err); }
        },
    });
}

/** A pass-through that hashes (SHA-256) and counts what flows through it. */
function createDigestTap() {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const t = new Transform({
        transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
    });
    t.result = () => ({ sha256: hash.digest('hex'), bytes });
    return t;
}

function hmacManifest(master, body) {
    return crypto.createHmac('sha256', manifestKey(master)).update(body).digest('hex');
}

module.exports = {
    parseKey,
    keyId,
    createEncryptStream,
    createDecryptStream,
    createDigestTap,
    encryptedSize,
    hmacManifest,
    BackupCryptoError,
    HEADER_LEN,
    TAG_LEN,
    DEFAULT_CHUNK,
};
