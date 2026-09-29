'use strict';
/**
 * Per-site serving configuration (plan T12 J3, decision D4): the response headers, the redirects and
 * the SPA fallback of ONE site, kept in PostgreSQL and applied by server/http/tenant.js BEFORE the
 * platform's own headers. The platform's security, routing and caching headers (CSP, HSTS,
 * Set-Cookie, X-Forwarded-*, Cache-Control, …) are reserved and can never be set through it; a
 * redirect target must be a local path, so a site can never become an open redirect. A site with no
 * row serves exactly as before.
 */
const { ApiError } = require('../http/errors');
const { principalOf } = require('./access');

const MAX_HEADERS = 50;
const MAX_HEADER_VALUE = 1024;
const MAX_REDIRECTS = 200;
const MAX_LOCATION = 1024;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REDIRECT_STATUS = new Set([301, 302, 307, 308]);

// Headers the platform owns: a site's config can never set one. `X-Forwarded-*` is refused as a
// prefix, so a site can never lie about the client to an upstream reading those headers.
const RESERVED_HEADERS = new Set([
    'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security',
    'set-cookie', 'set-cookie2', 'clear-site-data',
    'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade', 'te', 'host', 'location',
    'content-type', 'content-disposition', 'content-encoding', 'content-range', 'accept-ranges',
    'cache-control', 'cdn-cache-control', 'etag', 'expires', 'last-modified', 'vary', 'age',
    'x-content-type-options', 'x-served-by', 'x-robots-tag', 'referrer-policy',
    'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'permissions-policy',
    // Scope and transport are the platform's too: a wider service-worker scope, or another host:port for this origin.
    'service-worker-allowed', 'alt-svc',
]);
const RESERVED_PREFIXES = ['x-forwarded-'];

/** Why `name` cannot be configured, or null when it can. */
function reservedReason(name) {
    const lower = String(name).toLowerCase();
    if (RESERVED_HEADERS.has(lower)) return `"${name}" is set by the platform and cannot be configured`;
    if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) return `"${name}" is reserved (X-Forwarded-*) and cannot be configured`;
    return null;
}
function isReservedHeader(name) { return reservedReason(name) !== null; }

const fail = (code, message) => { throw new ApiError(422, code, message); };

function cleanHeaderValue(name, value) {
    const v = value == null ? '' : String(value);
    if (v.length > MAX_HEADER_VALUE) fail('site_config.header_value', `the value of "${name}" is longer than ${MAX_HEADER_VALUE} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) fail('site_config.header_value', `the value of "${name}" contains a control character: a header value must be one line`);
    return v;
}

/** name → value object of configurable headers, or throws ApiError(422). */
function cleanHeaders(input) {
    if (input == null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) fail('site_config.headers', 'headers must be an object of name → value');
    const names = Object.keys(input);
    if (names.length > MAX_HEADERS) fail('site_config.too_many', `a site may set at most ${MAX_HEADERS} headers`);
    const out = {};
    for (const name of names) {
        if (!HEADER_NAME_RE.test(name)) fail('site_config.header_name', `"${name}" is not a valid header name`);
        const reason = reservedReason(name);
        if (reason) fail('site_config.reserved_header', reason);
        out[name] = cleanHeaderValue(name, input[name]);
    }
    return out;
}

/** A redirect source or target must be a local path: no scheme, no host, no backslash (which browsers read as "/"). */
function cleanLocalPath(value, field) {
    const s = value == null ? '' : String(value).trim();
    if (!s || s.length > MAX_LOCATION) fail('site_config.redirect', `${field} must be a path of 1–${MAX_LOCATION} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) fail('site_config.redirect', `${field} contains a control character`);
    if (s.includes('\\')) fail('site_config.redirect', `${field} contains a backslash`);
    if (s[0] !== '/') fail('site_config.redirect', `${field} must be a local path starting with "/"`);
    if (s.startsWith('//')) fail('site_config.redirect', `${field} must be a local path, not a protocol-relative URL`);
    let decoded;
    try { decoded = decodeURIComponent(s); } catch { fail('site_config.redirect', `${field} is not valid percent-encoding`); }
    // eslint-disable-next-line no-control-regex
    if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded) || /(^|\/)\/\//.test(decoded)) fail('site_config.redirect', `${field} must be a local path (it decoded to a scheme, a host or a control character)`);
    return s;
}

