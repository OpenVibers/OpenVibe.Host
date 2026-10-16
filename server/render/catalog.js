'use strict';

/**
 * The hosting catalog's pages (plan T20 step 3: hosting compared). Server-rendered, complete without JavaScript:
 *
 *   front({ plans, providers, promos, stats, domains })   the front page of openvibe.host (`domains`: render/domains.js frontSection)
 *   catalog({ result, query, providers })        /catalog: the filterable comparison table
 *   provider(p)                                  /catalog/providers/:slug
 *   plan(p)                                      /catalog/plans/:id
 *   promos(list)                                 /catalog/promos
 *   offers({ result, query })                    /catalog/offers: what providers post on LowEndTalk and LowEndBox
 *
 * Every price shows when it was checked and links where it came from; an unknown value reads "Unknown", never 0;
 * affiliate links carry rel="sponsored nofollow noopener" with the provider's own disclosure beside them, and the
 * order never depends on affiliation (the store sorts; nothing here reorders).
 */
const showcase = require('openvibe-shared/showcase');
const seo = require('openvibe-shared/seo');
const { esc } = require('./layout');
const { MAX_AGE_DAYS } = require('../catalog/offers');

const DISCLOSURE = 'OpenVibe may earn a commission from links marked as affiliate links; it never changes the order or the prices shown.';
const KINDS = [['', 'Any kind'], ['cloud', 'Cloud'], ['vps', 'VPS'], ['dedicated', 'Dedicated'], ['storage', 'Storage'], ['domain', 'Domains']];
const SORTS = [['price', 'Lowest price'], ['price_per_vcpu', 'Price per vCPU'], ['price_per_gb_ram', 'Price per GB of RAM'], ['price_per_gb_disk', 'Price per GB of disk'], ['checked_at', 'Recently checked']];
const RAM = [['', 'Any RAM'], ['1024', '1 GB+'], ['2048', '2 GB+'], ['4096', '4 GB+'], ['8192', '8 GB+'], ['16384', '16 GB+'], ['32768', '32 GB+'], ['65536', '64 GB+']];

const UNKNOWN = '<span class="hc-unknown" title="The source does not state it">Unknown</span>';
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
    const m = money(p.price_monthly, p.currency);
    return `<span class="hc-price">${m ? esc(m) : UNKNOWN}</span><span class="hc-per">/mo</span>`;
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

