'use strict';
/**
 * Reading a deploy upload from a request, with every size limit applied while streaming:
 *
 *   Content-Type: application/gzip | application/x-gzip | application/x-tar | application/octet-stream
 *       the body is a tar or tar.gz archive
 *   Content-Type: multipart/form-data
 *       archive=<one .tar/.tar.gz file>          or
 *       files=<file>… (the part's filename is the path in the site, e.g. "css/site.css";
 *                      a browser folder upload sends "<folder>/css/site.css" and strip=folder
 *                      removes that shared first segment)
 *       optional fields: activate=1, root=<subdirectory to deploy>, strip=folder, csrf (dashboard)
 *
 * Query parameters activate=1 and root=… work for both forms.
 * -> { source: 'archive'|'files', entries: [{ path, data }], fields, notes: [] }
 */
const Busboy = require('busboy');
const { readArchive, normaliseName, selectRoot, stripSharedTop, ArchiveError } = require('../artifacts/archive');
const { checkPath, PathError } = require('../artifacts/paths');

const ARCHIVE_TYPES = new Set(['application/gzip', 'application/x-gzip', 'application/x-tar', 'application/octet-stream', 'application/x-compressed-tar', 'application/tar', 'application/tar+gzip']);
const FIELD_NAMES = new Set(['activate', 'root', 'strip', 'csrf', 'expected_active']);
const fmt = (n) => `${(n / 1048576).toFixed(1)} MiB`;

class UploadError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Oversized bodies are not drained: the response closes the connection instead. */
function tooLarge(max) {
    const e = new UploadError(413, 'upload.too_large', `the upload is larger than ${fmt(max)}`);
    e.closeConnection = true;
    return e;
}

function readRaw(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let failed = false;
        req.on('data', (c) => {
            if (failed) return;
            size += c.length;
            if (size > max) { failed = true; req.pause(); reject(tooLarge(max)); return; }
            chunks.push(c);
        });
        req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
        req.on('error', (err) => { if (!failed) { failed = true; reject(err); } });
    });
}

function readMultipart(req, { maxUploadBytes, limits }) {
    return new Promise((resolve, reject) => {
        let bb;
        try {
            bb = Busboy({
                headers: req.headers,
                preservePath: true,
                limits: { fileSize: Math.max(limits.maxFileBytes, maxUploadBytes) + 1, files: limits.maxFiles + 1, fields: 20, fieldSize: 2048, parts: limits.maxFiles + 25, headerPairs: 50 },
            });
        } catch (err) {
            reject(new UploadError(400, 'upload.invalid_multipart', err.message));
            return;
        }
        const fields = {};
        const files = [];
        let archive = null;
        let total = 0;
        let failure = null;
        const fail = (e) => { if (!failure) failure = e; };

        bb.on('field', (name, value) => { if (FIELD_NAMES.has(name)) fields[name] = value; });
        bb.on('file', (name, stream, info) => {
            const chunks = [];
            let size = 0;
            stream.on('data', (c) => {
                if (failure) return;
                size += c.length;
                total += c.length;
                if (total > maxUploadBytes) {
                    fail(tooLarge(maxUploadBytes));
                    req.unpipe(bb);
                    req.pause();
                    resolve({ failure, fields });
                    return;
                }
                chunks.push(c);
            });
            stream.on('limit', () => fail(tooLarge(maxUploadBytes)));
            stream.on('end', () => {
                if (failure) return;
                const data = Buffer.concat(chunks);
                if (name === 'archive') {
                    if (archive) fail(new UploadError(422, 'upload.invalid', 'send one archive'));
                    archive = data;
                } else if (name === 'files' || name === 'file') {
                    if (!info.filename) return;          // an empty <input type=file>
                    files.push({ path: String(info.filename), data });
                } else {
                    fail(new UploadError(422, 'upload.invalid', `unexpected file field "${name}" (use "archive" or "files")`));
                }
            });
        });
        bb.on('filesLimit', () => fail(new UploadError(413, 'quota.max_files', `more than ${limits.maxFiles} files`)));
        bb.on('partsLimit', () => fail(new UploadError(413, 'quota.max_files', 'too many parts')));
        bb.on('error', (err) => { fail(new UploadError(400, 'upload.invalid_multipart', err.message)); resolve({ failure, fields }); });
        bb.on('close', () => {
            if (failure) return resolve({ failure, fields });
            if (archive && files.length) return resolve({ failure: new UploadError(422, 'upload.invalid', 'send either an archive or files, not both'), fields });
            resolve({ fields, archive, files });
        });
        req.pipe(bb);
    });
}

