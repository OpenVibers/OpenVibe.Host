'use strict';

/**
 * The hosting catalog in OpenVibe.Search (openvibe-publishing/search-feed): one search.index-document@1 per public
 * catalog page, a plan (/catalog/plans/<id>), a provider (/catalog/providers/<slug>) or a domain ending
 * (/catalog/domains/<tld>, id tld-<tld>), sent as
 * host.index_document.upserted|deleted through Host's events outbox (contracts 0.145.0). A hidden or gone entry, or a
 * plan of a hidden provider, becomes a tombstone. The document says what the page shows: the plan's specifications,
 * its monthly price and currency and the day it was checked; a plan from OpenVibe.Sources names its source as
 * provenance (authorship imported), a staff entry its source URL.
 *
 * Search is brought level by a sweep (the sequencer, host_index_revisions, gives an unchanged document its old
 * revision, so a quiet sweep sends nothing): after each catalog pull, a minute after boot, hourly, and shortly after
 * a staff change.
 *
 *   const search = createCatalogSearch({ config, store, outbox, log });
 *   await search.sweep();   search.sweepSoon();
 */
const { createSearchFeed } = require('openvibe-publishing/search-feed');
const { money, bytesMb, sizeGb } = require('../render/catalog');
const { displayTld, tldKind, KIND_LABEL } = require('./domains');
const { isStorageRate, isStale, freshCutoff } = require('./pricing');

const KINDS = { cloud: 'Cloud', vps: 'VPS', dedicated: 'Dedicated server', storage: 'Storage', domain: 'Domain' };
const day = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString().slice(0, 10) : null);
const iso = (ms) => (Number.isFinite(Number(ms)) && ms != null ? new Date(Number(ms)).toISOString() : null);

function planDocument(row) {
    // A per-GB storage rate is not a monthly price: the document names it as the rate per GB it is.
    const storage = isStorageRate(row);
    const price = money(row.price_monthly, row.currency, storage ? 4 : 2);
    const priceText = price ? (storage ? `${price} a GB a month` : `${price} a month`) : null;
    const transfer = row.unmetered ? 'unmetered transfer' : (sizeGb(row.bandwidth_gb) ? `${sizeGb(row.bandwidth_gb)} transfer` : null);
    const specs = [row.vcpu != null ? `${Number(row.vcpu)} vCPU` : null, bytesMb(row.ram_mb) ? `${bytesMb(row.ram_mb)} RAM` : null,
        sizeGb(row.disk_gb) ? `${sizeGb(row.disk_gb)}${row.disk_type ? ` ${row.disk_type.toUpperCase()}` : ''} disk` : null, transfer].filter(Boolean);
    const checked = day(row.checked_at);
    const stale = isStale(row.checked_at, Date.now()) ? ', stale' : '';
    return {
        listed: row.status === 'active' && row.provider_status === 'active',
        title: `${row.provider_name} ${row.name}${priceText ? `: ${priceText}` : ''}`,
        summary: [...specs, checked ? `checked ${checked}${stale}` : null].filter(Boolean).join(' · ') || null,
        body: [`${row.provider_name} ${row.name}`, KINDS[row.kind] || row.kind, specs.join(', '),
            priceText ? `${priceText} (${row.currency})${checked ? `, checked ${checked}${stale}` : ''}` : null,
            Array.isArray(row.locations) && row.locations.length ? `Locations: ${row.locations.join(', ')}` : null].filter(Boolean).join('\n'),
        facets: { provider: row.provider_slug, kind: row.kind, currency: row.currency },
        authorship: { mode: row.origin === 'sources' ? 'imported' : 'human' },
        provenance: row.source_url ? [{
            service: row.origin === 'sources' ? 'sources' : 'host', type: row.origin === 'sources' ? 'item' : 'staff_entry',
            id: String(row.origin === 'sources' && row.source_item_id ? row.source_item_id : row.id).slice(0, 128),
            label: row.origin === 'sources' ? (row.source_key || 'OpenVibe.Sources') : `${row.provider_name} pricing`,
            url: row.source_url, retrievedAt: iso(row.checked_at),
        }] : [],
        publishedAt: iso(row.first_seen_at || row.created_at),
        updatedAt: iso(row.checked_at || row.updated_at),
    };
}

function providerDocument(row) {
    const count = Number(row.plan_count) || 0;
    const from = row.from_price != null ? money(row.from_price, row.from_currency) : null;
    return {
        listed: row.status === 'active' && count > 0,
        title: `${row.name} hosting plans and prices`,
        summary: `${count} plan${count === 1 ? '' : 's'}${from ? ` from ${from} a month` : ''}`,
        body: [row.name, row.description, `${count} plan${count === 1 ? '' : 's'} in the catalog${from ? `, from ${from} a month` : ''}`].filter(Boolean).join('\n'),
        facets: { provider: row.slug },
        authorship: { mode: 'human' },
        publishedAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
    };
}

