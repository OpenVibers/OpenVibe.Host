'use strict';
/**
 * The DNS adapter (roadmap WS-N task 12): Cloudflare's API, behind ovhost.
 *
 *   ovhost dns list <zone>
 *   ovhost dns ensure <name> <type> <content> (--proxied | --dns-only) [--ttl <s>] [--apply]
 *   ovhost dns delete <name> <type> [--apply]
 *
 * The token is the operator's: --token-file <path>, else $CLOUDFLARE_API_TOKEN_FILE, else
 * ~/.config/cloudflare-token, else $CLOUDFLARE_API_TOKEN. It never leaves the machine that runs the command,
 * is never printed or written, and the production host holds none (so these commands run from the
 * operator's workstation). Changes are a dry run unless --apply.
 *
 * The zone is the longest suffix of <name> among the zones the token can see. `ensure` makes exactly one
 * record of that name and type with that content and proxy mode: it creates, updates in place, or reports
 * `unchanged`; several records of the same name and type are refused (resolve by hand). A/AAAA/CNAME need an
 * explicit --proxied or --dns-only. Names the inventory lists as DNS-only (`dns.dnsOnly`: RTMP, TURN, JSMPEG,
 * the custom-domain CNAME target; see the Cloudflare layout) are never proxied.
 */
const path = require('path');

const API = 'https://api.cloudflare.com/client/v4';
const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'];
const PROXYABLE = new Set(['A', 'AAAA', 'CNAME']);
// DNS-only on 2026-09-26 (Cloudflare layout): RTMP/SRT ingest, the TURN relay, the custom-domain CNAME target.
// Mail records (_dmarc, *._domainkey) are DNS-only by their nature and are refused by the underscore rule.
const DEFAULT_DNS_ONLY = Object.freeze(['ingest.openvibe.live', 'relay.openvibe.live', 'turn.openvibe.live', 'cname.openvibe.host', 'ingest.openre.stream']);
const NAME_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

class DnsError extends Error {
    constructor(message, exitCode = 2) { super(message); this.name = 'DnsError'; this.exitCode = exitCode; }
}

async function loadToken(exec, { tokenFile = null, env = {} } = {}) {
    const candidates = [tokenFile, env.CLOUDFLARE_API_TOKEN_FILE, env.HOME ? path.join(env.HOME, '.config', 'cloudflare-token') : null].filter(Boolean);
    for (const f of candidates) {
        let text = null;
        try { text = await exec.readFile(f); } catch { text = null; }
        if (text && text.trim()) return text.trim();
        if (f === tokenFile) throw new DnsError(`--token-file ${f} is not readable`, 1);
    }
    if (env.CLOUDFLARE_API_TOKEN) return String(env.CLOUDFLARE_API_TOKEN).trim();
    throw new DnsError('no Cloudflare token: pass --token-file, or run this from the operator\'s workstation (~/.config/cloudflare-token); the host holds none', 1);
}

function client(exec, token) {
    return async function cf(method, route, body = null) {
        const r = await exec.request(`${API}${route}`, {
            method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : null, timeoutMs: 15000,
        });
        let json = null;
        try { json = JSON.parse(r.body); } catch { json = null; }
        if (!json || json.success !== true) {
            const msg = json && Array.isArray(json.errors) && json.errors.length ? json.errors.map((e) => `${e.code}: ${e.message}`).join('; ') : (r.status ? `HTTP ${r.status}` : (r.error || 'no answer'));
            throw new DnsError(`Cloudflare refused ${method} ${route.split('?')[0]}: ${msg}`);
        }
        return json.result;
    };
}

async function zoneFor(cf, name) {
    const labels = name.replace(/^\*\./, '').split('.');
    for (let i = 0; i < labels.length - 1; i++) {
        const candidate = labels.slice(i).join('.');
        const zones = await cf('GET', `/zones?name=${encodeURIComponent(candidate)}&per_page=5`);
        if (Array.isArray(zones) && zones.length) return zones[0];
    }
    throw new DnsError(`no zone for ${name} is visible to this token`, 1);
}

const show = (r) => ({ name: r.name, type: r.type, content: r.content, proxied: !!r.proxied, ttl: r.ttl });

async function list(ctx, zoneName, opts = {}) {
    const cf = client(ctx.exec, await loadToken(ctx.exec, opts));
    const zone = await zoneFor(cf, zoneName);
    const out = [];
    for (let page = 1; page <= 20; page++) {
        const rows = await cf('GET', `/zones/${zone.id}/dns_records?per_page=100&page=${page}`);
        out.push(...rows.map(show));
        if (rows.length < 100) break;
    }
    return { zone: zone.name, records: out.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)) };
}

