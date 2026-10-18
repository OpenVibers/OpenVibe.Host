'use strict';

const express = require('express');
const contracts = require('openvibe-contracts');
const { ApiError, run, privateNoStore, sendError } = require('./errors');
const { renderPage, esc } = require('../render/layout');
const render = require('../render/catalog');
const renderDomains = require('../render/domains');
const rateLimit = require('express-rate-limit');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const { guard } = require('../auth/viewer');
const cache = require('openvibe-shared/cache-policy');

const disclosure = render.DISCLOSURE;
// A name check asks a registry: 30 a minute per address, below every registry's own RDAP limit.
const checkLimit = () => rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
function createCatalogApi({ catalog, domainCheck, viewers, actorLimits }) {
    const router = express.Router();
    router.use(viewers.middleware('api'));
    if (actorLimits) router.use(actorLimits);
    router.use((_req, res, next) => { privateNoStore(res); next(); });
    const catalogJsonBody = (req, res, next) => express.json({ limit: '64kb' })(req, res, (err) => err ? contracts.http.sendProblem(res, 400, 'host.catalog.invalid', { detail: 'Malformed JSON body', ctx: req.ov }) : next());
    const staff = (req, _res, next) => req.viewer.kind === 'user' && req.viewer.staff ? next() : next(new ApiError(403, 'host.catalog.forbidden', 'Staff access required'));
    router.get('/plans', run(async (req) => await catalog.plans(req.query)));
    router.get('/plans/:id', run(async (req) => ({ plan: await catalog.plan(req.params.id) })));
    router.get('/providers', run(async () => ({ providers: await catalog.providers() })));
    router.get('/providers/:slug', run(async (req) => ({ provider: await catalog.providers(req.params.slug) })));
    router.get('/promos', run(async () => ({ promos: await catalog.promos() })));
    router.get('/offers', run(async (req) => await catalog.offers(req.query)));
    router.get('/domains', run(async (req) => await catalog.domains.list(req.query)));
    router.get('/domains/check', checkLimit(), run(async (req) => ({ check: await domainCheck.check(req.query.name) })));
    router.get('/domains/:tld', run(async (req) => ({ tld: await catalog.domains.tld(req.params.tld) })));
    for (const type of ['providers', 'plans', 'promos']) {
        router.post(`/${type}`, guard('host.catalog.manage'), staff, catalogJsonBody, run(async (req) => ({ [type.slice(0, -1)]: await catalog.save(type, req.body, null, req.viewer.subject) }), 201));
        router.patch(`/${type}/:id`, guard('host.catalog.manage'), staff, catalogJsonBody, run(async (req) => ({ [type.slice(0, -1)]: await catalog.save(type, req.body, req.params.id, req.viewer.subject) })));
    }
    router.use((err, req, res, next) => { if (res.headersSent) return next(err); sendError(res, req, err); });
    return router;
}
function createCatalogPages({ catalog, domainCheck, community, config, viewers, actorLimits, log = console }) {
    const router = express.Router();
    router.use(viewers.middleware('dashboard'));
    if (actorLimits) router.use(actorLimits);
    const cachePage = (req, res, publicPage) => {
        res.vary('Cookie'); res.vary('Authorization');
        res.set('Cache-Control', cache.htmlHeaders(publicPage && req.viewer.kind === 'anonymous' ? { maxAge: 60 } : { private: true }));
    };
    const page = (req, res, title, body, indexable = true, description, ld) => {
        cachePage(req, res, indexable);
        return res.status(200).type('html').send(renderPage({ title, body, viewer: req.viewer, config, path: req.originalUrl, indexable, description, jsonLd: ld, css: ['css/catalog.css'] }));
    };
    async function discussionFor(req, type, entity, label) {
        if (!community || !community.enabled) return null;
        try {
            const threadId = await community.threadFor(type, entity, label, req.ov);
            const data = await community.readThread(threadId, req.ov);
            if (!data || !data.thread) throw new Error('Community returned no thread');
            return { state: 'ok', thread: data.thread, comments: Array.isArray(data.comments) ? data.comments : [], communityUrl: community.publicUrl };
        } catch (err) {
            log.warn(`[Host] ${type} ${entity.id} discussion unavailable: ${err.message}`);
            return { state: 'unavailable' };
        }
    }
    const view = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            cachePage(req, res, false);
            const status = err.status || 500;
            const body = status === 404 ? '<h1>Not in the catalog</h1><p>This entry is not listed (or no longer is).</p><p><a href="/catalog">Compare plans</a></p>'
                : status === 422 ? `<h1>That filter did not work</h1><p>${esc(err.message)}</p><p><a href="/catalog">Clear the filters</a></p>`
                    : `<h1>Catalog error</h1><p>${esc(err.message)}</p>`;
            res.status(status).type('html').send(renderPage({ title: 'Catalog', body, viewer: req.viewer, config, path: req.originalUrl, css: ['css/catalog.css'] }));
        }
    };
    router.get('/', view(async (req, res) => {
        const [result, providers, currencies] = await Promise.all([catalog.plans(req.query), catalog.providers(), catalog.currencies()]);
        page(req, res, 'Compare hosting plans', render.catalog({ result, query: req.query, providers, currencies }), !Object.keys(req.query).length,
            'Compare cloud, VPS and dedicated hosting plans: price per month, per vCPU and per GB, each with the day it was checked and its source.',
            render.jsonLd.catalog(config.baseUrl, result.plans));
    }));
    router.get('/providers', view(async (req, res) => {
        page(req, res, 'Hosting providers', render.providerList(await catalog.providers()));
    }));
    router.get('/providers/:slug', view(async (req, res) => {
        const p = await catalog.providers(req.params.slug);
        const discussion = await discussionFor(req, 'provider', p, p.name);
        page(req, res, `${p.name} plans and prices`, render.provider(p, discussion), true, `${p.name}'s hosting plans compared: monthly prices, per-resource prices and the day each was checked.`);
    }));
    router.get('/plans/:id', view(async (req, res) => {
        const p = await catalog.plan(req.params.id);
        const discussion = await discussionFor(req, 'plan', p, `${p.provider_name} ${p.name}`);
        page(req, res, `${p.provider_name} ${p.name}`, render.plan(p, discussion, { baseUrl: config.baseUrl, watchUrl: config.watch && config.watch.publicUrl }), true, `${p.provider_name} ${p.name}: ${p.currency} ${p.price_monthly} a month, with its specifications, price per resource and price history.`, render.jsonLd.plan(config.baseUrl, p));
    }));
    router.get('/promos', view(async (req, res) => {
        page(req, res, 'Hosting promotions', render.promos(await catalog.promos()), true, 'Hosting promotions running now, with their codes and end dates as the providers state them.');
    }));
    router.get('/offers', view(async (req, res) => {
        // Sorting by price stays within one currency (nothing is converted): the page picks USD when none is chosen.
        const query = { ...req.query };
        if (query.sort === 'price' && !query.currency) query.currency = 'USD';
        const result = await catalog.offers(query);
        page(req, res, 'Hosting offers', render.offers({ result, query }), !Object.keys(req.query).length,
            'Hosting offers from LowEndSpirit\'s Offers board, newest first or cheapest a month, each with the price its headline states and the day it was posted.');
    }));
    router.get('/domains', view(async (req, res) => {
        const [result, stats] = await Promise.all([catalog.domains.list(req.query), catalog.domains.stats()]);
        page(req, res, 'Compare domain prices', renderDomains.index({ result, query: req.query, stats, registrars: stats.registrars }), !Object.keys(req.query).length,
            'Domain prices compared: what registrars charge for each ending for the first year, a renewal and a transfer, five years added up, and a name check at the registry.',
            renderDomains.jsonLd.index(config.baseUrl, result.tlds));
    }));
    router.get('/domains/check', checkLimit(), view(async (req, res) => {
        if (typeof req.query.name !== 'string' || !req.query.name.trim()) return res.redirect(303, '/catalog/domains');
        let c;
        try { c = await domainCheck.check(req.query.name); } catch (err) {
            if (err.status !== 422) throw err;
            cachePage(req, res, false);
            return res.status(422).type('html').send(renderPage({ title: 'Check a domain name', body: `<h1>That is not a domain name</h1><p>${esc(err.message)}</p><p><a href="/catalog/domains">Check another name</a></p>`, viewer: req.viewer, config, path: req.originalUrl, css: ['css/catalog.css'] }));
        }
        page(req, res, `${c.display}: is it taken?`, renderDomains.check(c), false, `Whether ${c.display} is registered, and what it costs at each registrar.`);
    }));
    router.get('/domains/:tld', view(async (req, res) => {
        const t = await catalog.domains.tld(req.params.tld);
        if (req.params.tld !== t.tld) return res.redirect(301, `/catalog/domains/${encodeURIComponent(t.tld)}`);
        page(req, res, `${t.display} domain prices`, renderDomains.tld(t, { baseUrl: config.baseUrl, watchUrl: config.watch && config.watch.publicUrl }), true,
            `${t.display} domains from ${render.money(t.cheapest.register, 'USD') || 'an unknown price'} the first year, renewing from ${render.money(t.cheapest.renew, 'USD') || 'an unknown price'}: every registrar's price, dated and sourced.`,
            renderDomains.jsonLd.tld(config.baseUrl, t));
    }));
    router.get('/manage', view(async (req, res) => {
        if (req.viewer.kind !== 'user' || !req.viewer.staff) throw new ApiError(403, 'host.catalog.forbidden', 'Staff access required');
        const csrf = csrfToken(config, req.viewer);
        const blocks = await Promise.all(['providers', 'plans', 'promos'].map(async (type) => {
            const rows = await catalog.all(type);
            const keys = { providers: ['slug', 'name', 'homepage_url', 'description', 'affiliate_url', 'affiliate_note', 'status'], plans: ['provider_id', 'external_id', 'name', 'kind', 'vcpu', 'ram_mb', 'disk_gb', 'disk_type', 'bandwidth_gb', 'unmetered', 'port_mbps', 'ipv4', 'locations', 'currency', 'price_monthly', 'price_hourly', 'setup_fee', 'source_url', 'checked_at', 'status'], promos: ['provider_id', 'title', 'details', 'code', 'url', 'affiliate', 'starts_at', 'ends_at', 'status'] }[type];
            const form = (row) => `<form method="post" action="/catalog/manage/${type}${row ? `/${esc(row.id)}` : ''}"><input type="hidden" name="csrf" value="${csrf}">${keys.map((k) => `<label>${esc(k)} <input name="${k}" value="${esc(row && row[k] != null ? Array.isArray(row[k]) ? row[k].join(',') : row[k] : '')}"></label>`).join('')}<button>${row ? 'Save' : 'Add'}</button></form>`;
            return `<section><h2>${type}</h2>${form(null)}${rows.map((r) => `<h3>${esc(r.name || r.title || r.id)}</h3>${form(r)}`).join('')}</section>`;
        }));
        page(req, res, 'Manage catalog', `<h1>Manage catalog</h1>${blocks.join('')}`, false);
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
            if (['vcpu', 'ram_mb', 'disk_gb', 'bandwidth_gb', 'port_mbps', 'ipv4', 'price_monthly', 'price_hourly', 'setup_fee', 'checked_at', 'starts_at', 'ends_at'].includes(k)) body[k] = Number(body[k]);
            if (['unmetered', 'affiliate'].includes(k)) body[k] = body[k] === 'true';
            if (k === 'locations') body[k] = body[k].split(',').map((x) => x.trim()).filter(Boolean);
        }
        await catalog.save(type, body, req.params.id || null, req.viewer.subject);
        res.redirect(303, '/catalog/manage');
    }));
    return router;
}
module.exports = { createCatalogApi, createCatalogPages, disclosure };
