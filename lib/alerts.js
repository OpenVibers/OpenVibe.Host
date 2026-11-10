'use strict';
/**
 * `ovhost alerts relay` (roadmap WS-H task 11): the alerts firing in the host's Prometheus, delivered to the
 * operator. Prometheus evaluates the rules in deploy/prometheus/openvibe-rules.yml (backups, the developer path,
 * the Tools job proof, the browser check), but nothing delivered them. Every two minutes
 * (openvibe-alerts.timer) this reads GET <prometheus>/api/v1/alerts, keeps the firing ones (not pending), and
 * sends the complete set to OpenVibe.Network's POST /internal/operator/alerts (network.operator.alert,
 * network.operator-alerts-request@1) with Host's service token. Network pages the owner when an alert opens,
 * once a day while it stays open, and when it resolves (it drops out of the set).
 *
 * Per alert: fingerprint = sha256 of the alert name and its sorted labels (first 32 hex), name = alertname,
 * severity = the severity label (page or critical → critical, ticket or warning → warning, info; anything else is
 * warning), summary and description
 * = the rule's annotations, service = the service label when it is a service id, started_at = activeAt.
 * Free-form labels never leave the host.
 *
 * A browser-check alert (`OpenVibeBrowserCheckFailed`) carries what its result file knows, so the notification can
 * explain it in words instead of repeating the rule: up to five `details` (route, check, axe rule and impact, at
 * most five target selectors, the rule's help text and Deque help page, the failing page's own URL, a console
 * error, a viewport width, a status, overflow offenders), the release sha (resolved to the full commit when the
 * service's checkout has it) and `release_url`, `checked_at` and `failing_since`. Links are built on the host from
 * facts it has and are accepted only when https on one of the network's own domains, git.openvibe.codes, github.com
 * or dequeuniversity.com. A plain Prometheus alert carries only its annotations, as before.
 *
 * A Prometheus that does not answer sends nothing: an empty set would resolve every open alert. Each run
 * writes openvibe_alert_relay.prom to the textfile collector (last run, last success, alerts firing).
 * Credentials: Host's principal from /etc/openvibe/host.env (announce.js loadCredentials; the secret and the
 * token are never printed).
 */
const crypto = require('crypto');
const path = require('path');
const { loadCredentials } = require('./announce');
const { axeHelpUrl } = require('./links');

const DEFAULT_PROMETHEUS = 'http://127.0.0.1:9090';
// The rules' severity label: page (and critical) pages now; ticket (and warning) pages at high; info is quiet.
const SEVERITIES = { critical: 'critical', page: 'critical', warning: 'warning', ticket: 'warning', info: 'info' };
const NAME_RE = /^[A-Za-z][A-Za-z0-9_:]{0,99}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';
const MAX = 200;
const MAX_DETAILS = 5;
const MAX_TARGETS = 5;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
// The only hosts a link may point at, besides the network's own public domains (contracts' service manifests).
const LINK_HOSTS = new Set(['git.openvibe.codes', 'github.com', 'dequeuniversity.com']);

class AlertsError extends Error {
    constructor(message, exitCode = 2) { super(message); this.name = 'AlertsError'; this.exitCode = exitCode; }
}

