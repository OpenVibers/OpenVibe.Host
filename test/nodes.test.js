'use strict';
/**
 * The node registry reporter (lib/nodes.js, WS-X1 step 3): `ovhost nodes report` measures each inventory node's
 * beacon (2xx fast = up, 2xx slow = degraded, anything else = down), sends network.node-report-request@1 to
 * Network with Host's token (network.node.report), never shows a secret, and leaves openvibe_nodes_report.prom.
 * The inventory refuses addresses and duplicate ids: the registry is public.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { normalise } = require('../lib/inventory');

const TOKEN = 'tok_NODES_TOKEN_MUST_NEVER_APPEAR_9c2f';
const HOST_SECRET = `${SECRET}-host`;
const PROM_FILE = '/var/lib/prometheus/node-exporter/openvibe_nodes_report.prom';
const NODES = [
    { id: 'oregon-1', name: 'Oregon 1', roles: ['web', 'app', 'data', 'ingest'], location: { region: 'us-west', country: 'US', city: 'Hillsboro' }, provider: 'ovh', beacon: 'https://openvibe.network/api/v1/nodes/oregon-1/beacon' },
    { id: 'probe-fra', name: 'Frankfurt probe', roles: ['edge-probe'], location: { region: 'eu-central', country: 'DE' }, beacon: 'https://fra.example.test/beacon' },
    { id: 'probe-sgp', name: 'Singapore probe', roles: ['edge-probe'], location: { region: 'ap-southeast', country: 'SG' }, beacon: 'https://sgp.example.test/beacon' },
];

function withNetwork({ network = 'ok' } = {}) {
    const host = scenario();
    host.inv.nodes = normalise({ services: {}, nodes: NODES }).nodes;
    host.inv.nodeSource = 'oregon';
    host.put('/etc/openvibe/host.json', JSON.stringify({ ...JSON.parse(host.read('/etc/openvibe/host.json')), nodeSource: 'oregon', nodes: NODES }), { mode: 0o640, owner: 'root' });
    host.put('/etc/openvibe/host.env', `OV_OAUTH_CLIENT_ID=host\nOV_OAUTH_CLIENT_SECRET="${HOST_SECRET}"\nEVENTS_URL=http://127.0.0.1:4300\nOV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000\n`, { mode: 0o600, owner: 'root' });
    host.put('/var/lib/prometheus/node-exporter/.keep', '');
    host.tokenRequests = [];
    host.delivered = [];
    host.http.set(NODES[0].beacon, () => ({ status: 204, body: '' }));
    host.http.set(NODES[1].beacon, () => { host.exec.sleep(2500); return { status: 204, body: '' }; });
    host.http.set(NODES[2].beacon, () => ({ status: 502, body: 'bad gateway' }));
    host.http.set('http://127.0.0.1:4000/oauth/token', ({ body }) => {
        const form = Object.fromEntries(new URLSearchParams(body));
        host.tokenRequests.push(form);
        if (form.client_secret !== HOST_SECRET) return { status: 401, body: { error: 'invalid_client' } };
        return { status: 200, body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 300 } };
    });
    host.http.set('http://127.0.0.1:4000/internal/nodes/report', ({ method, headers, body }) => {
        assert.strictEqual(method, 'POST');
        assert.strictEqual(headers.Authorization, `Bearer ${TOKEN}`);
        const doc = JSON.parse(body);
        host.delivered.push(doc);
        if (network !== 'ok') return network;
        return { status: 200, body: { nodes: doc.nodes, generated_at: '2026-09-28T12:00:00Z' } };
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
    test('inventory: nodes need ids and https beacons, never an address, no duplicates', async () => {
        assert.deepStrictEqual(normalise({ services: {} }).nodes, []);
        assert.strictEqual(normalise({ services: {} }).nodeSource, 'primary');
        assert.throws(() => normalise({ services: {}, nodes: [{ ...NODES[0], address: '15.0.0.1' }] }), /must not carry an address/);
        assert.throws(() => normalise({ services: {}, nodes: [NODES[0], NODES[0]] }), /listed twice/);
        assert.throws(() => normalise({ services: {}, nodes: [{ ...NODES[0], beacon: 'http://x.test/b' }] }), /https:\/\//);
        assert.throws(() => normalise({ services: {}, nodes: {} }), /must be an array/);
    }),
    test('nodes report: beacons measured, the complete set sent with network.node.report, metrics written', async () => {
        const host = withNetwork();
        const r = await host.cli('nodes', 'report');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /NODES reported: 3 node\(s\) of oregon; the registry lists 3, down: probe-sgp/);
        assert.match(r.out, /up +oregon-1 +\d+ ms/);
        assert.match(r.out, /degraded +probe-fra +2500 ms/);
        assert.match(r.out, /down +probe-sgp +beacon answered 502/);
        assert.deepStrictEqual(host.tokenRequests.map((t) => [t.grant_type, t.client_id, t.audience, t.scope]), [['client_credentials', 'host', 'openvibe.network', 'network.node.report']]);
        const doc = host.delivered[0];
        assert.ok(contracts.validate('network.node-report-request@1', doc).valid);
        assert.deepStrictEqual(doc.nodes.map((n) => [n.id, n.health.status]), [['oregon-1', 'up'], ['probe-fra', 'degraded'], ['probe-sgp', 'down']]);
        const prom = host.read(PROM_FILE);
        assert.match(prom, /openvibe_nodes_report_last_run_ok 1/);
        assert.match(prom, /openvibe_nodes\{status="down"\} 1/);
        assert.match(prom, /openvibe_nodes_report_last_success_timestamp_seconds \d+/);
        noSecrets(host, r.out);
    }),
    test('dry run sends nothing; a refused report fails loudly and keeps the last success time', async () => {
        const host = withNetwork({ network: { status: 403, body: { error: 'insufficient_scope' } } });
        const dry = await host.cli('nodes', 'report', '--dry-run');
        assert.strictEqual(dry.code, 0, dry.out);
        assert.match(dry.out, /3 node\(s\) of oregon \(dry run, nothing sent\)/);
        assert.strictEqual(host.delivered.length, 0);
        host.put(PROM_FILE, 'openvibe_nodes_report_last_success_timestamp_seconds 1790000000\n');
        const r = await host.cli('nodes', 'report');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /NODES not reported \(deliver\): Network answered 403: insufficient_scope/);
        const prom = host.read(PROM_FILE);
        assert.match(prom, /openvibe_nodes_report_last_run_ok 0/);
        assert.match(prom, /openvibe_nodes_report_last_success_timestamp_seconds 1790000000/);
        noSecrets(host, r.out);
    }),
    test('an inventory node the contract refuses stops the run before any token is asked for', async () => {
        const host = withNetwork();
        host.put('/etc/openvibe/host.json', JSON.stringify({ ...JSON.parse(host.read('/etc/openvibe/host.json')), nodes: [{ ...NODES[0], roles: ['gameserver'] }] }), { mode: 0o640, owner: 'root' });
        const r = await host.cli('nodes', 'report');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /NODES not reported \(inventory\): .*roles/);
        assert.strictEqual(host.tokenRequests.length, 0);
    }),
]);
