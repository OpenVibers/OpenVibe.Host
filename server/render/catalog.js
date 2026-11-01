'use strict';

/**
 * The hosting catalog's pages (plan T20 step 3: hosting compared). Server-rendered, complete without JavaScript:
 *
 *   front({ plans, providers, promos, stats, domains })   the front page of openvibe.host (`domains`: render/domains.js frontSection)
 *   catalog({ result, query, providers })        /catalog: the filterable comparison table
 *   provider(p)                                  /catalog/providers/:slug
 *   plan(p)                                      /catalog/plans/:id
 *   promos(list)                                 /catalog/promos
 *   offers({ result, query })                    /catalog/offers: what providers post on LowEndSpirit's Offers board
 *
 * Every price shows when it was checked and links where it came from; an unknown value reads "Unknown", never 0;
 * affiliate links carry rel="sponsored nofollow noopener" with the provider's own disclosure beside them, and the
 * order never depends on affiliation (the store sorts; nothing here reorders).
 */
const showcase = require('openvibe-shared/showcase');
const kit = require('openvibe-shared/kit');
const seo = require('openvibe-shared/seo');
const { esc } = require('./layout');
const { MAX_AGE_DAYS } = require('../catalog/offers');

const DISCLOSURE = 'OpenVibe may earn a commission from links marked as affiliate links; it never changes the order or the prices shown.';
const KINDS = [['', 'Any kind'], ['cloud', 'Cloud'], ['vps', 'VPS'], ['dedicated', 'Dedicated'], ['storage', 'Storage'], ['domain', 'Domains']];
const SORTS = [['price', 'Lowest price'], ['price_per_vcpu', 'Price per vCPU'], ['price_per_gb_ram', 'Price per GB of RAM'], ['price_per_gb_disk', 'Price per GB of disk'], ['checked_at', 'Recently checked']];
const RAM = [['', 'Any RAM'], ['1024', '1 GB+'], ['2048', '2 GB+'], ['4096', '4 GB+'], ['8192', '8 GB+'], ['16384', '16 GB+'], ['32768', '32 GB+'], ['65536', '64 GB+']];

const UNKNOWN = '<span class="hc-unknown" title="The source does not state it">Unknown</span>';
const REVIEWS_URL = 'https://openvibe.reviews';
const num = (v) => (v == null || v === '' ? null : Number(v));
function money(v, currency, digits = 2) {
    const n = num(v);
    if (n == null || !Number.isFinite(n)) return null;
    try { return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n); } catch { return `${n.toFixed(digits)} ${currency}`; }
}
function bytesMb(mb) {
    const n = num(mb);
    if (n == null) return null;
    if (n >= 1024) { const g = n / 1024; return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`; }
    return `${n} MB`;
}
function sizeGb(gb) {
    const n = num(gb);
    if (n == null) return null;
    if (n >= 1000) { const t = n / 1000; return `${Number.isInteger(t) ? t : t.toFixed(1)} TB`; }
    return `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;
}
const transfer = (p) => (p.unmetered ? 'Unmetered' : sizeGb(p.bandwidth_gb));
const day = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
const or = (v) => (v == null ? UNKNOWN : esc(v));
const kindName = (k) => (KINDS.find(([v]) => v === k) || [k, k])[1];
const link = (href, label, cls = '') => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''}>${label}</a>`;
const out = (href, label, { affiliate = false, cls = '' } = {}) => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''} rel="${affiliate ? 'sponsored nofollow noopener' : 'noopener'}">${label}</a>`;

/** The visit button for a provider: its affiliate link (marked, with the provider's own disclosure) or its homepage. */
function visit(p, label = 'Visit provider') {
    if (p.affiliate_url) {
        return `<span class="hc-visit">${out(p.affiliate_url, `${esc(label)} <span class="hc-chip">Affiliate</span>`, { affiliate: true, cls: 'button' })}${p.affiliate_note ? `<small class="hc-note">${esc(p.affiliate_note)}</small>` : ''}</span>`;
    }
    return p.homepage_url ? `<span class="hc-visit">${out(p.homepage_url, esc(label), { cls: 'button hc-button-quiet' })}</span>` : '';
}

function priceCell(p) {
    const price = Number(p.price_monthly);
    const m = Number.isFinite(price) && price > 0 ? money(price, p.currency) : null;
    return `<span class="hc-price">${m ? esc(m) : 'price not stated'}</span><span class="hc-per">/mo</span>`;
}

const isoAt = (v) => new Date(v).toISOString();
const MINUS = '−';

/** A trend's step: each price holds until the next point, so a change is a vertical step, never a diagonal. */
function stepPoints(t) {
    const points = [];
    (t.points || []).forEach((p, i) => {
        if (i) points.push([new Date(Date.parse(p.at) - 1).toISOString(), Number(t.points[i - 1].price)]);
        points.push([p.at, Number(p.price)]);
    });
    return points;
}

/** The value of a step series at a moment (the last point at or before it). */
function valueAt(points, time) {
    let value = null;
    for (const [at, price] of points) { if (Date.parse(at) > time) break; value = price; }
    return value;
}

