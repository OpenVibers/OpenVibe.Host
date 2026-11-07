'use strict';
/**
 * The hosting providers whose prices need an account (the owner-setup design of 2026-11-07): DigitalOcean's Droplet
 * sizes and Hetzner Cloud's server types, read with the owner's read-only token from `host.data_sources` (the panel's
 * value, else HOST_DIGITALOCEAN_TOKEN / HOST_HETZNER_TOKEN), at use time. Without a token a feed is skipped and says so.
 *
 * Each plan becomes an item in the shape OpenVibe.Sources stores (source_key, identity, title, fields, provenance), so
 * it goes through the same mapping (server/catalog/mapping.js) and catalog.applyItem as every other price: a changed
 * price is recorded, a plan's first-seen time is kept. Nothing here is written but catalog rows; the token goes in the
 * Authorization header only and never into a log line, an error or an answer.
 *
 * test(feed, token) is the Setup tab's Test button: one read-only call (DigitalOcean's account, Hetzner's first server
 * type), answered in one line.
 */
const TIMEOUT_MS = 15_000;
const API = Object.freeze({ digitalocean: 'https://api.digitalocean.com', hetzner: 'https://api.hetzner.cloud' });

async function getJson(fetchImpl, url, token) {
    let res;
    try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        return { status: 0, json: null, error: err && err.name === 'TimeoutError' ? 'did not answer within 15 seconds' : 'could not be reached' };
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json, error: null };
}

function refusal(name, r) {
    if (r.error) return `${name} ${r.error}.`;
    const says = r.json && (r.json.message || (r.json.error && r.json.error.message)) ? String(r.json.message || r.json.error.message) : '';
    if (r.status === 401 || r.status === 403) return `${name} refused the token (${r.status})${says ? `: ${says}` : '.'}`;
    if (r.status === 429) return `${name} is limiting requests right now (429); try again later.`;
    return `${name} answered ${r.status}${says ? `: ${says}` : '.'}`;
}

/** A plan as the Sources `api` adapter would have stored it. */
function item(sourceKey, identity, title, fields, at) {
    return {
        id: `host:${sourceKey}:${identity}`, source_key: sourceKey, category: 'hosting', kind: 'plan', identity, canonical_url: null,
        title, summary: null, authors: [], published_at: null, source_updated_at: null, fields, revision: 1,
        provenance: { retrieved_at: at, first_seen_at: at, content_hash: null, raw_body_hash: null, parser_version: 'host-keyed@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null },
        removed: null,
    };
}

/** DigitalOcean: every available Droplet size (GET /v2/sizes, 200 a page). */
async function digitalOceanItems(fetchImpl, token, at) {
    const out = [];
    let url = `${API.digitalocean}/v2/sizes?per_page=200`;
    for (let page = 0; url && page < 10; page++) {
        const r = await getJson(fetchImpl, url, token);
        if (!(r.status >= 200 && r.status < 300)) throw new Error(refusal('DigitalOcean', r));
        for (const s of (r.json && Array.isArray(r.json.sizes) ? r.json.sizes : [])) {
            if (!s || !s.slug || s.available === false) continue;
            out.push(item('digitalocean-sizes', String(s.slug), String(s.slug), {
                description: s.description || null, vcpus: s.vcpus, memory: s.memory, disk: s.disk, transfer: s.transfer,
                price_monthly: s.price_monthly, price_hourly: s.price_hourly, regions: Array.isArray(s.regions) ? s.regions : [],
            }, at));
        }
        const next = r.json && r.json.links && r.json.links.pages && r.json.links.pages.next;
        url = typeof next === 'string' && next.startsWith(`${API.digitalocean}/`) ? next : null;
    }
    return out;
}

/** Hetzner Cloud: every server type that is not deprecated (GET /v1/server_types), its cheapest location's price. */
async function hetznerItems(fetchImpl, token, at) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
        const r = await getJson(fetchImpl, `${API.hetzner}/v1/server_types?per_page=50&page=${page}`, token);
        if (!(r.status >= 200 && r.status < 300)) throw new Error(refusal('Hetzner Cloud', r));
        const list = r.json && Array.isArray(r.json.server_types) ? r.json.server_types : [];
        for (const s of list) {
            if (!s || !s.name || s.deprecated || (s.deprecation && s.deprecation.unavailable_after)) continue;
            out.push(item('hetzner-server-types', String(s.name), String(s.name).toUpperCase(), {
                description: s.description || null, cores: s.cores, memory: s.memory, disk: s.disk, cpu_type: s.cpu_type || null,
                storage_type: s.storage_type || null, architecture: s.architecture || null, prices: Array.isArray(s.prices) ? s.prices : [],
            }, at));
        }
        const next = r.json && r.json.meta && r.json.meta.pagination && r.json.meta.pagination.next_page;
        if (!next) break;
    }
    return out;
}

function createKeyedFeeds({ catalog, dataSources, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const read = { digitalocean: digitalOceanItems, hetzner: hetznerItems };

    /** Read every feed that has a token. Answers { [feed]: { skipped } | { applied, held } | { error } }. */
    async function pull() {
        const report = {};
        for (const feed of Object.keys(read)) {
            const t = dataSources.token(feed);
            if (!t.value) { report[feed] = { skipped: 'no token' }; continue; }
            try {
                const items = await read[feed](fetchImpl, t.value, new Date(now()).toISOString());
                let applied = 0;
                let held = 0;
                for (const it of items) {
                    const r = await catalog.applyItem(it).catch(() => 'hold');
                    if (r === 'hold') held++; else applied++;
                }
                report[feed] = { applied, held };
            } catch (err) {
                const message = String((err && err.message) || 'failed').split(t.value).join('[hidden]').slice(0, 200);
                report[feed] = { error: message };
                log.warn(`[Host] ${feed} prices: ${message}`);
            }
        }
        return report;
    }

    /** The Setup tab's Test: one read-only call with the token. */
    async function test(feed, token) {
        if (feed === 'digitalocean') {
            const r = await getJson(fetchImpl, `${API.digitalocean}/v2/account`, token);
            if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal('DigitalOcean', r) };
            const status = r.json && r.json.account && r.json.account.status;
            return { ok: true, message: `DigitalOcean accepted the token${status ? ` (the account is ${status})` : ''}; its Droplet prices can be read.` };
        }
        if (feed === 'hetzner') {
            const r = await getJson(fetchImpl, `${API.hetzner}/v1/server_types?per_page=1`, token);
            if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal('Hetzner Cloud', r) };
            const total = r.json && r.json.meta && r.json.meta.pagination && r.json.meta.pagination.total_entries;
            return { ok: true, message: `Hetzner Cloud accepted the token${Number.isFinite(Number(total)) ? ` and lists ${Number(total)} server types` : ''}.` };
        }
        return null;
    }

    return { pull, test, feeds: Object.keys(read) };
}

module.exports = { createKeyedFeeds, digitalOceanItems, hetznerItems, API };
