'use strict';
/**
 * Domain prices in the catalog (migrations/0011_catalog_domains.sql, server/catalog/domains.js): one row per registrar
 * and TLD, applied from Sources items; the TLD table, a TLD's page and the cheapest price for a list of endings.
 *
 * Until 0011 has applied (a held contract migration holds every later one) the tables do not exist: reads answer
 * empty and `ready()` is false, so pages leave the price sections out rather than fail.
 */
const { newId } = require('../ids');
const { ApiError } = require('../http/errors');
const domains = require('./domains');

const invalid = (message) => { throw new ApiError(422, 'host.catalog.invalid', message); };
const PAGE = 100;
const POPULAR_RANK = `CASE p.tld ${domains.POPULAR.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} ELSE ${domains.POPULAR.length} END`;
// Five years at a registrar: the first year, then four renewals (a registrar that states only one of them uses it).
const FIVE_YEAR = '(COALESCE(p.register, p.renew) + 4 * COALESCE(p.renew, p.register))';
const SORTS = {
    popular: `MIN(${POPULAR_RANK}) ASC, p.tld ASC`,
    tld: 'p.tld ASC',
    register: 'MIN(p.register) ASC NULLS LAST, p.tld ASC',
    renew: 'MIN(p.renew) ASC NULLS LAST, p.tld ASC',
    five_year: `MIN(${FIVE_YEAR}) ASC NULLS LAST, p.tld ASC`,
};
const KINDS = {
    country: "p.tld ~ '^[a-z]{2}$'",
    generic: "position('.' in p.tld) = 0 AND p.tld !~ '^[a-z]{2}$' AND p.tld NOT LIKE 'xn--%'",
    'second-level': "position('.' in p.tld) > 0",
    internationalized: "position('.' in p.tld) = 0 AND p.tld LIKE 'xn--%'",
};
const missingTable = (err) => err && err.code === '42P01';
const n = (v) => (v == null ? null : Number(v));
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

