'use strict';

/** OpenVibe.Host catalog HTTP app. */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const sharedMetrics = require('openvibe-shared/metrics');
const cache = require('openvibe-shared/cache-policy');
const sharedSeo = require('openvibe-shared/seo');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const ovServe = require('openvibe-shared/serve');
const { createIndexNow } = require('openvibe-shared/indexnow');
const configLib = require('./config');
const { openStore } = require('./db');
const { createHostOutbox } = require('./events/outbox');
const { createSsoClient } = require('openvibe-sdk/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createHostSession } = require('./auth/sso');
const { createHostReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { createCatalog } = require('./catalog/store');
const { createCommunity } = require('./catalog/community');
const { createCatalogIngest } = require('./catalog/ingest');
const { createCatalogSearch } = require('./catalog/search-index');
const { createRdap } = require('./catalog/rdap');
const { createDomainCheck } = require('./catalog/domain-check');
const domainsRender = require('./render/domains');
const { createCatalogApi, createCatalogPages } = require('./http/catalog');
const { renderPage, assetVersion, setRelease } = require('./render/layout');
const catalogRender = require('./render/catalog');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const SPACE_URL = 'https://openvibe.space';
const MOVED = 'Static hosting moved to OpenVibe.Space.';
const DASHBOARD_CSP_HEADER = Object.entries({
    'default-src': ["'self'"],
    // Cloudflare Web Analytics: the edge injects its beacon into every page (as on Wiki and Live).
    'script-src': ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
    'img-src': ["'self'", 'data:', 'https:'],
    'connect-src': ["'self'", 'https://openvibe.network', 'https://openvibe.events', 'https://cloudflareinsights.com'],
    'frame-src': ["'self'", 'https://openvibe.network'],
    'frame-ancestors': ["'none'"], 'object-src': ["'none'"], 'base-uri': ["'self'"],
    'form-action': ["'self'", 'https://openvibe.network'],
}).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');

async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const store = opts.store || await openStore(config, { now: opts.now, log });
    require('./http/errors').setLogger(log);
    const outbox = createHostOutbox({ db: store.db, config, fetchImpl: opts.fetchImpl, now: store.now, log });
    const auth = opts.auth || createSsoClient({
        site: 'host', baseUrl: config.baseUrl, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope, networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl, issuer: config.networkUrl,
        secureCookies: config.cookies.secure, log,
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    const viewers = createViewerResolver({ auth, config, log });
    const community = createCommunity({ store, config, fetchImpl: opts.fetchImpl, log });
    // IndexNow: off without INDEXNOW_KEY; a malformed key warns and stays off rather than stopping the site.
    const indexnow = opts.indexnow || (() => {
        const warn = (...a) => (log.warn || console.warn)(...a);
        const fetch = opts.fetchImpl || globalThis.fetch;
        try { return createIndexNow({ host: config.baseUrl, key: config.indexnow.key, fetch, log: warn }); } catch (err) {
            warn(`[Host] ${err.message} — IndexNow is off until INDEXNOW_KEY is fixed`);
            return createIndexNow({ host: config.baseUrl, key: '', fetch, log: warn });
        }
    })();
    const catalog = createCatalog({ store, community, log, indexnow, baseUrl: config.baseUrl });
    const catalogIngest = createCatalogIngest({ config, store, catalog, fetchImpl: opts.fetchImpl });
    const domainCheck = createDomainCheck({ catalog, rdap: opts.rdap || createRdap({ log }) });
    const catalogSearch = createCatalogSearch({ config, store, outbox, log });
    catalog.onChange(() => { if (config.worker.enabled) catalogSearch.sweepSoon(); });
    const worker = createWorker({ config, outbox, catalogIngest, catalogSearch, log });
    const ctx = { config, store, outbox, catalog, domainCheck, community, catalogIngest, catalogSearch, auth, viewers, worker, log };
    ctx.console = require('./console/console').createConsole({ store, config, catalog, fetchImpl: opts.fetchImpl, log });
    const app = express();
    app.disable('x-powered-by');
    app.disable('etag');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'host', root: path.join(__dirname, '..') });
    setRelease(release.release);
    const registry = sharedMetrics.createRegistry();
    const proc = sharedMetrics.processMetrics(registry);
    ctx.stopMetrics = proc.stop;
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.actorLimits = require('./http/actor-limits').createHostActorLimits({ registry, valkey });
    sharedMetrics.releaseInfo(registry, { service: 'host', release: release.release });
    app.locals.metrics = registry;
    app.locals.ctx = ctx;
    app.use(sharedMetrics.httpMetrics(registry).middleware);
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()
    const catalogHost = new URL(config.baseUrl).hostname.toLowerCase();
    app.use((req, res, next) => {
        let hostname;
        try { hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); }
        catch { return res.status(400).send('Invalid Host header'); }
        if (hostname === catalogHost || hostname === 'localhost' || hostname === '127.0.0.1') return next();
        if (hostname.endsWith(`.${catalogHost}`)) return res.status(410).type('html').send(`<h1>Static hosting moved</h1><p>${MOVED} <a href="${SPACE_URL}">Visit OpenVibe.Space</a>.</p>`);
        return res.status(404).send('Unknown host');
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
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-host', version: VERSION }));
    release.mount(app, { registry });
    app.get('/api/ready', createHostReadiness({ store, outbox, jwksUrl: `${config.networkInternalUrl}/api/.well-known/jwks`, release: release.release, valkey }).handler);
    app.get('/metrics', sharedMetrics.metricsHandler(registry));
    const legalPaths = require('openvibe-shared/legal').PATHS;
    app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(['User-agent: *', 'Allow: /$', ...legalPaths.map((p) => `Allow: ${p}$`), 'Allow: /catalog$', 'Allow: /catalog/*', 'Disallow: /catalog/domains/check', 'Disallow: /', '', `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n')));
    app.get('/sitemap.xml', async (_req, res, next) => {
        try {
            const [providers, plans, tlds] = await Promise.all([catalog.providers(), catalog.sitemapPlans(), catalog.domains.sitemap()]);
            const day = (ms) => Number.isFinite(Number(ms)) && ms != null ? new Date(Number(ms)).toISOString().slice(0, 10) : undefined;
            const latest = (rows) => day(rows.reduce((m, p) => Math.max(m, Number(p.checked_at) || 0), 0) || undefined);
            const urls = [{ path: '/', lastmod: latest(plans) }, ...legalPaths.map((p) => ({ path: p })), { path: '/catalog', lastmod: latest(plans) }, { path: '/catalog/promos' }, { path: '/catalog/providers', lastmod: latest(plans) },
                ...providers.map((p) => ({ path: `/catalog/providers/${p.slug}`, lastmod: latest(plans.filter((v) => v.provider_slug === p.slug)) })),
                ...plans.map((p) => ({ path: `/catalog/plans/${p.id}`, lastmod: day(p.checked_at) })),
                ...(tlds.length ? [{ path: '/catalog/domains', lastmod: latest(tlds) }, ...tlds.map((t) => ({ path: `/catalog/domains/${encodeURIComponent(t.tld)}`, lastmod: day(t.checked_at) }))] : [{ path: '/catalog/domains' }])];
            res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.sitemapXml(urls.map((u) => ({ loc: `${config.baseUrl}${u.path}`, lastmod: u.lastmod }))));
        } catch (err) { next(err); }
    });
    const summary = 'OpenVibe.Host compares cloud, VPS and dedicated hosting plans and domain name prices, every price dated and sourced.';
    const publicPages = [
        { title: 'OpenVibe.Host', url: '/', text: summary },
        { title: 'Compare hosting plans', url: '/catalog', text: 'Filter and compare hosting plans by price and resources.' },
        { title: 'Hosting providers', url: '/catalog/providers', text: 'Every provider in the catalog.' },
        { title: 'Hosting promotions', url: '/catalog/promos', text: 'Current provider promotions.' },
        { title: 'Compare domain prices', url: '/catalog/domains', text: 'What registrars charge for each domain ending: first year, renewal, transfer and five years, and a name check at the registry.' },
        { title: 'What shipped on OpenVibe.Host', url: '/updates', text: 'The public update log.' },
        ...legalPaths.map((p) => ({ title: p.slice(1), url: p, text: `The ${p.slice(1)} of OpenVibe.Host.` })),
    ];
    const allPages = async () => [...publicPages,
        ...(await catalog.providers()).map((p) => ({ title: p.name, url: `/catalog/providers/${p.slug}`, text: `Hosting plans from ${p.name}.` })),
        ...(await catalog.domains.sitemap()).map((t) => ({ title: `${require('./catalog/domains').displayTld(t.tld)} domain prices`, url: `/catalog/domains/${encodeURIComponent(t.tld)}`, text: 'Every registrar\'s price for this ending.' })),
        ...(await catalog.sitemapPlans()).map((p) => ({ title: `Hosting plan ${p.id}`, url: `/catalog/plans/${p.id}`, text: 'Sourced plan and price history.' }))];
    app.get('/llms.txt', async (_req, res, next) => { try { res.type('text/plain').send(sharedSeo.llmsTxt({ name: 'OpenVibe.Host', summary, sections: [{ title: 'Public pages', links: (await allPages()).map((p) => ({ title: p.title, url: `${config.baseUrl}${p.url}` })) }] })); } catch (err) { next(err); } });
    app.get('/llms-full.txt', async (_req, res, next) => { try { res.type('text/plain').send(sharedSeo.llmsFull({ site: { name: 'OpenVibe.Host', url: config.baseUrl }, summary, base: config.baseUrl, maxBytes: 512 * 1024, sections: [{ title: 'Public pages', pages: await allPages() }] })); } catch (err) { next(err); } });
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createHostSession({ auth, config }).router(express));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'host', service: 'host', host: 'openvibe.host', name: 'OpenVibe.Host', profile: 'ugc' })); }
    app.use('/shared', require('openvibe-shared/serve').handler());
    // GET /<key>.txt — the IndexNow key file, only when a key is configured.
    if (indexnow.enabled) app.use(indexnow.keyFile);
    app.use(express.static(PUBLIC_DIR, { index: false, redirect: false, etag: true, setHeaders(res, filePath) {
        const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
        res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!res.req.query.v && res.req.query.v === assetVersion(rel) }));
    } }));
    app.post('/internal/catalog/events', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
        try { const result = await catalogIngest.consume(req.body, req.headers); res.status(result.status).json(result); }
        catch (err) { require('./http/errors').sendError(res, req, err, log); }
    });
    // ── OpenVibe.Events → Host (loopback only: nginx answers 404 for /internal/) ──
    // network.account.export_requested and network.account.deleted (ADR-033) through openvibe-sdk/account-data, which reads
    // the raw body itself (the v2 signature covers it) and refuses a request that came through a proxy.
    {
        const { createNetworkSender } = require('openvibe-sdk/account-data');
        const accountData = require('./account-data').create({ db: store.db, log });
        const accountSend = opts.accountSend || (config.oauth.clientSecret
            ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) })
            : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Host cannot answer account events'); });
        app.locals.accountData = accountData;
        app.post('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend, log }));
    }
    app.use('/console', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }), require('./console/pages').createConsolePages(ctx));
    app.use('/api/v1/catalog', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createCatalogApi(ctx));
    const movedApi = (req, res) => res.status(410).type('application/problem+json').json({ code: 'host.moved_to_space', title: 'Static hosting moved', detail: MOVED, url: SPACE_URL });
    const movedPage = (req, res) => res.status(410).type('html').send(renderPage({ title: 'Static hosting moved', body: `<h1>Static hosting moved</h1><p>${MOVED} <a href="${SPACE_URL}">Visit OpenVibe.Space</a>.</p>`, config, path: req.originalUrl }));
    // Lookaheads: app.use strips what the path matched, and a consumed '/' would make Express skip the route.
    app.use(/^\/api\/v1\/(?:projects|sites|deploys|domains|resources)(?=\/|$)/, movedApi);
    // /domains was static hosting's custom domains (moved to Space); the page itself is now the domain comparison.
    app.get('/domains', (_req, res) => res.redirect(301, '/catalog/domains'));
    app.use(/^\/(?:hosting|projects|sites|deploys|domains|preview)(?=\/|$)/, movedPage);
    app.use('/catalog', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }), createCatalogPages(ctx));
    app.get('/providers', (_req, res) => res.redirect(301, '/catalog/providers'));
    app.get('/promotions', (_req, res) => res.redirect(301, '/catalog/promos'));
    app.get('/updates', (_req, res) => res.type('html').send(renderPage({ title: 'What shipped on OpenVibe.Host', body: frame.updatesBody({ service: 'host', siteName: 'OpenVibe.Host' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`, config, path: '/updates', indexable: true })));
    app.get('/', viewers.middleware('dashboard'), async (req, res, next) => {
        try {
            const [result, providers, promos, stats, recent, popular, domainStats] = await Promise.all([catalog.plans({}), catalog.providers(), catalog.promos(), catalog.stats(), catalog.offers({}), catalog.domains.list({}), catalog.domains.stats()]);
            res.type('html').send(renderPage({ body: catalogRender.front({ plans: result.plans, providers, promos, stats, offers: recent.offers, domains: domainsRender.frontSection({ popular: popular.tlds, stats: domainStats }) }), viewer: req.viewer, config, path: '/', indexable: true, styles: [showcase.STYLESHEET], css: ['css/catalog.css'], jsonLd: catalogRender.jsonLd.front(config.baseUrl, result.plans) }));
        } catch (err) { next(err); }
    });
    app.use((req, res) => req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }) : res.status(404).type('html').send(renderPage({ title: 'Not found', body: '<h1>Not found</h1>', config, path: req.originalUrl })));
    app.use((err, req, res, _next) => {
        log.error('[Host]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side.');
    });
    return { app, ctx };
}
module.exports = { createApp, DASHBOARD_CSP_HEADER };
