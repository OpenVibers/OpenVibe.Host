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
 * bytes come from the blob store keyed by the project id and the manifest's hash — the local disk
 * cache, or, with HOST_OBJECT_STORE=media, the object fetched back from OpenVibe.Media and verified
 * (server/storage.js). The key is never built from the URL, so no URL, encoding or Host trick can
 * reach another project's objects.
 *
 * Responses: GET/HEAD only; Content-Type from the manifest; strong ETag (the sha256); 304 on
 * If-None-Match; single byte ranges; `immutable` caching for fingerprinted assets and revalidation
 * for everything else (so a rollback shows at once); nosniff; a strict CSP; never a cookie.
 * A site that staff took down (domain/takedowns.js) answers 451 with none of its content.
 * A deploy that ships no sitemap.xml or robots.txt gets a generated one (the manifest's HTML pages on
 * the host the request came in on, so a verified custom domain gets its own; a sandbox site gets
 * `Disallow: /`). A file the tenant uploaded at either path is served instead.
 *
 * A site's own configuration (domain/site-config.js) adds its response headers, its local-only
 * redirects and an optional SPA fallback (extensionless paths serve index.html). The headers are
 * applied BEFORE the platform's own, and a reserved header (CSP, HSTS, Set-Cookie, X-Forwarded-*, …)
 * is never applied even if a row holds one, so a tenant can never weaken or spoof them.
 *
 * preview() serves a site's ONE live preview deploy (host_sites.preview_deploy_id) on the dashboard
 * host only, to a member of its project, at /preview/<deploy-id>/… — always noindex, never cached by
 * a shared cache, and never announced to a search engine (plan T12 J4, decision D5).
 */
const fs = require('fs');
const { sitemapXml, robotsTxt } = require('openvibe-shared/seo');
const { checkPath, PathError, isHashedAsset } = require('../artifacts/paths');
const { isHostname } = require('../domain/domains');
const { isReservedHeader } = require('../domain/site-config');
const { isId } = require('../ids');

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

/**
 * A preview is tenant content served from the dashboard's OWN origin, so — unlike tenant sites, which
 * live on a separate registrable domain — it must be stopped from acting as openvibe.host. Its CSP
 * sandboxes the document into an opaque origin (there is deliberately no `allow-same-origin`), so
 * every tenant script, style and asset it loads runs without access to the dashboard's cookies,
 * storage or DOM (the "active content runs only on the tenant's own origin" control, docs/threat-review.md §5).
 */
