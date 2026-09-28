'use strict';
/**
 * `ovhost nodes report` (roadmap WS-X1 step 3, ADR-034 §12): the machines this inventory knows, with their health
 * now, sent to Network's node registry (POST /internal/nodes/report, network.node.report, Host's principal).
 * openvibe-nodes.timer runs it every five minutes; products read the result at GET /api/v1/nodes.
 *
 * The inventory's "nodes" array holds each machine's public description (network.node@1 without health and
 * updated_at: id, name, roles, region-level location, provider, beacon); "nodeSource" names this inventory (default
 * "primary"). Health is measured, never assumed: each node's beacon is fetched; a 2xx within 2 s is up, a slower 2xx
 * degraded, anything else down. A node removed from the inventory is marked down by Network, not deleted.
 * Every run leaves openvibe_nodes_report.prom for the textfile collector (OpenVibeNodeReportStale).
 */
const path = require('path');
const { loadCredentials } = require('./announce');

const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';
const SOURCE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SLOW_MS = 2000;

async function measure(exec, beacon) {
    const t0 = exec.now();
    const r = await exec.request(beacon, { method: 'GET', headers: { 'user-agent': 'openvibe-host-nodes' }, timeoutMs: 5000 });
    const ms = exec.now() - t0;
    if (!(r.status >= 200 && r.status < 300)) return { status: 'down', detail: r.status ? `beacon answered ${r.status}` : `beacon unreachable (${r.error || 'no answer'})` };
    return { status: ms > SLOW_MS ? 'degraded' : 'up', detail: `${ms} ms` };
}

/** The report body (network.node-report-request@1) from the inventory, with measured health. */
async function build(exec, inv) {
    const source = inv.nodeSource || 'primary';
    if (!SOURCE_RE.test(source)) throw new Error(`nodeSource "${source}" must match ${SOURCE_RE}`);
    const at = new Date(exec.now()).toISOString();
    const nodes = [];
    const probes = [];
    for (const n of inv.nodes || []) {
        const m = await measure(exec, n.beacon);
        probes.push({ id: n.id, ...m });
        nodes.push({ ...n, health: { status: m.status, checked_at: at }, updated_at: at });
    }
    const body = { source, nodes };
    const v = require('openvibe-contracts').validate('network.node-report-request@1', body);
    if (!v.valid) throw new Error(`the inventory's nodes do not match network.node-report-request@1: ${(v.errors || []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    return { body, probes };
}

async function writeMetrics(exec, dir, r) {
    const now = Math.floor(exec.now() / 1000);
    let lastOk = r.ok ? now : null;
    if (!r.ok) {
        const prev = (await exec.readFile(path.join(dir, 'openvibe_nodes_report.prom'))) || '';
        const m = prev.match(/^openvibe_nodes_report_last_success_timestamp_seconds (\d+)$/m);
        if (m) lastOk = Number(m[1]);
    }
    const count = (s) => (r.probes || []).filter((p) => p.status === s).length;
    const lines = [
        '# HELP openvibe_nodes_report_last_run_ok 1 when the last ovhost nodes report reached Network.',
        '# TYPE openvibe_nodes_report_last_run_ok gauge',
        `openvibe_nodes_report_last_run_ok ${r.ok ? 1 : 0}`,
        '# HELP openvibe_nodes Nodes of this inventory by the health the last run measured.',
        '# TYPE openvibe_nodes gauge',
        ...['up', 'degraded', 'down'].map((s) => `openvibe_nodes{status="${s}"} ${count(s)}`),
    ];
    if (lastOk) lines.push('# HELP openvibe_nodes_report_last_success_timestamp_seconds When a report last reached Network.', '# TYPE openvibe_nodes_report_last_success_timestamp_seconds gauge', `openvibe_nodes_report_last_success_timestamp_seconds ${lastOk}`);
    await exec.writeFile(path.join(dir, 'openvibe_nodes_report.prom'), `${lines.join('\n')}\n`, { mode: 0o644 });
}

/** One run → { ok, source, probes, stage?, error?, dryRun? }. opts: envFile, env, dryRun, metrics (default true). */
async function report(ctx, { envFile = null, env = {}, dryRun = false, metrics = true } = {}) {
    const { exec, inv } = ctx;
    const done = async (r) => {
        if (metrics && !dryRun) { try { await writeMetrics(exec, inv.textfileDir || TEXTFILE_DIR, r); } catch { /* metrics never fail a run */ } }
        return r;
    };
    let built;
    try { built = await build(exec, inv); } catch (err) { return done({ ok: false, stage: 'inventory', error: err.message }); }
    const { body, probes } = built;
    if (dryRun) return { ok: true, dryRun: true, source: body.source, probes, body };
    const creds = await loadCredentials(exec, inv, { file: envFile, env });
    if (creds.error) return done({ ok: false, stage: 'credentials', source: body.source, probes, error: creds.error });
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.secret, audience: 'openvibe.network', scope: 'network.node.report' });
    const t = await exec.request(`${creds.networkUrl}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeoutMs: 5000 });
    let token = null;
    try { token = t.status === 200 ? JSON.parse(t.body).access_token : null; } catch { token = null; }
    if (typeof token !== 'string' || !token) return done({ ok: false, stage: 'token', source: body.source, probes, error: t.status ? `the token endpoint answered ${t.status}` : `Network unreachable (${t.error || 'no answer'})` });
    const r = await exec.request(`${creds.networkUrl}/internal/nodes/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), timeoutMs: 10000,
    });
    let result = null;
    try { result = JSON.parse(r.body); } catch { result = null; }
    if (r.status !== 200 || !result || !Array.isArray(result.nodes)) {
        return done({ ok: false, stage: 'deliver', source: body.source, probes, error: r.status ? `Network answered ${r.status}${result && result.error ? `: ${result.error}` : ''}` : `Network unreachable (${r.error || 'no answer'})` });
    }
    const down = result.nodes.filter((n) => n.health && n.health.status === 'down').map((n) => n.id);
    return done({ ok: true, source: body.source, probes, registered: result.nodes.length, down });
}

module.exports = { report, build, measure, writeMetrics };
