'use strict';
/**
 * Release notifications (roadmap WS-P task 9; ADR-016). When a network service's release goes live,
 * Host publishes `host.release.published` to OpenVibe.Events with visibility public and subject
 * { type: release, id: <service>:<release> }. Open tabs (openvibe-shared release-watch, subscribed to
 * that topic over Events realtime) then check /release.json within seconds instead of at their next
 * poll.
 *
 *   ovhost deploy|rollback <service>   announces after a deploy or rollback that went live
 *   ovhost announce <service>          for services deployed by their own scripts (Live, Tools, Sites,
 *                                      OpenRe, Games)
 *
 * Best effort: it never fails or holds up a deploy. The token request and the publish each have a
 * short timeout and the whole announcement a budget of a few seconds; a failure is logged and the
 * deploy's exit code stays what it was. A retry sends the same event_id, which Events stores once.
 *
 * The release is what the service's own /release.json reports now (on loopback, at the origin of its
 * ready URL), because that is what open tabs compare with; else the checkout's HEAD (12 hex); or
 * --release. The commit is included when it is known and the release is its prefix (or --commit).
 * The origin is --origin, the inventory entry's `origin`, or the service manifest's publicOrigin in
 * the installed openvibe-contracts. The last release announced for each service is kept in
 * <stateDir>/announced/<service>.json and the same release is not announced twice (--force does).
 *
 * Credentials: Host's Network service principal, client `host` (grant events.event.publish, audience
 * openvibe.events), from the Host API's env file. Variable NAMES:
 *   OV_OAUTH_CLIENT_ID        default host
 *   OV_OAUTH_CLIENT_SECRET    required
 *   EVENTS_URL                required, e.g. http://127.0.0.1:4300
 *   OV_NETWORK_INTERNAL_URL   default http://127.0.0.1:4000 (the token endpoint is <it>/oauth/token)
 * File: --events-env, else $OVHOST_EVENTS_ENV, else the inventory's events.envFile, else
 * /etc/openvibe/host.env. The secret and the token are never printed, logged, stored or returned.
 */
const path = require('path');
const { git } = require('./git');

const EVENT_TYPE = 'host.release.published';
const DEFAULT_ENV_FILE = '/etc/openvibe/host.env';
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const HEX_RE = /^[0-9a-f]{7,40}$/;
const COMPONENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION_RE = /^[0-9A-Za-z._+-]{1,64}$/;
const KINDS = ['style', 'content', 'script', 'server'];
const MAX_COMPONENTS = 32;
const REQUEST_MS = 2500;   // each HTTP request
const BUDGET_MS = 6000;    // the token request, the publish and its one retry together
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const WANTED = ['OV_OAUTH_CLIENT_ID', 'OV_OAUTH_CLIENT_SECRET', 'EVENTS_URL', 'OV_NETWORK_INTERNAL_URL'];

class AnnounceError extends Error {
    constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

const loopback = (hostname) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);

/** KEY=value lines -> { KEY: value } for the names announce reads; nothing else is kept. */
function parseEnv(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(LINE_RE);
        if (!m || !WANTED.includes(m[1])) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '');
        out[m[1]] = v;
    }
    return out;
}

