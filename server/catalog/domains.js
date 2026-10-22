'use strict';
/**
 * Domain names compared (migrations/0011_catalog_domains.sql): what registrars charge for each TLD, and the names a
 * person can check.
 *
 *   SOURCES                 the Sources keys that carry a registrar's price list (category hosting)
 *   mapTldPrice(item)       a Sources item → one registrar's price for one TLD, or null (held: not an ICANN TLD, no price)
 *   REGISTRARS              where to search a name at each well-known registrar (deep links, never affiliate)
 *   POPULAR                 the endings people ask for most, shown first
 *   parseName(input, tlds)  "My-Site.dev" → { label, tld, name }, the TLD the longest known suffix
 *   tldKind(tld)            'country' | 'generic' | 'second-level' | 'internationalized'
 *   displayTld(tld)         ".рф" for "xn--p1ai"
 */
const url = require('url');

// Only these keys may create a registrar. A Sources api item carries the TLD as `identity` and the registrar's price
// fields flat in `fields`, as the API gave them.
const SOURCES = Object.freeze({
    'porkbun-tld-pricing': {
        slug: 'porkbun', name: 'Porkbun', homepage_url: 'https://porkbun.com/', source_url: 'https://porkbun.com/products/domains',
        // "2,060.25": Porkbun writes thousands with a comma.
        prices: (x) => ({ register: amount(x.registration), renew: amount(x.renewal), transfer: amount(x.transfer) }),
        // Handshake names are sold beside ICANN TLDs but resolve only in Handshake's own root.
        skip: (x) => x.special_type != null && x.special_type !== '',
    },
    'ovhcloud-domain-pricing': {
        slug: 'ovhcloud', name: 'OVHcloud', homepage_url: 'https://www.ovhcloud.com/en/', source_url: 'https://www.ovhcloud.com/en/domains/tld/',
        // The public catalog's integers are hundred-millionths of a dollar (920000000 is $9.20). A first year of 0 (an
        // ending sold only under conditions) or the 999999 sentinel is not a price to compare: that ending is left out.
        prices: (x) => ({ register: hundredMillionths(x.register), renew: hundredMillionths(x.renew), transfer: hundredMillionths(x.transfer, { zero: true }) }),
        skip: (x) => x.currency !== 'USD' || !(Number(x.register) > 0) || Number(x.register) >= OVH_SENTINEL,
    },
});

const OVH_SENTINEL = 99999900000000;
/** An OVHcloud catalog price → dollars, or null (missing, the sentinel, or 0 where 0 is not a price). */
function hundredMillionths(v, { zero = false } = {}) {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n) || n < 0 || n >= OVH_SENTINEL) return null;
    if (n === 0 && !zero) return null;
    return Math.round(n / 1e6) / 100;
}

