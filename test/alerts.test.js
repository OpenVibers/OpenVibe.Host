'use strict';
/**
 * Operator alerts (lib/alerts.js, WS-H task 11): `ovhost alerts relay` reads the firing alerts from Prometheus
 * and sends the complete set to Network's POST /internal/operator/alerts with Host's token
 * (network.operator.alert); a Prometheus that does not answer sends nothing; secrets never show; each run
 * leaves openvibe_alert_relay.prom for the textfile collector.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { toReport, fingerprint } = require('../lib/alerts');

const TOKEN = 'tok_ALERTS_TOKEN_MUST_NEVER_APPEAR_5d1e';
const HOST_SECRET = `${SECRET}-host`;
const PROM_FILE = '/var/lib/prometheus/node-exporter/openvibe_alert_relay.prom';

const FIRING = [
    { labels: { alertname: 'OpenVibeBackupMissed', severity: 'page', instance: '127.0.0.1:9100', job: 'node' }, annotations: { summary: 'No successful nightly backup for more than 30 hours' }, state: 'firing', activeAt: '2026-09-26T05:35:00.123Z', value: '1' },
    { labels: { alertname: 'OpenVibeDeployDrift', severity: 'ticket', service: 'live' }, annotations: { summary: 'live: main has had commits production does not run for more than a day', description: 'x'.repeat(1500) }, state: 'firing', activeAt: '2026-09-26T06:00:00Z' },
    { labels: { alertname: 'OpenVibeToolsJobProofFailed', severity: 'page' }, annotations: {}, state: 'pending', activeAt: '2026-09-26T13:59:00Z' },
    { labels: { alertname: 'bad name!' }, state: 'firing', activeAt: '2026-09-26T06:00:00Z' },
];

function withNetwork({ prom = { status: 200, body: { status: 'success', data: { alerts: FIRING } } }, network = 'ok' } = {}) {
    const host = scenario();
    host.put('/etc/openvibe/host.env', `OV_OAUTH_CLIENT_ID=host\nOV_OAUTH_CLIENT_SECRET="${HOST_SECRET}"\nEVENTS_URL=http://127.0.0.1:4300\nOV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000\n`, { mode: 0o600, owner: 'root' });
    host.put('/var/lib/prometheus/node-exporter/.keep', '');
    host.tokenRequests = [];
    host.delivered = [];
    if (prom) host.http.set('http://127.0.0.1:9090/api/v1/alerts', () => prom);
    host.http.set('http://127.0.0.1:4000/oauth/token', ({ body }) => {
        const form = Object.fromEntries(new URLSearchParams(body));
        host.tokenRequests.push(form);
        if (form.client_secret !== HOST_SECRET) return { status: 401, body: { error: 'invalid_client' } };
        return { status: 200, body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 300 } };
    });
    host.http.set('http://127.0.0.1:4000/internal/operator/alerts', ({ method, headers, body }) => {
        assert.strictEqual(method, 'POST');
        assert.strictEqual(headers.Authorization, `Bearer ${TOKEN}`);
        const doc = JSON.parse(body);
        host.delivered.push(doc);
        if (network !== 'ok') return network;
        return { status: 200, body: { ok: true, firing: doc.alerts.length, opened: doc.alerts.length, reminded: 0, resolved: 0, notified: doc.alerts.length } };
    });
    return host;
}

function noSecrets(host, out) {
    for (const s of [HOST_SECRET, TOKEN]) {
        assert.ok(!out.includes(s), 'the output shows no secret');
        for (const [p, f] of host.files) if (p !== '/etc/openvibe/host.env' && f.type === 'file') assert.ok(!String(f.content).includes(s), `${p} holds no secret`);
    }
}

runTests([
    test('toReport: firing only, the rule severities mapped, annotations clipped, no free-form labels, stable fingerprints', async () => {
        const r = toReport(FIRING);
        assert.deepStrictEqual(r.map((a) => [a.name, a.severity, a.service || null]), [['OpenVibeBackupMissed', 'critical', null], ['OpenVibeDeployDrift', 'warning', 'live']]);
        assert.strictEqual(r[0].started_at, '2026-09-26T05:35:00.123Z');
        assert.strictEqual(r[1].description.length, 1000);
        assert.ok(!JSON.stringify(r).includes('127.0.0.1:9100'), 'instance and job labels stay on the host');
        assert.strictEqual(r[0].fingerprint, fingerprint({ severity: 'page', alertname: 'OpenVibeBackupMissed', job: 'node', instance: '127.0.0.1:9100' }), 'label order does not matter');
        assert.notStrictEqual(r[0].fingerprint, r[1].fingerprint);
        const v = contracts.validate('network.operator-alerts-request@1', { source: 'prometheus', alerts: r });
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.deepStrictEqual(toReport([]), []);
    }),
    test('alerts relay: a token for network.operator.alert, the complete firing set delivered, metrics written', async () => {
        const host = withNetwork();
        const r = await host.cli('alerts', 'relay');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /ALERTS delivered: 2 firing; opened 2, reminded 0, resolved 0; 2 notification\(s\)/);
        assert.deepStrictEqual(host.tokenRequests.map((t) => [t.grant_type, t.client_id, t.audience, t.scope]), [['client_credentials', 'host', 'openvibe.network', 'network.operator.alert']]);
        assert.strictEqual(host.delivered.length, 1);
        const doc = host.delivered[0];
        assert.ok(contracts.validate('network.operator-alerts-request@1', doc).valid);
        assert.deepStrictEqual(doc.alerts.map((a) => a.name), ['OpenVibeBackupMissed', 'OpenVibeDeployDrift']);
        const prom = host.files.get(PROM_FILE).content;
        assert.match(prom, /^openvibe_alert_relay_last_run_ok 1$/m);
        assert.match(prom, /^openvibe_alert_relay_firing 2$/m);
        assert.match(prom, /^openvibe_alert_relay_last_success_timestamp_seconds \d+$/m);
        noSecrets(host, r.out);
    }),
    test('alerts relay: nothing firing sends an empty set (Network resolves what was open)', async () => {
        const host = withNetwork({ prom: { status: 200, body: { status: 'success', data: { alerts: [] } } } });
        const r = await host.cli('alerts', 'relay');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.delivered.map((d) => d.alerts), [[]]);
    }),
    test('alerts relay: Prometheus down or odd → nothing is sent (an empty set would resolve everything), exit 2', async () => {
        for (const prom of [null, { status: 503, body: 'no' }, { status: 200, body: { status: 'error' } }]) {
            const host = withNetwork({ prom });
            const r = await host.cli('alerts', 'relay');
            assert.strictEqual(r.code, 2, r.out);
            assert.match(r.out, /ALERTS not delivered \(prometheus\)/);
            assert.strictEqual(host.delivered.length, 0);
            assert.strictEqual(host.tokenRequests.length, 0);
            assert.match(host.files.get(PROM_FILE).content, /^openvibe_alert_relay_last_run_ok 0$/m);
            assert.match(host.files.get(PROM_FILE).content, /^openvibe_alert_relay_firing NaN$/m);
        }
    }),
    test('alerts relay: Network refusing → exit 2 with the stage; the last success is kept from the previous file', async () => {
        const host = withNetwork({ network: { status: 403, body: { error: 'Forbidden' } } });
        host.put(PROM_FILE, 'openvibe_alert_relay_last_success_timestamp_seconds 1790000000\n');
        const r = await host.cli('alerts', 'relay');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /ALERTS not delivered \(deliver\): Network answered 403: Forbidden/);
        assert.match(host.files.get(PROM_FILE).content, /^openvibe_alert_relay_last_success_timestamp_seconds 1790000000$/m);
        noSecrets(host, r.out);
    }),
    test('alerts relay --dry-run: reads and maps, asks for no token, sends nothing; --json', async () => {
        const host = withNetwork();
        const r = await host.cli('alerts', 'relay', '--dry-run');
        assert.strictEqual(r.code, 0);
        assert.match(r.out, /2 alert\(s\) firing \(dry run, nothing sent\)/);
        assert.match(r.out, /critical +OpenVibeBackupMissed/);
        assert.deepStrictEqual([host.tokenRequests.length, host.delivered.length], [0, 0]);
        const j = await withNetwork().cli('alerts', 'relay', '--json');
        assert.strictEqual(JSON.parse(j.out).result.opened, 2);
    }),
    test('alerts relay: no credentials → exit 2 at the credentials stage', async () => {
        const host = withNetwork();
        host.files.delete('/etc/openvibe/host.env');
        const r = await host.cli('alerts', 'relay');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /ALERTS not delivered \(credentials\)/);
    }),
    test('alerts: usage', async () => {
        const r = await scenario().cli('alerts');
        assert.notStrictEqual(r.code, 0);
        assert.match(r.out, /usage: ovhost alerts relay/);
    }),
]);
