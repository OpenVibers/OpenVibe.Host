'use strict';
/**
 * Domain names compared (server/catalog/domains.js, domain-store.js, rdap.js). Server-rendered, complete without
 * JavaScript:
 *
 *   index({ result, query, stats, registrars })   /catalog/domains: check a name, and every ending's cheapest prices
 *   tld(t, { baseUrl, watchUrl })                  /catalog/domains/:tld: every registrar's price for one ending
 *   check(c)                                       /catalog/domains/check?name=: is it taken, where to register it
 *   frontSection({ popular, stats })               the front page's domain block
 *
 * Prices are what registrars publish, each with the day it was checked and its source; the five-year cost is the
 * first year plus four renewals at the same registrar. Registrar search links are plain links (never affiliate).
 */
const seo = require('openvibe-shared/seo');
const { esc } = require('./layout');
const { money, tldTrendFigure } = require('./catalog');
const domains = require('../catalog/domains');

const UNKNOWN = '<span class="hc-unknown" title="The registrar does not state it">Unknown</span>';
const SORTS = [['popular', 'Popular first'], ['register', 'Cheapest first year'], ['renew', 'Cheapest renewal'], ['five_year', 'Cheapest over five years'], ['tld', 'A to Z']];
const KINDS = [['', 'Every ending'], ['generic', 'Generic (.dev, .app)'], ['country', 'Country codes (.uk, .io)'], ['second-level', 'Second level (.co.uk)'], ['internationalized', 'Internationalized (.рф)']];
const day = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
const usd = (v) => (v == null ? UNKNOWN : esc(money(v, 'USD')));
const link = (href, label, cls = '') => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''}>${label}</a>`;
const out = (href, label, cls = '') => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''} rel="nofollow noopener">${label}</a>`;
const tldHref = (tld) => `/catalog/domains/${encodeURIComponent(tld)}`;
const checkHref = (name) => `/catalog/domains/check?${new URLSearchParams({ name })}`;
const select = (name, label, options, current) => `<label><span>${esc(label)}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(current || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
// A renewal more than a fifth above the first year is the usual trap: a cheap first year, then the real price.
const searchAt = (registrar, name, fallback) => { const r = domains.REGISTRARS.find((x) => x.name === registrar); return r ? r.search(name) : fallback; };
const jumps = (r) => r.register != null && r.renew != null && r.renew > r.register * 1.2;
const jumpChip = (r) => (jumps(r) ? ' <span class="hc-chip" title="The renewal costs more than the first year">Renews higher</span>' : '');

function checkForm({ value = '', tld = '', label = 'Is your name free?', autofocus = false } = {}) {
    const ph = tld ? `yourname${domains.displayTld(tld)}` : 'yourname.dev';
    return `<form class="hd-check" method="get" action="/catalog/domains/check" role="search" aria-label="Check a domain name">
<label for="hd-name">${esc(label)}</label>
<div class="hd-check-row"><input id="hd-name" name="name" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" maxlength="253" required${autofocus ? ' autofocus' : ''}>
<button type="submit">Check</button></div>
<p class="hd-check-note">Asks the registry directly (RDAP), then shows what it costs at each registrar.</p>
</form>`;
}

function tldTable(rows, { caption }) {
    if (!rows.length) return '';
    // With one registrar listed the count says nothing: the column appears once a second registrar's list is read.
    const many = rows.some((r) => r.registrars > 1);
    return `<div class="hc-table-wrap"><table class="hc-table hd-table hd-list"><caption>${esc(caption)}</caption>
<thead><tr><th scope="col">Ending</th><th scope="col" class="hc-n">First year</th><th scope="col" class="hc-n">Renewal</th><th scope="col" class="hc-n">Transfer</th><th scope="col" class="hc-n">5 years</th>${many ? '<th scope="col" class="hc-n">Registrars</th>' : ''}<th scope="col">Checked</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
<th scope="row" data-label="Ending">${link(tldHref(r.tld), esc(r.display))}<span class="hc-kind">${esc(domains.KIND_LABEL[r.kind] || '')}</span></th>
<td data-label="First year" class="hc-n hd-first"><span class="hc-price">${usd(r.register)}</span></td>
<td data-label="Renewal" class="hc-n">${usd(r.renew)}${jumpChip(r)}</td>
<td data-label="Transfer" class="hc-n hc-dim">${usd(r.transfer)}</td>
<td data-label="5 years" class="hc-n">${usd(r.five_year)}</td>
${many ? `<td data-label="Registrars" class="hc-n hc-dim">${esc(String(r.registrars))}</td>` : ''}
<td data-label="Checked" class="hc-checked">${esc(day(r.checked_at) || '')}</td>
</tr>`).join('')}</tbody></table></div>`;
}

