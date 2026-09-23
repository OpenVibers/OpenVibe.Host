'use strict';
/**
 * Domains: every site answers at its default <name>.<sitesDomain>; a custom domain answers only
 * once its owner has proven control with a DNS TXT record:
 *
 *   _openvibe-host.<hostname>  TXT  "openvibe-host-verification=<token>"
 *
 * The resolver is injectable (tests use a table; production uses node:dns with a timeout). A
 * verified hostname belongs to exactly one site (unique index), first-party domains and the sites
 * domain itself can never be claimed, and sandbox projects cannot add custom domains.
 *
 * Verified custom domains are re-checked daily: when the TXT record has been gone for
 * HOST_DOMAIN_LAPSE_DAYS the domain lapses and stops being served (whoever controls the name now
 * may claim it). Pending domains that never verify fail after HOST_DOMAIN_PENDING_DAYS.
 *
 * TLS for custom domains is an operator step (ovhost nginx tenants + certbot); no certificate or
 * key ever passes through this API.
 */
const crypto = require('crypto');
const dns = require('dns');
const contracts = require('openvibe-contracts');
const { newId, isId } = require('../ids');
const { ApiError } = require('../http/errors');
const { principalOf, actorRef } = require('./access');

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
const CHALLENGE_PREFIX = '_openvibe-host';
const TXT_PREFIX = 'openvibe-host-verification=';
const DAY = 24 * 3600 * 1000;
const MIN_RECHECK_MS = 5000;

function isHostname(h) {
    return typeof h === 'string' && h.length <= 253 && HOSTNAME_RE.test(h);
}

/** First-party domains from the released service manifests, plus configured extras. */
function firstPartyDomains(config) {
    const out = new Set(['openvibe.network', 'openvibe.live', 'openvibe.media', 'openvibe.community', 'openvibe.tools', config.sitesDomain, config.dashboardHost]);
    try {
        const m = contracts.services.manifests;
        for (const s of Array.isArray(m) ? m : Object.values(m || {})) for (const d of s.domains || []) out.add(String(d).toLowerCase());
    } catch { /* the defaults above still apply */ }
    for (const d of config.domains.extraReserved) out.add(d);
    return [...out].filter(Boolean);
}

function defaultResolver(servers) {
    const r = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
    if (servers && servers.length) r.setServers(servers);
    return { resolveTxt: (name) => r.resolveTxt(name) };
}

