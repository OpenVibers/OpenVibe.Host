'use strict';

/**
 * OpenVibe.Host Stage B: Express app factory. server/index.js listens and starts the workers;
 * tests build their own instance with a temp database and storage, an injectable clock, a DNS
 * resolver table and a mock Network.
 *
 * Every request is dispatched on its Host header FIRST:
 *
 *   <site>.<sitesDomain> / verified custom domain  → tenant static files (http/tenant.js) and
 *                                                    nothing else: no API, no auth, no cookies
 *   the dashboard host (BASE_URL) and loopback     → dashboard pages, /api/v1, /auth, /api/ready,
 *                                                    /release.json, /limits.json, /metrics (loopback only)
 *   anything else                                  → 404 unknown host
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const sharedMetrics = require('openvibe-shared/metrics');
const cache = require('openvibe-shared/cache-policy');
const sharedSeo = require('openvibe-shared/seo');
const { createIndexNow } = require('openvibe-shared/indexnow');

const configLib = require('./config');
const { openStore } = require('./db');
const { createBlobStore } = require('./storage');
const { createHostOutbox } = require('./events/outbox');
const { createAccess } = require('./domain/access');
const { createTakedowns } = require('./domain/takedowns');
const { createProjects } = require('./domain/projects');
const { createSites } = require('./domain/sites');
const { createDeploys } = require('./domain/deploys');
const { createDomains } = require('./domain/domains');
const { createSiteConfig } = require('./domain/site-config');
const { createSiteSources } = require('./domain/site-sources');
const { createSsoClient } = require('openvibe-sdk/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createHostSession } = require('./auth/sso');
const { createTenantServer } = require('./http/tenant');
const { createUploadGate } = require('./http/upload');
const { createApi } = require('./http/api');
const { createDashboard } = require('./http/dashboard');
const { createHostReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { renderPage, assetVersion, setRelease } = require('./render/layout');
const pages = require('./render/pages');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

const DASHBOARD_CSP = {
    'default-src': ["'self'"],
    // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
    'script-src': ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
    'img-src': ["'self'", 'data:', 'https:'],
    // events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
    'connect-src': ["'self'", 'https://openvibe.network', 'https://events.openvibe.network'],
    'frame-src': ["'self'", 'https://openvibe.network'],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", 'https://openvibe.network'],
};
const DASHBOARD_CSP_HEADER = Object.entries(DASHBOARD_CSP).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');

/**
 * opts: config, store | dbPath, now (clock), fetchImpl, auth (an openvibe-sdk/sso client),
 *       resolver ({ resolveTxt }), log
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.
    const store = opts.store || await openStore(config, { now: opts.now, log });
    // The object store: local disk, written through to OpenVibe.Media when HOST_OBJECT_STORE=media.
    // The Media client is built here (not at module load) and fetches a token lazily; unset config
    // leaves media null and the store is exactly the local one.
    const mediaStore = config.objectStore.mode === 'media' ? {
        url: config.media.url,
        namespace: config.media.namespace,
        scope: config.media.scope,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    } : null;
    const blobs = createBlobStore(opts.storageDir || config.storageDir, { media: mediaStore, log });
    require('./http/errors').setLogger(log);

    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY. Unset → off, nothing
    // mounted, nothing sent; tests and drills never set it. The key file is served on every host (it is
    // mounted below, before the tenant dispatch), and one module per public host keeps a tenant site's
    // URL on its own host, which the protocol (and the module) requires. Tests inject a single object
    // through opts.indexnow (a spy) and every ping goes through it.
    const indexnow = opts.indexnow !== undefined ? opts.indexnow : createIndexNow({
        host: config.baseUrl, key: config.indexnow.key, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}), log,
    });
    const indexnowHosts = new Map();
    function indexnowFor(hostname) {
        if (!indexnowHosts.has(hostname)) indexnowHosts.set(hostname, createIndexNow({
            host: hostname, key: config.indexnow.key, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}), log,
        }));
        return indexnowHosts.get(hostname);
    }
    /**
     * Queue a page that appeared, changed or left the index: one absolute URL per path on `hostname`,
     * sent as a debounced batch. With an injected module (tests) it is used for every host. Never throws.
     */
    function announce(hostname, paths) {
        if (!indexnow.enabled || !hostname) return;
        const u = new URL(config.baseUrl);
        const origin = `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ''}`;
        const target = opts.indexnow !== undefined ? indexnow : indexnowFor(hostname);
        target.pingSoon(paths.map((p) => new URL(p, origin).href));
    }

    const outbox = createHostOutbox({ db: store.db, config, fetchImpl: opts.fetchImpl, now: store.now, log });
    const access = createAccess({ store });
    const takedowns = createTakedowns({ store });
    const projects = createProjects({ store, config, access, blobs, takedowns, log, indexnow: announce });
    const sites = createSites({ store, config, access, projects, takedowns, indexnow: announce });
    const deploys = createDeploys({ store, config, access, projects, sites, blobs, outbox, takedowns, log, indexnow: announce });
    const domains = createDomains({ store, config, access, projects, sites, outbox, resolver: opts.resolver, log, indexnow: announce });
    const siteConfig = createSiteConfig({ store });
    const siteSources = createSiteSources({ store, sites });
    const auth = opts.auth || createSsoClient({
        site: 'host',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.networkUrl,
        secureCookies: config.cookies.secure,
        log,
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    const viewers = createViewerResolver({ auth, config, log });
    const tenant = createTenantServer({ store, config, blobs, takedowns, siteConfig, access, log });
    const uploadGate = createUploadGate(config.uploads.maxConcurrent);
    const worker = createWorker({ config, store, domains, blobs, outbox, log });

    const ctx = { config, store, blobs, outbox, access, takedowns, projects, sites, deploys, domains, siteConfig, siteSources, auth, viewers, tenant, worker, uploadGate, indexnow, log };

    const app = express();
    app.disable('x-powered-by');
    app.disable('etag');
    app.set('trust proxy', config.trustProxy);

    const release = require('openvibe-shared/release').createRelease({ service: 'host', root: path.join(__dirname, '..') });
    setRelease(release.release);
    const registry = sharedMetrics.createRegistry();
    const httpMetrics = sharedMetrics.httpMetrics(registry, { normalize: (req) => (req.hostTarget === 'site' ? 'tenant_site' : req.hostTarget === 'unknown' ? 'unknown_host' : null) });
    const proc = sharedMetrics.processMetrics(registry);
    // Per-actor limits on writes (server/http/actor-limits.js; roadmap WS-R task 4), one budget for the API and the dashboard.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.actorLimits = require('./http/actor-limits').createHostActorLimits({ registry, valkey });
    sharedMetrics.releaseInfo(registry, { service: 'host', release: release.release });
    registry.gauge({
        name: 'host_sites', help: 'Active tenant sites',
        collect: async () => [{ labels: {}, value: (await store.db.prepare("SELECT COUNT(*) AS n FROM host_sites WHERE status = 'active'").get()).n }],
    });
    ctx.stopMetrics = proc.stop;
    app.locals.metrics = registry;
    app.locals.ctx = ctx;

    app.use(httpMetrics.middleware);

    // GET /<key>.txt — the IndexNow key file (openvibe-shared/indexnow). Served before the host dispatch
    // so it answers on the dashboard host and on every tenant host (an engine fetches it from the host a
    // ping names). Mounted only with a key; it answers that one path and falls through for everything else.
    if (indexnow.enabled) app.use(indexnow.keyFile);

    // ── Host dispatch: tenant sites never reach anything below ──
    // resolve/handle read the database (ADR-035: async), so a rejection here must reach the error
    // handler below: Express 4 does not catch a rejected async handler, which would hang the request.
    app.use(async (req, res, next) => {
        try {
            const target = await tenant.resolve(req.headers.host);
            req.hostTarget = target.kind;
            if (target.kind === 'dashboard') return next();
            if (target.kind === 'site') return await tenant.handle(req, res, target.site);
            return tenant.unknownHost(req, res);
        } catch (err) {
            req.hostTarget = req.hostTarget || 'unknown';
            return next(err);
        }
    });

    app.use(contracts.http.middleware());
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', DASHBOARD_CSP_HEADER);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        next();
    });
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-host', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: registry });
    // GET /limits.json: the developer limits enforced here, from config (WS-N task 7; Codes renders them).
    require('./limits').mountLimits(app, config);
    const readiness = createHostReadiness({ store, blobs, outbox, jwksUrl: `${config.networkInternalUrl}/api/.well-known/jwks`, release: release.release, minFreeBytes: () => config.uploads.minFreeBytes, valkey: ctx.valkey });
    app.get('/api/ready', readiness.handler);
    app.get('/metrics', sharedMetrics.metricsHandler(registry));
    // The dashboard host: only the public front page and the legal pages are crawlable. Tenant sites
    // never reach this app's routes; http/tenant.js serves a deploy's own robots.txt/sitemap.xml, or a
    // generated one when the deploy ships none.
    const legalPaths = require('openvibe-shared/legal').PATHS;
    app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(['User-agent: *', 'Allow: /$', ...legalPaths.map((p) => `Allow: ${p}$`), 'Disallow: /', '', `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n')));
    app.get('/sitemap.xml', (_req, res) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', ...legalPaths].map((p) => `  <url><loc>${config.baseUrl}${p}</loc></url>`).join('\n')}\n</urlset>\n`));
    // /llms.txt and /llms-full.txt (llmstxt.org): a map of Host's own public pages only. A tenant site, a preview
    // URL, the dashboard, /api and /internal are never listed (a tenant's own /llms.txt is its deploy's file).
    const SITE_SUMMARY = 'OpenVibe.Host: static site hosting for OpenVibe projects (alpha). Immutable deploys, custom domains and one-step rollback.';
    const legalTitles = require('openvibe-shared/legal').TITLES;
    const publicPages = [
        { title: 'OpenVibe.Host', url: '/', text: 'The public front page of OpenVibe.Host: static site hosting for OpenVibe projects. Upload a folder or a .tar.gz of HTML, CSS, JavaScript, images and fonts; Host keeps every deploy as an immutable artifact, serves the active one on a <site>.openvibe.host address or a verified custom domain, and rolls back in one step. Alpha: static files only, no build step and no server-side code.' },
        { title: 'What shipped on OpenVibe.Host', url: '/updates', text: 'The public update log for OpenVibe.Host: what shipped, newest first.' },
        ...legalPaths.map((p) => ({ title: legalTitles[p.slice(1)] || p.slice(1), url: p, text: `The ${legalTitles[p.slice(1)] || p.slice(1)} of OpenVibe.Host.` })),
    ];
    app.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsTxt({
        name: 'OpenVibe.Host',
        summary: SITE_SUMMARY,
        details: 'The sites Host serves belong to their owners and are not listed here; the dashboard, sign-in and the API are per-person.',
        sections: [
            { title: 'Public pages', links: publicPages.map((p) => ({ title: p.title, url: `${config.baseUrl}${p.url}` })) },
            { title: 'Machine-readable', links: [
                { title: 'Sitemap', url: `${config.baseUrl}/sitemap.xml`, note: 'the public pages' },
                { title: 'robots.txt', url: `${config.baseUrl}/robots.txt` },
                { title: 'llms-full.txt', url: `${config.baseUrl}/llms-full.txt`, note: 'this same map with a description of each public page' },
            ] },
        ],
    })));
    app.get('/llms-full.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsFull({
        site: { name: 'OpenVibe.Host', url: config.baseUrl },
        summary: SITE_SUMMARY,
        base: config.baseUrl,
        maxBytes: 512 * 1024,
        sections: [{ title: 'Public pages', pages: publicPages }],
    })));

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createHostSession({ auth, config }).router(express));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'host', service: 'host', host: 'openvibe.host', name: 'OpenVibe.Host', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false, etag: true,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Preview deploys (plan T12 J4) ───────────────────────
    // A member views a site's live preview deploy at /preview/<deploy-id>/… — dashboard host only (the
    // dispatch above sends every tenant host to tenant.handle, so this never answers on a public host),
    // session-authenticated, membership-checked in tenant.preview, noindex and never cached.
    app.use('/preview', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }), viewers.middleware('dashboard'), (req, res, next) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        Promise.resolve(tenant.preview(req, res)).catch(next);
    });

    // ── Dashboard ───────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }), createDashboard(ctx));
    app.use((req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov });
        res.status(404).type('html').send(renderPage({ title: 'Not found', body: pages.errorPage({ status: 404, message: 'There is no page at this address.' }), viewer: req.viewer, config, path: req.originalUrl }));
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Host]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp, DASHBOARD_CSP_HEADER };