function method(registrars) {
    return `<section class="hc-method" aria-labelledby="hd-method-h">
<h2 id="hd-method-h">How domain prices are compared</h2>
<ul>
<li><strong>Published prices.</strong> From registrars' own public price lists through OpenVibe.Sources${registrars.length ? ` (${esc(registrars.join(', '))} today)` : ''}, each with the day it was checked and a link to the list. More registrars join as their lists are checked.</li>
<li><strong>The renewal counts.</strong> A first year is often cheap and the renewal is the real price, so every ending shows both, marks a renewal more than a fifth higher, and adds up five years (the first year and four renewals at one registrar).</li>
<li><strong>Checked at the registry.</strong> A name check asks the ending's registry over RDAP, the public lookup that replaced WHOIS. A name with no registration is probably free; a registry can still hold it as reserved or premium.</li>
<li><strong>Not for sale.</strong> The order comes only from the sort you pick. The registrar links are plain links; nobody pays to be listed.</li>
</ul></section>`;
}

function registrarLinks(name) {
    return `<ul class="hd-registrars">${domains.REGISTRARS.map((r) => `<li>${out(r.search(name), `<span>${esc(r.name)}</span><small>Search ${esc(name)}</small>`)}</li>`).join('')}</ul>`;
}

function index({ result, query = {}, stats, registrars = [] }) {
    const q = query || {};
    const rows = result.tlds;
    const filtered = ['q', 'kind', 'registrar'].some((k) => q[k]);
    const next = result.next_cursor ? `<p class="hc-more">${link(`/catalog/domains?${new URLSearchParams({ ...q, cursor: result.next_cursor })}`, 'Next 100 endings →', 'button hc-button-quiet')}</p>` : '';
    const sortLabel = (SORTS.find(([v]) => v === (q.sort || 'popular')) || SORTS[0])[1].toLowerCase();
    const prices = stats.tlds ? `<form class="hc-filters" method="get" action="/catalog/domains" role="search" aria-label="Filter domain endings">
<label><span>Ending</span><input name="q" value="${esc(q.q || '')}" placeholder=".dev, co.uk" autocapitalize="off" spellcheck="false"></label>
${select('kind', 'Kind', KINDS, q.kind)}
${select('sort', 'Sort by', SORTS, q.sort || 'popular')}
<div class="hc-filter-actions"><button type="submit">Show</button> <a href="/catalog/domains" class="hc-reset">Reset</a></div>
</form>
${tldTable(rows, { caption: `${rows.length}${result.next_cursor ? '+' : ''} ending${rows.length === 1 ? '' : 's'}, ${sortLabel}; the cheapest price at any registrar` })}
${!rows.length && filtered ? `<div class="hc-empty"><p><strong>No ending matches.</strong></p><p>${link('/catalog/domains', 'Clear the filters')} or try another ending.</p></div>` : ''}${next}` : '';
    return `<header class="hc-head"><p class="hc-eyebrow">OpenVibe.Host · domains compared</p><h1>Compare domain prices</h1>
<p class="hc-lede">${stats.tlds ? `${stats.tlds.toLocaleString('en')} endings with what registrars charge for the first year, a renewal and a transfer, and the total over five years.` : 'What registrars charge for each ending, for the first year, a renewal and a transfer.'} Check whether a name is taken, then register it wherever it costs least.</p></header>
${checkForm({ autofocus: !filtered && !q.sort && !q.cursor })}
${prices}
<section aria-labelledby="hd-reg-h"><h2 id="hd-reg-h">Search a name at every registrar</h2>${registrarLinks('yourname.com')}</section>
${method(registrars)}
<p class="hc-links">${link('/catalog', 'Compare hosting plans')} · ${link('/catalog/offers', 'Hosting offers')}</p>`;
}