/** "Was $9 on 2 Sep, now $7 (−22%) · low $7 · high $12"; one observation says when it was first seen instead. */
function trendSummary(t, label = '') {
    if (!t || !t.points || !t.points.length) return '';
    const cur = t.currency;
    const first = t.points[0];
    const now = money(t.now, cur) || String(t.now);
    const was = money(first.price, cur) || String(first.price);
    let line;
    if (t.points.length < 2) line = `No changes recorded since ${day(first.at) || first.at} (${now})`;
    else if (t.change && t.change.amount === 0) line = `Unchanged since ${day(first.at)}: ${now}`;
    else if (t.change && t.change.percent != null) line = `Was ${was} on ${day(first.at)}, now ${now} (${t.change.amount > 0 ? '+' : MINUS}${Math.abs(t.change.percent)}%)`;
    else if (t.change) line = `Was ${was} on ${day(first.at)}, now ${now}`;
    const low = money(t.low, cur) || String(t.low);
    const high = money(t.high, cur) || String(t.high);
    const lowAt = (t.points.find((p) => Number(p.price) === Number(t.low)) || first).at;
    const highAt = (t.points.find((p) => Number(p.price) === Number(t.high)) || first).at;
    return `<p class="hc-trend-summary">${label ? `<strong>${esc(label)}</strong> ` : ''}${esc(line)} · low ${esc(low)} (${esc(day(lowAt) || '')}), high ${esc(high)} (${esc(day(highAt) || '')}).</p>`;
}

/** One series' step chart, with its summary line under it. Nothing with one observation. */
function trendFigure(t, { title = 'Price over time', label = '', seriesName = 'Price', note = 'A price holds until the next change.' } = {}) {
    if (!t || !t.points || t.points.length < 2) return '';
    const chart = kit.chart({
        type: 'line', title, note, height: 220, label: `${title} over time`,
        x: { time: true, label: 'Date' }, y: { fmt: 'money', zero: false, label: t.currency || 'Price' },
        series: [{ name: seriesName, points: stepPoints(t) }],
    });
    return `<div class="hc-trend">${chart}${trendSummary(t, label)}</div>`;
}

/** The registration and renewal step series on a shared time axis (kit.chart reads one x list for every series). */
function tldTrendFigure(trends, { title = 'Domain price over time' } = {}) {
    const all = [['Registration', trends && trends.register], ['Renewal', trends && trends.renew]].filter(([, t]) => t && t.points && t.points.length);
    if (!all.length) return '';
    const steps = all.map(([name, t]) => ({ name, points: stepPoints(t) }));
    const times = [...new Set(steps.flatMap((s) => s.points.map(([at]) => Date.parse(at))))].sort((a, b) => a - b);
    const series = steps.map((s) => ({ name: s.name, points: times.map((t) => [isoAt(t), valueAt(s.points, t)]) }));
    const chart = series.some((s) => s.points.length > 1)
        ? kit.chart({
            type: 'line', title, note: 'The cheapest price at any registrar; a price holds until the next change.', height: 240,
            label: `${title}: registration and renewal`,
            x: { time: true, label: 'Date' }, y: { fmt: 'money', zero: false, label: 'USD' },
            series,
        })
        : '';
    return `<div class="hc-trend">${chart}${all.map(([name, t]) => trendSummary(t, name)).join('')}</div>`;
}