function checkRecord(ctx, { name, type, content, proxied, ttl }) {
    if (!NAME_RE.test(String(name || '').toLowerCase())) throw new DnsError(`not a DNS name: ${name}`, 1);
    if (!TYPES.includes(type)) throw new DnsError(`type is one of ${TYPES.join(', ')}`, 1);
    if (!content) throw new DnsError('content is required', 1);
    if (PROXYABLE.has(type) && proxied == null) throw new DnsError(`${type} records need --proxied or --dns-only (Cloudflare layout: web traffic proxied; RTMP, TURN, JSMPEG and the CNAME target DNS-only)`, 1);
    if (!PROXYABLE.has(type) && proxied) throw new DnsError(`${type} records cannot be proxied`, 1);
    const dnsOnly = new Set(((ctx.inv && ctx.inv.dns && ctx.inv.dns.dnsOnly) || []).map((n) => String(n).toLowerCase()));
    if (proxied && dnsOnly.has(String(name).toLowerCase())) throw new DnsError(`${name} is DNS-only by the inventory (dns.dnsOnly): it carries non-HTTP traffic or is the CNAME target`, 1);
    if (proxied && /(^|\.)_/.test(String(name))) throw new DnsError(`${name} is a service record (_dmarc, _domainkey…): never proxied`, 1);
    if (ttl != null && !(Number.isInteger(ttl) && (ttl === 1 || (ttl >= 60 && ttl <= 86400)))) throw new DnsError('ttl is 1 (automatic) or 60–86400 seconds', 1);
}

/** Make exactly one <name> <type> record with this content and proxy mode. → { action, zone, before?, after } */
async function ensure(ctx, rec, { apply = false, ...opts } = {}) {
    const want = { name: String(rec.name).toLowerCase(), type: String(rec.type).toUpperCase(), content: String(rec.content), proxied: rec.proxied, ttl: rec.ttl == null ? 1 : Number(rec.ttl) };
    checkRecord(ctx, want);
    const cf = client(ctx.exec, await loadToken(ctx.exec, opts));
    const zone = await zoneFor(cf, want.name);
    const existing = await cf('GET', `/zones/${zone.id}/dns_records?type=${want.type}&name=${encodeURIComponent(want.name)}`);
    if (existing.length > 1) throw new DnsError(`${existing.length} ${want.type} records named ${want.name}: resolve them by hand first`);
    const body = { type: want.type, name: want.name, content: want.content, ttl: want.ttl, ...(PROXYABLE.has(want.type) ? { proxied: !!want.proxied } : {}) };
    const cur = existing[0] || null;
    const same = cur && cur.content === body.content && (!PROXYABLE.has(want.type) || !!cur.proxied === !!body.proxied) && (cur.ttl === body.ttl || (body.proxied && cur.ttl === 1));
    if (same) return { action: 'unchanged', zone: zone.name, after: show(cur) };
    const action = cur ? 'update' : 'create';
    if (!apply) return { action, dryRun: true, zone: zone.name, ...(cur ? { before: show(cur) } : {}), after: show({ ...body, proxied: !!body.proxied }) };
    const done = cur ? await cf('PUT', `/zones/${zone.id}/dns_records/${cur.id}`, body) : await cf('POST', `/zones/${zone.id}/dns_records`, body);
    return { action, zone: zone.name, ...(cur ? { before: show(cur) } : {}), after: show(done) };
}

async function remove(ctx, { name, type }, { apply = false, ...opts } = {}) {
    const n = String(name).toLowerCase(); const t = String(type).toUpperCase();
    if (!NAME_RE.test(n)) throw new DnsError(`not a DNS name: ${name}`, 1);
    if (!TYPES.includes(t)) throw new DnsError(`type is one of ${TYPES.join(', ')}`, 1);
    const cf = client(ctx.exec, await loadToken(ctx.exec, opts));
    const zone = await zoneFor(cf, n);
    const existing = await cf('GET', `/zones/${zone.id}/dns_records?type=${t}&name=${encodeURIComponent(n)}`);
    if (!existing.length) return { action: 'absent', zone: zone.name };
    if (existing.length > 1) throw new DnsError(`${existing.length} ${t} records named ${n}: resolve them by hand`);
    if (!apply) return { action: 'delete', dryRun: true, zone: zone.name, before: show(existing[0]) };
    await cf('DELETE', `/zones/${zone.id}/dns_records/${existing[0].id}`);
    return { action: 'delete', zone: zone.name, before: show(existing[0]) };
}

module.exports = { list, ensure, remove, loadToken, DnsError, TYPES, DEFAULT_DNS_ONLY };