function createDomains({ store, config, access, projects, sites, outbox, resolver = null, log = console }) {
    const { db } = store;
    const dnsResolver = resolver || defaultResolver(config.domains.dnsServers);
    const reserved = firstPartyDomains(config);
    const q = {
        byId: db.prepare('SELECT * FROM host_domains WHERE id = ?'),
        forSite: db.prepare("SELECT * FROM host_domains WHERE site_id = ? ORDER BY kind DESC, created_at, rowid"),
        verifiedByHost: db.prepare("SELECT * FROM host_domains WHERE hostname = ? AND status = 'verified'"),
        onSite: db.prepare('SELECT * FROM host_domains WHERE site_id = ? AND hostname = ?'),
        insert: db.prepare(`INSERT INTO host_domains (id, project_id, site_id, hostname, kind, status, token, created_by, created_at)
                            VALUES (?, ?, ?, ?, 'custom', 'pending', ?, ?, ?)`),
        checked: db.prepare('UPDATE host_domains SET last_checked_at = ?, last_error = ?, check_count = check_count + 1 WHERE id = ?'),
        verified: db.prepare("UPDATE host_domains SET status = 'verified', verified_at = ?, last_checked_at = ?, last_error = NULL, check_count = check_count + 1, record_missing_since = NULL WHERE id = ? AND status IN ('pending','failed','lapsed')"),
        setStatus: db.prepare('UPDATE host_domains SET status = ?, last_error = ? WHERE id = ?'),
        missing: db.prepare('UPDATE host_domains SET record_missing_since = COALESCE(record_missing_since, ?), last_checked_at = ?, last_error = ?, check_count = check_count + 1 WHERE id = ?'),
        present: db.prepare('UPDATE host_domains SET record_missing_since = NULL, last_checked_at = ?, last_error = NULL, check_count = check_count + 1 WHERE id = ?'),
        remove: db.prepare('DELETE FROM host_domains WHERE id = ?'),
        duePending: db.prepare("SELECT * FROM host_domains WHERE kind = 'custom' AND status = 'pending' AND COALESCE(last_checked_at, 0) < ? ORDER BY COALESCE(last_checked_at, 0) LIMIT ?"),
        dueVerified: db.prepare("SELECT * FROM host_domains WHERE kind = 'custom' AND status = 'verified' AND COALESCE(last_checked_at, 0) < ? ORDER BY COALESCE(last_checked_at, 0) LIMIT ?"),
    };

    const challengeName = (hostname) => `${CHALLENGE_PREFIX}.${hostname}`;

    function load(viewer, id, need) {
        const domain = isId('domain', id) ? q.byId.get(id) : null;
        const notFound = new ApiError(404, 'domain.not_found', 'no such domain');
        if (!domain) throw notFound;
        const site = sites.get(domain.site_id);
        if (!site || site.status !== 'active') throw notFound;
        access.authorize(projects.get(domain.project_id), viewer, need, notFound);
        return { domain, site };
    }

    function checkHostname(raw) {
        const hostname = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
        if (!isHostname(hostname)) throw new ApiError(422, 'domain.invalid_hostname', 'a custom domain is a fully qualified host name such as www.example.org');
        // Anything that reads as an OpenVibe property (openvibe.<tld>, any subdomain) is refused too.
        if (/(^|\.)openvibe\.[a-z]+$/.test(hostname)) throw new ApiError(422, 'domain.reserved', `${hostname} is an OpenVibe domain and cannot be used as a custom domain`);
        for (const r of reserved) {
            if (hostname === r || hostname.endsWith(`.${r}`)) throw new ApiError(422, 'domain.reserved', `${hostname} is an OpenVibe domain and cannot be used as a custom domain`);
        }
        return hostname;
    }

    /** What the owner must publish: shown by the API and the dashboard. */
    function instructions(domain, site) {
        if (domain.kind === 'default') return null;
        const target = config.domains.cnameTarget || sites.defaultHostname(site.name);
        const routing = [{ type: 'CNAME', name: domain.hostname, value: target, note: 'for a subdomain such as www.example.org' }];
        if (config.domains.originIpv4) routing.push({ type: 'A', name: domain.hostname, value: config.domains.originIpv4, note: 'for an apex domain (or use your DNS provider\'s ALIAS/ANAME to the CNAME target)' });
        if (config.domains.originIpv6) routing.push({ type: 'AAAA', name: domain.hostname, value: config.domains.originIpv6, note: 'for an apex domain' });
        return {
            verification: { type: 'TXT', name: challengeName(domain.hostname), value: `${TXT_PREFIX}${domain.token}`, note: 'keep this record: Host re-checks it daily' },
            routing,
            tls: 'after verification an operator issues the certificate (Let\'s Encrypt); HTTPS starts working once it is installed',
        };
    }

    function add(viewer, siteId, input = {}) {
        const { site, project } = sites.load(viewer, siteId, 'maintain');
        const hostname = checkHostname(input.hostname);
        if (project.environment === 'sandbox') throw new ApiError(403, 'domain.sandbox', 'sandbox projects are served on their default domain only');
        const quota = projects.quotaOf(project);
        if (projects.usageOf(project).customDomains >= quota.customDomains) throw new ApiError(429, 'quota.custom_domains', `this project may have ${quota.customDomains} custom domains`);
        if (q.onSite.get(site.id, hostname)) throw new ApiError(409, 'domain.exists', `${hostname} is already on this site`);
        if (q.verifiedByHost.get(hostname)) throw new ApiError(409, 'domain.taken', `${hostname} is already verified for another site`);
        const id = newId('domain', store.now());
        const token = crypto.randomBytes(20).toString('hex');
        q.insert.run(id, project.id, site.id, hostname, token, principalOf(viewer), store.now());
        const domain = q.byId.get(id);
        return { domain, site };
    }

    async function lookup(hostname) {
        try {
            const records = await dnsResolver.resolveTxt(challengeName(hostname));
            return { ok: true, values: (records || []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks))) };
        } catch (err) {
            const code = err && err.code;
            if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return { ok: true, values: [] };
            return { ok: false, error: `DNS lookup failed (${code || 'error'})` };
        }
    }

    /** Check the TXT record now. -> the domain row after the check. */
    async function verifyDomain(domain, viewer = null, { traceparent } = {}) {
        if (domain.kind !== 'custom') return domain;
        if (domain.status === 'verified') return domain;
        const now = store.now();
        if (domain.last_checked_at && now - domain.last_checked_at < MIN_RECHECK_MS) return domain;
        const r = await lookup(domain.hostname);
        const expected = `${TXT_PREFIX}${domain.token}`;
        if (!r.ok) { q.checked.run(store.now(), r.error, domain.id); return q.byId.get(domain.id); }
        if (!r.values.includes(expected)) {
            q.checked.run(store.now(), r.values.length ? `${challengeName(domain.hostname)} has TXT records, but not the expected value` : `no TXT record at ${challengeName(domain.hostname)} yet`, domain.id);
            return q.byId.get(domain.id);
        }
        try {
            store.tx(() => {
                if (q.verifiedByHost.get(domain.hostname)) throw new ApiError(409, 'domain.taken', `${domain.hostname} was verified for another site first`);
                const site = sites.get(domain.site_id);
                if (!site || site.status !== 'active') throw new ApiError(404, 'domain.not_found', 'no such domain');
                if (q.verified.run(store.now(), store.now(), domain.id).changes !== 1) return;
                outbox.emit({
                    event_type: 'host.domain.verified', actor: viewer ? actorRef(viewer) : { type: 'service', id: 'host' }, visibility: 'internal', priority: 'low',
                    subject: { type: 'domain', id: domain.id },
                    payload: { project_id: domain.project_id, site_id: domain.site_id, site: site.name, hostname: domain.hostname },
                }, { traceparent });
            });
        } catch (err) {
            if (err instanceof ApiError && err.code === 'domain.taken') { q.setStatus.run('failed', err.message, domain.id); return q.byId.get(domain.id); }
            throw err;
        }
        outbox.kick();
        return q.byId.get(domain.id);
    }

    async function verify(viewer, id, opts = {}) {
        const { domain } = load(viewer, id, 'maintain');
        return verifyDomain(domain, viewer, opts);
    }

    function remove(viewer, id) {
        const { domain } = load(viewer, id, 'maintain');
        if (domain.kind === 'default') throw new ApiError(409, 'domain.default', 'the default domain goes away only with the site');
        q.remove.run(domain.id);
        return { deleted: true };
    }

    /** Worker pass: pending domains (every interval), verified domains (daily). */
    async function recheck({ limit = 50 } = {}) {
        const now = store.now();
        const summary = { verified: 0, failed: 0, lapsed: 0, checked: 0 };
        for (const d of q.duePending.all(now - config.domains.recheckIntervalMs + 1000, limit)) {
            if (now - d.created_at > config.domains.pendingDays * DAY) {
                q.setStatus.run('failed', `not verified within ${config.domains.pendingDays} days`, d.id);
                summary.failed++;
                continue;
            }
            const after = await verifyDomain(d);
            summary.checked++;
            if (after.status === 'verified') summary.verified++;
        }
        for (const d of q.dueVerified.all(now - DAY, limit)) {
            const r = await lookup(d.hostname);
            summary.checked++;
            if (!r.ok) { q.checked.run(store.now(), r.error, d.id); continue; }
            if (r.values.includes(`${TXT_PREFIX}${d.token}`)) { q.present.run(store.now(), d.id); continue; }
            q.missing.run(store.now(), store.now(), `the TXT record at ${challengeName(d.hostname)} is gone`, d.id);
            const row = q.byId.get(d.id);
            if (row.record_missing_since && store.now() - row.record_missing_since > config.domains.lapseDays * DAY) {
                q.setStatus.run('lapsed', `the TXT record has been gone for more than ${config.domains.lapseDays} days; the domain is no longer served`, d.id);
                summary.lapsed++;
                log.warn(`[Host] custom domain ${d.hostname} lapsed (TXT record gone)`);
            }
        }
        return summary;
    }

    return {
        load, add, verify, verifyDomain, remove, recheck, instructions, checkHostname,
        listForSite: (siteId) => q.forSite.all(siteId),
        get: (id) => (isId('domain', id) ? q.byId.get(id) || null : null),
        verifiedCustom: () => db.prepare("SELECT hostname, site_id FROM host_domains WHERE kind = 'custom' AND status = 'verified' ORDER BY hostname").all(),
        challengeName, TXT_PREFIX,
    };
}

module.exports = { createDomains, isHostname, firstPartyDomains, CHALLENGE_PREFIX, TXT_PREFIX };