function baseUrl(raw, name) {
    let u;
    try { u = new URL(raw); } catch { return { error: `${name} is not a URL` }; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return { error: `${name} must be an http(s) URL without credentials` };
    if (u.protocol === 'http:' && !loopback(u.hostname)) return { error: `${name} must be https:// (plain http only on loopback)` };
    return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * -> { file, clientId, eventsUrl, networkUrl } with the secret as a non-enumerable property (so
 * JSON.stringify and util.inspect never show it), or { file, error, notConfigured }.
 */
async function loadCredentials(exec, inv, { file = null, env = {} } = {}) {
    const f = file || env.OVHOST_EVENTS_ENV || (inv.events && inv.events.envFile) || DEFAULT_ENV_FILE;
    if (!path.isAbsolute(f)) return { file: f, error: 'the events env file must be an absolute path', notConfigured: true };
    let text;
    try { text = await exec.readFile(f, { privileged: true }); } catch (err) { return { file: f, error: `${f} is not readable (${err.code || 'error'})`, notConfigured: true }; }
    if (text == null) return { file: f, error: `${f} not found`, notConfigured: true };
    const v = parseEnv(text);
    const missing = ['OV_OAUTH_CLIENT_SECRET', 'EVENTS_URL'].filter((n) => !v[n]);
    if (missing.length) return { file: f, error: `${f} sets no ${missing.join(' and no ')}`, notConfigured: true };
    const events = baseUrl(v.EVENTS_URL, 'EVENTS_URL');
    if (events.error) return { file: f, error: events.error, notConfigured: true };
    const network = baseUrl(v.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000', 'OV_NETWORK_INTERNAL_URL');
    if (network.error) return { file: f, error: network.error, notConfigured: true };
    const clientId = v.OV_OAUTH_CLIENT_ID || 'host';
    if (!SERVICE_RE.test(clientId)) return { file: f, error: 'OV_OAUTH_CLIENT_ID is not a service principal id', notConfigured: true };
    const cfg = { file: f, clientId, eventsUrl: events.url, networkUrl: network.url };
    Object.defineProperty(cfg, 'secret', { value: v.OV_OAUTH_CLIENT_SECRET, enumerable: false });
    return cfg;
}

/** The service's public origin from the installed openvibe-contracts manifest, or null. */
function manifestOrigin(id, contracts) {
    let lib = contracts;
    if (!lib) { try { lib = require('openvibe-contracts'); } catch { return null; } }
    const m = lib.services && typeof lib.services.get === 'function' ? lib.services.get(id) : null;
    return m && m.publicOrigin ? checkOrigin(m.publicOrigin, { quiet: true }) : null;
}

function checkOrigin(raw, { quiet = false } = {}) {
    let u;
    try { u = new URL(String(raw)); } catch { if (quiet) return null; throw new AnnounceError('--origin must be a URL such as https://openvibe.live'); }
    const ok = (u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname))) && !u.username && !u.password;
    if (!ok) { if (quiet) return null; throw new AnnounceError('--origin must be an https:// origin'); }
    return u.origin;
}

/** Only what the event schema allows: { <name>: { kind, version } }, at most 32; else null. */
function components(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    const names = Object.keys(raw);
    if (!names.length || names.length > MAX_COMPONENTS) return null;
    for (const name of names) {
        const c = raw[name];
        if (!COMPONENT_RE.test(name) || !c || !KINDS.includes(c.kind) || !VERSION_RE.test(String(c.version || ''))) return null;
        out[name] = { kind: c.kind, version: String(c.version) };
    }
    return out;
}

/** GET <ready origin>/release.json on loopback -> { release, components } | { note }. */
async function servedManifest(exec, svc) {
    let url;
    try { url = new URL('/release.json', svc.ready.url).href; } catch { return { note: 'no ready URL to find /release.json at' }; }
    const r = await exec.http(url, { timeoutMs: 3000, headers: svc.ready.headers || {} });
    if (r.status !== 200) return { note: `${url} answered ${r.status || r.error}; using the checkout's HEAD` };
    let m;
    try { m = JSON.parse(r.body); } catch { return { note: `${url} is not JSON; using the checkout's HEAD` }; }
    if (!m || typeof m.release !== 'string' || !HEX_RE.test(m.release)) return { note: `${url} names no release; using the checkout's HEAD` };
    if (m.service !== svc.id) return { note: `${url} is service "${m.service}", not "${svc.id}"; using the checkout's HEAD` };
    return { release: m.release, components: components(m.components) };
}

/**
 * What to announce for `id`: { service, release, commit, origin, components, from, notes }.
 * `head` (a full sha) saves the git call when the caller knows it (ovhost deploy).
 */
async function describeRelease(ctx, id, { release = null, commit = null, origin = null, head = null, contracts = null } = {}) {
    const { exec, inv } = ctx;
    if (!SERVICE_RE.test(String(id || ''))) throw new AnnounceError(`"${id}" is not a service id (the "service" a /release.json names)`);
    const svc = inv.services[id] || null;
    const notes = [];
    let rel = release == null ? null : String(release).toLowerCase();
    if (rel !== null && !HEX_RE.test(rel)) throw new AnnounceError('--release must be 7 to 40 hex characters: the release id the service\'s /release.json reports');
    let cm = commit == null ? null : String(commit).toLowerCase();
    if (cm !== null && !HEX_RE.test(cm)) throw new AnnounceError('--commit must be 7 to 40 hex characters');
    let comps = null;
    let from = rel ? '--release' : null;
    if (!rel && svc && svc.ready) {
        const m = await servedManifest(exec, svc);
        if (m.release) { rel = m.release; comps = m.components; from = '/release.json'; } else notes.push(m.note);
    }
    let sha = head && /^[0-9a-f]{40}$/.test(head) ? head : null;
    if (!sha && svc && (!rel || !cm)) {
        try {
            const h = await git(exec, svc).head();
            if (/^[0-9a-f]{40}$/.test(h)) sha = h;
        } catch (err) { notes.push(`the checkout's HEAD is unknown (${err.message.split('\n')[0].slice(0, 120)})`); }
    }
    if (!rel && sha) { rel = sha.slice(0, 12); from = 'git HEAD'; }
    if (!rel) {
        throw new AnnounceError(svc ? `cannot tell ${id}'s release (no /release.json answer, no git HEAD): pass --release <id>`
            : `${id} is not in the inventory: pass --release <id> (the release its /release.json reports) and --origin`);
    }
    if (!cm && sha && sha.startsWith(rel)) cm = sha;
    let o = null;
    if (origin != null) o = checkOrigin(origin);
    else if (svc && svc.origin) o = svc.origin;
    else o = manifestOrigin(svc ? svc.manifest : id, contracts);
    return { service: id, release: rel, commit: cm, origin: o, components: comps, from, notes };
}

function newEventId(now) {
    return require('openvibe-contracts').ids.newId('event', now);
}

/** The events.event-envelope@1 for a description (payload: contract host.release.published@1). */
function envelope(d, { now, rollback = false, eventId = newEventId(now) }) {
    const at = new Date(now).toISOString();
    const payload = { service: d.service, release: d.release, commit: d.commit || null, origin: d.origin || null, deployed_at: at };
    if (d.components) payload.components = d.components;
    if (rollback) payload.rollback = true;
    return {
        event_id: eventId,
        event_type: EVENT_TYPE,
        version: 1,
        source: 'host',
        actor: { type: 'service', id: 'host' },
        timestamp: at,
        priority: 'low',
        visibility: 'public',
        subject: { type: 'release', id: `${d.service}:${d.release}` },
        payload,
    };
}

/** A short reason for a failed request: the status and a problem/OAuth code, never the body. */
function reason(r) {
    if (!r) return 'no answer';
    if (r.status === 0) return r.error || 'unreachable';
    let code = null;
    try { const j = JSON.parse(r.body); code = j && (j.code || j.error); } catch { /* not JSON */ }
    return `HTTP ${r.status}${typeof code === 'string' && /^[a-z0-9._-]{1,60}$/i.test(code) ? ` ${code}` : ''}`;
}

/** Token, then POST /api/v1/events (one retry, same event_id). -> { ok, seq, duplicate } | { ok: false, stage, error }. */
async function publish(exec, creds, env) {
    const start = exec.now();
    const left = () => BUDGET_MS - (exec.now() - start);
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.secret, audience: 'openvibe.events', scope: 'events.event.publish' });
    const t = await exec.request(`${creds.networkUrl}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeoutMs: REQUEST_MS,
    });
    if (t.status !== 200) return { ok: false, stage: 'token', error: reason(t) };
    let token = null;
    try { token = JSON.parse(t.body).access_token; } catch { token = null; }
    if (typeof token !== 'string' || !token) return { ok: false, stage: 'token', error: 'no access_token in the answer' };
    const body = JSON.stringify(env);
    let last = null;
    let attempts = 0;
    while (attempts < 2) {
        attempts += 1;
        last = await exec.request(`${creds.eventsUrl}/api/v1/events`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` }, body, timeoutMs: Math.max(500, Math.min(REQUEST_MS, left())),
        });
        if (last.status === 200 || last.status === 201) {
            let j = {};
            try { j = JSON.parse(last.body) || {}; } catch { j = {}; }
            return { ok: true, seq: Number.isInteger(j.seq) ? j.seq : null, duplicate: j.duplicate === true || last.status === 200, attempts };
        }
        const retryable = last.status === 0 || last.status === 429 || last.status >= 500;
        if (!retryable || left() < 1000) break;
        await exec.sleep(300);
    }
    return { ok: false, stage: 'publish', error: reason(last), attempts };
}

