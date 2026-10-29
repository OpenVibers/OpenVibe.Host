'use strict';
// The Markdown twins of openvibe.host's public pages (openvibe-shared/agent-layer), rendered by the same
// view builders the routes use (server/http/catalog-views.js and the front page's own builder), so a twin
// cannot drift from its page. Anonymous only: the console, the manage pages, the domain name check and
// the API are never rendered here.
const { renderPage } = require('./render/layout');

function createAgentPages(ctx, views) {
    const v = views || require('./http/catalog-views').createCatalogViews(ctx);

    const twin = (page, path) => (page ? {
        html: renderPage({
            ...page, config: ctx.config, path, indexable: page.indexable !== false,
            viewer: { kind: 'anonymous' },
        }),
    } : null);

    async function renderPublicPage(path, { query } = {}) {
        const q = query ? Object.fromEntries(query.entries()) : {};
        if (path === '/') return twin(await v.front(), '/');
        if (path === '/catalog') return twin(await v.index(q), '/catalog');
        if (path === '/catalog/providers') return twin(await v.providerList(), path);
        if (path === '/catalog/promos') return twin(await v.promos(), path);
        if (path === '/catalog/offers') return twin(await v.offers(q), path);
        if (path === '/catalog/domains') return twin(await v.domains(q), path);
        if (path === '/catalog/benchmarks') return twin(await v.benchmarkList(q), path);
        if (path === '/updates') return twin(v.updates(), path);
        let m = /^\/catalog\/providers\/([^/]+)$/.exec(path);
        if (m) return twin(await v.provider(decodeURIComponent(m[1])), path);
        m = /^\/catalog\/plans\/([^/]+)$/.exec(path);
        if (m) return twin(await v.plan(decodeURIComponent(m[1])), path);
        m = /^\/catalog\/domains\/([^/]+)$/.exec(path);
        if (m) return twin(await v.domainTld(decodeURIComponent(m[1])), path);
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
