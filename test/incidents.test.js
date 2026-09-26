'use strict';
/**
 * Incident and maintenance controls (lib/incidents.js, WS-N task 12): ovhost incident / maintenance post to
 * Network's status page with Host's token (network.status.incident); freezes hold deploys (exit 6) but never
 * rollbacks; --force goes through and says so; a window scheduled with --freeze is lifted by complete.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { scenario, push, test, runTests, SECRET } = require('./helpers');

const TOKEN = 'tok_INCIDENT_TOKEN_MUST_NEVER_APPEAR_7a2c';
const HOST_SECRET = `${SECRET}-host`;
const INC = 'inc_01JAB2C3D4E5F6G7H8J9K0MNPQ';

function withNetwork() {
    const host = scenario();
    host.put('/etc/openvibe/host.env', `OV_OAUTH_CLIENT_ID=host\nOV_OAUTH_CLIENT_SECRET="${HOST_SECRET}"\nEVENTS_URL=http://127.0.0.1:4300\nOV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000\n`, { mode: 0o600, owner: 'root' });
    host.tokenRequests = [];
    host.posts = [];
    const store = [];
    host.http.set('http://127.0.0.1:4000/oauth/token', ({ body }) => {
        const form = Object.fromEntries(new URLSearchParams(body));
        host.tokenRequests.push(form);
        if (form.client_secret !== HOST_SECRET) return { status: 401, body: { error: 'invalid_client' } };
        return { status: 200, body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 300 } };
    });
    const now = '2026-09-26T16:00:00.000Z';
    host.http.set('http://127.0.0.1:4000/api/v1/status/incidents', ({ method, headers, body }) => {
        if (method === 'GET') return { status: 200, body: { active: store.filter((i) => !['resolved', 'completed'].includes(i.state)), recent: store.filter((i) => ['resolved', 'completed'].includes(i.state)) } };
        assert.strictEqual(headers.Authorization, `Bearer ${TOKEN}`);
        const b = JSON.parse(body);
        assert.ok(contracts.validate('network.status-incident-request@1', b).valid, JSON.stringify(b));
        host.posts.push(b);
        const i = { id: INC, kind: b.kind, title: b.title, ...(b.kind === 'incident' ? { severity: b.severity } : {}), state: b.kind === 'maintenance' ? 'scheduled' : 'investigating', services: b.services, starts_at: b.starts_at || now, ends_at: b.ends_at || null, updates: [{ at: now, state: 'investigating', message: b.message }], created_at: now, updated_at: now };
        store.push(i);
        return { status: 201, body: i };
    });
    host.http.set(`http://127.0.0.1:4000/api/v1/status/incidents/${INC}/updates`, ({ headers, body }) => {
        assert.strictEqual(headers.Authorization, `Bearer ${TOKEN}`);
        const b = JSON.parse(body);
        assert.ok(contracts.validate('network.status-incident-request@1', b).valid);
        host.posts.push(b);
        const i = store.find((x) => x.id === INC);
        if (['resolved', 'completed'].includes(i.state)) return { status: 409, body: { detail: `this ${i.kind} is ${i.state}` } };
        i.state = b.state; i.updates.push({ at: now, state: b.state, message: b.message });
        return { status: 200, body: i };
    });
    return host;
}

runTests([
    test('incident open / update / list: Host\'s token for network.status.incident, contract bodies, no secret shown', async () => {
        const host = withNetwork();
        let r = await host.cli('incident', 'open', '--title', 'Live streams stall on start', '--services', 'live', '--severity', 'major', '--message', 'New streams take a minute to start.');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, new RegExp(`${INC}  major  investigating  live  Live streams stall on start`));
        assert.deepStrictEqual(host.tokenRequests.map((t) => [t.audience, t.scope]), [['openvibe.network', 'network.status.incident']]);
        r = await host.cli('incident', 'update', INC, '--state', 'resolved', '--message', 'Rebound.');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /resolved/);
        r = await host.cli('incident', 'update', INC, '--state', 'monitoring', '--message', 'again');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /Network answered 409: this incident is resolved/);
        r = await host.cli('incident', 'list');
        assert.match(r.out, /active: 0/);
        assert.match(r.out, /closed in the last 30 days: 1/);
        for (const s of [HOST_SECRET, TOKEN]) assert.ok(!r.out.includes(s));
    }),
    test('bad input stops before Network: services, ids, missing text', async () => {
        const host = withNetwork();
        assert.strictEqual((await host.cli('incident', 'open', '--title', 'x', '--services', 'Bad Id', '--message', 'm')).code, 1);
        assert.strictEqual((await host.cli('incident', 'open', '--title', 'x', '--services', 'live')).code, 1, '--message is required');
        assert.strictEqual((await host.cli('incident', 'update', 'nope', '--state', 'resolved', '--message', 'm')).code, 1);
        assert.strictEqual(host.posts.length, 0);
    }),
    test('freeze holds deploys (exit 6), never rollbacks; --force goes through loudly; unfreeze lifts it', async () => {
        const host = withNetwork();
        push(host, 'live', { 'server/index.js': 'console.log(2);' }, 'server change');
        let r = await host.cli('freeze', 'live', '--reason', 'incident: streams stall', '--incident', INC);
        assert.strictEqual(r.code, 0, r.out);
        r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 6, r.out);
        assert.match(r.out, /live is frozen since .*: incident: streams stall \(inc_/);
        assert.deepStrictEqual(host.restarts(), [], 'nothing restarted');
        r = await host.cli('freeze');
        assert.match(r.out, /^live {2}since .* {2}incident: streams stall/m);
        r = await host.cli('deploy', 'live', '--force');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /--force: deploying live through the freeze/);
        await host.cli('unfreeze', 'live');
        await host.cli('freeze', 'all', '--reason', 'network-wide change window');
        push(host, 'live', { 'server/index.js': 'console.log(3);' }, 'another');
        r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 6);
        assert.match(r.out, /\(all services\)/);
        r = await host.cli('rollback', 'live');
        assert.notStrictEqual(r.code, 6, 'a rollback is never frozen');
        assert.match((await host.cli('unfreeze', 'all')).out, /unfrozen: all/);
        assert.match((await host.cli('unfreeze', 'all')).out, /was not frozen/);
    }),
    test('maintenance schedule --freeze freezes its services; complete lifts them', async () => {
        const host = withNetwork();
        let r = await host.cli('maintenance', 'schedule', '--title', 'Media storage move', '--services', 'media,live', '--from', '2026-09-28T03:00:00Z', '--until', '2026-09-28T04:00:00Z', '--message', 'Uploads pause for up to an hour.', '--freeze');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.posts[0], { kind: 'maintenance', title: 'Media storage move', services: ['media', 'live'], message: 'Uploads pause for up to an hour.', starts_at: '2026-09-28T03:00:00.000Z', ends_at: '2026-09-28T04:00:00.000Z' });
        r = await host.cli('freeze');
        assert.match(r.out, /live .*maintenance: Media storage move/);
        assert.match(r.out, /media .*maintenance: Media storage move/);
        r = await host.cli('maintenance', 'start', INC, '--message', 'Moving now.');
        assert.strictEqual(r.code, 0);
        r = await host.cli('maintenance', 'complete', INC, '--message', 'Done.');
        assert.strictEqual(r.code, 0, r.out);
        assert.match((await host.cli('freeze')).out, /nothing is frozen/);
        assert.strictEqual((await host.cli('maintenance', 'schedule', '--title', 'x', '--services', 'live', '--from', 'soon', '--until', 'later', '--message', 'm')).code, 1);
    }),
    test('not configured: a clear refusal', async () => {
        const host = scenario();
        const r = await host.cli('incident', 'open', '--title', 'x', '--services', 'live', '--message', 'm');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /not configured/);
    }),
]);