function fingerprint(labels) {
    const keys = Object.keys(labels || {}).sort();
    return crypto.createHash('sha256').update(JSON.stringify(keys.map((k) => [k, String(labels[k])]))).digest('hex').slice(0, 32);
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Prometheus alerts (the /api/v1/alerts data) → network.operator-alerts-request@1 alerts. */
function toReport(promAlerts) {
    const out = new Map();
    for (const a of promAlerts || []) {
        if (!a || a.state !== 'firing') continue;
        const labels = a.labels || {};
        const name = String(labels.alertname || '');
        if (!NAME_RE.test(name)) continue;
        const ann = a.annotations || {};
        const started = Date.parse(a.activeAt);
        const item = {
            fingerprint: fingerprint(labels),
            name,
            severity: SEVERITIES[labels.severity] || 'warning',
            summary: clip(ann.summary || name, 300) || name,
            started_at: new Date(Number.isFinite(started) ? started : Date.now()).toISOString(),
        };
        const description = clip(ann.description, 1000);
        if (description) item.description = description;
        if (SERVICE_RE.test(String(labels.service || ''))) item.service = labels.service;
        out.set(item.fingerprint, item);
    }
    return [...out.values()].slice(0, MAX);
}

// ── What a browser-check alert carries (the result file's facts, in text and https links) ──────────

let domainsCache = null;

/** The network's own public domains, from the service manifests; the only site hosts a link may use. */
function networkDomains(lib = null) {
    if (domainsCache) return domainsCache;
    let c = lib;
    if (!c) { try { c = require('openvibe-contracts'); } catch { c = null; } }
    const out = new Set();
    for (const m of (c && c.services && c.services.manifests) || []) {
        for (const d of m.domains || []) if (d) out.add(String(d).toLowerCase());
        try { const h = new URL(m.publicOrigin).hostname.toLowerCase(); if (h) out.add(h); } catch { /* no origin */ }
    }
    domainsCache = out;
    return out;
}

/** An https link on an allowed host, else null. Every URL a notification shows passes through here. */
function safeLink(value, domains) {
    try {
        const u = new URL(String(value));
        if (u.protocol !== 'https:') return null;
        const host = u.hostname.toLowerCase();
        if (!LINK_HOSTS.has(host) && !domains.has(host)) return null;
        return u.href;
    } catch { return null; }
}

/** The failing page on the site's own origin: https, a network domain, and never off that origin. */
function pageLink(origin, route, domains) {
    try {
        const base = new URL(String(origin));
        if (base.protocol !== 'https:' || !domains.has(base.hostname.toLowerCase())) return null;
        const u = new URL(String(route || '/'), base);
        return u.origin === base.origin ? u.href : null;
    } catch { return null; }
}

/** The repository slug (OpenVibers/OpenVibe.Domains) from the service manifest, when it declares one. */
function serviceRepo(service, lib) {
    try {
        const m = lib && lib.services && typeof lib.services.get === 'function' ? lib.services.get(service) : null;
        return m && REPO_RE.test(String(m.repository || '')) ? String(m.repository) : null;
    } catch { return null; }
}

/** The deployed commit's full sha: git in the service's checkout when it knows the short one from /release.json. */
async function fullCommit(exec, inv, service, short) {
    const s = String(short || '').toLowerCase();
    if (!COMMIT_SHA_RE.test(s)) return null;
    if (s.length === 40) return s;
    const svc = inv.services && inv.services[service];
    const dir = svc && svc.repo;
    if (!dir) return s;
    try {
        const r = await exec.run('git', ['-C', dir, '-c', `safe.directory=${dir}`, 'rev-parse', '--verify', `${s}^{commit}`], { as: svc.owner || 'root' });
        const out = String(r.stdout || '').trim().toLowerCase();
        return r.code === 0 && /^[0-9a-f]{40}$/.test(out) ? out : s;
    } catch { return s; }
}

/** The commit page: git.openvibe.codes when the repository is mirrored there, else github.com. */
async function releaseLink(exec, repo, sha, cache = new Map()) {
    if (!repo || !COMMIT_SHA_RE.test(String(sha || ''))) return null;
    let forge = cache.get(repo);
    if (forge === undefined) {
        forge = false;
        try { forge = (await exec.request(`https://git.openvibe.codes/${repo}`, { timeoutMs: 3000 })).status === 200; } catch { forge = false; }
        cache.set(repo, forge);
    }
    return forge ? `https://git.openvibe.codes/${repo}/commit/${sha}` : `https://github.com/${repo}/commit/${sha}`;
}

/** One result-file detail → the contract's optional fields, with only allowed https links. */
function browserDetail(d, origin, domains, axeVersion = null) {
    if (!d || typeof d !== 'object') return null;
    const check = clip(d.check, 40);
    if (!check) return null;
    const out = { check };
    const route = typeof d.route === 'string' ? clip(d.route, 200) : '';
    if (route) out.route = route;
    if (d.rule) out.rule = clip(d.rule, 100);
    if (['minor', 'moderate', 'serious', 'critical'].includes(d.impact)) out.impact = d.impact;
    if (Array.isArray(d.targets)) { const t = d.targets.slice(0, MAX_TARGETS).map((x) => clip(x, 160)).filter(Boolean); if (t.length) out.targets = t; }
    if (d.help) out.help = clip(d.help, 300);
    if (check === 'axe') {
        const help = safeLink(d.help_url, domains) || axeHelpUrl(d.rule, axeVersion);
        if (help) out.help_url = help;
    }
    const page = pageLink(origin, route, domains);
    if (page) out.page_url = page;
    if (d.message) out.message = clip(d.message, 300);
    if (Number.isInteger(d.width) && d.width >= 0 && d.width <= 10000) out.width = d.width;
    if (Number.isInteger(d.status) && d.status >= 100 && d.status <= 599) out.status = d.status;
    if (Array.isArray(d.offenders)) { const o = d.offenders.slice(0, MAX_TARGETS).map((x) => clip(x, 160)).filter(Boolean); if (o.length) out.offenders = o; }
    return out;
}

/**
 * Add the browser-check result file's facts to the alerts that have one. A missing or stale file, an unreachable
 * Forgejo or a checkout without the commit never fails the relay: the alert stays what Prometheus said.
 */
async function enrichBrowser(ctx, alerts, { contracts: lib = null, domains = null, forgejo = new Map() } = {}) {
    const { exec, inv } = ctx;
    const libc = lib || (() => { try { return require('openvibe-contracts'); } catch { return null; } })();
    const allowed = domains || networkDomains(libc);
    const repos = new Map();
    for (const a of alerts) {
        if (a.name !== 'OpenVibeBrowserCheckFailed' || !a.service) continue;
        a.failing_since = a.started_at;
        try {
            let state = null;
            try { state = JSON.parse((await exec.readFile(path.join(inv.stateDir, 'browser-watch', `${a.service}.json`))) || 'null'); } catch { state = null; }
            if (!state || state.ok !== false) continue;
            const details = [];
            for (const d of (state.details || []).slice(0, MAX_DETAILS)) { const x = browserDetail(d, state.origin, allowed, state.axeVersion); if (x) details.push(x); }
            const sha = await fullCommit(exec, inv, a.service, state.release);
            if (sha) {
                a.release = sha;
                let repo = repos.get(a.service);
                if (repo === undefined) { repo = serviceRepo(a.service, libc); repos.set(a.service, repo); }
                const url = await releaseLink(exec, repo, sha, forgejo);
                if (url) a.release_url = url;
            }
            if (details.length) a.details = details;
            const checked = Date.parse(state.checkedAt);
            if (Number.isFinite(checked)) a.checked_at = new Date(checked).toISOString();
        } catch { /* the alert keeps what Prometheus said */ }
    }
    return alerts;
}

async function writeMetrics(exec, dir, r) {
    if (!(await exec.readdir(dir))) return false;
    const now = Math.floor(Date.now() / 1000);
    let lastOk = r.ok ? now : null;
    if (!lastOk) {
        const prev = (await exec.readFile(path.join(dir, 'openvibe_alert_relay.prom'))) || '';
        const m = prev.match(/^openvibe_alert_relay_last_success_timestamp_seconds (\d+)$/m);
        lastOk = m ? Number(m[1]) : null;
    }
    const lines = [
        '# HELP openvibe_alert_relay_last_run_timestamp_seconds When ovhost alerts relay last ran.',
        '# TYPE openvibe_alert_relay_last_run_timestamp_seconds gauge',
        `openvibe_alert_relay_last_run_timestamp_seconds ${now}`,
        '# HELP openvibe_alert_relay_last_run_ok 1 when the last run delivered the firing set to Network.',
        '# TYPE openvibe_alert_relay_last_run_ok gauge',
        `openvibe_alert_relay_last_run_ok ${r.ok ? 1 : 0}`,
        '# HELP openvibe_alert_relay_firing Alerts firing at the last run that read Prometheus.',
        '# TYPE openvibe_alert_relay_firing gauge',
        `openvibe_alert_relay_firing ${r.firing == null ? 'NaN' : r.firing}`,
    ];
    if (lastOk) lines.push('# HELP openvibe_alert_relay_last_success_timestamp_seconds When a run last delivered.', '# TYPE openvibe_alert_relay_last_success_timestamp_seconds gauge', `openvibe_alert_relay_last_success_timestamp_seconds ${lastOk}`);
    await exec.writeFile(path.join(dir, 'openvibe_alert_relay.prom'), `${lines.join('\n')}\n`, { mode: 0o644 });
    return true;
}

/**
 * One relay run. Answers { ok, firing, alerts, result?, stage?, error?, dryRun? }.
 * opts: prometheus (URL), envFile, env, dryRun (read and map only), metrics (default true).
 */
async function relay(ctx, { prometheus = null, envFile = null, env = {}, dryRun = false, metrics = true } = {}) {
    const { exec, inv } = ctx;
    const prom = String(prometheus || env.OVHOST_PROMETHEUS_URL || (inv.prometheus && inv.prometheus.url) || DEFAULT_PROMETHEUS).replace(/\/+$/, '');
    const done = async (r) => {
        if (metrics && !dryRun) { try { await writeMetrics(exec, inv.textfileDir || TEXTFILE_DIR, r); } catch { /* metrics never fail a run */ } }
        return r;
    };
    const p = await exec.request(`${prom}/api/v1/alerts`, { timeoutMs: 5000 });
    let data = null;
    try { data = p.status === 200 ? JSON.parse(p.body) : null; } catch { data = null; }
    if (!data || data.status !== 'success' || !data.data || !Array.isArray(data.data.alerts)) {
        return done({ ok: false, stage: 'prometheus', firing: null, error: p.status ? `Prometheus answered ${p.status}` : `Prometheus unreachable (${p.error || 'no answer'})` });
    }
    const alerts = await enrichBrowser(ctx, toReport(data.data.alerts));
    const body = { source: 'prometheus', sent_at: new Date().toISOString(), alerts };
    if (dryRun) return { ok: true, dryRun: true, firing: alerts.length, alerts };

    const creds = await loadCredentials(exec, inv, { file: envFile, env });
    if (creds.error) return done({ ok: false, stage: 'credentials', firing: alerts.length, alerts, error: creds.error });
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.secret, audience: 'openvibe.network', scope: 'network.operator.alert' });
    const t = await exec.request(`${creds.networkUrl}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeoutMs: 5000 });
    let token = null;
    try { token = t.status === 200 ? JSON.parse(t.body).access_token : null; } catch { token = null; }
    if (typeof token !== 'string' || !token) return done({ ok: false, stage: 'token', firing: alerts.length, alerts, error: t.status ? `the token endpoint answered ${t.status}` : `Network unreachable (${t.error || 'no answer'})` });
    const r = await exec.request(`${creds.networkUrl}/internal/operator/alerts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), timeoutMs: 10000,
    });
    let result = null;
    try { result = JSON.parse(r.body); } catch { result = null; }
    if (r.status !== 200 || !result || result.ok !== true) {
        return done({ ok: false, stage: 'deliver', firing: alerts.length, alerts, error: r.status ? `Network answered ${r.status}${result && result.error ? `: ${result.error}` : ''}` : `Network unreachable (${r.error || 'no answer'})` });
    }
    return done({ ok: true, firing: alerts.length, alerts, result });
}

module.exports = { relay, toReport, enrichBrowser, browserDetail, networkDomains, safeLink, fullCommit, releaseLink, fingerprint, writeMetrics, AlertsError, DEFAULT_PROMETHEUS };
