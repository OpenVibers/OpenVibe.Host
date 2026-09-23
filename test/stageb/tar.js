'use strict';
/**
 * A test-only tar writer that can produce what a hostile uploader would send: symlinks, hard links,
 * devices, FIFOs, pax path overrides, GNU long names, absolute and ".." names.
 *
 *   tarball([{ name, content, type: '0'|'1'|'2'|'3'|'5'|'6'|'x'|'L', linkname, pax: { path } }], { gzip })
 */
const zlib = require('zlib');

function header(name, size, type = '0', linkname = '') {
    const buf = Buffer.alloc(512, 0);
    const nameBuf = Buffer.from(name, 'utf8');
    nameBuf.copy(buf, 0, 0, Math.min(nameBuf.length, 100));
    buf.write('0000644\0', 100);
    buf.write('0001750\0', 108);
    buf.write('0001750\0', 116);
    buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    buf.write(`${Math.floor(Date.parse('2026-09-22T12:00:00Z') / 1000).toString(8).padStart(11, '0')}\0`, 136);
    buf.write('        ', 148);
    buf.write(type, 156);
    if (linkname) buf.write(linkname, 157);
    buf.write('ustar\0', 257);
    buf.write('00', 263);
    let sum = 0;
    for (const b of buf) sum += b;
    buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return buf;
}

function block(data) {
    const pad = (512 - (data.length % 512)) % 512;
    return pad ? [data, Buffer.alloc(pad, 0)] : [data];
}

function paxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    return `${len}${body}`;
}

function tarball(entries, { gzip = true } = {}) {
    const parts = [];
    for (const e of entries) {
        if (e.pax) {
            const data = Buffer.from(Object.entries(e.pax).map(([k, v]) => paxRecord(k, v)).join(''), 'utf8');
            parts.push(header('PaxHeader', data.length, 'x'), ...block(data));
        }
        if (e.longName) {
            const data = Buffer.from(`${e.longName}\0`, 'utf8');
            parts.push(header('././@LongLink', data.length, 'L'), ...block(data));
        }
        const type = e.type || '0';
        const data = type === '0' ? (Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content == null ? '' : e.content), 'utf8')) : Buffer.alloc(0);
        parts.push(header(e.name, data.length, type, e.linkname || ''), ...block(data));
    }
    parts.push(Buffer.alloc(1024, 0));
    const tar = Buffer.concat(parts);
    return gzip ? zlib.gzipSync(tar) : tar;
}

/** A small static site: { path: content }. */
function site(files, opts) {
    return tarball(Object.entries(files).map(([name, content]) => ({ name, content })), opts);
}

module.exports = { tarball, site };
