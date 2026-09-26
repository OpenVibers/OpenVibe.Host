'use strict';
/**
 * Incident and maintenance controls (roadmap WS-N task 12).
 *
 *   ovhost incident open --title <t> --services a,b [--severity minor|major|critical] --message <m>
 *   ovhost incident update <inc_…> --state identified|monitoring|resolved --message <m>
 *   ovhost incident list
 *   ovhost maintenance schedule --title <t> --services a,b --from <iso> --until <iso> --message <m> [--freeze]
 *   ovhost maintenance start|complete <inc_…> --message <m>
 *   ovhost freeze <service|all> --reason <text> [--incident <inc_…>]
 *   ovhost unfreeze <service|all>
 *
 * Incidents and windows are posted to OpenVibe.Network's status page (POST /api/v1/status/incidents,
 * Contracts 0.66.0 network.status-incident-request@1) with Host's service token (network.status.incident),
 * from the same credentials as release notifications (/etc/openvibe/host.env; the secret and token are never
 * printed). Messages are for the public: no internal hostnames, secrets or personal data.
 *
 * A freeze is local: <stateDir>/freeze/<service>.json (or all.json). `ovhost deploy` refuses a frozen service
 * (exit 6) unless --force; rollbacks are never frozen, since they are how an incident ends. A maintenance window
 * scheduled with --freeze freezes its services until `maintenance complete`.
 */
const path = require('path');
const { loadCredentials } = require('./announce');

const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const INCIDENT_RE = /^inc_[0-9A-HJKMNP-TV-Z]{26}$/;

class IncidentsError extends Error {
    constructor(message, exitCode = 2) { super(message); this.name = 'IncidentsError'; this.exitCode = exitCode; }
}

async function call(ctx, method, route, body, { envFile = null, env = {} } = {}) {
    const creds = await loadCredentials(ctx.exec, ctx.inv, { file: envFile, env });
    if (creds.error) throw new IncidentsError(`not configured: ${creds.error}`);
    const net = creds.networkUrl;
    let token = null;
    if (method !== 'GET') {
        const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.secret, audience: 'openvibe.network', scope: 'network.status.incident' });
        const t = await ctx.exec.request(`${net}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeoutMs: 5000 });
        try { token = t.status === 200 ? JSON.parse(t.body).access_token : null; } catch { token = null; }
        if (!token) throw new IncidentsError(t.status ? `the token endpoint answered ${t.status}` : `Network unreachable (${t.error || 'no answer'})`);
    }
    const r = await ctx.exec.request(`${net}/api/v1/status/incidents${route}`, {
        method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : null, timeoutMs: 10000,
    });
    let json = null;
    try { json = JSON.parse(r.body); } catch { json = null; }
    if (r.status < 200 || r.status >= 300) throw new IncidentsError(`Network answered ${r.status || 'nothing'}${json && (json.detail || json.error) ? `: ${json.detail || json.error}` : ''}`);
    return json;
}

function services(list) {
    const s = String(list || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!s.length) throw new IncidentsError('--services names at least one service id', 1);
    for (const x of s) if (!SERVICE_RE.test(x)) throw new IncidentsError(`not a service id: ${x}`, 1);
    return s;
}
const needId = (id) => { if (!INCIDENT_RE.test(String(id || ''))) throw new IncidentsError('name the incident: inc_…', 1); return id; };
const needText = (v, flag) => { if (!v || v === true || !String(v).trim()) throw new IncidentsError(`${flag} is required`, 1); return String(v).trim(); };

const open = (ctx, o, conn) => call(ctx, 'POST', '', {
    kind: 'incident', title: needText(o.title, '--title'), severity: o.severity || 'minor', services: services(o.services), message: needText(o.message, '--message'),
}, conn);
const update = (ctx, id, o, conn) => call(ctx, 'POST', `/${needId(id)}/updates`, { state: needText(o.state, '--state'), message: needText(o.message, '--message'), ...(o.until ? { ends_at: new Date(o.until).toISOString() } : {}) }, conn);
const list = (ctx, conn) => call(ctx, 'GET', '', null, conn);
function schedule(ctx, o, conn) {
    const from = Date.parse(o.from); const until = Date.parse(o.until);
    if (!Number.isFinite(from) || !Number.isFinite(until)) throw new IncidentsError('--from and --until are ISO 8601 times', 1);
    return call(ctx, 'POST', '', { kind: 'maintenance', title: needText(o.title, '--title'), services: services(o.services), message: needText(o.message, '--message'), starts_at: new Date(from).toISOString(), ends_at: new Date(until).toISOString() }, conn);
}

// ── Freezes ──
const freezeDir = (inv) => path.join(inv.stateDir, 'freeze');
const freezeFile = (inv, id) => path.join(freezeDir(inv), `${id}.json`);

async function freeze(ctx, id, { reason, incident = null, by = null, now = new Date().toISOString() } = {}) {
    if (id !== 'all' && !SERVICE_RE.test(String(id))) throw new IncidentsError(`not a service id: ${id}`, 1);
    const rec = { service: id, reason: needText(reason, '--reason'), incident: incident || null, by: by || null, at: now };
    await ctx.exec.mkdir(freezeDir(ctx.inv), { mode: 0o750 });
    await ctx.exec.writeFile(freezeFile(ctx.inv, id), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o640 });
    return rec;
}
async function unfreeze(ctx, id) {
    if (id !== 'all' && !SERVICE_RE.test(String(id))) throw new IncidentsError(`not a service id: ${id}`, 1);
    const had = await frozen(ctx, id, { exact: true });
    if (had) await ctx.exec.removeFile(freezeFile(ctx.inv, id));
    return !!had;
}
/** The freeze that holds a service (its own, else 'all'), or null. exact: only its own file. */
async function frozen(ctx, id, { exact = false } = {}) {
    for (const f of exact ? [id] : [id, 'all']) {
        let rec = null;
        try { rec = JSON.parse((await ctx.exec.readFile(freezeFile(ctx.inv, f))) || 'null'); } catch { rec = null; }
        if (rec) return rec;
    }
    return null;
}
async function freezes(ctx) {
    const out = [];
    for (const e of (await ctx.exec.readdir(freezeDir(ctx.inv))) || []) {
        if (!e.name.endsWith('.json')) continue;
        try { const r = JSON.parse((await ctx.exec.readFile(path.join(freezeDir(ctx.inv), e.name))) || 'null'); if (r) out.push(r); } catch { /* skip */ }
    }
    return out.sort((a, b) => a.service.localeCompare(b.service));
}

module.exports = { open, update, list, schedule, freeze, unfreeze, frozen, freezes, IncidentsError, INCIDENT_RE };
