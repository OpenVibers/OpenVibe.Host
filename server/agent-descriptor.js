'use strict';
// What openvibe.host tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the catalog API, the llms files, the sitemap and the
// public pages that have a Markdown twin. The catalog publishes no OpenAPI document and has no docs page,
// so neither is named.
module.exports = {
    id: 'host',
    name: 'OpenVibe.Host',
    purpose: 'Hosting plans and domain prices compared side by side: cloud, VPS and dedicated servers from every provider in the catalog, and what each registrar charges per domain ending, every price dated and linked to its source, with server benchmarks people ran on their own machines.',
    home: 'https://openvibe.host',
    site: 'openvibe.host',
    api: '/api/v1/catalog',
    docs: '/catalog',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '300 page requests and 240 catalog API requests a minute per address; 30 domain name checks a minute; sign-in 60 attempts per 15 minutes',
    },
};
