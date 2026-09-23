'use strict';
/**
 * The rules every file path in a deploy obeys, and the content types Host serves.
 *
 * Paths are relative, '/'-separated, ASCII, and made of plain segments: no '.', '..', empty
 * segment, backslash, NUL or control character, and no hidden segment except the leading
 * `.well-known/`. The same rules are applied to request paths after percent-decoding, and serving
 * looks paths up in the deploy's manifest (a database table) — never on the filesystem.
 *
 * Content types come from an allowlist keyed by extension. Nothing is ever executed: Stage B has no
 * build step and no server-side code, and files that are server-side code (php, cgi, asp, jsp,
 * shtml, …) are refused rather than served as text, so nobody deploys them believing they run.
 */

const MAX_PATH = 1024;
const MAX_SEGMENT = 255;
const MAX_DEPTH = 32;
const SEGMENT_RE = /^[A-Za-z0-9._@+~()!,= -]+$/;
const CA_VALIDATION = new Set(['acme-challenge', 'pki-validation']);

class PathError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

/** -> normalized path, or throws PathError. `allowDir` accepts a trailing '/'. */
function checkPath(input) {
    if (typeof input !== 'string' || !input) throw new PathError('path.empty', 'empty path');
    if (input.length > MAX_PATH) throw new PathError('path.too_long', `path longer than ${MAX_PATH} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathError('path.control_character', 'path contains a control character');
    if (input.includes('\\')) throw new PathError('path.backslash', 'path contains a backslash');
    if (/[^ -~]/.test(input)) throw new PathError('path.non_ascii', 'path contains a non-ASCII character');
    if (input.startsWith('/')) throw new PathError('path.absolute', 'absolute path');
    const segments = input.split('/');
    if (segments.length > MAX_DEPTH) throw new PathError('path.too_deep', `more than ${MAX_DEPTH} levels`);
    segments.forEach((s, i) => {
        if (s === '' ) throw new PathError('path.empty_segment', 'empty path segment ("//" or a trailing "/")');
        if (s === '.' || s === '..') throw new PathError('path.traversal', `"${s}" segment`);
        if (s.length > MAX_SEGMENT) throw new PathError('path.too_long', 'path segment longer than 255 characters');
        if (!SEGMENT_RE.test(s)) throw new PathError('path.invalid_character', `segment "${s}" has a character outside [A-Za-z0-9._@+~()!,= -]`);
        if (s.startsWith('.') && !(i === 0 && s === '.well-known' && segments.length > 1)) {
            throw new PathError('path.hidden', `hidden file or directory "${s}" (only .well-known/ is published)`);
        }
        if (s.endsWith(' ') || s.startsWith(' ')) throw new PathError('path.invalid_character', `segment "${s}" starts or ends with a space`);
    });
    // Certificate authorities prove control of a host name with files under these paths (ACME
    // HTTP-01, and the file-based validation other CAs accept over HTTPS). A tenant must never be
    // able to obtain a certificate for <site>.openvibe.host: the operator issues every certificate.
    if (segments[0] === '.well-known' && CA_VALIDATION.has(String(segments[1]).toLowerCase())) {
        throw new PathError('path.reserved', `"${segments.slice(0, 2).join('/')}/" is reserved: certificate validation files are never published from a site`);
    }
    return input;
}

// Server-side code and credentials: refused with an explicit reason.
const REFUSED = new Map([
    ...['php', 'php3', 'php4', 'php5', 'php7', 'phtml', 'phar', 'cgi', 'fcgi', 'pl', 'pm', 'py', 'pyc', 'rb', 'sh', 'bash', 'zsh', 'ksh', 'csh',
        'asp', 'aspx', 'ascx', 'ashx', 'asmx', 'jsp', 'jspx', 'cfm', 'cfc', 'shtml', 'shtm', 'stm', 'ssi', 'lua', 'ps1', 'psm1', 'bat', 'cmd',
        'exe', 'dll', 'so', 'dylib', 'bin', 'elf', 'jar', 'war', 'ear', 'class', 'htaccess', 'htpasswd']
        .map((e) => [e, 'server-side code or an executable: Host serves static files only and never runs anything']),
    ...['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'env', 'npmrc', 'pgpass', 'netrc', 'kdbx', 'sqlite', 'sqlite3', 'db']
        .map((e) => [e, 'looks like a credential or a database: never publish secrets in a static site']),
]);

const TYPES = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
    webmanifest: 'application/manifest+json; charset=utf-8',
    txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
    xml: 'application/xml; charset=utf-8', rss: 'application/rss+xml; charset=utf-8', atom: 'application/atom+xml; charset=utf-8',
    vtt: 'text/vtt; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', m4v: 'video/mp4',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
    pdf: 'application/pdf', wasm: 'application/wasm',
    glb: 'model/gltf-binary', gltf: 'model/gltf+json',
    zip: 'application/zip',
};
// Extension-less files (CNAME, LICENSE, robots-like files) are served as plain text.
const NO_EXTENSION = 'text/plain; charset=utf-8';

/** -> { contentType } or { refused: reason } */
function contentTypeFor(p) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return { contentType: NO_EXTENSION };
    const ext = base.slice(dot + 1).toLowerCase();
    if (REFUSED.has(ext)) return { refused: REFUSED.get(ext), code: 'deploy.file_refused' };
    if (TYPES[ext]) return { contentType: TYPES[ext] };
    return { refused: `".${ext}" is not an allowed file type`, code: 'deploy.type_not_allowed' };
}

/**
 * Fingerprinted asset names (bundler output) are cached as immutable: a hash-like segment of 8–64
 * characters with at least one digit right before the extension (app.3f2a9c1b.js, index-BdK3x9aQ.js).
 */
function isHashedAsset(p) {
    const m = /[.-]([A-Za-z0-9_]{8,64})\.[A-Za-z0-9]+$/.exec(p);
    return Boolean(m && /[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1]) && !/\.html?$/i.test(p));
}

module.exports = { checkPath, contentTypeFor, isHashedAsset, PathError, TYPES, REFUSED, MAX_PATH };