function previewCsp(origin) {
    return [
        "default-src 'none'",
        `script-src ${origin}`,
        `style-src ${origin} 'unsafe-inline'`,
        `img-src ${origin} data: https:`,
        `font-src ${origin} data:`,
        `media-src ${origin} https:`,
        `connect-src ${origin}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
    ].join('; ');
}

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

/** Apply a site's configured headers, never a reserved one (defense in depth: they are refused on write too). */
function applyConfiguredHeaders(res, headers) {
    for (const [name, value] of Object.entries(headers || {})) {
        if (isReservedHeader(name)) continue;
        try { res.setHeader(name, value); } catch { /* a name or value Node refuses is simply not set */ }
    }
}

function createTenantServer({ store, config, blobs, takedowns = null, siteConfig = null, access = null, log = console }) {
    const { db } = store;
    const q = {
        siteByName: db.prepare("SELECT s.*, p.environment FROM host_sites s JOIN host_projects p ON p.id = s.project_id WHERE s.name = ? AND s.status = 'active' AND p.status = 'active'"),
        siteByCustom: db.prepare(`SELECT s.*, p.environment FROM host_domains d JOIN host_sites s ON s.id = d.site_id JOIN host_projects p ON p.id = s.project_id
                                  WHERE d.hostname = ? AND d.kind = 'custom' AND d.status = 'verified' AND s.status = 'active' AND p.status = 'active'`),
        file: db.prepare(`SELECT f.sha256, f.size, f.content_type, d.project_id FROM host_deploy_files f JOIN host_deploys d ON d.id = f.deploy_id
                          WHERE f.deploy_id = ? AND f.path = ? AND d.state = 'ready'`),
        htmlFiles: db.prepare("SELECT path FROM host_deploy_files WHERE deploy_id = ? AND content_type LIKE 'text/html%' ORDER BY path"),
        deployById: db.prepare('SELECT id, site_id, project_id, state FROM host_deploys WHERE id = ?'),
        siteById: db.prepare('SELECT * FROM host_sites WHERE id = ?'),
        projectById: db.prepare('SELECT id, status, environment FROM host_projects WHERE id = ?'),
    };
    const suffix = `.${config.sitesDomain}`;
    let previewOrigin = "'self'";
    try { previewOrigin = new URL(config.baseUrl).origin; } catch { /* keep 'self' */ }
    const PREVIEW_CSP = previewCsp(previewOrigin);

    /**
     * -> { kind: 'dashboard' } | { kind: 'site', site } | { kind: 'unknown', host }
     */
    async function resolve(rawHost) {
        const host = normaliseHost(rawHost);
        if (!host) return { kind: 'unknown', host: null };
        if (host === config.dashboardHost || LOOPBACK_HOSTS.has(host)) return { kind: 'dashboard' };
        if (host.endsWith(suffix)) {
            const label = host.slice(0, -suffix.length);
            if (!label || label.includes('.')) return { kind: 'unknown', host };
            const site = await q.siteByName.get(label);
            return site ? { kind: 'site', site, host } : { kind: 'unknown', host };
        }
        if (!isHostname(host)) return { kind: 'unknown', host };
        const site = await q.siteByCustom.get(host);
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

    async function send(req, res, site, row, { status = 200, cache, deployId = site.active_deploy_id }) {
        const etag = `"${row.sha256}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Content-Type', row.content_type);
        res.setHeader('Cache-Control', cache);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-OpenVibe-Deploy', deployId);
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
        const length = row.size === 0 ? 0 : end - start + 1;
        if (req.method === 'HEAD' || row.size === 0) { res.setHeader('Content-Length', length); return res.end(); }
        // The local cache, or (Media store) the object fetched from Media, its sha256 verified, and
        // cached. A miss that cannot be satisfied is a 500: bytes of the wrong content are never served.
        let file;
        try {
            file = await blobs.ensure(row.project_id, row.sha256);
        } catch (err) {
            log.error('[Host] object missing or unreadable:', row.project_id, row.sha256, err.code || err.message);
            if (!res.headersSent) { res.removeHeader('Content-Range'); return plain(res, 500, 'This file could not be read. Try again later.'); }
            return res.destroy();
        }
        res.setHeader('Content-Length', length);
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', (err) => {
            log.error('[Host] object missing or unreadable:', row.project_id, row.sha256, err.code || err.message);
            if (!res.headersSent) { res.removeHeader('Content-Length'); plain(res, 500, 'This file could not be read. Try again later.'); } else res.destroy();
        });
        stream.pipe(res);
    }

    /** The absolute origin for the host this request arrived on (tenant hosts are https in production). */
    function originOf(req) {
        const host = normaliseHost(req.headers.host);
        if (!host) return null;
        let proto = 'https';
        try { proto = new URL(config.baseUrl).protocol.replace(':', '') || 'https'; } catch { /* default */ }
        return `${proto}://${host}`;
    }

    /**
     * A manifest HTML path as the absolute-path URL a crawler should use: the error page is left out,
     * `index.html` becomes the directory URL, and everything else keeps its manifest path.
     */
    function pagePath(p) {
        if (!/\.html?$/i.test(p)) return null;
        if (/(^|\/)404\.html?$/i.test(p)) return null;
        const stem = p.replace(/\.html?$/i, '');
        if (stem === 'index') return '/';
        if (stem.endsWith('/index')) return `/${stem.slice(0, -'index'.length)}`;
        return `/${p}`;
    }

    /**
     * A sitemap the deploy did not ship: the manifest's HTML pages on the host this request came in on.
     * Served per host (a sitemap may only list URLs of one host), so a verified custom domain gets its
     * own copy under its own name.
     */
    async function generatedSitemap(req, res, site) {
        const origin = originOf(req);
        if (!origin) return await notFound(req, res, site, 'invalid');
        const locs = [];
        const seen = new Set();
        for (const row of await q.htmlFiles.all(site.active_deploy_id)) {
            const p = pagePath(row.path);
            if (!p) continue;
            const loc = `${origin}${p}`;
            if (seen.has(loc)) continue;
            seen.add(loc);
            locs.push({ loc });
        }
        const body = sitemapXml(locs);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        return req.method === 'HEAD' ? res.end() : res.end(body);
    }

    /** A robots.txt the deploy did not ship: welcome crawlers to a production site, keep a sandbox out. */
    async function generatedRobots(req, res, site) {
        const origin = originOf(req);
        if (!origin) return await notFound(req, res, site, 'invalid');
        const body = site.environment === 'sandbox'
            ? robotsTxt({ disallow: ['/'], allow: [], allowAI: false })
            : robotsTxt({ sitemaps: [`${origin}/sitemap.xml`] });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        return req.method === 'HEAD' ? res.end() : res.end(body);
    }

    async function notFound(req, res, site, reason) {
        const page = site.active_deploy_id ? await q.file.get(site.active_deploy_id, '404.html') : null;
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

    /** An extensionless path (`/app/route`, `/a-b-c`, `/`) — the only kind an SPA fallback rewrites. */
    function isExtensionlessPath(rawPath) {
        if (rawPath === '/' || rawPath === '') return true;
        const p = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
        const last = p.slice(p.lastIndexOf('/') + 1);
        return !last.includes('.');
    }

    /** Serves one request for a resolved site. */
    async function handle(req, res, site) {
        const cfg = siteConfig ? await siteConfig.getForSite(site.id) : null;
        // The site's own headers go on first; baseHeaders then overrides every reserved one, so a
        // tenant can never weaken CSP/HSTS/nosniff or set a cookie.
        if (cfg) applyConfiguredHeaders(res, cfg.headers);
        baseHeaders(res, { sandbox: site.environment === 'sandbox' });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return plain(res, 405, 'Static site: only GET and HEAD are supported.', { Allow: 'GET, HEAD' });
        }
        // Taken down by staff: nothing of the tenant's is served, on any of its hosts, until lifted.
        if (takedowns && await takedowns.ofSite(site)) {
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
        // A configured redirect: an exact path to a local path (validated on write, never an open redirect).
        // It does not need an active deploy, and it is checked before anything is read from one.
        if (cfg && cfg.redirects.length) {
            const r = cfg.redirects.find((x) => x.from === rawPath);
            if (r) {
                res.statusCode = r.status;
                res.setHeader('Location', r.to);
                res.setHeader('Cache-Control', 'no-cache');
                return res.end();
            }
        }
        if (!site.active_deploy_id) return await notFound(req, res, site, 'no-deploy');
        const c = candidates(rawPath);
        if (!c) return await notFound(req, res, site, 'invalid');
        const deployId = site.active_deploy_id;
        for (const p of c.list) {
            const row = await q.file.get(deployId, p);
            if (row && row.project_id === site.project_id) {
                const hashed = isHashedAsset(p);
                // Browsers keep fingerprinted assets for a year; a shared CDN in front of the tenant
                // vhost (Cloudflare) keeps them for an hour at most, so a takedown, deletion or
                // rollback leaves the edge within the hour even if nobody purges it.
                if (hashed) res.setHeader('CDN-Cache-Control', 'public, max-age=3600');
                return send(req, res, site, row, { cache: hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' });
            }
        }
        if (!c.dir && c.dirIndex && await q.file.get(deployId, c.dirIndex)) {
            // /docs → /docs/ so relative links inside docs/index.html resolve; built from the raw path.
            res.statusCode = 301;
            res.setHeader('Location', `${rawPath}/${search}`);
            res.setHeader('Cache-Control', 'no-cache');
            return res.end();
        }
        // The deploy ships no sitemap.xml / robots.txt of its own: generate them (the tenant's own file,
        // looked up above, always wins). IndexNow's ping of /sitemap.xml now has a real target.
        if (rawPath === '/sitemap.xml') return await generatedSitemap(req, res, site);
        if (rawPath === '/robots.txt') return await generatedRobots(req, res, site);
        // SPA fallback: an extensionless path with no file of its own serves this site's index.html
        // (a client-side route). A missing file with an extension is still a 404.
        if (cfg && cfg.spa && isExtensionlessPath(rawPath)) {
            const row = await q.file.get(deployId, 'index.html');
            if (row && row.project_id === site.project_id) return send(req, res, site, row, { cache: 'public, max-age=0, must-revalidate' });
        }
        return await notFound(req, res, site, 'missing');
    }

    function unknownHost(req, res) {
        return plain(res, 404, 'Unknown host: no site is served at this address.');
    }

    /**
     * GET/HEAD /preview/<deploy-id>/<path> — one deploy of a site, served ONLY to a member of its
     * project and ONLY on the dashboard host (the dispatch in server/app.js never sends a tenant host
     * here, so a preview can never appear at <site>.<sitesDomain>). It serves exactly the deploy the
     * site currently points at as its live preview (host_sites.preview_deploy_id) while that preview
     * has not expired; once it expires, the site deploys or rolls back, or the preview is deleted, the
     * address is a plain 404. Every response is noindex, no-store and never announced to a search
     * engine, and the bytes come from the deploy's own project and manifest — never from the URL —
     * exactly as in handle().
     */
    async function preview(req, res) {
        // Never the dashboard's own CSP: the preview is sandboxed into an opaque origin (see previewCsp).
        res.setHeader('Content-Security-Policy', PREVIEW_CSP);
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', 'private, no-store');
        const miss = () => plain(res, 404, 'No preview is served at this address.');
        const viewer = req.viewer;
        if (!access || !viewer || viewer.kind === 'anonymous') return miss();
        if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Static preview: only GET and HEAD are supported.', { Allow: 'GET, HEAD' });
        const raw = req.originalUrl || req.url || '';
        const cut = raw.indexOf('?');
        const m = /^\/preview\/([^/?#]+)(\/[^?#]*)?$/.exec(cut >= 0 ? raw.slice(0, cut) : raw);
        if (!m || !isId('deploy', m[1])) return miss();
        const deploy = await q.deployById.get(m[1]);
        if (!deploy || deploy.state !== 'ready') return miss();
        const site = await q.siteById.get(deploy.site_id);
        if (!site || site.status !== 'active' || site.project_id !== deploy.project_id) return miss();
        // Only the site's ONE live preview is served, and only until it expires.
        if (site.preview_deploy_id !== deploy.id || !site.preview_expires_at || site.preview_expires_at <= store.now()) return miss();
        const project = await q.projectById.get(deploy.project_id);
        try { await access.authorize(project, viewer, 'read'); } catch { return miss(); }
        if (takedowns && await takedowns.ofSite(site)) {
            return plain(res, 451, 'This site is unavailable: OpenVibe.Host staff took it down after a report.', { 'Clear-Site-Data': '"cache", "storage"' });
        }
        const c = candidates(m[2] || '/');
        if (!c) return miss();
        for (const p of c.list) {
            const row = await q.file.get(deploy.id, p);
            if (row && row.project_id === deploy.project_id) {
                return send(req, res, site, row, { cache: 'private, no-store, max-age=0', deployId: deploy.id });
            }
        }
        return miss();
    }

    return { resolve, handle, preview, unknownHost, normaliseHost, candidates, TENANT_CSP };
}

module.exports = { createTenantServer, normaliseHost, TENANT_CSP };