const stateFile = (inv, service) => path.join(inv.stateDir, 'announced', `${service}.json`);

async function readState(exec, inv, service) {
    try {
        const text = await exec.readFile(stateFile(inv, service));
        return text ? JSON.parse(text) : null;
    } catch { return null; }
}

/**
 * Announce `id`'s current release. Never throws for a publishing problem: the result says what
 * happened. Throws AnnounceError only for bad arguments (exit 1).
 *   -> { service, release, commit, origin, from, event_id, published, skipped, error, notConfigured, seq, duplicate, envelope? }
 */
async function announce(ctx, id, { release = null, commit = null, origin = null, head = null, rollback = false, force = false, dryRun = false, envFile = null, env = {}, contracts = null } = {}) {
    const { exec, inv, log = () => {} } = ctx;
    let creds = null;
    if (!dryRun) {
        creds = await loadCredentials(exec, inv, { file: envFile, env });
        if (creds.error) {
            // Nothing is described or sent: an unconfigured host announces nothing, quietly and cheaply.
            if (!SERVICE_RE.test(String(id || ''))) throw new AnnounceError(`"${id}" is not a service id`);
            return { service: id, release: release || null, published: false, skipped: 'not configured', error: creds.error, notConfigured: true };
        }
    }
    const d = await describeRelease(ctx, id, { release, commit, origin, head, contracts });
    for (const n of d.notes) log(n);
    const env_ = envelope(d, { now: exec.now(), rollback });
    const out = { service: d.service, release: d.release, commit: d.commit, origin: d.origin, from: d.from, event_id: env_.event_id, published: false, skipped: null, error: null, notConfigured: false };
    if (dryRun) return { ...out, skipped: 'dry run', envelope: env_ };
    const prev = await readState(exec, inv, d.service);
    if (!force && prev && prev.release === d.release) return { ...out, event_id: prev.event_id || null, skipped: `already announced at ${prev.at}` };
    const p = await publish(exec, creds, env_);
    if (!p.ok) return { ...out, error: `${p.stage}: ${p.error}` };
    const rec = { service: d.service, release: d.release, commit: d.commit, event_id: env_.event_id, seq: p.seq, at: env_.timestamp };
    try {
        await exec.mkdir(path.dirname(stateFile(inv, d.service)), { mode: 0o750 });
        await exec.writeFile(stateFile(inv, d.service), `${JSON.stringify(rec)}\n`, { mode: 0o640 });
    } catch (err) { log(`note: could not record the announcement in ${stateFile(inv, d.service)} (${err.code || err.message})`); }
    return { ...out, published: true, seq: p.seq, duplicate: p.duplicate };
}

/** One line for the operator. */
function summary(r) {
    const what = `${r.service}${r.release ? ` ${r.release}` : ''}`;
    if (r.published) return `release notification sent: ${what}${r.from ? ` (from ${r.from})` : ''} as ${r.event_id}${r.seq != null ? ` (seq ${r.seq}${r.duplicate ? ', already stored' : ''})` : ''}`;
    if (r.notConfigured) return `release notification not sent: ${r.error} (see docs/release-notifications.md)`;
    if (r.error) return `release notification FAILED for ${what}: ${r.error} (the deploy stands; ovhost announce ${r.service} retries)`;
    if (r.skipped === 'dry run') return `dry run: ${what}${r.from ? ` (from ${r.from})` : ''}; nothing sent`;
    return `release notification not sent: ${what} was ${r.skipped}${r.skipped && r.skipped.startsWith('already') ? ' (--force sends it again)' : ''}`;
}

module.exports = { announce, describeRelease, envelope, publish, loadCredentials, summary, stateFile, AnnounceError, EVENT_TYPE, DEFAULT_ENV_FILE };