function provider(p, discussion = null) {
    const cheapest = p.plans.length ? p.plans.reduce((m, x) => (Number(x.price_monthly) < Number(m.price_monthly) ? x : m), p.plans[0]) : null;
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog', 'Catalog')} / ${link('/catalog/providers', 'Providers')}</nav>
<header class="hc-head hc-head-row">
<div><h1>${esc(p.name)}</h1>${p.description ? `<p class="hc-lede">${esc(p.description)}</p>` : ''}
<p class="hc-facts">${p.plans.length || !p.domains ? `${p.plans.length} plan${p.plans.length === 1 ? '' : 's'} listed` : ''}${cheapest ? ` · from <strong>${esc(money(cheapest.price_monthly, cheapest.currency))}</strong>/mo` : ''}${p.domains ? `${p.plans.length ? ' · ' : ''}${link(`/catalog/domains?registrar=${encodeURIComponent(p.slug)}&sort=tld`, `${p.domains.toLocaleString('en')} domain endings priced`)}` : ''}${p.homepage_url ? ` · ${out(p.homepage_url, esc(new URL(p.homepage_url).hostname))}` : ''}</p></div>
${visit(p)}
</header>
${p.plans.length ? planTable(p.plans, { caption: `${p.name}'s plans, lowest price first`, showProvider: false }) : p.domains ? `<p class="hc-more">${link(`/catalog/domains?registrar=${encodeURIComponent(p.slug)}&sort=tld`, `See ${esc(p.name)}'s domain prices →`, 'button')}</p>` : '<div class="hc-empty"><p>No plan of this provider is listed right now.</p></div>'}
${discussionSection(discussion)}
<h2>Promotions</h2>
${promoCards(p.promos, { showProvider: false })}
${p.affiliate_url || p.promos.some((x) => x.affiliate) ? `<p class="hc-disclosure">${esc(DISCLOSURE)}</p>` : ''}`;
}

function plan(p, discussion = null, { baseUrl = '', watchUrl = '' } = {}) {
    const spec = [
        ['vCPU', p.vcpu == null ? null : num(p.vcpu)], ['RAM', bytesMb(p.ram_mb)],
        ['Disk', p.disk_gb == null ? null : `${sizeGb(p.disk_gb)}${p.disk_type ? ` ${p.disk_type.toUpperCase()}` : ''}`],
        ['Transfer', transfer(p)], ['Port', p.port_mbps == null ? null : `${num(p.port_mbps)} Mbps`], ['IPv4', p.ipv4 == null ? null : num(p.ipv4)],
        ['Locations', p.locations && p.locations.length ? p.locations.join(', ') : null], ['Kind', kindName(p.kind)],
    ];
    const value = [['Per vCPU', money(p.price_per_vcpu, p.currency)], ['Per GB of RAM', money(p.price_per_gb_ram, p.currency)], ['Per GB of disk', money(p.price_per_gb_disk, p.currency, 3)]];
    const history = p.price_history.length
        ? `<ol class="hc-history">${p.price_history.map((h) => `<li><time datetime="${esc(day(Number(h.observed_at)))}">${esc(day(Number(h.observed_at)))}</time> ${esc(money(h.price_monthly_before, h.currency) || h.price_monthly_before)} → <strong>${esc(money(h.price_monthly_after, h.currency) || h.price_monthly_after)}</strong></li>`).join('')}</ol>`
        : '<p class="hc-dim">No price change recorded since the catalog first saw this plan.</p>';
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog', 'Catalog')} / ${link(`/catalog/providers/${encodeURIComponent(p.provider_slug)}`, esc(p.provider_name))}</nav>
<header class="hc-head"><p class="hc-eyebrow">${esc(p.provider_name)} · ${esc(kindName(p.kind))}</p><h1>${esc(p.name)}</h1></header>
<div class="hc-plan">
<section class="hc-price-card" aria-label="Price">
<p class="hc-big">${esc(money(p.price_monthly, p.currency) || '')}<span>/month</span></p>
${p.price_hourly != null ? `<p class="hc-dim">${esc(money(p.price_hourly, p.currency, 4))} an hour</p>` : ''}
${p.setup_fee != null && Number(p.setup_fee) > 0 ? `<p class="hc-dim">Setup fee ${esc(money(p.setup_fee, p.currency))}</p>` : ''}
<p class="hc-checked-line">Checked <strong>${esc(day(p.checked_at) || 'unknown')}</strong> · ${out(p.source_url, 'source')}</p>
${visit(p)}
</section>
<section aria-labelledby="hc-spec-h"><h2 id="hc-spec-h">What you get</h2><dl class="hc-spec">${spec.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${or(v)}</dd></div>`).join('')}</dl></section>
<section aria-labelledby="hc-value-h"><h2 id="hc-value-h">Value</h2><dl class="hc-spec">${value.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${or(v)}</dd></div>`).join('')}</dl></section>
</div>
<h2>Price history</h2>
${history}
${baseUrl && watchUrl ? `<p class="hc-watch">${out(`${watchUrl}/watches/new?${new URLSearchParams({ template: 'json', url: `${baseUrl}/api/v1/catalog/plans/${p.id}`, value_path: 'plan.price_monthly', op: 'changed', name: `${p.provider_name} ${p.name} price` })}`, 'Tell me when this price changes', { cls: 'button hc-button-quiet' })} <span class="hc-dim">with OpenVibe.Watch, free</span></p>` : ''}
${discussionSection(discussion)}
${p.affiliate_url ? `<p class="hc-disclosure">${esc(DISCLOSURE)}</p>` : ''}
<p class="hc-links">${link('/catalog', '← Compare plans')}</p>`;
}

