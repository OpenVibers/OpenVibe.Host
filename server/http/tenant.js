'use strict';
/**
 * Serving tenant sites by Host header.
 *
 *   <name>.<sitesDomain>        the site called <name> (one label; anything deeper is unknown)
 *   <verified custom domain>    the site it was verified for (pending, failed and lapsed: unknown)
 *   anything else               404 "unknown host" with no tenant content
 *
 * A request resolves its site ONCE from the Host header, reads the site's active deploy pointer
 * ONCE, and from then on reads only immutable rows of that deploy (host_deploy_files). The file's
 * bytes come from <storage>/projects/<that site's project>/<sha256>: the path is built from the
 * project id and the manifest's hash, never from the URL, so no URL, encoding or Host trick can
 * reach another project's objects.
 *
 * Responses: GET/HEAD only; Content-Type from the manifest; strong ETag (the sha256); 304 on
 * If-None-Match; single byte ranges; `immutable` caching for fingerprinted assets and revalidation
 * for everything else (so a rollback shows at once); nosniff; a strict CSP; never a cookie.
 * A site that staff took down (domain/takedowns.js) answers 451 with none of its content.
 */
const fs = require('fs');
const { checkPath, PathError, isHashedAsset } = require('../artifacts/paths');
const { isHostname } = require('../domain/domains');

const TENANT_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "media-src 'self' https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    'upgrade-insecure-requests',
].join('; ');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Host header → lowercase host name without port or trailing dot; null when it is not one. */
function normaliseHost(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 260) return null;
    let h = raw.trim().toLowerCase();
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        return end > 0 ? h.slice(0, end + 1) : null;
    }
    const colon = h.indexOf(':');
    if (colon >= 0) {
        if (!/^\d{1,5}$/.test(h.slice(colon + 1))) return null;
        h = h.slice(0, colon);
    }
    if (h.endsWith('.')) h = h.slice(0, -1);
    if (!h || !/^[a-z0-9.-]+$/.test(h)) return null;
    return h;
}

function baseHeaders(res, { sandbox = false } = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', TENANT_CSP);
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    res.setHeader('X-Served-By', 'OpenVibe.Host');
    if (sandbox) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function plain(res, status, text, extra = {}) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.end(text);
}

