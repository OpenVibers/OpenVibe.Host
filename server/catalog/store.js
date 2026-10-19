'use strict';

const { newId } = require('../ids');
const { ApiError } = require('../http/errors');
const { mapItem } = require('./mapping');
const offerFeed = require('./offers');
const domainFeed = require('./domains');
const { createDomainStore } = require('./domain-store');
const invalid = (message) => { throw new ApiError(422, 'host.catalog.invalid', message); };
const missing = () => { throw new ApiError(404, 'host.catalog.not_found', 'Catalog entry not found'); };
const fields = {
    providers: ['slug', 'name', 'homepage_url', 'description', 'affiliate_url', 'affiliate_note', 'status'],
    plans: ['provider_id', 'external_id', 'name', 'kind', 'vcpu', 'ram_mb', 'disk_gb', 'disk_type', 'bandwidth_gb', 'unmetered', 'port_mbps', 'ipv4', 'locations', 'currency', 'price_monthly', 'price_hourly', 'setup_fee', 'source_url', 'checked_at', 'status'],
    promos: ['provider_id', 'title', 'details', 'code', 'url', 'affiliate', 'starts_at', 'ends_at', 'status'],
};
const kinds = new Set(['cloud', 'vps', 'dedicated', 'storage', 'domain']);
const currencies = new Set(Intl.supportedValuesOf('currency'));
const url = (v) => { try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };
const clean = (type, input, current, now) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Body must be an object');
    for (const k of Object.keys(input)) if (!fields[type].includes(k)) invalid(`Unknown field: ${k}`);
    const v = { ...(current || {}), ...input };
    const strings = type === 'providers' ? ['slug', 'name', 'homepage_url', 'description', 'affiliate_url', 'affiliate_note', 'status'] : type === 'plans' ? ['provider_id', 'external_id', 'name', 'kind', 'disk_type', 'currency', 'source_url', 'status'] : ['provider_id', 'title', 'details', 'code', 'url', 'status'];
    for (const k of strings) if (v[k] != null && (typeof v[k] !== 'string' || v[k].length > 2048 || (v[k] === '' && !['description', 'affiliate_note', 'details', 'code'].includes(k)))) invalid(`Invalid ${k}`);
    const required = type === 'providers' ? ['slug', 'name', 'homepage_url'] : type === 'plans' ? ['provider_id', 'external_id', 'name', 'kind', 'currency', 'price_monthly', 'source_url'] : ['provider_id', 'title', 'url'];
    for (const k of required) if (v[k] == null || v[k] === '') invalid(`${k} is required`);
    for (const k of ['homepage_url', 'affiliate_url', 'source_url', 'url']) if (v[k] != null && !url(v[k])) invalid(`${k} must be an HTTP(S) URL`);
    if (type === 'providers' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug)) invalid('Invalid slug');
    if (type === 'plans') {
        if (!kinds.has(v.kind) || !currencies.has(v.currency)) invalid('Invalid kind or currency');
        for (const k of ['vcpu', 'ram_mb', 'disk_gb', 'bandwidth_gb', 'port_mbps', 'ipv4', 'price_monthly', 'price_hourly', 'setup_fee']) {
            if (input[k] != null && (typeof input[k] !== 'number' || !Number.isFinite(input[k]) || input[k] < 0)) invalid(`${k} must be a non-negative number`);
        }
        if (v.ipv4 != null && !Number.isInteger(v.ipv4)) invalid('ipv4 must be an integer');
        if (v.disk_type != null && !['ssd', 'nvme', 'hdd'].includes(v.disk_type)) invalid('Invalid disk type');
        if (v.unmetered != null && typeof v.unmetered !== 'boolean') invalid('unmetered must be boolean');
        if (v.locations != null && (!Array.isArray(v.locations) || v.locations.some((x) => typeof x !== 'string' || !x))) invalid('Invalid locations');
        if (v.checked_at == null || (current && input.price_monthly !== undefined && input.checked_at === undefined)) v.checked_at = now;
        if (v.price_monthly >= 100000000 || (v.price_hourly != null && v.price_hourly >= 1000000) || (v.setup_fee != null && v.setup_fee >= 100000000)) invalid('Price is outside catalog range');
        if (!Number.isSafeInteger(v.checked_at) || v.checked_at < 0) invalid('Invalid checked_at');
        if (v.status != null && !['active', 'gone', 'hidden'].includes(v.status)) invalid('Invalid status');
    }
    if (type === 'providers' && v.status != null && !['active', 'hidden'].includes(v.status)) invalid('Invalid status');
    if (type === 'promos') {
        if (v.status != null && !['active', 'ended', 'hidden'].includes(v.status)) invalid('Invalid status');
        if (v.affiliate != null && typeof v.affiliate !== 'boolean') invalid('affiliate must be boolean');
        for (const k of ['starts_at', 'ends_at']) if (v[k] != null && !Number.isSafeInteger(v[k])) invalid(`Invalid ${k}`);
        if (v.starts_at != null && v.ends_at != null && v.starts_at > v.ends_at) invalid('Promo end precedes start');
    }
    return v;
};
function createCatalog({ store, community = null, log = console, indexnow = null, baseUrl = null }) {
    // IndexNow (openvibe-shared/indexnow): a page the catalog pull adds or reprices is sent to search engines with the
    // sitemap, in one batch. Only these transitions announce; a plan re-checked at the same price does not.
    const announce = (paths) => {
        if (!paths.length || !indexnow || !indexnow.enabled || !baseUrl) return;
        indexnow.pingSoon([...paths, '/sitemap.xml'].map((path) => `${baseUrl}${path}`));
    };
    const db = store.db;
    const domains = createDomainStore({ store, announce });
    const listeners = [];
    const changed = (type) => { for (const fn of listeners) { try { fn(type); } catch { /* a listener never breaks a save */ } } };
    let visibilityQueue = Promise.resolve();
    const open = async (type, id) => {
        const sql = type === 'provider'
            ? 'SELECT 1 FROM catalog_providers WHERE id = ? AND status = \'active\''
            : 'SELECT 1 FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.id = ? AND p.status = \'active\' AND v.status = \'active\'';
        return Boolean(await db.prepare(sql).get(id));
    };
    const idle = () => new Promise((resolve) => setImmediate(() => visibilityQueue.then(resolve)));
    const providerOut = (p) => ({ ...p, affiliate_rel: p.affiliate_url ? 'sponsored nofollow noopener' : null, affiliate_disclosure: p.affiliate_url ? 'OpenVibe may earn a commission from links marked as affiliate links; it never changes the order or the prices shown.' : null });
    const promoOut = (p) => ({ ...p, status: p.status === 'active' && p.ends_at != null && Number(p.ends_at) <= store.now() ? 'ended' : p.status, affiliate_rel: p.affiliate ? 'sponsored nofollow noopener' : null, affiliate_disclosure: p.affiliate ? 'OpenVibe may earn a commission from links marked as affiliate links; it never changes the order or the prices shown.' : null });
    const get = async (type, id) => { const row = await db.prepare(`SELECT * FROM catalog_${type} WHERE id = ?`).get(id); if (!row) missing(); return type === 'promos' ? promoOut(row) : row; };
    const save = async (type, input, id, actor) => { const out = await saveTx(type, input, id, actor); changed(type); return out; };
    const saveTx = async (type, input, id, actor) => await db.tx(async () => {
        const current = id ? await get(type, id) : null;
        const watched = [];
        if (community && community.enabled && current && ['providers', 'plans'].includes(type)) {
            const kind = type === 'providers' ? 'provider' : 'plan';
            watched.push({ kind, id, was: await open(kind, id) });
            if (kind === 'provider') {
                for (const row of await db.prepare('SELECT id FROM catalog_plans WHERE provider_id = ?').all(id)) watched.push({ kind: 'plan', id: row.id, was: await open('plan', row.id) });
            }
        }
        if (current && type === 'plans' && current.origin === 'sources' && Object.keys(input).some((k) => k !== 'status')) invalid('Only status can be edited on a Sources plan');
        const now = store.now();
        const v = clean(type, input, current, now);
        if (type !== 'providers' && !(await db.prepare('SELECT 1 FROM catalog_providers WHERE id = ?').get(v.provider_id))) invalid('Unknown provider');
        const cols = fields[type].filter((k) => v[k] !== undefined);
        if (type === 'providers' && await db.prepare('SELECT id FROM catalog_providers WHERE slug = ? AND id <> ?').get(v.slug, id || '')) invalid('Provider slug already exists');
        if (type === 'plans' && await db.prepare('SELECT id FROM catalog_plans WHERE provider_id = ? AND external_id = ? AND id <> ?').get(v.provider_id, v.external_id, id || '')) invalid('Plan external_id already exists for provider');
        if (id) {
            if (type === 'plans' && v.price_monthly !== undefined && (Number(current.price_monthly) !== Number(v.price_monthly) || current.currency !== v.currency)) {
                await db.prepare('INSERT INTO catalog_price_changes (plan_id, observed_at, currency, price_monthly_before, price_monthly_after) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(id, v.checked_at, v.currency, current.price_monthly, v.price_monthly);
            }
            await db.prepare(`UPDATE catalog_${type} SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((k) => v[k]), now, id);
            if (watched.length) db.afterCommit(() => {
                visibilityQueue = visibilityQueue.then(async () => {
                    for (const item of watched) {
                        const isOpen = await open(item.kind, item.id);
                        if (isOpen !== item.was) await community.setThreadVisibility(item.kind, item.id, isOpen ? 'public' : 'hidden');
                    }
                }).catch((err) => log.warn(`[Host] catalog discussion sync failed: ${err.message}`));
            });
            return await get(type, id);
        }
        const key = { providers: 'catalogProvider', plans: 'catalogPlan', promos: 'catalogPromo' }[type];
        const newKey = newId(key, now);
        const extras = type === 'plans' ? { origin: 'staff', first_seen_at: now, last_seen_at: now } : {};
        const all = { ...Object.fromEntries(cols.map((k) => [k, v[k]])), ...extras, id: newKey, created_by: actor, created_at: now, updated_at: now };
        await db.prepare(`INSERT INTO catalog_${type} (${Object.keys(all).join(', ')}) VALUES (${Object.keys(all).map(() => '?').join(', ')})`).run(...Object.values(all));
        return await get(type, newKey);
    });
    async function applyItem(item, t = db) {
        if (item && offerFeed.SOURCES[item.source_key]) return await applyOffer(item, t);
        if (item && domainFeed.SOURCES[item.source_key]) return await domains.apply(item, t);
        if (item && item.removed) return 'hold';
        const v = mapItem(item);
        if (!v) return 'hold';
        const now = store.now();
        let p = await t.prepare('SELECT * FROM catalog_providers WHERE slug = ?').get(v.provider.slug);
        const fresh = [];
        if (!p) {
            const id = newId('catalogProvider', now);
            await t.prepare('INSERT INTO catalog_providers (id, slug, name, homepage_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, v.provider.slug, v.provider.name, v.provider.homepage_url, 'active', now, now);
            p = { id, status: 'active' };
            fresh.push(`/catalog/providers/${encodeURIComponent(v.provider.slug)}`);
        }
        const old = await t.prepare('SELECT * FROM catalog_plans WHERE provider_id = ? AND external_id = ?').get(p.id, v.external_id);
        const cols = ['name', 'kind', 'vcpu', 'ram_mb', 'disk_gb', 'disk_type', 'bandwidth_gb', 'unmetered', 'port_mbps', 'ipv4', 'locations', 'currency', 'price_monthly', 'price_hourly', 'source_key', 'source_item_id', 'source_url', 'checked_at'];
        if (old) {
            if (old.origin !== 'sources' || v.checked_at < Number(old.checked_at)) return 'hold';
            if (Number(old.price_monthly) !== v.price_monthly || old.currency !== v.currency) {
                if (old.status === 'active' && p.status === 'active') fresh.push(`/catalog/plans/${encodeURIComponent(old.id)}`);
                await t.prepare('INSERT INTO catalog_price_changes (plan_id, observed_at, currency, price_monthly_before, price_monthly_after) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(old.id, v.checked_at, v.currency, old.price_monthly, v.price_monthly);
            }
            await t.prepare(`UPDATE catalog_plans SET ${cols.map((k) => `${k} = ?`).join(', ')}, last_seen_at = ?, updated_at = ? WHERE id = ?`).run(...cols.map((k) => v[k]), v.checked_at, now, old.id);
        } else {
            const all = { id: newId('catalogPlan', now), provider_id: p.id, external_id: v.external_id, ...Object.fromEntries(cols.map((k) => [k, v[k]])), origin: 'sources', first_seen_at: v.first_seen_at, last_seen_at: v.checked_at, status: 'active', created_at: now, updated_at: now };
            await t.prepare(`INSERT INTO catalog_plans (${Object.keys(all).join(', ')}) VALUES (${Object.keys(all).map(() => '?').join(', ')})`).run(...Object.values(all));
            if (p.status === 'active') fresh.push(`/catalog/plans/${encodeURIComponent(all.id)}`, `/catalog/providers/${encodeURIComponent(v.provider.slug)}`);
        }
        announce([...new Set(fresh)]);
        return 'applied';
    }
    // An offer post from a feed (server/catalog/offers.js): inserted once, its headline and stated price updated when
    // the source revises it; a post the source removed is hidden.
    async function applyOffer(item, t) {
        const now = store.now();
        if (item.removed) {
            const r = await t.prepare("UPDATE catalog_offers SET status = 'hidden', updated_at = ? WHERE source_key = ? AND external_id = ? AND status = 'active'").run(now, item.source_key, String(item.identity || ''));
            return r.changes ? 'removed' : 'hold';
        }
        const v = offerFeed.mapOffer(item, now);
        if (!v) return 'hold';
        const cols = ['source_item_id', 'title', 'poster', 'url', 'published_at', 'price_text', 'price_from', 'price_amount', 'price_currency', 'price_period', 'price_monthly', 'checked_at'];
        const old = await t.prepare('SELECT id, checked_at FROM catalog_offers WHERE source_key = ? AND external_id = ?').get(v.source_key, v.external_id);
        if (old) {
            if (v.checked_at < Number(old.checked_at)) return 'hold';
            await t.prepare(`UPDATE catalog_offers SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((k) => v[k]), now, old.id);
        } else {
            const all = { id: newId('catalogOffer', now), source_key: v.source_key, external_id: v.external_id, ...Object.fromEntries(cols.map((k) => [k, v[k]])), status: 'active', first_seen_at: v.first_seen_at, created_at: now, updated_at: now };
            await t.prepare(`INSERT INTO catalog_offers (${Object.keys(all).join(', ')}) VALUES (${Object.keys(all).map(() => '?').join(', ')})`).run(...Object.values(all));
            announce(['/catalog/offers']);
        }
        return 'applied';
    }
    // Offers posted in the last MAX_AGE_DAYS: newest first, or by the stated monthly price within one currency.
    const OFFER_SORTS = { new: 'published_at DESC, id DESC', price: 'price_monthly ASC, published_at DESC, id DESC' };
    const offerOut = (o) => ({ ...o, source: offerFeed.SOURCES[o.source_key] ? offerFeed.SOURCES[o.source_key].label : o.source_key, published_at: new Date(Number(o.published_at)).toISOString(), checked_at: new Date(Number(o.checked_at)).toISOString(),
        price_amount: o.price_amount == null ? null : Number(o.price_amount), price_monthly: o.price_monthly == null ? null : Number(o.price_monthly) });
    async function offers(query = {}) {
        const allowed = new Set(['sort', 'currency', 'max_monthly', 'source', 'priced', 'cursor']);
        for (const k of Object.keys(query)) if (!allowed.has(k) || Array.isArray(query[k])) invalid(`Invalid filter: ${k}`);
        const sort = query.sort || 'new';
        if (!OFFER_SORTS[sort]) invalid('Invalid sort');
        if (sort === 'price' && !query.currency) invalid('Sorting by price needs a currency: prices are never converted');
        const args = [store.now() - offerFeed.MAX_AGE_DAYS * 86400000];
        let where = "status = 'active' AND published_at >= ?";
        if (query.currency) {
            if (!['USD', 'EUR', 'GBP'].includes(query.currency)) invalid('Invalid currency');
            where += ' AND price_currency = ?'; args.push(query.currency);
        }
        if (query.source) {
            if (!offerFeed.SOURCES[query.source]) invalid('Invalid source');
            where += ' AND source_key = ?'; args.push(query.source);
        }
        if (query.priced === '1') where += ' AND price_monthly IS NOT NULL';
        if (query.max_monthly != null && query.max_monthly !== '') {
            const n = Number(query.max_monthly);
            if (!Number.isFinite(n) || n < 0) invalid('Invalid max_monthly');
            where += ' AND price_monthly <= ?'; args.push(n);
        }
        const offset = query.cursor == null ? 0 : Number(query.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) invalid('Invalid cursor');
        let rows;
        try {
            rows = await db.prepare(`SELECT * FROM catalog_offers WHERE ${where} ORDER BY ${OFFER_SORTS[sort]} LIMIT 51 OFFSET ${offset}`).all(...args);
        } catch (err) {
            // Before migration 0009 has applied (a held contract migration holds it), there are no offers yet.
            if (err && err.code === '42P01') return { offers: [], next_cursor: null };
            throw err;
        }
        return { offers: rows.slice(0, 50).map(offerOut), next_cursor: rows.length > 50 ? String(offset + 50) : null };
    }
    const planOut = (p) => ({ ...p, affiliate_rel: p.affiliate_url ? 'sponsored nofollow noopener' : null, affiliate_disclosure: p.affiliate_url ? 'OpenVibe may earn a commission from links marked as affiliate links; it never changes the order or the prices shown.' : null, price_per_vcpu: p.vcpu > 0 ? Number(p.price_monthly) / Number(p.vcpu) : null, price_per_gb_ram: p.ram_mb > 0 ? Number(p.price_monthly) * 1024 / Number(p.ram_mb) : null, price_per_gb_disk: p.disk_gb > 0 ? Number(p.price_monthly) / Number(p.disk_gb) : null, checked_at: new Date(Number(p.checked_at)).toISOString() });
    async function plans(query = {}) {
        const allowed = new Set(['kind', 'min_vcpu', 'min_ram_mb', 'min_disk_gb', 'max_price', 'currency', 'location', 'provider', 'sort', 'cursor']);
        for (const k of Object.keys(query)) if (!allowed.has(k) || Array.isArray(query[k])) invalid(`Invalid filter: ${k}`);
        const sort = query.sort || 'price';
        const sorts = { price: 'p.price_monthly', price_per_vcpu: 'p.price_monthly / NULLIF(p.vcpu, 0)', price_per_gb_ram: 'p.price_monthly * 1024 / NULLIF(p.ram_mb, 0)', price_per_gb_disk: 'p.price_monthly / NULLIF(p.disk_gb, 0)', checked_at: 'p.checked_at' };
        if (!sorts[sort]) invalid('Invalid sort');
        const args = [query.currency || 'USD'];
        if (!currencies.has(args[0])) invalid('Invalid currency');
        let where = "p.status = 'active' AND v.status = 'active' AND p.currency = ?";
        for (const [key, col] of [['kind', 'p.kind'], ['provider', 'v.slug'], ['location', 'p.locations']]) if (query[key]) { where += key === 'location' ? ' AND ? = ANY(p.locations)' : ` AND ${col} = ?`; args.push(query[key]); }
        if (query.kind && !kinds.has(query.kind)) invalid('Invalid kind');
        for (const [key, col] of [['min_vcpu', 'p.vcpu'], ['min_ram_mb', 'p.ram_mb'], ['min_disk_gb', 'p.disk_gb'], ['max_price', 'p.price_monthly']]) if (query[key] != null) {
            const n = Number(query[key]); if (!Number.isFinite(n) || n < 0 || query[key] === '') invalid(`Invalid ${key}`);
            where += ` AND ${col} ${key === 'max_price' ? '<=' : '>='} ?`; args.push(n);
        }
        const offset = query.cursor == null ? 0 : Number(query.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) invalid('Invalid cursor');
        // Affiliation is deliberately absent from the ORDER BY expression.
        const rows = await db.prepare(`SELECT p.*, v.slug AS provider_slug, v.name AS provider_name, v.affiliate_url, v.affiliate_note FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE ${where} ORDER BY ${sorts[sort]} ASC NULLS LAST, p.id ASC LIMIT 51 OFFSET ${offset}`).all(...args);
        return { plans: rows.slice(0, 50).map(planOut), next_cursor: rows.length > 50 ? String(offset + 50) : null };
    }
    async function plan(id) {
        const p = await db.prepare("SELECT p.*, v.slug AS provider_slug, v.name AS provider_name, v.homepage_url, v.affiliate_url, v.affiliate_note FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.id = ? AND p.status = 'active' AND v.status = 'active'").get(id);
        if (!p) missing();
        return { ...planOut(p), price_history: (await db.prepare('SELECT * FROM catalog_price_changes WHERE plan_id = ? ORDER BY observed_at DESC').all(id)).map((h) => ({ ...h, checked_at: new Date(Number(h.observed_at)).toISOString(), source_url: p.source_url })) };
    }
    async function providers(slug) {
        if (slug) {
            const p = await db.prepare("SELECT * FROM catalog_providers WHERE slug = ? AND status = 'active'").get(slug);
            if (!p) missing();
            return { ...providerOut(p), plans: (await db.prepare("SELECT * FROM catalog_plans WHERE provider_id = ? AND status = 'active' ORDER BY price_monthly, id").all(p.id)).map((row) => planOut({ ...row, provider_name: p.name, provider_slug: p.slug, affiliate_url: p.affiliate_url, affiliate_note: p.affiliate_note })), promos: await promos(p.id), domains: await domains.countFor(p.id) };
        }
        return (await db.prepare("SELECT * FROM catalog_providers WHERE status = 'active' ORDER BY name, id").all()).map(providerOut);
    }
    async function promos(providerId) {
        const now = store.now();
        const rows = providerId ? await db.prepare("SELECT p.*, v.affiliate_note FROM catalog_promos p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.provider_id = ? AND p.status = 'active' AND (p.starts_at IS NULL OR p.starts_at <= ?) AND (p.ends_at IS NULL OR p.ends_at > ?) ORDER BY p.id").all(providerId, now, now) : await db.prepare("SELECT p.*, v.name AS provider_name, v.affiliate_note FROM catalog_promos p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.status = 'active' AND v.status = 'active' AND (p.starts_at IS NULL OR p.starts_at <= ?) AND (p.ends_at IS NULL OR p.ends_at > ?) ORDER BY p.id").all(now, now);
        return rows.map(promoOut);
    }
    /** The currencies active plans are priced in (the filter's choices), USD first. */
    async function currenciesInUse() {
        const rows = await db.prepare("SELECT DISTINCT p.currency FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.status = 'active' AND v.status = 'active' ORDER BY p.currency").all();
        return ['USD', ...rows.map((r) => r.currency).filter((c) => c !== 'USD')];
    }
    /** Active plans, providers with an active plan, and the newest check (the front page's line). */
    async function stats() {
        const r = await db.prepare("SELECT COUNT(*) AS plans, COUNT(DISTINCT p.provider_id) AS providers, MAX(p.checked_at) AS last FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.status = 'active' AND v.status = 'active'").get();
        return { plans: Number(r.plans) || 0, providers: Number(r.providers) || 0, lastChecked: r.last == null ? null : Number(r.last) };
    }
    /** Every public plan for a form's choice list: provider by name, then cheapest first. */
    async function planChoices() { return await db.prepare("SELECT p.id, p.name, v.name AS provider_name, v.slug AS provider_slug FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.status = 'active' AND v.status = 'active' ORDER BY v.name, p.price_monthly, p.id LIMIT 1000").all(); }
    // Each public plan with the day its price was last checked, and its provider's slug, so the sitemap can date pages.
    async function sitemapPlans() { return await db.prepare("SELECT p.id, p.checked_at, v.slug AS provider_slug FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.status = 'active' AND v.status = 'active' ORDER BY p.id").all(); }
    return { onChange: (fn) => listeners.push(fn), save, get, applyItem, domains, plans, plan, providers, promos, offers, currencies: currenciesInUse, stats, sitemapPlans, planChoices, discussionIdle: idle, all: async (type) => { const rows = await db.prepare(`SELECT * FROM catalog_${type} ORDER BY created_at DESC, id DESC LIMIT 200`).all(); return type === 'promos' ? rows.map(promoOut) : rows; } };
}
module.exports = { createCatalog };
