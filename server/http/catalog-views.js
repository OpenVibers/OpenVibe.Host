'use strict';
/**
 * The public catalog pages as data (title, body, indexable, description, JSON-LD), shared by the routes
 * (server/http/catalog.js and the front page in server/app.js) and the agent-layer twins
 * (server/agent-pages.js), so a twin cannot drift from its page. Every view is signed out: it renders
 * what an anonymous visitor sees.
 *
 * The discussion block on a provider or plan page comes from OpenVibe.Community; the route passes the
 * request's context so the thread can be read, the twin does not (a twin never opens a community thread).
 */
const contracts = require('openvibe-contracts');
const sharedSeo = require('openvibe-shared/seo');
const showcase = require('openvibe-shared/showcase');
const frame = require('openvibe-shared/frame');
const ovServe = require('openvibe-shared/serve');
const render = require('../render/catalog');
const renderDomains = require('../render/domains');
const renderBench = require('../render/benchmarks');

// The home's questions are Host's own FAQ in its service manifest (openvibe-contracts), shown and published as FAQPage.
const HOST_FAQ = (((contracts.services.manifests.find((m) => m.id === 'host') || {}).site || {}).faq || []);
const HOME_TIERS_GB = [1, 2, 4, 8, 16, 32];
const HOME_DESCRIPTION = 'Cloud and VPS plans and domain prices compared side by side, per month, per vCPU and per GB, every price dated and linked to its source.';