// A domain ending's page (/catalog/domains/<tld>): the cheapest prices at any registrar (USD), dated, with the cheapest
// registrar's price list as provenance. id tld-<tld> (contracts 0.199.0).
function tldDocument(row) {
    const shown = displayTld(row.tld);
    const reg = row.register != null ? money(row.register, 'USD') : null;
    const ren = row.renew != null ? money(row.renew, 'USD') : null;
    const five = row.five_year != null ? money(row.five_year, 'USD') : null;
    const n = Number(row.registrars) || 0;
    const checked = day(row.checked_at);
    return {
        listed: n > 0,
        title: `${shown} domain prices${reg ? `: from ${reg} the first year` : ''}`,
        summary: [ren ? `renews from ${ren} a year` : null, five ? `five years from ${five}` : null, `${n} registrar${n === 1 ? '' : 's'}`, checked ? `checked ${checked}` : null].filter(Boolean).join(' · '),
        body: [`${shown} domain names`, `Kind: ${KIND_LABEL[tldKind(row.tld)] || 'Generic'}`,
            reg ? `First year from ${reg}` : null, ren ? `Renewal from ${ren} a year` : null, five ? `Five years from ${five}` : null,
            `Listed by ${n} registrar${n === 1 ? '' : 's'}${checked ? `, checked ${checked}` : ''}`].filter(Boolean).join('\n'),
        facets: { kind: tldKind(row.tld), ...(row.register != null ? { register_usd: Number(row.register) } : {}), ...(row.renew != null ? { renew_usd: Number(row.renew) } : {}) },
        authorship: { mode: 'imported' },
        provenance: row.source_url ? [{ service: 'host', type: 'registrar_price_list', id: String(row.id).slice(0, 128), label: `${row.registrar || 'Registrar'} price list`, url: row.source_url, retrievedAt: iso(row.checked_at) }] : [],
        publishedAt: iso(row.first_seen_at),
        updatedAt: iso(row.checked_at),
    };
}

function createCatalogSearch({ config, store, outbox, log = console }) {
    const db = store.db;
    const feed = createSearchFeed({
        owner: 'host', db, outbox, baseUrl: config.baseUrl, now: store.now, log,
        types: {
            plan: {
                page: (row) => `/catalog/plans/${row.id}`,
                document: planDocument,
                rows: (after, limit) => db.many(`SELECT p.*, v.slug AS provider_slug, v.name AS provider_name, v.status AS provider_status
                    FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.id > $1 ORDER BY p.id LIMIT $2`, [after, limit]),
                exists: async (ids) => (await db.many('SELECT id FROM catalog_plans WHERE id = ANY($1)', [ids])).map((r) => r.id),
            },
            provider: {
                page: (row) => `/catalog/providers/${row.slug}`,
                document: providerDocument,
                // The cheapest active plan is named in its own currency (the first currency by price, USD first when tied).
                rows: (after, limit) => db.many(`SELECT v.*,
                        (SELECT COUNT(*) FROM catalog_plans p WHERE p.provider_id = v.id AND p.status = 'active') AS plan_count,
                        (SELECT p.price_monthly FROM catalog_plans p WHERE p.provider_id = v.id AND p.status = 'active' AND p.price_monthly > 0 AND NOT (p.kind = 'storage' AND p.name ILIKE '%(per gb/month)%') AND p.checked_at >= $3 ORDER BY (p.currency <> 'USD'), p.price_monthly, p.id LIMIT 1) AS from_price,
                        (SELECT p.currency FROM catalog_plans p WHERE p.provider_id = v.id AND p.status = 'active' AND p.price_monthly > 0 AND NOT (p.kind = 'storage' AND p.name ILIKE '%(per gb/month)%') AND p.checked_at >= $3 ORDER BY (p.currency <> 'USD'), p.price_monthly, p.id LIMIT 1) AS from_currency
                    FROM catalog_providers v WHERE v.id > $1 ORDER BY v.id LIMIT $2`, [after, limit, freshCutoff(store.now())]),
                exists: async (ids) => (await db.many('SELECT id FROM catalog_providers WHERE id = ANY($1)', [ids])).map((r) => r.id),
            },
            tld: {
                page: (row) => `/catalog/domains/${encodeURIComponent(row.tld)}`,
                document: tldDocument,
                // Every ending any registrar has listed: its active prices aggregated (none active: unlisted, a tombstone).
                rows: (after, limit) => db.many(`SELECT 'tld-' || p.tld AS id, p.tld,
                        MIN(p.register) FILTER (WHERE p.status = 'active' AND v.status = 'active') AS register,
                        MIN(p.renew) FILTER (WHERE p.status = 'active' AND v.status = 'active') AS renew,
                        MIN(COALESCE(p.register, p.renew) + 4 * COALESCE(p.renew, p.register)) FILTER (WHERE p.status = 'active' AND v.status = 'active') AS five_year,
                        COUNT(*) FILTER (WHERE p.status = 'active' AND v.status = 'active') AS registrars,
                        MAX(p.checked_at) AS checked_at, MIN(p.first_seen_at) AS first_seen_at,
                        (array_agg(p.source_url ORDER BY p.register NULLS LAST))[1] AS source_url,
                        (array_agg(v.name ORDER BY p.register NULLS LAST))[1] AS registrar
                    FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id
                    GROUP BY p.tld HAVING 'tld-' || p.tld > $1 ORDER BY 1 LIMIT $2`, [after, limit]),
                exists: async (ids) => (await db.many("SELECT DISTINCT 'tld-' || tld AS id FROM catalog_tld_prices WHERE 'tld-' || tld = ANY($1)", [ids])).map((r) => r.id),
            },
        },
    });

    let soon = null;
    async function sweep() {
        const res = await feed.sweep();
        for (const [type, r] of Object.entries(res)) {
            if (r.sent || r.removed || r.failed) log.log(`[Search] catalog ${type}: ${r.sent} sent, ${r.removed} removed, ${r.failed} failed of ${r.seen}`);
        }
        if (outbox && outbox.kick) outbox.kick().catch(() => {});
        return res;
    }
    /** A staff change: one sweep a few seconds later (several edits in a row share it). */
    function sweepSoon(delayMs = 5000) {
        if (soon) return;
        soon = setTimeout(() => { soon = null; sweep().catch((err) => log.warn(`[Search] catalog sweep failed: ${(err && err.message) || err}`)); }, delayMs);
        if (soon.unref) soon.unref();
    }
    return { feed, sweep, sweepSoon, planDocument, providerDocument, tldDocument };
}

module.exports = { createCatalogSearch, planDocument, providerDocument, tldDocument };
