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
 *                                                    /release.json, /metrics (loopback only)
 *   anything else                                  → 404 unknown host
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const sharedMetrics = require('openvibe-shared/metrics');

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
const { createAuthClient, createAuthRoutes } = require('./auth/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createTenantServer } = require('./http/tenant');
const { createUploadGate } = require('./http/upload');
const { createApi } = require('./http/api');
const { createDashboard } = require('./http/dashboard');
const { createHostReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { renderPage, assetVersion } = require('./render/layout');
const pages = require('./render/pages');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

const DASHBOARD_CSP = {
    'default-src': ["'self'"],
    // The shared chrome (theme-loader, navbar) comes from the Network; the inline init is ours.
    'script-src': ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
    'img-src': ["'self'", 'data:', 'https:'],
    'connect-src': ["'self'", 'https://openvibe.network'],
    'frame-src': ["'self'", 'https://openvibe.network'],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", 'https://openvibe.network'],
};
const DASHBOARD_CSP_HEADER = Object.entries(DASHBOARD_CSP).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');

/**
 * opts: config, store | dbPath, now (clock), fetchImpl, auth (a createAuthClient-like object),
 *       resolver ({ resolveTxt }), log
 */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });
    const blobs = createBlobStore(opts.storageDir || config.storageDir);
    require('./http/errors').setLogger(log);

    const outbox = createHostOutbox({ db: store.db, config, fetchImpl: opts.fetchImpl, now: store.now, log });
    const access = createAccess({ store });
    const takedowns = createTakedowns({ store });
    const projects = createProjects({ store, config, access, blobs, takedowns, log });
    const sites = createSites({ store, config, access, projects, takedowns });
    const deploys = createDeploys({ store, config, access, projects, sites, blobs, outbox, takedowns, log });
    const domains = createDomains({ store, config, access, projects, sites, outbox, resolver: opts.resolver, log });
    const auth = opts.auth || createAuthClient(config);
    const viewers = createViewerResolver({ auth, config });
    const tenant = createTenantServer({ store, config, blobs, takedowns, log });
    const uploadGate = createUploadGate(config.uploads.maxConcurrent);
    const worker = createWorker({ config, store, domains, blobs, outbox, log });

    const ctx = { config, store, blobs, outbox, access, takedowns, projects, sites, deploys, domains, auth, viewers, tenant, worker, uploadGate, log };

    const app = express();
    app.disable('x-powered-by');
    app.disable('etag');
    app.set('trust proxy', config.trustProxy);

    const release = require('openvibe-shared/release').createRelease({ service: 'host', root: path.join(__dirname, '..') });
    const registry = sharedMetrics.createRegistry();
    const httpMetrics = sharedMetrics.httpMetrics(registry, { normalize: (req) => (req.hostTarget === 'site' ? 'tenant_site' : req.hostTarget === 'unknown' ? 'unknown_host' : null) });
    const proc = sharedMetrics.processMetrics(registry);
    sharedMetrics.releaseInfo(registry, { service: 'host', release: release.release });
    registry.gauge({
        name: 'host_sites', help: 'Active tenant sites',
        collect: () => [{ labels: {}, value: store.db.prepare("SELECT COUNT(*) AS n FROM host_sites WHERE status = 'active'").get().n }],
    });
    ctx.stopMetrics = proc.stop;
    app.locals.metrics = registry;
    app.locals.ctx = ctx;

    app.use(httpMetrics.middleware);

    // ── Host dispatch: tenant sites never reach anything below ──
    app.use((req, res, next) => {
        const target = tenant.resolve(req.headers.host);
        req.hostTarget = target.kind;
        if (target.kind === 'dashboard') return next();
        if (target.kind === 'site') return tenant.handle(req, res, target.site);
        return tenant.unknownHost(req, res);
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
    app.get('/release.json', release.handler);
    const readiness = createHostReadiness({ store, blobs, auth, outbox, release: release.release, minFreeBytes: () => config.uploads.minFreeBytes });
    app.get('/api/ready', readiness.handler);
    app.get('/metrics', sharedMetrics.metricsHandler(registry));
    // The dashboard host: only the public front page and the legal pages are crawlable. Tenant sites
    // never reach this app's routes; their robots.txt and sitemap are whatever the tenant uploads.
    const legalPaths = require('openvibe-shared/legal').PATHS;
    app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600')
        .send(['User-agent: *', 'Allow: /$', ...legalPaths.map((p) => `Allow: ${p}$`), 'Disallow: /', '', `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n')));
    app.get('/sitemap.xml', (_req, res) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
        .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', ...legalPaths].map((p) => `  <url><loc>${config.baseUrl}${p}</loc></url>`).join('\n')}\n</urlset>\n`));

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'host', service: 'host', host: 'openvibe.host', name: 'OpenVibe.Host', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false, etag: true,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Dashboard ───────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }), createDashboard(ctx));
    app.use((req, res) => {
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov });
        res.status(404).type('html').send(renderPage({ title: 'Not found', body: pages.errorPage({ status: 404, message: 'There is no page at this address.' }), viewer: req.viewer, config, path: req.originalUrl }));
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Host]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp, DASHBOARD_CSP_HEADER };