// Offers (server/catalog/offers.js): headlines from LowEndTalk's Offers board and LowEndBox, each with the cheapest
// price per month or year its headline (or the post's opening) states, and that price a month.
const OFFER_SORTS = [['new', 'Newest'], ['price', 'Cheapest a month']];
const OFFER_CURRENCIES = [['', 'Any currency'], ['USD', 'USD ($)'], ['EUR', 'EUR (€)'], ['GBP', 'GBP (£)']];
const OFFER_SOURCES = [['', 'Both boards'], ['lowendtalk-offers', 'LowEndTalk Offers'], ['lowendbox-posts', 'LowEndBox']];
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
<p class="hc-lede">What providers post on LowEndTalk's Offers board and LowEndBox, with the price each headline states and that price a month. Sort by the monthly price within one currency; nothing is converted.</p></header>
<form class="hc-filters" method="get" action="/catalog/offers" role="search" aria-label="Filter hosting offers">
${select('sort', 'Sort by', OFFER_SORTS, q.sort || 'new')}
${select('currency', 'Currency', OFFER_CURRENCIES, q.currency)}
${input('max_monthly', 'Max a month', q.max_monthly, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="Any"')}
${select('source', 'Board', OFFER_SOURCES, q.source)}
<label class="hc-check"><input type="checkbox" name="priced" value="1"${q.priced === '1' ? ' checked' : ''}> <span>Only with a stated price</span></label>
<div class="hc-filter-actions"><button type="submit">Show offers</button> <a href="/catalog/offers" class="hc-reset">Reset</a></div>
</form>
${list.length ? `<ol class="hc-offers" aria-label="${list.length}${result.next_cursor ? '+' : ''} offers">${list.map((o) => offerItem(o, now)).join('')}</ol>`
        : filtered ? `<div class="hc-empty"><p><strong>No offer matches these filters.</strong></p><p>${link('/catalog/offers', 'Clear the filters')} or widen one of them.</p></div>`
            : '<div class="hc-empty"><p><strong>No offer has arrived yet.</strong></p><p>Offers arrive as LowEndTalk\'s and LowEndBox\'s feeds are read, every hour.</p></div>'}
${next}
<section class="hc-method" aria-labelledby="hc-offers-method-h"><h2 id="hc-offers-method-h">How offers are read</h2><ul>
<li><strong>From the boards' own feeds.</strong> LowEndTalk's Offers board, where providers post their offers, and LowEndBox's offer posts, through OpenVibe.Sources. Each headline links to its post, which has the details and the final word.</li>
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
        return [
            seo.jsonLd.breadcrumbs([{ name: 'Catalog', url: `${base}/catalog` }, { name: p.provider_name, url: `${base}/catalog/providers/${encodeURIComponent(p.provider_slug)}` }, { name: p.name, url: planUrl(base, p) }]),
            seo.jsonLd.product({
                name: `${p.provider_name} ${p.name}`, url: planUrl(base, p), brand: { '@type': 'Brand', name: p.provider_name },
                description: [p.vcpu != null ? `${Number(p.vcpu)} vCPU` : null, bytesMb(p.ram_mb) ? `${bytesMb(p.ram_mb)} RAM` : null, sizeGb(p.disk_gb) ? `${sizeGb(p.disk_gb)} disk` : null].filter(Boolean).join(', ') || undefined,
                offers: Number.isFinite(price) ? { '@type': 'Offer', price: price.toFixed(2), priceCurrency: p.currency, url: p.source_url, availability: 'https://schema.org/InStock',
                    priceSpecification: { '@type': 'UnitPriceSpecification', price: price.toFixed(2), priceCurrency: p.currency, unitText: 'MONTH' } } : undefined,
            }),
        ];
    },
};

