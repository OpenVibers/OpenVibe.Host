'use strict';
/**
 * A name check (/catalog/domains/check, /api/v1/catalog/domains/check): read what the person typed, ask the registry
 * over RDAP whether it is registered, and price the same name at the popular endings.
 *
 *   createDomainCheck({ catalog, rdap }) → { check(input) }
 *   check('OpenVibe.dev') → { label, tld, name, display, labelDisplay, status, registrar, created, expires, server, reason, cached, prices }
 *
 * A bare label ("openvibe") is checked as .com. A name that is not a domain name is a 422.
 */
const url = require('url');
const { ApiError } = require('../http/errors');
const domains = require('./domains');

function createDomainCheck({ catalog, rdap }) {
    async function check(input) {
        const known = await catalog.domains.knownTlds();
        const parsed = domains.parseName(typeof input === 'string' ? input : '', known);
        if (!parsed) throw new ApiError(422, 'host.domain.invalid', 'That is not a domain name: letters, digits and hyphens, such as my-site.dev.');
        const tld = parsed.tld || 'com';
        const name = parsed.name || `${parsed.label}.com`;
        const answer = await rdap.lookup(name);
        // The name's own ending first, then up to twelve popular endings that have a listed price.
        const prices = (await catalog.domains.cheapest([tld, ...domains.POPULAR.filter((t) => t !== tld)])).slice(0, 13);
        return {
            label: parsed.label, labelDisplay: url.domainToUnicode(parsed.label) || parsed.label, tld, name, display: url.domainToUnicode(name) || name,
            status: answer.status, registrar: answer.registrar || null, created: answer.created || null, expires: answer.expires || null,
            server: answer.server || null, reason: answer.reason || null, cached: Boolean(answer.cached), prices,
        };
    }
    return { check };
}

module.exports = { createDomainCheck };
