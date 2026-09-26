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
 * A Prometheus that does not answer sends nothing: an empty set would resolve every open alert. Each run
 * writes openvibe_alert_relay.prom to the textfile collector (last run, last success, alerts firing).
 * Credentials: Host's principal from /etc/openvibe/host.env (announce.js loadCredentials; the secret and the
 * token are never printed).
 */
const crypto = require('crypto');
const path = require('path');
const { loadCredentials } = require('./announce');

const DEFAULT_PROMETHEUS = 'http://127.0.0.1:9090';
// The rules' severity label: page (and critical) pages now; ticket (and warning) pages at high; info is quiet.
const SEVERITIES = { critical: 'critical', page: 'critical', warning: 'warning', ticket: 'warning', info: 'info' };
const NAME_RE = /^[A-Za-z][A-Za-z0-9_:]{0,99}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';
const MAX = 200;

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
    const alerts = toReport(data.data.alerts);
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

module.exports = { relay, toReport, fingerprint, writeMetrics, AlertsError, DEFAULT_PROMETHEUS };
