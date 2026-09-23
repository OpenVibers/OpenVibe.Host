'use strict';
/**
 * Reading an uploaded deploy: a tar or tar.gz archive (ustar, pax and GNU long names), or a set
 * of multipart files. Both end as the same list of { path, data } entries, checked by validate.js.
 *
 * The reader never touches the filesystem: entries are parsed from a Buffer and nothing is
 * extracted. Symbolic links, hard links, devices, FIFOs, sparse and other special entries are
 * refused (the whole deploy fails), never skipped silently. Decompression is capped
 * (maxOutputLength), so a gzip bomb stops at the limit instead of filling memory.
 */
const zlib = require('zlib');

class ArchiveError extends Error {
    constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

const BLOCK = 512;

function str(buf, start, len) {
    const s = buf.subarray(start, start + len);
    const z = s.indexOf(0);
    return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function octal(buf, start, len, what) {
    if (buf[start] & 0x80) throw new ArchiveError('archive.unsupported', `${what} uses base-256 encoding (entries over 8 GB are not supported)`);
    const s = str(buf, start, len).trim();
    if (!s) return 0;
    if (!/^[0-7]+$/.test(s)) throw new ArchiveError('archive.corrupt', `${what} is not an octal number`);
    return parseInt(s, 8);
}

function checksumOk(header) {
    const stored = octal(header, 148, 8, 'header checksum');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : header[i];
    return sum === stored;
}

function parsePax(data) {
    const out = {};
    let off = 0;
    const text = data.toString('utf8');
    while (off < text.length) {
        const sp = text.indexOf(' ', off);
        if (sp < 0) break;
        const len = parseInt(text.slice(off, sp), 10);
        if (!Number.isFinite(len) || len <= 0) throw new ArchiveError('archive.corrupt', 'malformed pax header');
        const record = text.slice(sp + 1, off + len - 1);
        const eq = record.indexOf('=');
        if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
        off += len;
    }
    return out;
}

const TYPE_NAMES = { 1: 'a hard link', 2: 'a symbolic link', 3: 'a character device', 4: 'a block device', 6: 'a FIFO', 7: 'a contiguous file', K: 'a GNU long link name', S: 'a sparse file', V: 'a volume header', M: 'a multi-volume entry', N: 'an old GNU long name' };

/**
 * buf: the uploaded bytes (gzip or plain tar). limits: { maxTotalBytes, maxFiles, maxFileBytes }.
 * -> { entries: [{ path, data }], directories: n, compressed: bool }
 */
function readArchive(buf, limits) {
    let tar = buf;
    const compressed = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    if (compressed) {
        const cap = limits.maxTotalBytes + (limits.maxFiles + 16) * 3 * BLOCK + 1024 * 1024;
        try {
            tar = zlib.gunzipSync(buf, { maxOutputLength: cap });
        } catch (err) {
            if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) {
                throw new ArchiveError('deploy.too_large', 'the archive expands beyond the size this project may deploy', 413);
            }
            throw new ArchiveError('archive.corrupt', 'not a valid gzip stream');
        }
    }
    if (tar.length < BLOCK) throw new ArchiveError('archive.corrupt', 'not a tar archive (too short)');

    const entries = [];
    let directories = 0;
    let total = 0;
    let off = 0;
    let pending = {};          // pax / GNU long-name overrides for the next entry
    let sawEnd = false;
    while (off + BLOCK <= tar.length) {
        const header = tar.subarray(off, off + BLOCK);
        if (header.every((b) => b === 0)) { sawEnd = true; break; }
        if (!checksumOk(header)) throw new ArchiveError('archive.corrupt', `bad header checksum at byte ${off}`);
        const type = String.fromCharCode(header[156] || 48);   // NUL means a regular file
        const size = octal(header, 124, 12, 'entry size');
        const magic = str(header, 257, 6);
        let name = str(header, 0, 100);
        if (magic.startsWith('ustar')) {
            const prefix = str(header, 345, 155);
            if (prefix) name = `${prefix}/${name}`;
        }
        const dataStart = off + BLOCK;
        const dataEnd = dataStart + size;
        if (dataEnd > tar.length) throw new ArchiveError('archive.corrupt', 'truncated archive');
        const data = tar.subarray(dataStart, dataEnd);
        off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

        if (type === 'x') { Object.assign(pending, parsePax(data)); continue; }
        if (type === 'g') continue;                                   // global pax header: nothing we use
        if (type === 'L') { pending.path = str(data, 0, data.length); continue; }
        if (pending.path != null) name = pending.path;
        if (pending.linkpath != null && type !== '1' && type !== '2') throw new ArchiveError('deploy.link_refused', `"${name}" carries a link target`);
        pending = {};

        if (type === '1' || type === '2') throw new ArchiveError('deploy.link_refused', `"${name}" is ${TYPE_NAMES[type]}: links are refused (a deploy holds regular files only)`);
        if (type === '5') { directories++; continue; }
        if (type !== '0') throw new ArchiveError('deploy.special_file_refused', `"${name}" is ${TYPE_NAMES[type] || `an entry of type "${type}"`}: only regular files are accepted`);

        // A regular file.
        if (entries.length >= limits.maxFiles) throw new ArchiveError('quota.max_files', `more than ${limits.maxFiles} files`, 413);
        if (size > limits.maxFileBytes) throw new ArchiveError('quota.max_file_bytes', `"${name}" is ${size} bytes; the limit per file is ${limits.maxFileBytes}`, 413);
        total += size;
        if (total > limits.maxTotalBytes) throw new ArchiveError('deploy.too_large', `the files add up to more than ${limits.maxTotalBytes} bytes`, 413);
        entries.push({ path: name, data });   // a view into the tar buffer: no second copy
    }
    if (!sawEnd && off < tar.length) throw new ArchiveError('archive.corrupt', 'trailing garbage after the last entry');
    return { entries, directories, compressed };
}

/**
 * Normalise archive/multipart names before validation: tar's "./" prefix and directory-style
 * names. Anything else (absolute paths, "..", backslashes) is left for the validator to refuse.
 */
function normaliseName(name) {
    let n = String(name);
    while (n.startsWith('./')) n = n.slice(2);
    return n;
}

/**
 * Deploy from a subdirectory: keep entries under `root/`, strip the prefix, report what was
 * dropped. root must itself be a clean relative path.
 */
function selectRoot(entries, root) {
    if (!root) return { entries, dropped: 0 };
    const prefix = `${root.replace(/\/+$/, '')}/`;
    const kept = [];
    let dropped = 0;
    for (const e of entries) {
        if (e.path.startsWith(prefix)) kept.push({ ...e, path: e.path.slice(prefix.length) });
        else dropped++;
    }
    return { entries: kept, dropped };
}

/** A browser folder upload names every file "<folder>/…": strip that single shared top folder. */
function stripSharedTop(entries) {
    if (!entries.length) return { entries, stripped: null };
    const firsts = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : null)));
    if (firsts.size !== 1 || firsts.has(null)) return { entries, stripped: null };
    const top = [...firsts][0];
    return { entries: entries.map((e) => ({ ...e, path: e.path.slice(top.length + 1) })), stripped: top };
}

module.exports = { readArchive, normaliseName, selectRoot, stripSharedTop, ArchiveError };