function createCatalogViews({ catalog, benchmarks, community, config, log = console }) {
    const watchUrl = config.watch && config.watch.publicUrl;
    const baseUrl = config.baseUrl;

    /** The community thread of a provider or plan, or null when Community is off or unreachable. */
    async function discussionFor(ctx, type, entity, label) {
        if (!community || !community.enabled) return null;
        try {
            const threadId = await community.threadFor(type, entity, label, ctx);
            const data = await community.readThread(threadId, ctx);
            if (!data || !data.thread) throw new Error('Community returned no thread');
            return { state: 'ok', thread: data.thread, comments: Array.isArray(data.comments) ? data.comments : [], communityUrl: community.publicUrl };
        } catch (err) {
            log.warn('[Host] ' + type + ' ' + entity.id + ' discussion unavailable: ' + err.message);
            return { state: 'unavailable' };
        }
    }

    /** The front page: the same hero, tables, offers, promos, domain section and FAQ the route renders. */
    async function front() {
        const [result, providers, promos, stats, recent, popular, domainStats, cheapDomains, providerCards] = await Promise.all([
            catalog.plans({}), catalog.providers(), catalog.promos(), catalog.stats(), catalog.offers({}),
            catalog.domains.list({}), catalog.domains.stats(), catalog.domains.list({ sort: 'register' }), catalog.providerSummary(),
        ]);
        // The lowest price for each size, and the most each dollar buys: the same plan query the catalog page runs.
        const first = async (q) => (await catalog.plans(q)).plans[0] || null;
        const tiers = (await Promise.all(HOME_TIERS_GB.map(async (gb) => ({ gb, plan: await first({ min_ram_mb: gb * 1024 }) }))))
            .filter((x, i, all) => x.plan && !(i > 0 && all[i - 1].plan && all[i - 1].plan.id === x.plan.id));
        const [vcpu, ram, disk] = await Promise.all([first({ sort: 'price_per_vcpu' }), first({ sort: 'price_per_gb_ram' }), first({ sort: 'price_per_gb_disk' })]);
        const more = {
            counts: [
                { value: stats.plans, label: 'hosting plans compared', href: '/catalog' },
                { value: stats.providers, label: stats.providers === 1 ? 'provider' : 'providers', href: '/catalog/providers' },
                { value: domainStats.tlds, label: 'domain endings priced', href: '/catalog/domains' },
                { value: (domainStats.registrars || []).length, label: (domainStats.registrars || []).length === 1 ? 'registrar priced' : 'registrars compared', href: '/catalog/domains' },
            ],
            tiers, value: { vcpu, ram, disk }, providerCards, faq: HOST_FAQ,
        };
        return {
            title: 'Hosting plans and domain prices, compared',
            description: HOME_DESCRIPTION,
            body: render.front({
                plans: result.plans, providers, promos, stats, offers: recent.offers, more,
                domains: renderDomains.frontSection({ popular: popular.tlds, cheap: cheapDomains.tlds, stats: domainStats }),
            }),
            indexable: true,
            styles: [showcase.STYLESHEET],
            css: ['css/catalog.css'],
            jsonLd: [...render.jsonLd.front(baseUrl, result.plans), ...(HOST_FAQ.length ? [sharedSeo.jsonLd.faq(HOST_FAQ.map((f) => ({ q: f.question, a: f.answer })))] : [])],
        };
    }

    /** The public update log. */
    function updates() {
        return {
            title: 'What shipped on OpenVibe.Host', indexable: true,
            body: frame.updatesBody({ service: 'host', siteName: 'OpenVibe.Host' }) + '<script src="' + ovServe.url('shipped.js') + '" defer></script>',
        };
    }

    async function index(query = {}) {
        const [result, providers, currencies] = await Promise.all([catalog.plans(query), catalog.providers(), catalog.currencies()]);
        return {
            title: 'Compare hosting plans',
            body: render.catalog({ result, query, providers, currencies }),
            indexable: !Object.keys(query).length,
            description: 'Compare cloud, VPS and dedicated hosting plans: price per month, per vCPU and per GB, each with the day it was checked and its source.',
            jsonLd: render.jsonLd.catalog(baseUrl, result.plans),
        };
    }

    async function providerList() {
        return { title: 'Hosting providers', body: render.providerList(await catalog.providers()), indexable: true };
    }

    async function provider(slug, ctx) {
        const p = await catalog.providers(slug);
        const [discussion, bench] = await Promise.all([discussionFor(ctx, 'provider', p, p.name), benchmarks.summary({ providerId: p.id })]);
        const benchHtml = p.plans.length || bench.count ? renderBench.summaryBlock(bench, { href: '/catalog/benchmarks?provider=' + encodeURIComponent(p.slug), label: p.name }) : '';
        return {
            title: p.name + ' plans and prices', body: render.provider(p, discussion, benchHtml), indexable: true,
            description: p.name + "'s hosting plans compared: monthly prices, per-resource prices and the day each was checked.",
        };
    }

    async function plan(id, ctx) {
        const p = await catalog.plan(id);
        const [discussion, bench] = await Promise.all([discussionFor(ctx, 'plan', p, p.provider_name + ' ' + p.name), benchmarks.summary({ planId: p.id })]);
        const benchHtml = renderBench.summaryBlock(bench, { href: '/catalog/benchmarks?plan=' + encodeURIComponent(p.id), label: p.provider_name + ' ' + p.name });
        return {
            title: p.provider_name + ' ' + p.name,
            body: render.plan(p, discussion, { baseUrl, watchUrl, extra: benchHtml }),
            indexable: true,
            description: p.provider_name + ' ' + p.name + ': ' + p.currency + ' ' + p.price_monthly + ' a month, with its specifications, price per resource and price history.',
            jsonLd: render.jsonLd.plan(baseUrl, p),
        };
    }

    async function promos() {
        return { title: 'Hosting promotions', body: render.promos(await catalog.promos()), indexable: true, description: 'Hosting promotions running now, with their codes and end dates as the providers state them.' };
    }

    async function offers(query = {}) {
        // Sorting by price stays within one currency (nothing is converted): the page picks USD when none is chosen.
        const q = { ...query };
        if (q.sort === 'price' && !q.currency) q.currency = 'USD';
        const result = await catalog.offers(q);
        return {
            title: 'Hosting offers', body: render.offers({ result, query: q }), indexable: !Object.keys(query).length,
            description: "Hosting offers from LowEndSpirit's Offers board, newest first or cheapest a month, each with the price its headline states and the day it was posted.",
        };
    }

    async function domains(query = {}) {
        const [result, stats] = await Promise.all([catalog.domains.list(query), catalog.domains.stats()]);
        return {
            title: 'Compare domain prices', body: renderDomains.index({ result, query, stats, registrars: stats.registrars }), indexable: !Object.keys(query).length,
            description: 'Domain prices compared: what registrars charge for each ending for the first year, a renewal and a transfer, five years added up, and a name check at the registry.',
            jsonLd: renderDomains.jsonLd.index(baseUrl, result.tlds),
        };
    }

    async function domainTld(tld) {
        const t = await catalog.domains.tld(tld);
        return {
            title: t.display + ' domain prices', body: renderDomains.tld(t, { baseUrl, watchUrl }), indexable: true,
            description: t.display + ' domains from ' + (render.money(t.cheapest.register, 'USD') || 'an unknown price') + ' the first year, renewing from ' + (render.money(t.cheapest.renew, 'USD') || 'an unknown price') + ": every registrar's price, dated and sourced.",
            jsonLd: renderDomains.jsonLd.tld(baseUrl, t),
        };
    }

    async function benchmarkList(query = {}) {
        const result = await benchmarks.list(query);
        return {
            title: 'Server benchmarks', body: renderBench.list({ result, query }), indexable: !Object.keys(query).length,
            description: 'CPU, disk and network benchmarks people ran on their own VPS and dedicated servers with YABS: Geekbench, fio and iperf3, by provider and plan.',
        };
    }

    return { front, updates, index, providerList, provider, plan, promos, offers, domains, domainTld, benchmarkList };
}

module.exports = { createCatalogViews, HOME_DESCRIPTION, HOST_FAQ };