/**
 * Throws UploadError for problems with the request itself; everything else (the archive's
 * contents) is reported by the validator.
 */
async function readUpload(req, { maxUploadBytes, maxUnpackedBytes = Infinity, limits }) {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > maxUploadBytes) throw tooLarge(maxUploadBytes);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const notes = [];
    let source;
    let fields = {};
    let entries;
    let rawArchive = null;
    if (type === 'multipart/form-data') {
        const r = await readMultipart(req, { maxUploadBytes, limits });
        fields = r.fields || {};
        if (r.failure) { r.failure.fields = fields; throw r.failure; }
        if (r.archive) { rawArchive = r.archive; } else {
            source = 'files';
            entries = r.files.map((f) => ({ path: normaliseName(f.path), data: f.data }));
            notes.push(`received ${entries.length} files as multipart form data`);
            if ((fields.strip || req.query.strip) === 'folder') {
                const s = stripSharedTop(entries);
                entries = s.entries;
                if (s.stripped) notes.push(`removed the uploaded folder name "${s.stripped}/" from every path`);
            }
        }
    } else if (ARCHIVE_TYPES.has(type)) {
        rawArchive = await readRaw(req, maxUploadBytes);
    } else {
        req.resume();   // bodies of an unsupported type are small or refused by nginx; drain for keep-alive
        throw new UploadError(415, 'upload.unsupported_type', 'send a tar or tar.gz archive (application/gzip) or multipart/form-data');
    }

    if (rawArchive) {
        source = 'archive';
        let r;
        try { r = readArchive(rawArchive, { ...limits, maxTotalBytes: Math.min(limits.maxTotalBytes, maxUnpackedBytes) }); } catch (err) {
            if (err instanceof ArchiveError) { const e = new UploadError(err.status, err.code, err.message); e.fields = fields; e.source = 'archive'; throw e; }
            throw err;
        }
        entries = r.entries.map((e) => ({ path: normaliseName(e.path), data: e.data }));
        notes.push(`received a ${r.compressed ? 'tar.gz' : 'tar'} archive of ${(rawArchive.length / 1024).toFixed(1)} KiB: ${entries.length} files, ${r.directories} directories`);
    }

    const root = fields.root || req.query.root;
    if (root) {
        let clean;
        try { clean = checkPath(String(root).replace(/^\.\/+/, '').replace(/\/+$/, '')); } catch (err) {
            if (err instanceof PathError) { const e = new UploadError(422, 'upload.invalid_root', `root: ${err.message}`); e.fields = fields; e.source = source; throw e; }
            throw err;
        }
        const s = selectRoot(entries, clean);
        entries = s.entries;
        notes.push(`deploying from "${clean}/": ${entries.length} files kept, ${s.dropped} outside it ignored`);
    }
    return { source, entries, fields, notes };
}

/**
 * At most `max` uploads are read and validated at once, service-wide. An upload is held in memory
 * (up to HOST_MAX_UPLOAD_BYTES, plus up to HOST_MAX_UNPACKED_BYTES once unpacked), so without a cap
 * a handful of accounts uploading together could exhaust the host's memory. enter() -> release()
 * or null when every slot is taken (the caller answers 503 with Retry-After before reading a byte).
 */
function createUploadGate(max) {
    const limit = Math.max(1, Number(max) || 1);
    let inFlight = 0;
    return {
        enter() {
            if (inFlight >= limit) return null;
            inFlight++;
            let released = false;
            return () => { if (!released) { released = true; inFlight--; } };
        },
        get inFlight() { return inFlight; },
        limit,
    };
}

module.exports = { readUpload, UploadError, createUploadGate };