/** The front page of the hosting comparison. */
function front({ plans, providers, promos: live, stats, offers: recent = [], domains: domainSection = '', now = Date.now() }) {
    const aside = plans.length ? `<div class="hc-aside" aria-label="Lowest prices right now">
<p class="hc-aside-h">Lowest monthly prices right now</p>
<ol>${plans.slice(0, 5).map((p) => `<li>${link(`/catalog/plans/${encodeURIComponent(p.id)}`, `<span>${esc(p.provider_name)} <b>${esc(p.name)}</b></span><span class="hc-aside-spec">${[p.vcpu != null ? `${num(p.vcpu)} vCPU` : null, bytesMb(p.ram_mb)].filter(Boolean).map(esc).join(' · ')}</span><strong>${esc(money(p.price_monthly, p.currency))}</strong>`)}</li>`).join('')}</ol>
<p class="hc-aside-foot">Checked ${esc(day(stats.lastChecked) || '')} · ${link('/catalog', 'compare all')}</p>
</div>` : '';
    return showcase.hero({
        eyebrow: 'OpenVibe.Host · hosting compared · alpha',
        title: 'Hosting, compared honestly.',
        accent: 'Every price dated and sourced.',
        lede: 'Cloud, VPS and dedicated plans from providers\' official APIs, side by side: price per month, per vCPU and per GB, the day each price was checked and a link to where it came from. Sorted by what you ask for, never by who pays.',
        actions: [{ label: 'Compare plans', href: '/catalog', primary: true }, { label: 'Domain prices', href: '/catalog/domains' }, { label: 'Latest offers', href: '/catalog/offers' }],
        note: stats.plans ? `${stats.plans} plans from ${stats.providers} provider${stats.providers === 1 ? '' : 's'} so far. More providers join as their sources are checked.` : 'The catalog is filling up: providers join as their official sources are checked and enabled.',
        aside: aside ? { html: aside } : undefined,
    }) + `<section class="sc-sec">${planTable(plans.slice(0, 8), { caption: 'Lowest price first' })}
<p class="hc-more">${link('/catalog', 'Filter and sort every plan →', 'button')}</p></section>`
    + domainSection
    + showcase.features({
        id: 'why',
        title: 'Why this comparison is different',
        items: [
            { icon: 'ov:check', title: 'Straight from the source', text: 'Every provider in one table, from their own APIs or from staff entries that name the page they came from. Nothing is estimated.' },
            { icon: 'ov:history', title: 'Dated prices', text: 'Every price shows when it was last checked, and price changes are kept as a history per plan.' },
            { icon: 'ov:search', title: 'Compare what matters', text: 'Sort by monthly price, or by price per vCPU, per GB of RAM or per GB of disk. Unknown stays unknown.' },
            { icon: 'ov:account', title: 'Ranked by you', text: 'No paid placement. Affiliate links are marked, disclosed beside the link, and never change the order.' },
        ],
    }) + (recent.length ? `<section class="sc-sec"><h2>Latest hosting offers</h2><ol class="hc-offers">${recent.slice(0, 6).map((o) => offerItem(o, now)).join('')}</ol><p class="hc-more">${link('/catalog/offers', 'Every offer, by price or date →')}</p></section>` : '')
    + (live.length ? `<section class="sc-sec"><h2>Promotions running now</h2>${promoCards(live.slice(0, 3))}<p class="hc-more">${link('/catalog/promos', 'All promotions →')}</p></section>` : '')
    + `<p class="hc-own">Want to host a site with OpenVibe? ${link('https://openvibe.space', 'Visit OpenVibe.Space')}.</p>`;
}

module.exports = { front, catalog, providerList, provider, plan, promos, offers, planTable, jsonLd, DISCLOSURE, money, bytesMb, sizeGb };
