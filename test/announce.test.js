'use strict';
/**
 * Release notifications (lib/announce.js, WS-P task 9): `ovhost announce` and the announcement after a
 * deploy publish host.deploy.activated to OpenVibe.Events with Host's service token, never fail or
 * change a deploy, send one release once, and never show the client secret or the token.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { scenario, push, test, runTests, SECRET } = require('./helpers');
const { main } = require('../lib/cli');

const TOKEN = 'tok_SERVICE_TOKEN_MUST_NEVER_APPEAR_91c2';
const ENV_FILE = '/etc/openvibe/host.env';
const HOST_SECRET = `${SECRET}-host`;

/** The installed openvibe-contracts has host.deploy.activated@1 from 0.58.0; older pins skip this check. */
function payloadSchemaCheck(payload) {
    let known = true;
    try { contracts.schema('host.deploy.activated'); } catch { known = false; }
    if (!known) return;
    const v = contracts.validate('host.deploy.activated@1', payload);
    assert.ok(v.valid, JSON.stringify(v.errors));
}

/** A scenario with Host's credentials, Network's token endpoint and Events' publish API. */
function withEvents({ events = 'ok', token = 'ok', envFile = ENV_FILE, envText } = {}) {
    const host = scenario();
    host.put(envFile, envText != null ? envText : `OV_OAUTH_CLIENT_ID=host\nOV_OAUTH_CLIENT_SECRET="${HOST_SECRET}"\nEVENTS_URL=http://127.0.0.1:4300\nOV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000\nHOST_FORM_SECRET=${SECRET}-form\n`, { mode: 0o600, owner: 'root' });
    host.tokenRequests = [];
    host.published = [];
    host.publishAttempts = 0;
    host.http.set('http://127.0.0.1:4000/oauth/token', ({ method, headers, body }) => {
        const form = Object.fromEntries(new URLSearchParams(body));
        host.tokenRequests.push({ method, contentType: headers['Content-Type'], form });
        if (token !== 'ok') return token;
        if (form.client_secret !== HOST_SECRET) return { status: 401, body: { error: 'invalid_client' } };
        return { status: 200, body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 300, scope: 'events.event.publish' } };
    });
    host.http.set('http://127.0.0.1:4300/api/v1/events', ({ method, headers, body }) => {
        host.publishAttempts += 1;
        assert.strictEqual(method, 'POST');
        assert.strictEqual(headers.Authorization, `Bearer ${TOKEN}`);
        const env = JSON.parse(body);
        const v = contracts.validate('events.event-envelope@1', env);
        assert.ok(v.valid, JSON.stringify(v.errors));
        if (typeof events === 'function') return events(env);
        if (events !== 'ok') return events;
        const dup = host.published.some((e) => e.event_id === env.event_id);
        if (!dup) host.published.push(env);
        return { status: dup ? 200 : 201, body: { event_id: env.event_id, seq: host.published.length + 100, duplicate: dup } };
    });
    return host;
}

function servesRelease(host, url, manifest) {
    host.releaseJsonHeaders = [];
    host.http.set(url, ({ headers }) => { host.releaseJsonHeaders.push(headers); return { status: 200, body: manifest }; });
}

function noSecrets(host, out) {
    for (const s of [HOST_SECRET, TOKEN, `${SECRET}-form`]) {
        assert.ok(!out.includes(s), 'the output shows no secret');
        assert.ok(!JSON.stringify(host.calls).includes(s), 'no recorded call carries a secret');
        for (const [p, f] of host.files) if (p !== ENV_FILE && f.type === 'file') assert.ok(!String(f.content).includes(s), `${p} holds no secret`);
    }
}