function planTable(plans, { caption = 'Hosting plans', showProvider = true } = {}) {
    if (!plans.length) return '';
    const rows = plans.map((p) => {
        const provider = showProvider ? `<td data-label="Provider">${link(`/catalog/providers/${encodeURIComponent(p.provider_slug)}`, esc(p.provider_name || p.provider_slug))}${p.affiliate_url ? ' <span class="hc-chip" title="This provider has an affiliate link">Affiliate</span>' : ''}</td>` : '';
        return `<tr>
${provider}<th scope="row" data-label="Plan">${link(`/catalog/plans/${encodeURIComponent(p.id)}`, esc(p.name))}<span class="hc-kind">${esc(kindName(p.kind))}</span></th>
<td data-label="vCPU" class="hc-n">${or(p.vcpu == null ? null : num(p.vcpu))}</td>
<td data-label="RAM" class="hc-n">${or(bytesMb(p.ram_mb))}</td>
<td data-label="Disk" class="hc-n">${or(sizeGb(p.disk_gb))}${p.disk_type ? ` <span class="hc-dim">${esc(p.disk_type.toUpperCase())}</span>` : ''}</td>
<td data-label="Transfer" class="hc-n">${or(transfer(p))}</td>
<td data-label="Price" class="hc-n">${priceCell(p)}</td>
<td data-label="Per vCPU" class="hc-n hc-dim">${or(money(p.price_per_vcpu, p.currency, 2))}</td>
<td data-label="Per GB RAM" class="hc-n hc-dim">${or(money(p.price_per_gb_ram, p.currency, 2))}</td>
<td data-label="Checked" class="hc-checked">${or(day(p.checked_at))} ${out(p.source_url, 'source', { cls: 'hc-src' })}</td>
</tr>`;
    }).join('');
    return `<div class="hc-table-wrap"><table class="hc-table">
<caption>${esc(caption)}</caption>
<thead><tr>${showProvider ? '<th scope="col">Provider</th>' : ''}<th scope="col">Plan</th><th scope="col" class="hc-n">vCPU</th><th scope="col" class="hc-n">RAM</th><th scope="col" class="hc-n">Disk</th><th scope="col" class="hc-n">Transfer</th><th scope="col" class="hc-n">Price</th><th scope="col" class="hc-n">Per vCPU</th><th scope="col" class="hc-n">Per GB RAM</th><th scope="col">Checked</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

const select = (name, label, options, current) => `<label><span>${esc(label)}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(current || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const input = (name, label, current, attrs = '') => `<label><span>${esc(label)}</span><input name="${name}" value="${esc(current || '')}" ${attrs}></label>`;

function filters(query, providers, currencies) {
    const q = query || {};
    return `<form class="hc-filters" method="get" action="/catalog" role="search" aria-label="Filter hosting plans">
${select('kind', 'Kind', KINDS, q.kind)}
${input('min_vcpu', 'Min vCPU', q.min_vcpu, 'type="number" min="0" step="1" inputmode="numeric" placeholder="Any"')}
${select('min_ram_mb', 'Min RAM', RAM, q.min_ram_mb)}
${input('min_disk_gb', 'Min disk (GB)', q.min_disk_gb, 'type="number" min="0" step="1" inputmode="numeric" placeholder="Any"')}
${input('max_price', 'Max price /mo', q.max_price, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="Any"')}
${select('provider', 'Provider', [['', 'Any provider'], ...providers.map((p) => [p.slug, p.name])], q.provider)}
${input('location', 'Location', q.location, 'placeholder="Any"')}
${select('currency', 'Currency', currencies.map((c) => [c, c]), q.currency || 'USD')}
${select('sort', 'Sort by', SORTS, q.sort || 'price')}
<div class="hc-filter-actions"><button type="submit">Compare</button> <a href="/catalog" class="hc-reset">Reset</a></div>
</form>`;
}

function method(hasAffiliate) {
    return `<section class="hc-method" aria-labelledby="hc-method-h">
<h2 id="hc-method-h">How the comparison works</h2>
<ul>
<li><strong>Sourced.</strong> Plans come from providers' official APIs through OpenVibe.Sources, or from a staff entry that names the page it was copied from. Nothing is estimated.</li>
<li><strong>Dated.</strong> Every price shows the day it was last checked and links its source. Prices change; the provider's own page is the final word.</li>
<li><strong>Normalised.</strong> "Per vCPU" and "per GB" divide the monthly price by what the plan states, in the plan's own currency. A value the source does not state stays Unknown and sorts last.</li>
<li><strong>Not for sale.</strong> The order comes only from the sort you pick.${hasAffiliate ? ` ${esc(DISCLOSURE)}` : ' No provider pays to be listed or ranked.'}</li>
</ul>
</section>`;
}

function catalog({ result, query, providers, currencies }) {
    const plans = result.plans;
    const filtered = Object.keys(query || {}).some((k) => k !== 'sort' && k !== 'cursor' && query[k]);
    const empty = plans.length ? '' : filtered
        ? `<div class="hc-empty"><p><strong>No plan matches these filters.</strong></p><p>${link('/catalog', 'Clear the filters')} or widen one of them.</p></div>`
        : `<div class="hc-empty"><p><strong>The catalog is filling up.</strong></p><p>Plans arrive from providers' official APIs as each source is checked and enabled, and from staff entries with their source pages.</p></div>`;
    const next = result.next_cursor ? `<p class="hc-more">${link(`/catalog?${new URLSearchParams({ ...query, cursor: result.next_cursor })}`, 'Next 50 plans →', 'button hc-button-quiet')}</p>` : '';
    return `<header class="hc-head">
<p class="hc-eyebrow">OpenVibe.Host · hosting compared · alpha</p>
<h1>Compare hosting plans</h1>
<p class="hc-lede">Cloud, VPS and dedicated plans side by side, each with the day its price was checked and a link to where it came from.</p>
</header>
${filters(query, providers, currencies)}
${planTable(plans, { caption: `${plans.length}${result.next_cursor ? '+' : ''} plan${plans.length === 1 ? '' : 's'}, sorted by ${(SORTS.find(([v]) => v === (query.sort || 'price')) || SORTS[0])[1].toLowerCase()}` })}
${empty}${next}
<p class="hc-links">${link('/catalog/promos', 'Current promotions')} · ${link('/catalog/providers', 'All providers')}</p>
${method(plans.some((p) => p.affiliate_url))}`;
}

function providerList(providers) {
    return `<header class="hc-head"><p class="hc-eyebrow">OpenVibe.Host · hosting compared</p><h1>Providers</h1>
<p class="hc-lede">Every provider in the catalog, with where its plans come from.</p></header>
${providers.length ? `<ul class="hc-providers">${providers.map((p) => `<li>${link(`/catalog/providers/${encodeURIComponent(p.slug)}`, `<strong>${esc(p.name)}</strong>`)}${p.description ? `<span>${esc(p.description)}</span>` : ''}${p.affiliate_url ? '<span class="hc-chip">Affiliate</span>' : ''}</li>`).join('')}</ul>` : '<div class="hc-empty"><p>No provider is listed yet.</p></div>'}
${providers.some((p) => p.affiliate_url) ? `<p class="hc-disclosure">${esc(DISCLOSURE)}</p>` : ''}`;
}

function promoCards(list, { showProvider = true } = {}) {
    if (!list.length) return '<div class="hc-empty"><p>No promotion is running right now.</p></div>';
    return `<ul class="hc-promos">${list.map((p) => `<li class="hc-promo">
${showProvider && p.provider_name ? `<p class="hc-promo-provider">${esc(p.provider_name)}</p>` : ''}
<h3>${esc(p.title)}</h3>
${p.details ? `<p>${esc(p.details)}</p>` : ''}
${p.code ? `<p class="hc-code">Code <code>${esc(p.code)}</code></p>` : ''}
<p class="hc-promo-meta">${p.ends_at ? `Ends ${esc(day(Number(p.ends_at)))}` : 'No end date stated'}</p>
<p>${out(p.url, `See the offer${p.affiliate ? ' <span class="hc-chip">Affiliate</span>' : ''}`, { affiliate: Boolean(p.affiliate), cls: 'button hc-button-quiet' })}${p.affiliate && p.affiliate_note ? `<small class="hc-note">${esc(p.affiliate_note)}</small>` : ''}</p>
</li>`).join('')}</ul>`;
}

// With nothing running, the page says what will appear here and under which rules, rather than one bare line.
const PROMO_RULES = `<div class="hc-empty hc-empty-rich"><p><strong>No promotion is running right now.</strong></p>
<p>When a provider runs one, it is listed here with:</p>
<ul class="hc-rules"><li>the offer, code and end date exactly as the provider states them, linked to the provider's own page;</li>
<li>the day it was checked, and nothing after it ends: an ended offer drops off by itself;</li>
<li>affiliate links marked beside the link, never changing the order.</li></ul>
<p>${link('/catalog', 'Compare every plan')} · ${link('/providers', 'See the providers')}</p></div>`;

function promos(list) {
    return `<header class="hc-head"><p class="hc-eyebrow">OpenVibe.Host · hosting compared</p><h1>Hosting promotions</h1>
<p class="hc-lede">Offers running now, with their codes and end dates as the provider states them. An ended offer drops off by itself.</p></header>
${list.length ? promoCards(list) : PROMO_RULES}
${list.some((p) => p.affiliate) ? `<p class="hc-disclosure">${esc(DISCLOSURE)}</p>` : ''}
<p class="hc-links">${link('/catalog', '← Compare plans')}</p>`;
}

function discussionSection(d) {
    if (!d) return '';
    if (d.state !== 'ok') return '<section class="hc-discussion" aria-labelledby="hc-discussion-h"><h2 id="hc-discussion-h">Discussion</h2><p class="hc-dim" role="status">Discussion is unavailable right now. Reload later.</p></section>';
    const count = Number(d.thread.comment_count) || 0;
    const threadUrl = `${d.communityUrl}/c/${encodeURIComponent(d.thread.id)}`;
    const one = (c) => `<li class="hc-comment"><p class="hc-comment-meta"><strong>${esc(c.deleted ? '[deleted]' : c.display_name || 'Anonymous')}</strong>${Number.isFinite(Date.parse(c.created_at)) ? ` · <time datetime="${esc(c.created_at)}">${esc(new Date(c.created_at).toLocaleDateString('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }))}</time>` : ''}</p><p>${c.deleted ? 'This comment was deleted.' : esc(c.message || '').replace(/\n/g, '<br>')}</p>${Array.isArray(c.replies) && c.replies.length ? `<ol>${c.replies.map(one).join('')}</ol>` : ''}</li>`;
    return `<section class="hc-discussion" aria-labelledby="hc-discussion-h"><h2 id="hc-discussion-h">Discussion <span class="hc-dim">(${count})</span></h2>
<p class="hc-dim">Comments are hosted by ${out(d.communityUrl, 'OpenVibe.Community')}.</p>
${d.comments.length ? `<ol class="hc-comments">${d.comments.map(one).join('')}</ol>` : '<p class="hc-dim">No comments yet.</p>'}
<p>${d.thread.visibility === 'locked' ? 'This thread is locked.' : out(threadUrl, 'Join the discussion on OpenVibe.Community', { cls: 'button hc-button-quiet' })}</p></section>`;
}

// Members' reviews live on OpenVibe.Reviews: its /review page finds the provider there (or adds it) and opens the form;
// /everywhere opens other review sites' own searches for the name. Host fetches nothing from either.
function reviewsSection(p) {
    const registrar = !p.plans.length && p.domains;
    const write = `${REVIEWS_URL}/review?kind=${registrar ? 'service' : 'hosting'}&name=${encodeURIComponent(p.name)}`;
    const elsewhere = `${REVIEWS_URL}/everywhere?q=${encodeURIComponent(p.name)}&kind=${registrar ? 'company' : 'hosting'}`;
    return `<section class="hc-reviews" aria-labelledby="hc-reviews-h"><h2 id="hc-reviews-h">Reviews</h2>
<p>Used ${esc(p.name)}? Review it on OpenVibe.Reviews, where reviews come from signed-in members, or see what other review sites say about it.</p>
<p class="hc-more">${out(write, `Review ${esc(p.name)}`, { cls: 'button' })} ${out(elsewhere, 'Other review sites →')}</p></section>`;
}

function provider(p, discussion = null, extra = '') {
    const cheapest = p.plans.length ? p.plans.reduce((m, x) => (Number(x.price_monthly) < Number(m.price_monthly) ? x : m), p.plans[0]) : null;
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog', 'Catalog')} / ${link('/catalog/providers', 'Providers')}</nav>
<header class="hc-head hc-head-row">
<div><h1>${esc(p.name)}</h1>${p.description ? `<p class="hc-lede">${esc(p.description)}</p>` : ''}
<p class="hc-facts">${p.plans.length || !p.domains ? `${p.plans.length} plan${p.plans.length === 1 ? '' : 's'} listed` : ''}${cheapest ? ` · from <strong>${esc(money(cheapest.price_monthly, cheapest.currency))}</strong>/mo` : ''}${p.domains ? `${p.plans.length ? ' · ' : ''}${link(`/catalog/domains?registrar=${encodeURIComponent(p.slug)}&sort=tld`, `${p.domains.toLocaleString('en')} domain endings priced`)}` : ''}${p.homepage_url ? ` · ${out(p.homepage_url, esc(new URL(p.homepage_url).hostname))}` : ''}</p></div>
${visit(p)}
</header>
${p.plans.length ? planTable(p.plans, { caption: `${p.name}'s plans, lowest price first`, showProvider: false }) : p.domains ? `<p class="hc-more">${link(`/catalog/domains?registrar=${encodeURIComponent(p.slug)}&sort=tld`, `See ${esc(p.name)}'s domain prices →`, 'button')}</p>` : '<div class="hc-empty"><p>No plan of this provider is listed right now.</p></div>'}
${extra}
${reviewsSection(p)}
${discussionSection(discussion)}
<h2>Promotions</h2>
${promoCards(p.promos, { showProvider: false })}
${p.affiliate_url || p.promos.some((x) => x.affiliate) ? `<p class="hc-disclosure">${esc(DISCLOSURE)}</p>` : ''}`;
}

function plan(p, discussion = null, { baseUrl = '', watchUrl = '', extra = '' } = {}) {
    const spec = [
        ['vCPU', p.vcpu == null ? null : num(p.vcpu)], ['RAM', bytesMb(p.ram_mb)],
        ['Disk', p.disk_gb == null ? null : `${sizeGb(p.disk_gb)}${p.disk_type ? ` ${p.disk_type.toUpperCase()}` : ''}`],
        ['Transfer', transfer(p)], ['Port', p.port_mbps == null ? null : `${num(p.port_mbps)} Mbps`], ['IPv4', p.ipv4 == null ? null : num(p.ipv4)],
        ['Locations', p.locations && p.locations.length ? p.locations.join(', ') : null], ['Kind', kindName(p.kind)],
    ];
    const value = [['Per vCPU', money(p.price_per_vcpu, p.currency)], ['Per GB of RAM', money(p.price_per_gb_ram, p.currency)], ['Per GB of disk', money(p.price_per_gb_disk, p.currency, 3)]];
    const trend = p.price_trend;
    const chart = trendFigure(trend, { title: 'Monthly price over time', seriesName: 'Monthly price' }) || trendSummary(trend);
    const history = p.price_history.length
        ? `<details class="hc-history-fold"><summary>Every change (${p.price_history.length})</summary><ol class="hc-history">${p.price_history.map((h) => `<li><time datetime="${esc(day(Number(h.observed_at)))}">${esc(day(Number(h.observed_at)))}</time> ${esc(money(h.price_monthly_before, h.currency) || h.price_monthly_before)} → <strong>${esc(money(h.price_monthly_after, h.currency) || h.price_monthly_after)}</strong></li>`).join('')}</ol></details>`
        : '';
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog', 'Catalog')} / ${link(`/catalog/providers/${encodeURIComponent(p.provider_slug)}`, esc(p.provider_name))}</nav>
<header class="hc-head"><p class="hc-eyebrow">${esc(p.provider_name)} · ${esc(kindName(p.kind))}</p><h1>${esc(p.name)}</h1></header>
<div class="hc-plan">
<section class="hc-price-card" aria-label="Price">
<p class="hc-big">${esc((() => { const price = Number(p.price_monthly); return (Number.isFinite(price) && price > 0) ? money(price, p.currency) : 'price not stated'; })())}<span>/month</span></p>
${p.price_hourly != null ? `<p class="hc-dim">${esc(money(p.price_hourly, p.currency, 4))} an hour</p>` : ''}
${p.setup_fee != null && Number(p.setup_fee) > 0 ? `<p class="hc-dim">Setup fee ${esc(money(p.setup_fee, p.currency))}</p>` : ''}
<p class="hc-checked-line">Checked <strong>${esc(day(p.checked_at) || 'unknown')}</strong> · ${out(p.source_url, 'source')}</p>
${visit(p)}
</section>
<section aria-labelledby="hc-spec-h"><h2 id="hc-spec-h">What you get</h2><dl class="hc-spec">${spec.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${or(v)}</dd></div>`).join('')}</dl></section>
<section aria-labelledby="hc-value-h"><h2 id="hc-value-h">Value</h2><dl class="hc-spec">${value.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${or(v)}</dd></div>`).join('')}</dl></section>
</div>
<h2>Price history</h2>
${chart}
${history}
${baseUrl && watchUrl ? `<p class="hc-watch">${out(`${watchUrl}/watches/new?${new URLSearchParams({ template: 'json', url: `${baseUrl}/api/v1/catalog/plans/${p.id}`, value_path: 'plan.price_monthly', op: 'changed', name: `${p.provider_name} ${p.name} price` })}`, 'Tell me when this price changes', { cls: 'button hc-button-quiet' })} <span class="hc-dim">with OpenVibe.Watch, free</span></p>` : ''}
${extra}
${discussionSection(discussion)}
${p.affiliate_url ? `<p class="hc-disclosure">${esc(DISCLOSURE)}</p>` : ''}
<p class="hc-links">${link('/catalog', '← Compare plans')}</p>`;
}

// Offers (server/catalog/offers.js): headlines from LowEndSpirit's Offers board, each with the cheapest
// price per month or year its headline (or the post's opening) states, and that price a month.
const OFFER_SORTS = [['new', 'Newest'], ['price', 'Cheapest a month']];
const OFFER_CURRENCIES = [['', 'Any currency'], ['USD', 'USD ($)'], ['EUR', 'EUR (€)'], ['GBP', 'GBP (£)']];
const daysAgo = (iso, now) => Math.floor((now - Date.parse(iso)) / 86400000);
function offerItem(o, now) {
    const age = daysAgo(o.published_at, now);
    const monthly = o.price_period === 'year' ? money(o.price_monthly, o.price_currency) : null;
    const price = o.price_text
        ? `<p class="hc-offer-price"><strong>${esc(o.price_text)}</strong>${monthly ? `<span>${esc(monthly)} a month</span>` : ''}${o.price_from === 'post' ? '<span>stated in the post</span>' : ''}</p>`
        : '<p class="hc-offer-price">Price in the post</p>';
    const when = `<time datetime="${esc(o.published_at)}">${esc(day(o.published_at))}</time>`;
    return `<li class="hc-offer">${price}
<div class="hc-offer-body"><h3><a href="${esc(o.url)}" rel="nofollow ugc noopener">${esc(o.title)}</a></h3>
<p class="hc-offer-meta">${esc(o.source)}${o.poster ? ` · posted by ${esc(o.poster)}` : ''} · ${when}${age > 30 ? ` <span class="hc-chip" title="Offers often end; the post says whether this one still runs">${age} days old</span>` : ''}</p></div></li>`;
}
function offers({ result, query = {}, now = Date.now() }) {
    const q = query || {};
    const list = result.offers;
    const filtered = ['currency', 'max_monthly', 'source', 'priced'].some((k) => q[k]);
    const next = result.next_cursor ? `<p class="hc-more">${link(`/catalog/offers?${new URLSearchParams({ ...q, cursor: result.next_cursor })}`, 'Next 50 offers →', 'button hc-button-quiet')}</p>` : '';
    return `<header class="hc-head"><p class="hc-eyebrow">OpenVibe.Host · hosting compared</p><h1>Hosting offers</h1>
<p class="hc-lede">What providers post on LowEndSpirit's Offers board, with the price each headline states and that price a month. Sort by the monthly price within one currency; nothing is converted.</p></header>
<form class="hc-filters" method="get" action="/catalog/offers" role="search" aria-label="Filter hosting offers">
${select('sort', 'Sort by', OFFER_SORTS, q.sort || 'new')}
${select('currency', 'Currency', OFFER_CURRENCIES, q.currency)}
${input('max_monthly', 'Max a month', q.max_monthly, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="Any"')}
<label class="hc-check"><input type="checkbox" name="priced" value="1"${q.priced === '1' ? ' checked' : ''}> <span>Only with a stated price</span></label>
<div class="hc-filter-actions"><button type="submit">Show offers</button> <a href="/catalog/offers" class="hc-reset">Reset</a></div>
</form>
${list.length ? `<ol class="hc-offers" aria-label="${list.length}${result.next_cursor ? '+' : ''} offers">${list.map((o) => offerItem(o, now)).join('')}</ol>`
        : filtered ? `<div class="hc-empty"><p><strong>No offer matches these filters.</strong></p><p>${link('/catalog/offers', 'Clear the filters')} or widen one of them.</p></div>`
            : '<div class="hc-empty"><p><strong>No offer in the last 120 days.</strong></p><p>LowEndSpirit\'s Offers board is read every hour.</p></div>'}
${next}
<section class="hc-method" aria-labelledby="hc-offers-method-h"><h2 id="hc-offers-method-h">How offers are read</h2><ul>
<li><strong>From the board's own feed.</strong> LowEndSpirit's Offers board, where providers post their offers, through OpenVibe.Sources. Each headline links to its post, which has the details and the final word.</li>
<li><strong>The price as stated.</strong> The cheapest "per month" or "per year" price the headline states, or the post's opening when the headline states none. A yearly price is shown a month too (divided by 12). A price without a period is not read.</li>
<li><strong>Dated.</strong> Every offer shows the day it was posted; one older than 30 days is marked, and offers older than ${MAX_AGE_DAYS} days drop off.</li>
<li><strong>Not for sale.</strong> The order comes only from the sort you pick. No provider pays to be listed here.</li>
</ul></section>
<p class="hc-links">${link('/catalog', '← Compare plans')} · ${link('/catalog/promos', 'Current promotions')}</p>`;
}

/** JSON-LD for the catalog pages (only indexable pages carry it; renderPage drops it otherwise). */
const planUrl = (base, p) => `${base}/catalog/plans/${encodeURIComponent(p.id)}`;
const jsonLd = {
    front(base, plans) {
        return [
            seo.jsonLd.website({ name: 'OpenVibe.Host', url: `${base}/`, description: 'Hosting plans compared: price per month, per vCPU and per GB, every price dated and sourced.' }),
            seo.jsonLd.itemList('Lowest monthly hosting prices', plans.slice(0, 8).map((p) => ({ name: `${p.provider_name} ${p.name}`, url: planUrl(base, p) })), { url: `${base}/catalog` }),
        ];
    },
    catalog(base, plans) {
        return [seo.jsonLd.itemList('Hosting plans', plans.map((p) => ({ name: `${p.provider_name} ${p.name}`, url: planUrl(base, p) })), { url: `${base}/catalog` })];
    },
    plan(base, p) {
        const price = Number(p.price_monthly);
        const url = planUrl(base, p);
        return [
            seo.jsonLd.breadcrumbs([{ name: 'Catalog', url: `${base}/catalog` }, { name: p.provider_name, url: `${base}/catalog/providers/${encodeURIComponent(p.provider_slug)}` }, { name: p.name, url }]),
            // One Product node for the plan's own page: the page's own heading is the plan's name,
            // the page names the provider (so it is the brand), and the price it shows is the monthly
            // price as a number. The plan is on sale only while it is active, so that is its availability.
            seo.jsonLd.product({
                name: p.name, url, brand: { '@type': 'Brand', name: p.provider_name },
                description: [p.vcpu != null ? `${Number(p.vcpu)} vCPU` : null, bytesMb(p.ram_mb) ? `${bytesMb(p.ram_mb)} RAM` : null, sizeGb(p.disk_gb) ? `${sizeGb(p.disk_gb)} disk` : null].filter(Boolean).join(', ') || undefined,
                offers: (Number.isFinite(price) && price > 0) ? { '@type': 'Offer', price, priceCurrency: p.currency, url, availability: 'https://schema.org/InStock',
                    priceSpecification: { '@type': 'UnitPriceSpecification', price, priceCurrency: p.currency, unitText: 'MONTH' } } : undefined,
            }),
        ];
    },
};

/** The front page of the hosting comparison. */
/** A plan as a small card: what it is, its size and its price, opening the plan's page. */
const planCard = (label, p, note = '') => {
    const price = Number(p.price_monthly);
    const priceLabel = Number.isFinite(price) && price > 0 ? money(price, p.currency) : 'price not stated';
    return `<li>${link(`/catalog/plans/${encodeURIComponent(p.id)}`, `<span class="hh-label">${esc(label)}</span><b>${esc(p.provider_name)} ${esc(p.name)}</b><span class="hh-spec">${[p.vcpu != null ? `${num(p.vcpu)} vCPU` : null, bytesMb(p.ram_mb), sizeGb(p.disk_gb) ? `${sizeGb(p.disk_gb)} disk` : null].filter(Boolean).map(esc).join(' · ')}</span><span class="hh-price"><strong>${esc(priceLabel)}</strong>${priceLabel === 'price not stated' ? '' : ' a month'}${note ? ` · ${esc(note)}` : ''}</span>`)}</li>`;
};
const perUnit = (p, by) => {
    const price = Number(p.price_monthly);
    const n = by === 'vcpu' ? Number(p.vcpu) : by === 'ram' ? Number(p.ram_mb) / 1024 : Number(p.disk_gb);
    return Number.isFinite(price) && n > 0 ? money(price / n, p.currency) : null;
};

/** The home's extra blocks, each from real rows and left out when it has none. */
function frontMore({ counts = [], tiers = [], value = {}, providerCards = [], faq = [] }) {
    const stat = counts.filter((c) => c && c.value);
    const best = [['vcpu', 'Lowest price per vCPU', 'per vCPU'], ['ram', 'Lowest price per GB of RAM', 'per GB of RAM'], ['disk', 'Lowest price per GB of disk', 'per GB of disk']]
        .filter(([k]) => value[k]).map(([k, label, unit]) => { const u = perUnit(value[k], k); return planCard(label, value[k], u ? `${u} ${unit}` : ''); });
    return {
        stats: stat.length ? `<div class="sc-sec hh-stats-wrap"><ul class="hh-stats" aria-label="OpenVibe.Host in numbers">${stat.map((c) => `<li>${link(c.href, `<b>${esc(c.value.toLocaleString('en'))}</b><span>${esc(c.label)}</span>`)}</li>`).join('')}</ul></div>` : '',
        sizes: tiers.length ? `<section class="sc-sec" aria-labelledby="hh-sizes"><h2 id="hh-sizes">The lowest price for each size</h2><p class="sc-lede">The cheapest plan with at least this much memory, from every provider in the catalog.</p><ul class="hh-cards">${tiers.map((x) => planCard(`${x.gb} GB of RAM or more`, x.plan)).join('')}</ul></section>` : '',
        value: best.length ? `<section class="sc-sec" aria-labelledby="hh-value"><h2 id="hh-value">The most for your money</h2><p class="sc-lede">The same catalog sorted by what each dollar buys. ${link('/catalog?sort=price_per_gb_ram', 'Sort every plan this way')}.</p><ul class="hh-cards">${best.join('')}</ul></section>` : '',
        providers: providerCards.length ? `<section class="sc-sec" aria-labelledby="hh-providers"><h2 id="hh-providers">Providers compared</h2><p class="sc-lede">Each provider's plans in the catalog, from its lowest monthly price, with the day it was last checked.</p><ul class="hh-cards">${providerCards.map((v) => `<li>${link(`/catalog/providers/${encodeURIComponent(v.slug)}`, `<b>${esc(v.name)}</b><span class="hh-spec">${esc(`${v.plans} plan${v.plans === 1 ? '' : 's'}`)}${v.domains ? esc(` · ${v.domains.toLocaleString('en')} domain endings`) : ''}</span><span class="hh-price">from <strong>${esc(money(v.from_price, v.currency))}</strong> a month</span>${v.last_checked ? `<span class="hh-spec">checked ${esc(day(v.last_checked))}</span>` : ''}`)}</li>`).join('')}</ul></section>` : '',
        faq: faq.length ? `<section class="sc-sec" aria-labelledby="hh-faq"><h2 id="hh-faq">Questions people ask</h2><div class="hh-faq">${faq.map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join('')}</div></section>` : '',
    };
}

function front({ plans, providers, promos: live, stats, offers: recent = [], domains: domainSection = '', changes = [], more = {}, now = Date.now() }) {
    const extra = frontMore(more);
    const changeRail = changes.length ? `<section class="sc-sec hh-changes" aria-labelledby="hh-changes-h"><h2 id="hh-changes-h">Price changes this month</h2>
<p class="hc-dim">Plans and domain endings whose stated price moved this month, biggest move first. Nothing is converted between currencies.</p>
<ol class="hc-changes">${changes.map((c) => {
        const up = c.after > c.before;
        const move = c.percent == null ? (up ? 'Rose' : 'Dropped') : `${up ? 'Rose' : 'Dropped'} ${Math.abs(c.percent)}%`;
        return `<li><a href="${esc(c.href)}"><span class="hc-change-what"><b>${esc(c.name)}</b><span class="hc-dim">${esc(c.kind)}</span></span><span class="hc-change-move ${up ? 'is-up' : 'is-down'}"><span class="hc-change-word">${move}</span><span class="hc-change-prices">${esc(money(c.before, c.currency) || String(c.before))} → ${esc(money(c.after, c.currency) || String(c.after))}</span></span></a></li>`;
    }).join('')}</ol></section>` : '';
    // The aside is servers: a plan with vCPU and a price above zero. Per-GB storage (archive tiers at $0.00 a GB once
    // rounded) read as four free "plans" at the top of the home (2026-11-01).
    const servers = plans.filter((p) => p.vcpu != null && Number(p.price_monthly) > 0);
    const aside = servers.length ? `<div class="hc-aside" aria-label="Lowest prices right now">
<p class="hc-aside-h">Cheapest servers right now</p>
<ol>${servers.slice(0, 5).map((p) => `<li>${link(`/catalog/plans/${encodeURIComponent(p.id)}`, `<span>${esc(p.provider_name)} <b>${esc(p.name)}</b></span><span class="hc-aside-spec">${[p.vcpu != null ? `${num(p.vcpu)} vCPU` : null, bytesMb(p.ram_mb)].filter(Boolean).map(esc).join(' · ')}</span><strong>${esc(money(p.price_monthly, p.currency))}</strong>`)}</li>`).join('')}</ol>
<p class="hc-aside-foot">Checked ${esc(day(stats.lastChecked) || '')} · ${link('/catalog', 'compare all')}</p>
</div>` : '';
    return showcase.hero({
        eyebrow: 'OpenVibe.Host · hosting compared · alpha',
        title: 'Hosting, compared honestly.',
        accent: 'Every price dated and sourced.',
        lede: 'Cloud, VPS and dedicated plans from providers\' official APIs, side by side: price per month, per vCPU and per GB, the day each price was checked and a link to where it came from. Sorted by what you ask for, never by who pays.',
        // Two, so they sit side by side on a phone; the latest offers have their own section and link below.
        actions: [{ label: 'Compare plans', href: '/catalog', primary: true }, { label: 'Domain prices', href: '/catalog/domains' }],
        note: stats.plans ? `${stats.plans} plans from ${stats.providers} provider${stats.providers === 1 ? '' : 's'} so far. More providers join as their sources are checked.` : 'The catalog is filling up: providers join as their official sources are checked and enabled.',
        aside: aside ? { html: aside } : undefined,
    }) + extra.stats + changeRail + `<section class="sc-sec hh-short" aria-labelledby="hh-cheapest"><h2 id="hh-cheapest">The lowest monthly prices</h2>${planTable(plans.slice(0, 8), { caption: 'Lowest price first' })}
<p class="hc-more">${link('/catalog', 'Filter and sort every plan →', 'button')}</p></section>`
    + extra.sizes + extra.value + extra.providers
    + domainSection
    + '<section class="sc-sec" id="why" aria-labelledby="hh-why"><details class="hh-fold"><summary><h2 id="hh-why">Why this comparison is different</h2><span>sourced, dated, ranked by you</span></summary>'
    + showcase.features({
        items: [
            { icon: 'ov:check', title: 'Straight from the source', text: 'Every provider in one table, from their own APIs or from staff entries that name the page they came from. Nothing is estimated.' },
            { icon: 'ov:history', title: 'Dated prices', text: 'Every price shows when it was last checked, and price changes are kept as a history per plan.' },
            { icon: 'ov:search', title: 'Compare what matters', text: 'Sort by monthly price, or by price per vCPU, per GB of RAM or per GB of disk. Unknown stays unknown.' },
            { icon: 'ov:account', title: 'Ranked by you', text: 'No paid placement. Affiliate links are marked, disclosed beside the link, and never change the order.' },
        ],
    }) + '</details></section>' + (recent.length ? `<section class="sc-sec"><h2>Latest hosting offers</h2><ol class="hc-offers">${recent.slice(0, 6).map((o) => offerItem(o, now)).join('')}</ol><p class="hc-more">${link('/catalog/offers', 'Every offer, by price or date →')}</p></section>` : '')
    + (live.length ? `<section class="sc-sec"><h2>Promotions running now</h2>${promoCards(live.slice(0, 3))}<p class="hc-more">${link('/catalog/promos', 'All promotions →')}</p></section>` : '')
    + extra.faq
    + `<p class="hc-own">Want to host a site with OpenVibe? ${link('https://openvibe.space', 'Visit OpenVibe.Space')}.</p>`;
}

module.exports = { front, catalog, providerList, provider, plan, promos, offers, planTable, jsonLd, DISCLOSURE, money, bytesMb, sizeGb, trendFigure, tldTrendFigure, trendSummary, day };