function amount(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    const s = String(v).trim().replace(/,(?=\d{3}(\D|$))/g, '');
    return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

const TLD_RE = /^(xn--)?[a-z0-9]+(-[a-z0-9]+)*(\.(xn--)?[a-z0-9]+(-[a-z0-9]+)*)*$/;
/** A TLD as stored: lower case, ASCII (punycode), no leading dot. */
function normalizeTld(v) {
    if (typeof v !== 'string') return null;
    const raw = v.trim().toLowerCase().replace(/^\.+/, '');
    if (!raw || raw.length > 120) return null;
    const ascii = /^[\x00-\x7f]*$/.test(raw) ? raw : url.domainToASCII(raw);
    return ascii && TLD_RE.test(ascii) ? ascii : null;
}

function mapTldPrice(item) {
    const source = SOURCES[item && item.source_key];
    if (!source) return null;
    if (item.category !== 'hosting' || !item.fields || typeof item.fields !== 'object' || !item.provenance || !item.provenance.retrieved_at || !item.provenance.first_seen_at) throw new TypeError('incomplete domain price item');
    const checked = Date.parse(item.provenance.retrieved_at), first = Date.parse(item.provenance.first_seen_at);
    if (!Number.isFinite(checked) || !Number.isFinite(first)) throw new TypeError('invalid fetch time');
    if (source.skip(item.fields)) return null;
    const tld = normalizeTld(item.identity);
    if (!tld) return null;
    const p = source.prices(item.fields);
    if (p.register == null && p.renew == null && p.transfer == null) return null;
    return {
        provider: source, tld, currency: 'USD', ...p, source_key: item.source_key, source_item_id: item.id,
        source_url: source.source_url, checked_at: checked, first_seen_at: first,
    };
}

const REGISTRARS = Object.freeze([
    { name: 'Porkbun', search: (n) => `https://porkbun.com/checkout/search?q=${encodeURIComponent(n)}` },
    { name: 'Cloudflare', search: (n) => `https://domains.cloudflare.com/?domain=${encodeURIComponent(n)}` },
    { name: 'Namecheap', search: (n) => `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(n)}` },
    { name: 'Spaceship', search: (n) => `https://www.spaceship.com/domain-search/?query=${encodeURIComponent(n)}` },
    { name: 'Dynadot', search: (n) => `https://www.dynadot.com/domain/search?domain=${encodeURIComponent(n)}` },
    { name: 'NameSilo', search: (n) => `https://www.namesilo.com/domain/search-domains?query=${encodeURIComponent(n)}` },
    { name: 'Name.com', search: (n) => `https://www.name.com/domain/search/${encodeURIComponent(n)}` },
    { name: 'Squarespace', search: (n) => `https://domains.squarespace.com/domain-search?query=${encodeURIComponent(n)}` },
    { name: 'Hover', search: (n) => `https://www.hover.com/domains/results?q=${encodeURIComponent(n)}` },
    { name: 'GoDaddy', search: (n) => `https://www.godaddy.com/domainsearch/find?domainToCheck=${encodeURIComponent(n)}` },
]);

const POPULAR = Object.freeze(['com', 'net', 'org', 'io', 'dev', 'app', 'ai', 'co', 'xyz', 'me', 'info', 'tech', 'site', 'online', 'store', 'us', 'uk', 'ca', 'de', 'gg']);

const displayTld = (tld) => `.${tld.split('.').map((l) => (l.startsWith('xn--') ? url.domainToUnicode(l) || l : l)).join('.')}`;

function tldKind(tld) {
    if (tld.includes('.')) return 'second-level';
    if (tld.startsWith('xn--')) return 'internationalized';
    return /^[a-z]{2}$/.test(tld) ? 'country' : 'generic';
}
const KIND_LABEL = { country: 'Country code', generic: 'Generic', 'second-level': 'Second level', internationalized: 'Internationalized' };

const LABEL_RE = /^(xn--)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * A name a person typed: "openvibe", "OpenVibe.dev", "https://www.example.co.uk/x". Returns { label, tld, name } with
 * the TLD the longest suffix in `known` (a Set of stored TLDs), else the last label; null when it is not a name.
 */
function parseName(input, known = new Set()) {
    if (typeof input !== 'string') return null;
    let s = input.trim().toLowerCase();
    if (!s || s.length > 253) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    const ascii = /^[\x00-\x7f]*$/.test(s) ? s : url.domainToASCII(s);
    if (!ascii) return null;
    const labels = ascii.split('.');
    if (labels.some((l) => !LABEL_RE.test(l) || /^..--/.test(l) && !l.startsWith('xn--'))) return null;
    if (labels.length === 1) return { label: labels[0], tld: null, name: null };
    // The registrable label sits right before the longest known suffix ("example" in example.co.uk when co.uk is sold).
    let tld = null;
    for (let i = 1; i < labels.length; i++) {
        const suffix = labels.slice(i).join('.');
        if (known.has(suffix)) { tld = suffix; break; }
    }
    if (!tld) tld = labels[labels.length - 1];
    const before = labels.slice(0, labels.length - tld.split('.').length);
    const label = before[before.length - 1];
    if (!label) return null;
    return { label, tld, name: `${label}.${tld}` };
}

module.exports = { SOURCES, REGISTRARS, POPULAR, KIND_LABEL, mapTldPrice, normalizeTld, parseName, tldKind, displayTld, amount };