function createTenantServer({ store, config, blobs, takedowns = null, log = console }) {
    const { db } = store;
    const q = {
        siteByName: db.prepare("SELECT s.*, p.environment FROM host_sites s JOIN host_projects p ON p.id = s.project_id WHERE s.name = ? AND s.status = 'active' AND p.status = 'active'"),
        siteByCustom: db.prepare(`SELECT s.*, p.environment FROM host_domains d JOIN host_sites s ON s.id = d.site_id JOIN host_projects p ON p.id = s.project_id
                                  WHERE d.hostname = ? AND d.kind = 'custom' AND d.status = 'verified' AND s.status = 'active' AND p.status = 'active'`),
        file: db.prepare(`SELECT f.sha256, f.size, f.content_type, d.project_id FROM host_deploy_files f JOIN host_deploys d ON d.id = f.deploy_id
                          WHERE f.deploy_id = ? AND f.path = ? AND d.state = 'ready'`),
    };
    const suffix = `.${config.sitesDomain}`;

    /**
     * -> { kind: 'dashboard' } | { kind: 'site', site } | { kind: 'unknown', host }
     */
    function resolve(rawHost) {
        const host = normaliseHost(rawHost);
        if (!host) return { kind: 'unknown', host: null };
        if (host === config.dashboardHost || LOOPBACK_HOSTS.has(host)) return { kind: 'dashboard' };
        if (host.endsWith(suffix)) {
            const label = host.slice(0, -suffix.length);
            if (!label || label.includes('.')) return { kind: 'unknown', host };
            const site = q.siteByName.get(label);
            return site ? { kind: 'site', site, host } : { kind: 'unknown', host };
        }
        if (!isHostname(host)) return { kind: 'unknown', host };
        const site = q.siteByCustom.get(host);
        return site ? { kind: 'site', site, host } : { kind: 'unknown', host };
    }

    /** Raw request path → candidate manifest paths, or null when the path is not a plain path. */
    function candidates(rawPath) {
        if (!rawPath.startsWith('/')) return null;
        const trailing = rawPath.length > 1 && rawPath.endsWith('/');
        const inner = rawPath.slice(1, trailing ? -1 : undefined);
        if (!inner) return { list: ['index.html'], dir: true, path: '' };
        const segments = inner.split('/');
        const decoded = [];
        for (const seg of segments) {
            if (/%2f|%5c|%00/i.test(seg)) return null;        // an encoded separator or NUL is never a path
            let d;
            try { d = decodeURIComponent(seg); } catch { return null; }
            decoded.push(d);
        }
        const p = decoded.join('/');
        try { checkPath(p); } catch (err) { if (err instanceof PathError) return null; throw err; }
        if (trailing) return { list: [`${p}/index.html`], dir: true, path: p };
        return { list: [p, `${p}.html`], dirIndex: `${p}/index.html`, dir: false, path: p };
    }

    function send(req, res, site, row, { status = 200, cache }) {
        const etag = `"${row.sha256}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Content-Type', row.content_type);
        res.setHeader('Cache-Control', cache);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-OpenVibe-Deploy', site.active_deploy_id);
        const inm = req.headers['if-none-match'];
        if (status === 200 && inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag)) {
            res.statusCode = 304;
            return res.end();
        }
        let start = 0;
        let end = row.size - 1;
        const range = status === 200 ? req.headers.range : null;
        if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
            if (!m || (!m[1] && !m[2])) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${row.size}`); return res.end(); }
            if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), row.size - 1) : row.size - 1; } else { start = Math.max(row.size - Number(m[2]), 0); }
            if (start > end || start >= row.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${row.size}`); return res.end(); }
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${start}-${end}/${row.size}`);
        } else {
            res.statusCode = status;
        }
        res.setHeader('Content-Length', row.size === 0 ? 0 : end - start + 1);
        if (req.method === 'HEAD' || row.size === 0) return res.end();
        const file = blobs.pathFor(row.project_id, row.sha256);
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', (err) => {
            log.error('[Host] object missing or unreadable:', row.project_id, row.sha256, err.code || err.message);
            if (!res.headersSent) { res.removeHeader('Content-Length'); plain(res, 500, 'This file could not be read. Try again later.'); } else res.destroy();
        });
        stream.pipe(res);
    }

    function notFound(req, res, site, reason) {
        const page = site.active_deploy_id ? q.file.get(site.active_deploy_id, '404.html') : null;
        if (page && page.project_id === site.project_id) return send(req, res, site, page, { status: 404, cache: 'no-cache' });
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title>`
            + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1rem;color:#1f2937}small{color:#6b7280}</style></head>'
            + `<body><h1>Not found</h1><p>${reason === 'no-deploy' ? 'This site has not published anything yet.' : 'There is no page at this address.'}</p><small>Hosted on OpenVibe.Host</small></body></html>`;
        if (req.method === 'HEAD') return res.end();
        return res.end(body);
    }

    /** Serves one request for a resolved site. */
    function handle(req, res, site) {
        baseHeaders(res, { sandbox: site.environment === 'sandbox' });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return plain(res, 405, 'Static site: only GET and HEAD are supported.', { Allow: 'GET, HEAD' });
        }
        // Taken down by staff: nothing of the tenant's is served, on any of its hosts, until lifted.
        if (takedowns && takedowns.ofSite(site)) {
            // Clear-Site-Data asks the browser to drop what the site left behind for this visitor
            // (caches, storage and service workers a phishing page may have installed).
            return plain(res, 451, 'This site is unavailable: OpenVibe.Host staff took it down after a report.', { 'Clear-Site-Data': '"cache", "storage"' });
        }
        // Absolute-form request targets must agree with the Host header (or they would pick the site).
        let target = req.url || '/';
        if (!target.startsWith('/')) {
            let u;
            try { u = new URL(target); } catch { return plain(res, 400, 'Bad request target.'); }
            if (normaliseHost(u.host) !== normaliseHost(req.headers.host)) return plain(res, 400, 'The request target and Host header disagree.');
            target = `${u.pathname}${u.search}`;
        }
        const q0 = target.indexOf('?');
        const rawPath = q0 >= 0 ? target.slice(0, q0) : target;
        const search = q0 >= 0 ? target.slice(q0) : '';
        if (!site.active_deploy_id) return notFound(req, res, site, 'no-deploy');
        const c = candidates(rawPath);
        if (!c) return notFound(req, res, site, 'invalid');
        const deployId = site.active_deploy_id;
        for (const p of c.list) {
            const row = q.file.get(deployId, p);
            if (row && row.project_id === site.project_id) {
                const hashed = isHashedAsset(p);
                // Browsers keep fingerprinted assets for a year; a shared CDN in front of the tenant
                // vhost (Cloudflare) keeps them for an hour at most, so a takedown, deletion or
                // rollback leaves the edge within the hour even if nobody purges it.
                if (hashed) res.setHeader('CDN-Cache-Control', 'public, max-age=3600');
                return send(req, res, site, row, { cache: hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' });
            }
        }
        if (!c.dir && c.dirIndex && q.file.get(deployId, c.dirIndex)) {
            // /docs → /docs/ so relative links inside docs/index.html resolve; built from the raw path.
            res.statusCode = 301;
            res.setHeader('Location', `${rawPath}/${search}`);
            res.setHeader('Cache-Control', 'no-cache');
            return res.end();
        }
        return notFound(req, res, site, 'missing');
    }

    function unknownHost(req, res) {
        return plain(res, 404, 'Unknown host: no site is served at this address.');
    }

    return { resolve, handle, unknownHost, normaliseHost, candidates, TENANT_CSP };
}

module.exports = { createTenantServer, normaliseHost, TENANT_CSP };