function createDomainStore({ store, announce = () => {} }) {
    const db = store.db;
    let known = { at: 0, set: new Set() };
    let isReady = null;

    async function ready() {
        if (isReady) return true;
        const r = await db.prepare("SELECT to_regclass('catalog_tld_prices') AS t").get();
        isReady = Boolean(r && r.t);
        return isReady;
    }
    async function safe(fn, fallback) {
        try { return await fn(); } catch (err) { if (missingTable(err)) { isReady = false; return fallback; } throw err; }
    }

    async function apply(item, t = db) {
        const now = store.now();
        if (item.removed) {
            const tld = domains.normalizeTld(item.identity);
            if (!tld) return 'hold';
            const r = await t.prepare("UPDATE catalog_tld_prices SET status = 'gone', updated_at = ? WHERE source_key = ? AND tld = ? AND status = 'active'").run(now, item.source_key, tld);
            if (r.changes) announce([`/catalog/domains/${encodeURIComponent(tld)}`]);
            return r.changes ? 'removed' : 'hold';
        }
        const v = domains.mapTldPrice(item);
        if (!v) return 'hold';
        let p = await t.prepare('SELECT id, status FROM catalog_providers WHERE slug = ?').get(v.provider.slug);
        if (!p) {
            const id = newId('catalogProvider', now);
            await t.prepare('INSERT INTO catalog_providers (id, slug, name, homepage_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, v.provider.slug, v.provider.name, v.provider.homepage_url, 'active', now, now);
            p = { id, status: 'active' };
        }
        const old = await t.prepare('SELECT * FROM catalog_tld_prices WHERE provider_id = ? AND tld = ?').get(p.id, v.tld);
        const page = `/catalog/domains/${encodeURIComponent(v.tld)}`;
        if (old) {
            if (old.origin !== 'sources' || v.checked_at < Number(old.checked_at)) return 'hold';
            const moved = ['register', 'renew', 'transfer'].some((k) => n(old[k]) !== v[k]) || old.currency !== v.currency;
            if (moved) {
                await t.prepare('INSERT INTO catalog_tld_price_changes (price_id, observed_at, currency, register_before, register_after, renew_before, renew_after, transfer_before, transfer_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
                    .run(old.id, v.checked_at, v.currency, old.register, v.register, old.renew, v.renew, old.transfer, v.transfer);
            }
            // A TLD the registrar stopped selling and sells again comes back; one staff hid stays hidden.
            const status = old.status === 'gone' ? 'active' : old.status;
            await t.prepare('UPDATE catalog_tld_prices SET currency = ?, register = ?, renew = ?, transfer = ?, source_item_id = ?, source_url = ?, checked_at = ?, last_seen_at = ?, status = ?, updated_at = ? WHERE id = ?')
                .run(v.currency, v.register, v.renew, v.transfer, v.source_item_id, v.source_url, v.checked_at, v.checked_at, status, now, old.id);
            if ((moved || status !== old.status) && status === 'active' && p.status === 'active') announce([page]);
            return 'applied';
        }
        await t.prepare('INSERT INTO catalog_tld_prices (id, provider_id, tld, currency, register, renew, transfer, origin, source_key, source_item_id, source_url, checked_at, first_seen_at, last_seen_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(newId('catalogTldPrice', now), p.id, v.tld, v.currency, v.register, v.renew, v.transfer, 'sources', v.source_key, v.source_item_id, v.source_url, v.checked_at, v.first_seen_at, v.checked_at, 'active', now, now);
        known.at = 0;
        if (p.status === 'active') announce([page, '/catalog/domains']);
        return 'applied';
    }

    const tldRow = (r) => ({
        tld: r.tld, display: domains.displayTld(r.tld), kind: domains.tldKind(r.tld), currency: r.currency,
        register: n(r.register), renew: n(r.renew), transfer: n(r.transfer), five_year: n(r.five_year),
        registrars: Number(r.registrars), checked_at: iso(r.checked_at),
    });
    const ACTIVE = "p.status = 'active' AND v.status = 'active'";

    /** The TLD table: the cheapest price at any registrar for each TLD, filtered and sorted. */
    async function list(query = {}) {
        const allowed = new Set(['q', 'kind', 'sort', 'registrar', 'cursor']);
        for (const k of Object.keys(query)) if (!allowed.has(k) || Array.isArray(query[k])) invalid(`Invalid filter: ${k}`);
        const sort = query.sort || 'popular';
        if (!SORTS[sort]) invalid('Invalid sort');
        if (query.kind && !KINDS[query.kind]) invalid('Invalid kind');
        const offset = query.cursor == null || query.cursor === '' ? 0 : Number(query.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) invalid('Invalid cursor');
        const args = ['USD'];
        let where = `${ACTIVE} AND p.currency = ?`;
        if (query.q) {
            const q = domains.normalizeTld(String(query.q));
            if (!q) invalid('Type an ending such as .dev or co.uk');
            where += ' AND (p.tld = ? OR p.tld LIKE ?)'; args.push(q, `%${q}%`);
        }
        if (query.kind) where += ` AND ${KINDS[query.kind]}`;
        if (query.registrar) {
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(query.registrar))) invalid('Invalid registrar');
            where += ' AND v.slug = ?'; args.push(query.registrar);
        }
        return await safe(async () => {
            const rows = await db.prepare(`SELECT p.tld, 'USD' AS currency, MIN(p.register) AS register, MIN(p.renew) AS renew, MIN(p.transfer) AS transfer, MIN(${FIVE_YEAR}) AS five_year, COUNT(*) AS registrars, MAX(p.checked_at) AS checked_at
                FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${where} GROUP BY p.tld ORDER BY ${SORTS[sort]} LIMIT ${PAGE + 1} OFFSET ${offset}`).all(...args);
            return { tlds: rows.slice(0, PAGE).map(tldRow), next_cursor: rows.length > PAGE ? String(offset + PAGE) : null };
        }, { tlds: [], next_cursor: null });
    }

    /** One TLD: every registrar's price (cheapest first year first) and the latest price changes. */
    async function tld(input) {
        const t = domains.normalizeTld(String(input || ''));
        if (!t) throw new ApiError(404, 'host.catalog.not_found', 'Not a domain ending');
        const data = await safe(async () => {
            const rows = await db.prepare(`SELECT p.*, ${FIVE_YEAR} AS five_year, v.slug AS provider_slug, v.name AS provider_name, v.homepage_url, v.affiliate_url, v.affiliate_note
                FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${ACTIVE} AND p.tld = ? ORDER BY p.register ASC NULLS LAST, v.name, p.id`).all(t);
            const history = rows.length ? await db.prepare(`SELECT h.*, v.name AS provider_name FROM catalog_tld_price_changes h JOIN catalog_tld_prices p ON p.id = h.price_id JOIN catalog_providers v ON v.id = p.provider_id
                WHERE p.tld = ? AND ${ACTIVE} ORDER BY h.observed_at DESC LIMIT 20`).all(t) : [];
            return { rows, history };
        }, { rows: [], history: [] });
        if (!data.rows.length) throw new ApiError(404, 'host.catalog.not_found', 'No registrar price is listed for this ending');
        const prices = data.rows.map((r) => ({
            registrar: r.provider_name, registrar_slug: r.provider_slug, homepage_url: r.homepage_url, affiliate_url: r.affiliate_url, affiliate_note: r.affiliate_note,
            currency: r.currency, register: n(r.register), renew: n(r.renew), transfer: n(r.transfer), five_year: n(r.five_year),
            source_url: r.source_url, checked_at: iso(r.checked_at), first_seen_at: iso(r.first_seen_at),
        }));
        const min = (k) => prices.reduce((m, p) => (p[k] != null && (m == null || p[k] < m) ? p[k] : m), null);
        return {
            tld: t, display: domains.displayTld(t), kind: domains.tldKind(t), currency: 'USD', prices,
            cheapest: { register: min('register'), renew: min('renew'), transfer: min('transfer'), five_year: min('five_year') },
            history: data.history.map((h) => ({
                registrar: h.provider_name, observed_at: iso(h.observed_at), currency: h.currency,
                register: [n(h.register_before), n(h.register_after)], renew: [n(h.renew_before), n(h.renew_after)], transfer: [n(h.transfer_before), n(h.transfer_after)],
            })),
        };
    }

    /** The cheapest prices for a few endings (a name check's alternatives), in the order asked. */
    async function cheapest(tlds) {
        const list = [...new Set(tlds.map((x) => domains.normalizeTld(x)).filter(Boolean))].slice(0, 30);
        if (!list.length) return [];
        const rows = await safe(() => db.prepare(`SELECT p.tld, 'USD' AS currency, MIN(p.register) AS register, MIN(p.renew) AS renew, MIN(p.transfer) AS transfer, MIN(${FIVE_YEAR}) AS five_year, COUNT(*) AS registrars, MAX(p.checked_at) AS checked_at
            FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${ACTIVE} AND p.currency = 'USD' AND p.tld IN (${list.map(() => '?').join(', ')}) GROUP BY p.tld`).all(...list), []);
        const by = new Map(rows.map((r) => [r.tld, tldRow(r)]));
        return list.filter((t) => by.has(t)).map((t) => by.get(t));
    }

    /** Every TLD with a listed price (for reading what a person typed), refreshed every five minutes. */
    async function knownTlds() {
        if (store.now() - known.at < 5 * 60_000) return known.set;
        const rows = await safe(() => db.prepare(`SELECT DISTINCT p.tld FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${ACTIVE}`).all(), []);
        known = { at: store.now(), set: new Set(rows.map((r) => r.tld)) };
        return known.set;
    }

    async function stats() {
        return await safe(async () => {
            const r = await db.prepare(`SELECT COUNT(DISTINCT p.tld) AS tlds, MAX(p.checked_at) AS last FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${ACTIVE}`).get();
            const names = await db.prepare(`SELECT DISTINCT v.name FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${ACTIVE} ORDER BY v.name`).all();
            return { tlds: Number(r.tlds) || 0, registrars: names.map((x) => x.name), lastChecked: r.last == null ? null : Number(r.last) };
        }, { tlds: 0, registrars: [], lastChecked: null });
    }

    async function sitemap() {
        return await safe(() => db.prepare(`SELECT p.tld, MAX(p.checked_at) AS checked_at FROM catalog_tld_prices p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${ACTIVE} GROUP BY p.tld ORDER BY p.tld`).all(), []);
    }

    /** How many TLDs each registrar lists (a provider page's domain line). */
    async function countFor(providerId) {
        return await safe(async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM catalog_tld_prices WHERE provider_id = ? AND status = 'active'").get(providerId)).n) || 0, 0);
    }

    return { apply, list, tld, cheapest, knownTlds, stats, sitemap, countFor, ready, SORTS: Object.keys(SORTS), KINDS: Object.keys(KINDS) };
}

module.exports = { createDomainStore };