function tld(t, { baseUrl = '', watchUrl = '' } = {}) {
    const c = t.cheapest;
    const jump = c.register != null && c.renew != null && c.renew > c.register * 1.2;
    const kind = t.kind === 'second-level' ? `Second level under ${domains.displayTld(t.tld.slice(t.tld.indexOf('.') + 1))}` : domains.KIND_LABEL[t.kind];
    const trend = tldTrendFigure(t.price_trend, { title: 'Registration and renewal over time' });
    const history = t.history.length ? `<details class="hc-history-fold"><summary>Every change (${t.history_count || t.history.length})</summary><ol class="hc-history">${t.history.map((h) => {
        const moved = [['first year', h.register], ['renewal', h.renew], ['transfer', h.transfer]].filter(([, [a, b]]) => a !== b)
            .map(([k, [a, b]]) => `${k} ${a == null ? 'none' : esc(money(a, h.currency))} → <strong>${b == null ? 'none' : esc(money(b, h.currency))}</strong>`).join(', ');
        return `<li><time datetime="${esc(day(h.observed_at))}">${esc(day(h.observed_at))}</time> ${esc(h.registrar)}: ${moved}</li>`;
    }).join('')}</ol></details>` : '';
    const rows = t.prices.map((p) => `<tr>
<th scope="row" data-label="Registrar">${link(`/catalog/providers/${encodeURIComponent(p.registrar_slug)}`, esc(p.registrar))}</th>
<td data-label="First year" class="hc-n hd-first"><span class="hc-price">${usd(p.register)}</span></td>
<td data-label="Renewal" class="hc-n">${usd(p.renew)}${jumpChip(p)}</td>
<td data-label="Transfer" class="hc-n hc-dim">${usd(p.transfer)}</td>
<td data-label="5 years" class="hc-n">${usd(p.five_year)}</td>
<td data-label="Checked" class="hc-checked">${esc(day(p.checked_at) || '')} ${out(p.source_url, 'source', 'hc-src')}</td>
<td data-label="Register" class="hd-go">${out(searchAt(p.registrar, `yourname.${t.tld}`, p.homepage_url), `Register at ${esc(p.registrar)}`, 'button hc-button-quiet')}</td>
</tr>`).join('');
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog/domains', 'Domains')} / ${esc(t.display)}</nav>
<header class="hc-head"><p class="hc-eyebrow">${esc(kind)} ending</p><h1>${esc(t.display)} domain prices</h1>
<p class="hc-lede">A ${esc(t.display)} name costs from <strong>${usd(c.register)}</strong> for the first year and renews from <strong>${usd(c.renew)}</strong> a year; five years cost from <strong>${usd(c.five_year)}</strong>.${jump ? ' The renewal is the real price here: it costs well above the first year.' : ''}</p></header>
${checkForm({ tld: t.tld, label: `Check a ${t.display} name` })}
<div class="hc-table-wrap"><table class="hc-table hd-table"><caption>${esc(t.display)} at ${t.prices.length} registrar${t.prices.length === 1 ? '' : 's'}, cheapest first year first</caption>
<thead><tr><th scope="col">Registrar</th><th scope="col" class="hc-n">First year</th><th scope="col" class="hc-n">Renewal</th><th scope="col" class="hc-n">Transfer</th><th scope="col" class="hc-n">5 years</th><th scope="col">Checked</th><th scope="col"><span class="hd-sr">Register</span></th></tr></thead>
<tbody>${rows}</tbody></table></div>
<h2>Price history</h2>
${trend}
${history}
${baseUrl && watchUrl ? `<p class="hc-watch">${out(`${watchUrl}/watches/new?${new URLSearchParams({ template: 'json', url: `${baseUrl}/api/v1/catalog/domains/${t.tld}`, value_path: 'tld.cheapest.renew', op: 'changed', name: `${t.display} renewal price` })}`, `Tell me when ${esc(t.display)} prices change`, 'button hc-button-quiet')} <span class="hc-dim">with OpenVibe.Watch, free</span></p>` : ''}
<section aria-labelledby="hd-reg-h"><h2 id="hd-reg-h">Search a ${esc(t.display)} name at every registrar</h2>${registrarLinks(`yourname.${t.tld}`)}</section>
<p class="hc-links">${link('/catalog/domains', '← Every ending')}</p>`;
}

const STATUS_TEXT = {
    registered: (c) => `<p class="hd-verdict">Taken</p><p>${esc(c.display)} is registered${c.registrar ? ` through <strong>${esc(c.registrar)}</strong>` : ''}${c.created ? ` since ${esc(day(c.created))}` : ''}${c.expires ? `, paid up to ${esc(day(c.expires))}` : ''}.</p>`,
    unregistered: (c) => `<p class="hd-verdict">Probably free</p><p>The ${esc(domains.displayTld(c.tld))} registry holds no registration for ${esc(c.display)}. It can still keep a name back as reserved or premium; a registrar's search says for sure.</p>`,
    unknown: (c) => `<p class="hd-verdict">Not known</p><p>${esc(c.reason || 'The registry did not answer.')}</p>`,
};

