'use strict';
/**
 * Is a domain name taken? RDAP (RFC 9082/9083), the registries' public lookup that replaced WHOIS: IANA's bootstrap
 * file names each TLD's RDAP server, and the registry answers 200 with the registration or 404 when it holds none.
 *
 *   createRdap({ fetchImpl, now, lookup }) → { lookup(name) }   (`lookup`: a dns.lookup stand-in, for tests)
 *   lookup('example.com') → { name, status: 'registered'|'unregistered'|'unknown', registrar, created, expires, server, reason }
 *
 * Only the bootstrap's own https servers are asked (never a URL from the person), redirects are refused, every call
 * has a timeout, and answers are cached (10 minutes, 2,000 names) so a burst of checks does not reach the registries.
 * "unregistered" means the registry holds no registration: the name is probably available, or reserved.
 */
const egress = require('openvibe-shared/egress');

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL = 24 * 3600_000;
const ANSWER_TTL = 10 * 60_000;
const MAX_CACHED = 2000;
const TIMEOUT_MS = 6000;
const UA = 'OpenVibe.Host domain check (+https://openvibe.host/catalog/domains)';

function createRdap({ fetchImpl = globalThis.fetch, now = Date.now, log = console, lookup: dnsLookup } = {}) {
    let bootstrap = null;   // { at, servers: Map<tld, base> }
    let loading = null;
    const answers = new Map();

    async function get(u, accept) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            return await fetchImpl(u, { headers: { accept, 'user-agent': UA }, redirect: 'error', signal: ctrl.signal });
        } finally { clearTimeout(timer); }
    }
    async function servers() {
        if (bootstrap && now() - bootstrap.at < BOOTSTRAP_TTL) return bootstrap.servers;
        if (!loading) {
            loading = (async () => {
                const res = await get(BOOTSTRAP_URL, 'application/json');
                if (!res.ok) throw new Error(`IANA bootstrap answered ${res.status}`);
                const body = await res.json();
                const map = new Map();
                for (const entry of Array.isArray(body.services) ? body.services : []) {
                    const [tlds, urls] = Array.isArray(entry) ? entry : [];
                    const base = (Array.isArray(urls) ? urls : []).find((x) => typeof x === 'string' && x.startsWith('https://'));
                    if (!base) continue;
                    for (const t of Array.isArray(tlds) ? tlds : []) if (typeof t === 'string') map.set(t.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
                }
                if (!map.size) throw new Error('IANA bootstrap listed no RDAP servers');
                bootstrap = { at: now(), servers: map };
                return map;
            })().finally(() => { loading = null; });
        }
        try { return await loading; } catch (err) {
            log.warn(`[Host] RDAP bootstrap: ${err.message}`);
            return bootstrap ? bootstrap.servers : null;
        }
    }
    const eventDate = (body, action) => {
        const e = (Array.isArray(body.events) ? body.events : []).find((x) => x && x.eventAction === action && typeof x.eventDate === 'string');
        return e && Number.isFinite(Date.parse(e.eventDate)) ? new Date(Date.parse(e.eventDate)).toISOString() : null;
    };
    const registrarOf = (body) => {
        const ent = (Array.isArray(body.entities) ? body.entities : []).find((x) => x && Array.isArray(x.roles) && x.roles.includes('registrar'));
        if (!ent) return null;
        const card = Array.isArray(ent.vcardArray) && Array.isArray(ent.vcardArray[1]) ? ent.vcardArray[1] : [];
        const fn = card.find((f) => Array.isArray(f) && f[0] === 'fn');
        const name = fn && typeof fn[3] === 'string' ? fn[3].trim() : '';
        return name ? name.slice(0, 200) : null;
    };

    async function ask(name) {
        const tld = name.slice(name.lastIndexOf('.') + 1);
        const map = await servers();
        if (!map) return { status: 'unknown', reason: 'The registries\' lookup directory did not answer just now.' };
        const base = map.get(tld);
        if (!base) return { status: 'unknown', reason: `The .${tld} registry offers no public RDAP lookup; a registrar's search will say.` };
        let target;
        try { target = await egress.assertPublicUrl(`${base}domain/${encodeURIComponent(name)}`, { protocols: ['https:'], lookup: dnsLookup }); } catch {
            return { status: 'unknown', reason: 'That registry\'s lookup is not reachable from here.' };
        }
        const server = new URL(base).hostname;
        let res;
        try { res = await get(target.href, 'application/rdap+json, application/json'); } catch (err) {
            return { status: 'unknown', server, reason: err && err.name === 'AbortError' ? 'The registry did not answer in time.' : 'The registry could not be reached.' };
        }
        if (res.status === 404) return { status: 'unregistered', server };
        if (res.status === 429) return { status: 'unknown', server, reason: 'The registry asked us to slow down; try again in a minute.' };
        if (!res.ok) return { status: 'unknown', server, reason: `The registry answered ${res.status}.` };
        let body;
        try { body = await res.json(); } catch { return { status: 'unknown', server, reason: 'The registry\'s answer could not be read.' }; }
        if (!body || typeof body !== 'object' || body.objectClassName !== 'domain') return { status: 'unknown', server, reason: 'The registry\'s answer was not a domain record.' };
        return { status: 'registered', server, registrar: registrarOf(body), created: eventDate(body, 'registration'), expires: eventDate(body, 'expiration') };
    }

    async function lookup(name) {
        const hit = answers.get(name);
        if (hit && now() - hit.at < ANSWER_TTL) return { name, ...hit.answer, cached: true };
        const answer = await ask(name);
        if (answer.status !== 'unknown') {
            if (answers.size >= MAX_CACHED) answers.delete(answers.keys().next().value);
            answers.set(name, { at: now(), answer });
        }
        return { name, ...answer, cached: false };
    }
    return { lookup };
}

module.exports = { createRdap, BOOTSTRAP_URL };
