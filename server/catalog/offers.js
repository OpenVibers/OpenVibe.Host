'use strict';

/**
 * Hosting offers (plan T20 step 3, "a modern LowEndBox with honest data"): what providers post on LowEndTalk's Offers
 * board and LowEndBox's offer posts, from their public RSS feeds through OpenVibe.Sources (category hosting, plain
 * `rss` items: title, link, date, author, a short plain-text summary).
 *
 * Host keeps the headline, the poster, the date and the link, and reads one price out of the headline (or, when the
 * headline states none, out of the post's opening): the cheapest "<amount> per <month|year>" it states, kept as the
 * exact text with its monthly equivalent (a yearly price divided by 12). Nothing else is inferred: a price stated
 * without a period is no price here, a currency is only $, US$, €, EUR, £ or GBP, and an offer whose post states no
 * price shows "Price in the post".
 */
const SOURCES = Object.freeze({
    'lowendtalk-offers': { label: 'LowEndTalk', board: 'Offers', home: 'https://lowendtalk.com/categories/offers' },
    'lowendbox-posts': { label: 'LowEndBox', board: null, home: 'https://lowendbox.com/' },
});
// LowEndBox's feed mixes editorials and giveaways with offers: an offer post is filed under "Low End …", or its
// headline states a price and it is not a giveaway.
const LEB_OFFER_CATEGORY = /^Low End /i;
const LEB_GIVEAWAY = /^Giveaways?$/i;
const MAX_AGE_DAYS = 120;

const CURRENCY = { '$': 'USD', 'us$': 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP' };
const PERIOD = { mo: 'month', mon: 'month', mth: 'month', month: 'month', monthly: 'month', yr: 'year', year: 'year', yearly: 'year', annually: 'year', annum: 'year' };
const AMOUNT = '(\\d{1,5}(?:[.,]\\d{1,2})?)';
const SYMBOL = '(US\\$|\\$|€|£|USD|EUR|GBP)';
const PER = '\\s*(?:/|per|a|an|each)\\s*(mo|mon|mth|month|monthly|yr|year|yearly|annually|annum)\\b';
// "$2.25/mo", "From $9.95/yr", "US$ 14.80 per Year", "2.60€/month", "€3.49 / Month", "4.17 EUR/mo".
const BEFORE = new RegExp(`${SYMBOL}\\s?${AMOUNT}${PER}`, 'gi');
const AFTER = new RegExp(`${AMOUNT}\\s?${SYMBOL}${PER}`, 'gi');

/** Every "<amount> per <period>" in `text` → [{ text, amount, currency, period, monthly }], cheapest monthly first. */
function statedPrices(text) {
    const s = String(text || '').replace(/\s+/g, ' ');
    const found = [];
    const add = (whole, symbol, amount, period) => {
        const currency = CURRENCY[symbol.toLowerCase()];
        const per = PERIOD[period.toLowerCase()];
        const n = Number(amount.replace(',', '.'));
        if (!currency || !per || !Number.isFinite(n) || n <= 0) return;
        found.push({ text: whole.trim(), amount: n, currency, period: per, monthly: Math.round((per === 'year' ? n / 12 : n) * 10000) / 10000 });
    };
    for (const m of s.matchAll(BEFORE)) add(m[0], m[1], m[2], m[3]);
    for (const m of s.matchAll(AFTER)) add(m[0], m[2], m[1], m[3]);
    return found.sort((a, b) => a.monthly - b.monthly);
}

/** A Sources rss item from an offer feed → the offer row's values, or null when it is not an offer (or too old). */
function mapOffer(item, now = Date.now()) {
    const source = SOURCES[item && item.source_key];
    if (!source) return null;
    if (item.category !== 'hosting' || !item.provenance || !item.provenance.retrieved_at || !item.provenance.first_seen_at) throw new TypeError('incomplete hosting item');
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const url = typeof item.canonical_url === 'string' ? item.canonical_url : '';
    const id = typeof item.identity === 'string' ? item.identity.trim() : '';
    const published = Date.parse(item.published_at || '');
    if (!title || !id || id.length > 2048 || !/^https:\/\//.test(url) || !Number.isFinite(published)) throw new TypeError('offer needs a title, link, id and date');
    if (published < now - MAX_AGE_DAYS * 86400000) return null;
    const inTitle = statedPrices(title);
    if (item.source_key === 'lowendbox-posts') {
        const categories = Array.isArray(item.fields && item.fields.categories) ? item.fields.categories : [];
        const filed = (re) => categories.some((c) => re.test(String(c)));
        if (!filed(LEB_OFFER_CATEGORY) && (!inTitle.length || filed(LEB_GIVEAWAY))) return null;
    }
    const inPost = inTitle.length ? [] : statedPrices(item.summary);
    const price = inTitle[0] || inPost[0] || null;
    const poster = Array.isArray(item.authors) && typeof item.authors[0] === 'string' ? item.authors[0].trim().slice(0, 100) || null : null;
    return {
        source_key: item.source_key, external_id: id, source_item_id: item.id || null, title, poster, url, published_at: published,
        price_text: price ? price.text.slice(0, 80) : null, price_from: price ? (inTitle.length ? 'title' : 'post') : null,
        price_amount: price ? price.amount : null, price_currency: price ? price.currency : null,
        price_period: price ? price.period : null, price_monthly: price ? price.monthly : null,
        checked_at: Date.parse(item.provenance.retrieved_at), first_seen_at: Date.parse(item.provenance.first_seen_at),
    };
}

module.exports = { SOURCES, MAX_AGE_DAYS, statedPrices, mapOffer };
