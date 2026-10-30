'use strict';

const express = require('express');
const contracts = require('openvibe-contracts');
const { ApiError, run, privateNoStore, sendError } = require('./errors');
const { renderPage, esc, twinHeader } = require('../render/layout');
const render = require('../render/catalog');
const renderDomains = require('../render/domains');
const renderBench = require('../render/benchmarks');
const { createCatalogViews } = require('./catalog-views');
const rateLimit = require('express-rate-limit');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const { guard } = require('../auth/viewer');
const cache = require('openvibe-shared/cache-policy');

const disclosure = render.DISCLOSURE;
// A name check asks a registry: 30 a minute per address, below every registry's own RDAP limit.
const checkLimit = () => rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
function createCatalogApi({ catalog, domainCheck, benchmarks, viewers, actorLimits, log = console }) {
    const router = express.Router();
    router.use(viewers.middleware('api'));
    if (actorLimits) router.use(actorLimits);
    router.use((_req, res, next) => { privateNoStore(res); next(); });
    const catalogJsonBody = (req, res, next) => express.json({ limit: '64kb' })(req, res, (err) => err ? contracts.http.sendProblem(res, 400, 'host.catalog.invalid', { detail: 'Malformed JSON body', ctx: req.ov }) : next());
    const staff = (req, _res, next) => req.viewer.kind === 'user' && req.viewer.staff ? next() : next(new ApiError(403, 'host.catalog.forbidden', 'Staff access required'));
    router.get('/plans', run(async (req) => await catalog.plans(req.query)));
    router.get('/plans/:id', run(async (req) => ({ plan: await catalog.plan(req.params.id) })));
    router.get('/plans/:id/price-trend', run(async (req) => await catalog.planPriceTrend(req.params.id)));
    router.get('/tlds/:tld/price-trend', run(async (req) => await catalog.domains.trend(req.params.tld, req.query.kind || 'register')));
    router.get('/providers', run(async () => ({ providers: await catalog.providers() })));
    router.get('/providers/:slug', run(async (req) => ({ provider: await catalog.providers(req.params.slug) })));
    router.get('/promos', run(async () => ({ promos: await catalog.promos() })));
    router.get('/offers', run(async (req) => await catalog.offers(req.query)));
    router.get('/domains', run(async (req) => await catalog.domains.list(req.query)));
    router.get('/domains/check', checkLimit(), run(async (req) => ({ check: await domainCheck.check(req.query.name) })));
    router.get('/domains/:tld', run(async (req) => ({ tld: await catalog.domains.tld(req.params.tld) })));
    router.get('/benchmarks', run(async (req) => await benchmarks.list(req.query)));
    router.get('/benchmarks/:id', run(async (req) => ({ benchmark: await benchmarks.get(req.params.id, req.viewer) })));
    router.post('/benchmarks/links', catalogJsonBody, run(async (req) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'host.benchmark.sign_in', 'Sign in to submit a benchmark');
        return { link: await benchmarks.createLink(req.viewer.subject, req.body || {}) };
    }, 201));
    router.delete('/benchmarks/:id', run(async (req) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'host.benchmark.sign_in', 'Sign in to submit a benchmark');
        await benchmarks.remove(req.params.id, req.viewer);
        return { removed: true };
    }));
    router.post('/benchmarks/yabs/:token', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }), express.text({ type: () => true, limit: '128kb' }), async (req, res) => {
        res.type('text/plain');
        try {
            await benchmarks.checkLink(req.params.token);
            let body;
            try { body = JSON.parse(typeof req.body === 'string' ? req.body : ''); } catch { throw new ApiError(400, 'host.benchmark.invalid', 'The result was not valid JSON; nothing was saved.'); }
            const saved = await benchmarks.submit(req.params.token, body);
            res.status(201).send('\nOpenVibe.Host saved this result: ' + saved.url + '\n');
        } catch (err) {
            if (!err.status || err.status >= 500) log.warn('[Host] benchmark submit failed: ' + err.message);
            res.status(err.status && err.status < 500 ? err.status : 500).send('\nOpenVibe.Host did not save this result: ' + (err.status && err.status < 500 ? err.message : 'something went wrong on our side') + '\n');
        }
    });
    for (const type of ['providers', 'plans', 'promos']) {
        router.post('/' + type, guard('host.catalog.manage'), staff, catalogJsonBody, run(async (req) => ({ [type.slice(0, -1)]: await catalog.save(type, req.body, null, req.viewer.subject) }), 201));
        router.patch('/' + type + '/:id', guard('host.catalog.manage'), staff, catalogJsonBody, run(async (req) => ({ [type.slice(0, -1)]: await catalog.save(type, req.body, req.params.id, req.viewer.subject) })));
    }
    router.use((err, req, res, next) => { if (res.headersSent) return next(err); sendError(res, req, err); });
    return router;
}
function createCatalogPages({ catalog, domainCheck, benchmarks, community, config, viewers, actorLimits, views: given, log = console }) {
    const router = express.Router();
    router.use(viewers.middleware('dashboard'));
    if (actorLimits) router.use(actorLimits);
    const cachePage = (req, res, publicPage) => {
        res.vary('Cookie'); res.vary('Authorization');
        res.set('Cache-Control', cache.htmlHeaders(publicPage && req.viewer.kind === 'anonymous' ? { maxAge: 60 } : { private: true }));
    };
    // The public pages are rendered by the shared view builders (catalog-views.js), the same ones the
    // agent-layer twins use, so a twin cannot drift from its page. A page with a twin advertises it in
    // its head and in the Link header.
    const views = given || createCatalogViews({ catalog, benchmarks, community, config, log });
    const page = (req, res, view) => {
        const indexable = view.indexable !== false;
        cachePage(req, res, indexable);
        const o = { title: view.title, body: view.body, viewer: req.viewer, config, path: req.originalUrl, indexable, description: view.description, jsonLd: view.jsonLd, css: view.css || ['css/catalog.css'], styles: view.styles, scripts: view.scripts, agent: indexable };
        const link = twinHeader(o);
        if (link) res.set('Link', link);
        return res.status(200).type('html').send(renderPage(o));
    };
    const view = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            cachePage(req, res, false);
            const status = err.status || 500;
            const body = status === 404 ? '<h1>Not in the catalog</h1><p>This entry is not listed (or no longer is).</p><p><a href="/catalog">Compare plans</a></p>'
                : status === 422 ? '<h1>That filter did not work</h1><p>' + esc(err.message) + '</p><p><a href="/catalog">Clear the filters</a></p>'
                    : '<h1>Catalog error</h1><p>' + esc(err.message) + '</p>';
            res.status(status).type('html').send(renderPage({ title: 'Catalog', body, viewer: req.viewer, config, path: req.originalUrl, css: ['css/catalog.css'] }));
        }
    };
    router.get('/', view(async (req, res) => page(req, res, await views.index(req.query))));
    router.get('/providers', view(async (req, res) => page(req, res, await views.providerList())));
    router.get('/providers/:slug', view(async (req, res) => page(req, res, await views.provider(req.params.slug, req.ov))));
    router.get('/plans/:id', view(async (req, res) => page(req, res, await views.plan(req.params.id, req.ov))));
    router.get('/promos', view(async (req, res) => page(req, res, await views.promos())));
    router.get('/offers', view(async (req, res) => page(req, res, await views.offers(req.query))));
    router.get('/domains', view(async (req, res) => page(req, res, await views.domains(req.query))));
    router.get('/domains/check', checkLimit(), view(async (req, res) => {
        if (typeof req.query.name !== 'string' || !req.query.name.trim()) return res.redirect(303, '/catalog/domains');
        let c;
        try { c = await domainCheck.check(req.query.name); } catch (err) {
            if (err.status !== 422) throw err;
            cachePage(req, res, false);
            return res.status(422).type('html').send(renderPage({ title: 'Check a domain name', body: '<h1>That is not a domain name</h1><p>' + esc(err.message) + '</p><p><a href="/catalog/domains">Check another name</a></p>', viewer: req.viewer, config, path: req.originalUrl, css: ['css/catalog.css'] }));
        }
        page(req, res, { title: c.display + ': is it taken?', body: renderDomains.check(c), indexable: false, description: 'Whether ' + c.display + ' is registered, and what it costs at each registrar.' });
    }));
    router.get('/domains/:tld', view(async (req, res) => {
        const t = await catalog.domains.tld(req.params.tld);
        if (req.params.tld !== t.tld) return res.redirect(301, '/catalog/domains/' + encodeURIComponent(t.tld));
        page(req, res, await views.domainTld(req.params.tld));
    }));
    router.get('/benchmarks', view(async (req, res) => page(req, res, await views.benchmarkList(req.query))));
    const benchForm = async (req, res, { error = null, status = 200 } = {}) => {
        const [providers, plans] = req.viewer.kind === 'user' ? await Promise.all([catalog.providers(), catalog.planChoices()]) : [[], []];
        const withPlans = providers.filter((p) => plans.some((x) => x.provider_slug === p.slug));
        cachePage(req, res, false);
        res.status(status).type('html').send(renderPage({ title: 'Benchmark your server', body: renderBench.submitForm({ viewer: req.viewer, providers: withPlans, plans, csrf: csrfToken(config, req.viewer), error, query: req.method === 'POST' ? req.body : req.query }), viewer: req.viewer, config, path: req.originalUrl, indexable: false, css: ['css/catalog.css'] }));
    };
    router.get('/benchmarks/new', view(async (req, res) => benchForm(req, res)));
    const benchParser = express.urlencoded({ extended: false, limit: '8kb' });
    router.post('/benchmarks/new', benchParser, view(async (req, res) => {
        if (req.viewer.kind !== 'user') return res.redirect(303, '/catalog/benchmarks/new');
        if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body.csrf)) throw new ApiError(403, 'host.catalog.forbidden', 'Invalid form token or origin');
        let l;
        try {
            l = await benchmarks.createLink(req.viewer.subject, req.body || {});
        } catch (err) {
            if (![422, 429, 503].includes(err.status)) throw err;
            return benchForm(req, res, { error: err.message, status: err.status });
        }
        res.set('Cache-Control', 'private, no-store');
        res.status(201).type('html').send(renderPage({ title: 'Your benchmark link', body: renderBench.issued(l), viewer: req.viewer, config, path: req.originalUrl, indexable: false, css: ['css/catalog.css'] }));
    }));
    router.get('/benchmarks/:id', view(async (req, res) => {
        const b = await benchmarks.get(req.params.id, req.viewer);
        const canRemove = req.viewer.kind === 'user' && (b.mine || req.viewer.staff);
        page(req, res, {
            title: b.provider_name + (b.plan_name ? ' ' + b.plan_name : '') + ' benchmark', indexable: false,
            body: renderBench.detail(b, { csrf: canRemove ? csrfToken(config, req.viewer) : '', canRemove }),
            description: 'A YABS benchmark of a ' + b.provider_name + ' server: Geekbench, disk and network results.',
        });
    }));
    router.post('/benchmarks/:id/remove', benchParser, view(async (req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(403, 'host.catalog.forbidden', 'Staff access required');
        if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body.csrf)) throw new ApiError(403, 'host.catalog.forbidden', 'Invalid form token or origin');
        await benchmarks.remove(req.params.id, req.viewer);
        res.redirect(303, '/catalog/benchmarks');
    }));
    router.get('/manage', view(async (req, res) => {
        if (req.viewer.kind !== 'user' || !req.viewer.staff) throw new ApiError(403, 'host.catalog.forbidden', 'Staff access required');
        const csrf = csrfToken(config, req.viewer);
        const blocks = await Promise.all(['providers', 'plans', 'promos'].map(async (type) => {
            const rows = await catalog.all(type);
            const keys = { providers: ['slug', 'name', 'homepage_url', 'description', 'affiliate_url', 'affiliate_note', 'status'], plans: ['provider_id', 'external_id', 'name', 'kind', 'vcpu', 'ram_mb', 'disk_gb', 'disk_type', 'bandwidth_gb', 'unmetered', 'port_mbps', 'ipv4', 'locations', 'currency', 'price_monthly', 'price_hourly', 'setup_fee', 'source_url', 'checked_at', 'status'], promos: ['provider_id', 'title', 'details', 'code', 'url', 'affiliate', 'starts_at', 'ends_at', 'status'] }[type];
            const form = (row) => '<form method="post" action="/catalog/manage/' + type + (row ? '/' + esc(row.id) : '') + '"><input type="hidden" name="csrf" value="' + csrf + '">' + keys.map((k) => '<label>' + esc(k) + ' <input name="' + k + '" value="' + esc(row && row[k] != null ? Array.isArray(row[k]) ? row[k].join(',') : row[k] : '') + '"></label>').join('') + '<button>Save</button></form>';
            return '<section><h2>' + type + '</h2>' + form(null) + rows.map((r) => '<h3>' + esc(r.name || r.title || r.id) + '</h3>' + form(r)).join('') + '</section>';
        }));
        page(req, res, { title: 'Manage catalog', body: '<h1>Manage catalog</h1>' + blocks.join(''), indexable: false });
    }));
    const parser = express.urlencoded({ extended: false, limit: '16kb' });
    router.post('/manage/:type/:id?', parser, view(async (req, res) => {
        if (req.viewer.kind !== 'user' || !req.viewer.staff) throw new ApiError(403, 'host.catalog.forbidden', 'Staff access required');
        if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body.csrf)) throw new ApiError(403, 'host.catalog.forbidden', 'Invalid form token or origin');
        const type = req.params.type;
        if (!['providers', 'plans', 'promos'].includes(type)) throw new ApiError(404, 'host.catalog.not_found', 'Unknown catalog entry');
        const body = { ...req.body }; delete body.csrf;
        for (const k of Object.keys(body)) {
            if (body[k] === '') { delete body[k]; continue; }
            if (['provider_id', 'vcpu', 'ram_mb', 'disk_gb', 'bandwidth_gb', 'port_mbps', 'ipv4', 'price_monthly', 'price_hourly', 'setup_fee', 'checked_at', 'starts_at', 'ends_at'].includes(k)) body[k] = Number(body[k]);
            if (['unmetered', 'affiliate'].includes(k)) body[k] = body[k] === 'true';
            if (k === 'locations') body[k] = body[k].split(',').map((x) => x.trim()).filter(Boolean);
        }
        await catalog.save(type, body, req.params.id || null, req.viewer.subject);
        res.redirect(303, '/catalog/manage');
    }));
    return router;
}
module.exports = { createCatalogApi, createCatalogPages, disclosure };