function check(c) {
    const own = c.prices.find((p) => p.tld === c.tld);
    const others = c.prices.filter((p) => p.tld !== c.tld);
    const card = c.name ? `<section class="hd-status hd-${esc(c.status)}" aria-live="polite">${STATUS_TEXT[c.status](c)}
${own ? `<p class="hd-cost">${c.status === 'registered' ? `A ${esc(domains.displayTld(c.tld))} name` : 'It'} costs from <strong>${usd(own.register)}</strong> the first year and <strong>${usd(own.renew)}</strong> a year after. ${link(tldHref(c.tld), `Every registrar's ${esc(domains.displayTld(c.tld))} price`)}</p>` : ''}
<p class="hc-dim hd-src">${c.server ? `Asked ${esc(c.server)} over RDAP${c.cached ? ' a few minutes ago' : ' just now'}.` : ''}</p></section>` : '';
    const alts = others.length ? `<section aria-labelledby="hd-alt-h"><h2 id="hd-alt-h">${esc(c.label)} with other endings</h2>
<div class="hc-table-wrap"><table class="hc-table hd-table"><caption>Cheapest price at any registrar</caption>
<thead><tr><th scope="col">Name</th><th scope="col" class="hc-n">First year</th><th scope="col" class="hc-n">Renewal</th><th scope="col" class="hc-n">5 years</th><th scope="col"><span class="hd-sr">Check</span></th></tr></thead>
<tbody>${others.map((p) => { const n = `${c.label}.${p.tld}`; return `<tr><th scope="row" data-label="Name">${link(tldHref(p.tld), esc(`${c.labelDisplay}${p.display}`))}</th>
<td data-label="First year" class="hc-n hd-first"><span class="hc-price">${usd(p.register)}</span></td><td data-label="Renewal" class="hc-n">${usd(p.renew)}${jumpChip(p)}</td><td data-label="5 years" class="hc-n">${usd(p.five_year)}</td>
<td data-label="Check" class="hd-go">${link(checkHref(n), `Check ${esc(`${c.labelDisplay}${p.display}`)}`, 'button hc-button-quiet')}</td></tr>`; }).join('')}</tbody></table></div></section>` : '';
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog/domains', 'Domains')} / Check a name</nav>
<header class="hc-head"><p class="hc-eyebrow">Domain check</p><h1 class="hd-name">${esc(c.display || c.labelDisplay)}</h1></header>
${checkForm({ value: c.display || c.labelDisplay, label: 'Check another name' })}
${card}
<section aria-labelledby="hd-reg-h"><h2 id="hd-reg-h">${c.status === 'registered' ? 'Look for it at a registrar' : 'Register it at a registrar'}</h2>${registrarLinks(c.name || `${c.label}.com`)}</section>
${alts}
<p class="hc-links">${link('/catalog/domains', '← Compare every ending')}</p>`;
}

function frontSection({ popular = [], cheap = [], stats }) {
    const registrars = (stats.registrars || []).length;
    return `<section class="sc-sec hd-front" aria-labelledby="hd-front-h"><h2 id="hd-front-h">Domain names, compared too</h2>
<p class="hc-dim">${stats.tlds ? `${stats.tlds.toLocaleString('en')} endings${registrars > 1 ? ` from ${registrars} registrars (${stats.registrars.map(esc).join(', ')})` : ''}, with the first year, the renewal and five years side by side. ` : ''}Check a name at its registry, then register it where it costs least.</p>
${checkForm({})}
<div class="hh-short">${tldTable(popular.slice(0, 6), { caption: 'Popular endings: the cheapest price at any registrar' })}</div>
${cheap.length ? '<div class="hh-short">' + tldTable(cheap.slice(0, 6), { caption: 'The cheapest first year right now: check what it renews at' }) + '</div>' : ''}
${stats.tlds ? `<p class="hc-more">${link('/catalog/domains', 'Every ending, by price →', 'button')}</p>` : ''}</section>`;
}

const jsonLd = {
    index(base, rows) {
        return [seo.jsonLd.itemList('Domain endings by price', rows.slice(0, 50).map((r) => ({ name: `${r.display} domains`, url: `${base}${tldHref(r.tld)}` })), { url: `${base}/catalog/domains` })];
    },
    tld(base, t) {
        return [seo.jsonLd.breadcrumbs([{ name: 'Domains', url: `${base}/catalog/domains` }, { name: t.display, url: `${base}${tldHref(t.tld)}` }])];
    },
};

module.exports = { index, tld, check, frontSection, jsonLd, SORTS };