runTests([
    test('announce live: the release /release.json reports, a service token for events.event.publish, one public event', async () => {
        const host = withEvents();
        const head = host.repo('live').head;
        servesRelease(host, 'http://127.0.0.1:3000/release.json', { service: 'live', release: head.slice(0, 8), components: { shell: { kind: 'script', version: 'sh1' }, server: { kind: 'server', version: 'sv1' } } });
        const r = await host.cli('announce', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, new RegExp(`release notification sent: live ${head.slice(0, 8)} \\(from /release\\.json\\) as evt_[0-9A-Z]{26} \\(seq 101\\)`));
        assert.deepStrictEqual(host.tokenRequests.map((t) => [t.method, t.contentType, t.form.grant_type, t.form.client_id, t.form.audience, t.form.scope]),
            [['POST', 'application/x-www-form-urlencoded', 'client_credentials', 'host', 'openvibe.events', 'events.event.publish']]);
        assert.strictEqual(host.published.length, 1);
        const e = host.published[0];
        assert.strictEqual(e.event_type, 'host.deploy.activated');
        assert.strictEqual(e.version, 1);
        assert.strictEqual(e.source, 'host');
        assert.deepStrictEqual(e.actor, { type: 'service', id: 'host' });
        assert.strictEqual(e.visibility, 'public');
        assert.strictEqual(e.priority, 'low');
        assert.deepStrictEqual(e.subject, { type: 'release', id: `live:${head.slice(0, 8)}` });
        assert.deepStrictEqual(e.payload, {
            service: 'live', release: head.slice(0, 8), commit: head, origin: 'https://openvibe.live', deployed_at: e.timestamp,
            components: { shell: { kind: 'script', version: 'sh1' }, server: { kind: 'server', version: 'sv1' } },
        });
        payloadSchemaCheck(e.payload);
        const state = JSON.parse(host.read('/var/lib/openvibe-host/announced/live.json'));
        assert.deepStrictEqual([state.release, state.event_id, state.seq], [head.slice(0, 8), e.event_id, 101]);
        noSecrets(host, r.out);
    }),

    test('the same release is announced once; --force sends it again as a new event', async () => {
        const host = withEvents();
        const r1 = await host.cli('announce', 'tools');
        assert.strictEqual(r1.code, 0, r1.out);
        const r2 = await host.cli('announce', 'tools');
        assert.strictEqual(r2.code, 0, r2.out);
        assert.match(r2.out, /tools [0-9a-f]{12} was already announced at .*--force sends it again/);
        assert.strictEqual(host.published.length, 1);
        const r3 = await host.cli('announce', 'tools', '--force');
        assert.strictEqual(r3.code, 0, r3.out);
        assert.strictEqual(host.published.length, 2);
        assert.notStrictEqual(host.published[0].event_id, host.published[1].event_id);
        push(host, 'tools', { 'apps/gateway/server.js': 'gw(2);' });
        await host.exec.run('git', ['-C', '/opt/openvibe.tools', 'merge', '--ff-only', host.repo('tools').remoteRefs['origin/main']], { as: 'ubuntu' });
        const r4 = await host.cli('announce', 'tools');
        assert.strictEqual(r4.code, 0, r4.out);
        assert.strictEqual(host.published.length, 3, 'a new release is announced');
    }),

    test('without /release.json: the checkout HEAD (12 hex) and its commit; the ready URL\'s Host header is sent', async () => {
        const host = withEvents();
        const head = host.repo('tools').head;
        const r = await host.cli('announce', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /answered ECONNREFUSED; using the checkout's HEAD/);
        assert.match(r.out, /\(from git HEAD\)/);
        const p = host.published[0].payload;
        assert.deepStrictEqual([p.service, p.release, p.commit, p.origin], ['tools', head.slice(0, 12), head, 'https://openvibe.tools']);
        assert.ok(!('components' in p));
        payloadSchemaCheck(p);
        host.published.length = 0;
        servesRelease(host, 'http://127.0.0.1:4001/release.json', { service: 'tools', release: 'abcdef123456' });
        const r2 = await host.cli('announce', 'tools', '--force');
        assert.strictEqual(r2.code, 0, r2.out);
        assert.strictEqual(host.releaseJsonHeaders[0].Host, 'openvibe.tools');
        assert.deepStrictEqual([host.published[0].payload.release, host.published[0].payload.commit], ['abcdef123456', null], 'a commit that does not start with the release is left out');
    }),

    test('a service the inventory does not know (a Sites placeholder): --release and --origin, no commit', async () => {
        const host = withEvents();
        const bad = await host.cli('announce', 'news');
        assert.strictEqual(bad.code, 1, bad.out);
        assert.match(bad.out, /news is not in the inventory: pass --release/);
        const r = await host.cli('announce', 'news', '--release', 'DF0D28A88E98', '--origin', 'https://openvibe.news');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.published[0].payload, { service: 'news', release: 'df0d28a88e98', commit: null, origin: 'https://openvibe.news', deployed_at: host.published[0].timestamp });
        assert.deepStrictEqual(host.published[0].subject, { type: 'release', id: 'news:df0d28a88e98' });
        payloadSchemaCheck(host.published[0].payload);
        const noOrigin = await host.cli('announce', 'stream', '--release', '2a3844407d96');
        assert.strictEqual(noOrigin.code, 0, noOrigin.out);
        assert.strictEqual(host.published[1].payload.origin, null, 'no manifest, no --origin: origin null');
        for (const argv of [['--release', 'not-hex'], ['--release', 'abcdef1', '--origin', 'http://example.com'], ['--release', 'abcdef1', '--commit', 'xyz']]) {
            const x = await host.cli('announce', 'news', ...argv);
            assert.strictEqual(x.code, 1, `${argv.join(' ')}: ${x.out}`);
        }
        const badId = await host.cli('announce', 'Bad_Id', '--release', 'abcdef1');
        assert.strictEqual(badId.code, 1, badId.out);
    }),

    test('publishing failures: one retry with the same event_id, exit 2, nothing recorded; a refused token is named', async () => {
        const host = withEvents({ events: { status: 503, body: { code: 'events.unavailable' } } });
        const r = await host.cli('announce', 'tools');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /release notification FAILED for tools [0-9a-f]{12}: publish: HTTP 503 events\.unavailable/);
        assert.strictEqual(host.publishAttempts, 2, 'retried once');
        assert.strictEqual(host.read('/var/lib/openvibe-host/announced/tools.json'), null);
        noSecrets(host, r.out);

        const ids = [];
        const flaky = withEvents({ events: (env) => { ids.push(env.event_id); return ids.length === 1 ? { error: 'ECONNRESET' } : { status: 201, body: { event_id: env.event_id, seq: 5, duplicate: false } }; } });
        const r2 = await flaky.cli('announce', 'tools');
        assert.strictEqual(r2.code, 0, r2.out);
        assert.strictEqual(ids.length, 2);
        assert.strictEqual(ids[0], ids[1], 'the retry is the same event (Events stores it once)');

        const refused = withEvents({ events: { status: 403, body: { code: 'events.type_not_allowed' } } });
        const r3 = await refused.cli('announce', 'tools');
        assert.strictEqual(r3.code, 2, r3.out);
        assert.strictEqual(refused.publishAttempts, 1, 'a 403 is not retried');
        assert.match(r3.out, /HTTP 403 events\.type_not_allowed/);

        const badToken = withEvents({ envText: `OV_OAUTH_CLIENT_SECRET=wrong-${SECRET}\nEVENTS_URL=http://127.0.0.1:4300\n` });
        const r4 = await badToken.cli('announce', 'tools');
        assert.strictEqual(r4.code, 2, r4.out);
        assert.match(r4.out, /token: HTTP 401 invalid_client/);
        assert.strictEqual(badToken.publishAttempts, 0);
        assert.ok(!r4.out.includes(`wrong-${SECRET}`));

        const down = withEvents();
        down.http.delete('http://127.0.0.1:4300/api/v1/events');
        const r5 = await down.cli('announce', 'tools');
        assert.strictEqual(r5.code, 2, r5.out);
        assert.match(r5.out, /publish: ECONNREFUSED/);
    }),

    test('not configured: exit 1, no HTTP at all; --events-env, $OVHOST_EVENTS_ENV and the inventory choose the file', async () => {
        const host = scenario();
        const r = await host.cli('announce', 'tools');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /release notification not sent: \/etc\/openvibe\/host\.env not found/);
        assert.ok(!host.calls.some((c) => c.cmd === 'curl'), 'nothing was requested');

        const partial = withEvents({ envText: 'OV_OAUTH_CLIENT_ID=host\nEVENTS_URL=http://127.0.0.1:4300\n' });
        const p = await partial.cli('announce', 'tools');
        assert.strictEqual(p.code, 1, p.out);
        assert.match(p.out, /sets no OV_OAUTH_CLIENT_SECRET/);

        const plainHttp = withEvents({ envText: `OV_OAUTH_CLIENT_SECRET=${SECRET}\nEVENTS_URL=http://events.example.com\n` });
        const ph = await plainHttp.cli('announce', 'tools');
        assert.strictEqual(ph.code, 1, ph.out);
        assert.match(ph.out, /EVENTS_URL must be https:\/\/ \(plain http only on loopback\)/);

        const other = withEvents({ envFile: '/etc/openvibe/announce.env' });
        const lines = [];
        const code = await main(['announce', 'tools'], { exec: other.exec, out: (s) => lines.push(s), env: { OVHOST_EVENTS_ENV: '/etc/openvibe/announce.env' } });
        assert.strictEqual(code, 0, lines.join('\n'));
        other.published.length = 0;
        const viaFlag = await other.cli('announce', 'tools', '--force', '--events-env', '/etc/openvibe/announce.env');
        assert.strictEqual(viaFlag.code, 0, viaFlag.out);
        const inv = JSON.parse(other.read('/etc/openvibe/host.json'));
        inv.events = { envFile: '/etc/openvibe/announce.env' };
        other.put('/etc/openvibe/host.json', JSON.stringify(inv), { mode: 0o640, owner: 'root' });
        const viaInventory = await other.cli('announce', 'tools', '--force');
        assert.strictEqual(viaInventory.code, 0, viaInventory.out);
        assert.strictEqual(other.published.length, 2);
    }),

    test('--dry-run prints the envelope and sends nothing (no credentials needed)', async () => {
        const host = scenario();
        const r = await host.cli('announce', 'tools', '--dry-run');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /dry run: tools [0-9a-f]{12} \(from git HEAD\); nothing sent/);
        const env = JSON.parse(r.out.slice(r.out.indexOf('{')));
        assert.strictEqual(env.event_type, 'host.deploy.activated');
        assert.ok(contracts.validate('events.event-envelope@1', env).valid);
        assert.ok(!host.reads.includes(ENV_FILE), 'the credentials were not read');
        const j = await host.cli('announce', 'tools', '--dry-run', '--json');
        assert.strictEqual(JSON.parse(j.out).envelope.visibility, 'public');
    }),

    test('ovhost deploy announces the release that went live; the deploy exit code never depends on it', async () => {
        const host = withEvents();
        const to = push(host, 'live', { 'server/index.js': 'console.log(2);' }, 'server change');
        host.http.set('http://127.0.0.1:3000/release.json', () => ({ status: 200, body: { service: 'live', release: host.units.get('openvibe-live.service').runningSha.slice(0, 12) } }));
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, new RegExp(`release notification sent: live ${to.slice(0, 12)} \\(from /release\\.json\\)`));
        assert.deepStrictEqual([host.published[0].payload.release, host.published[0].payload.commit], [to.slice(0, 12), to]);
        assert.ok(!('rollback' in host.published[0].payload));

        const rb = await host.cli('rollback', 'live', '--json');
        assert.strictEqual(rb.code, 0, rb.out);
        const rec = JSON.parse(rb.out.slice(rb.out.indexOf('{')));
        assert.strictEqual(rec.result, 'rolled-back');
        assert.strictEqual(rec.announce.published, true);
        assert.ok(!('envelope' in rec.announce));
        assert.strictEqual(host.published[1].payload.rollback, true);
        payloadSchemaCheck(host.published[1].payload);

        const quiet = withEvents();
        push(quiet, 'live', { 'server/index.js': 'console.log(3);' });
        const q = await quiet.cli('deploy', 'live', '--no-announce');
        assert.strictEqual(q.code, 0, q.out);
        assert.strictEqual(quiet.tokenRequests.length, 0);

        const down = withEvents({ events: { status: 500, body: {} } });
        push(down, 'live', { 'server/index.js': 'console.log(4);' });
        const d = await down.cli('deploy', 'live');
        assert.strictEqual(d.code, 0, d.out);
        assert.match(d.out, /release notification FAILED for live/);
        assert.match(d.out, /result: deployed/);

        const unconfigured = scenario();
        push(unconfigured, 'live', { 'server/index.js': 'console.log(5);' });
        const u = await unconfigured.cli('deploy', 'live');
        assert.strictEqual(u.code, 0, u.out);
        assert.match(u.out, /release notification not sent: \/etc\/openvibe\/host\.env not found/);
    }),

    test('a deploy that did not go live announces nothing', async () => {
        const host = withEvents();
        const to = push(host, 'live', { 'server/index.js': 'broken();' });
        host.badShas.add(to);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 3, r.out);
        assert.strictEqual(host.tokenRequests.length, 0);
        const same = await host.cli('deploy', 'media');
        assert.strictEqual(same.code, 0, same.out);
        assert.match(same.out, /nothing to do/);
        assert.strictEqual(host.tokenRequests.length, 0, 'an unchanged deploy is not announced');
    }),
]);