/** [{ from, to, status }] of local-only redirects, or throws ApiError(422). */
function cleanRedirects(input) {
    if (input == null) return [];
    if (!Array.isArray(input)) fail('site_config.redirects', 'redirects must be an array');
    if (input.length > MAX_REDIRECTS) fail('site_config.too_many', `a site may have at most ${MAX_REDIRECTS} redirects`);
    const seen = new Set();
    const out = [];
    for (const [i, r] of input.entries()) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail('site_config.redirect', `redirect ${i + 1} must be an object with "from" and "to"`);
        const from = cleanLocalPath(r.from, `redirect ${i + 1} "from"`);
        const to = cleanLocalPath(r.to, `redirect ${i + 1} "to"`);
        if (seen.has(from)) fail('site_config.redirect', `two redirects have the same "from" path (${from})`);
        seen.add(from);
        const status = r.status == null ? 301 : Number(r.status);
        if (!REDIRECT_STATUS.has(status)) fail('site_config.redirect', `redirect ${i + 1} status must be one of 301, 302, 307, 308`);
        out.push({ from, to, status });
    }
    return out;
}

const cleanSpa = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).toLowerCase());

/** The whole config, cleaned. */
function normalize(input = {}) {
    return { headers: cleanHeaders(input.headers), redirects: cleanRedirects(input.redirects), spa: cleanSpa(input.spa) };
}

function defaults() { return { headers: {}, redirects: [], spa: false }; }

// ── Dashboard text form (one "Name: value" per line; one "from -> to [status]" per line) ──
function headersToText(headers) {
    return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}
function parseHeadersText(text) {
    const obj = {};
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const i = line.indexOf(':');
        if (i <= 0) fail('site_config.header_syntax', `each header line must be "Name: value" (got "${line.slice(0, 60)}")`);
        const name = line.slice(0, i).trim();
        if (name in obj) fail('site_config.header_syntax', `"${name}" is listed twice`);
        obj[name] = line.slice(i + 1).trim();
    }
    return cleanHeaders(obj);
}
function redirectsToText(redirects) {
    return (redirects || []).map((r) => `${r.from} -> ${r.to}${r.status && r.status !== 301 ? ` ${r.status}` : ''}`).join('\n');
}
function parseRedirectsText(text) {
    const list = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^(\S+)\s*->\s*(\S+)(?:\s+(\d{3}))?$/.exec(line);
        if (!m) fail('site_config.redirect_syntax', `each redirect line must be "from -> to [status]" (got "${line.slice(0, 60)}")`);
        list.push({ from: m[1], to: m[2], status: m[3] ? Number(m[3]) : 301 });
    }
    return cleanRedirects(list);
}

function createSiteConfig({ store }) {
    const { db } = store;
    const q = {
        bySite: db.prepare('SELECT * FROM host_site_config WHERE site_id = ?'),
        upsert: db.prepare(`INSERT INTO host_site_config (site_id, headers, redirects, spa, updated_by, updated_at)
                            VALUES (?, ?::jsonb, ?::jsonb, ?, ?, ?)
                            ON CONFLICT (site_id) DO UPDATE SET headers = EXCLUDED.headers, redirects = EXCLUDED.redirects,
                                spa = EXCLUDED.spa, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`),
        remove: db.prepare('DELETE FROM host_site_config WHERE site_id = ?'),
    };

    const rowToConfig = (row) => (row
        ? { headers: row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers) ? row.headers : {}, redirects: Array.isArray(row.redirects) ? row.redirects : [], spa: Boolean(row.spa) }
        : defaults());

    async function getForSite(siteId) { return rowToConfig(await q.bySite.get(siteId)); }

    async function set(viewer, site, input) {
        const cfg = normalize(input);
        await q.upsert.run(site.id, JSON.stringify(cfg.headers), JSON.stringify(cfg.redirects), cfg.spa, principalOf(viewer), store.now());
        return await getForSite(site.id);
    }

    async function remove(site) { await q.remove.run(site.id); return defaults(); }

    return {
        getForSite, set, remove, defaults, normalize, cleanHeaders, cleanRedirects,
        headersToText, parseHeadersText, redirectsToText, parseRedirectsText,
    };
}

module.exports = {
    createSiteConfig, normalize, defaults, isReservedHeader, cleanHeaders, cleanRedirects,
    parseHeadersText, parseRedirectsText, headersToText, redirectsToText,
    RESERVED_HEADERS, RESERVED_PREFIXES, REDIRECT_STATUS, MAX_HEADERS, MAX_REDIRECTS,
};
