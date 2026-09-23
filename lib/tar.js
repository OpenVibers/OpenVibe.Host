'use strict';
/**
 * A minimal ustar writer + gzip, enough for config snapshots (regular files only, names under 100
 * bytes). Written here so snapshots need neither a tar binary nor a dependency, and the tests can
 * read the archive back with readTarGz().
 */
const zlib = require('zlib');

function header(name, size, mtime) {
    const buf = Buffer.alloc(512, 0);
    if (Buffer.byteLength(name) > 99) throw new Error(`tar: name too long: ${name}`);
    buf.write(name, 0, 'utf8');
    buf.write('0000640\0', 100);
    buf.write('0000000\0', 108);
    buf.write('0000000\0', 116);
    buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    buf.write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136);
    buf.write('        ', 148);
    buf.write('0', 156);
    buf.write('ustar\0', 257);
    buf.write('00', 263);
    let sum = 0;
    for (const b of buf) sum += b;
    buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return buf;
}

/** files: [{ name, content (string|Buffer) }] -> gzipped tar Buffer */
function createTarGz(files, mtime = Date.now()) {
    const parts = [];
    for (const f of files) {
        const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8');
        parts.push(header(f.name, data.length, mtime), data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) parts.push(Buffer.alloc(pad, 0));
    }
    parts.push(Buffer.alloc(1024, 0));
    return zlib.gzipSync(Buffer.concat(parts));
}

function readTarGz(buf) {
    const tar = zlib.gunzipSync(buf);
    const out = [];
    let off = 0;
    while (off + 512 <= tar.length) {
        const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
        if (!name) break;
        const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
        out.push({ name, content: tar.subarray(off + 512, off + 512 + size).toString('utf8') });
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

module.exports = { createTarGz, readTarGz };
