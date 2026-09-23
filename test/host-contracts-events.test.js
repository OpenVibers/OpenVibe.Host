'use strict';
/**
 * The proposals the lead releases in the next openvibe-contracts version are valid, match what the
 * code enforces and emits, and do not collide with released ids; and the outbox relay really
 * delivers Host's events to OpenVibe.Events with a Network service token.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./stageb/boot');
const { listen } = require('./stageb/mocks');
const { PROPOSED } = require('../server/auth/capabilities');
const { EVENT_TYPES } = require('../server/events/outbox');

const DIR = path.join(__dirname, '..', 'docs', 'capabilities-proposal');

(async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const caps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'service-manifest-proposal.json'), 'utf8'));

    await check('every capability proposal is a valid capabilities.capability@1 with 3 segments, owned by host', async () => {
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'host');
            assert.strictEqual(c.id.split('.').length, 3);
            assert.strictEqual(`${c.id}.json`, files[caps.indexOf(c)]);
            assert.ok(!contracts.capabilities.get(c.id) || contracts.capabilities.get(c.id).owner === 'host', `${c.id} collides with a released capability`);
        }
    });

    await check('the proposals are exactly the capabilities the routes guard, and every route guards one', async () => {
        assert.deepStrictEqual(caps.map((c) => c.id).sort(), [...PROPOSED].sort());
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());
        const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
        const routes = [...api.matchAll(/router\.(get|post|put|delete)\('([^']+)', guard\('([a-z.]+)'\)/g)].map((m) => ({ method: m[1].toUpperCase(), route: `/api/v1${m[2]}`, cap: m[3] }));
        const all = [...api.matchAll(/router\.(get|post|put|delete)\('/g)].length;
        assert.strictEqual(routes.length, all, 'every API route has exactly one capability guard');
        for (const r of routes) {
            const cap = caps.find((c) => c.id === r.cap);
            assert.ok(cap, r.cap);
            assert.ok(cap.implementedBy.includes(`${r.method} ${r.route}`), `${r.method} ${r.route} missing from ${r.cap}.implementedBy`);
        }
    });

    await check('the service manifest proposal is a valid registry.service-manifest@1 declaring every emitted event', async () => {
        const v = contracts.validate('registry.service-manifest@1', manifest);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(manifest.id, 'host');
        assert.deepStrictEqual([...manifest.eventsProduced].sort(), [...EVENT_TYPES].sort());
        for (const c of caps) for (const e of c.events) assert.ok(manifest.eventsProduced.includes(e), e);
        const src = ['server/domain/deploys.js', 'server/domain/domains.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
        for (const m of src.matchAll(/event_type: '([a-z_.]+)'/g)) assert.ok(manifest.eventsProduced.includes(m[1]), m[1]);
    });

    await check('the outbox relay publishes host.* events to OpenVibe.Events with a Network service token', async () => {
        const received = [];
        let network;
        const events = await listen((req, raw, json) => {
            if (req.url !== '/api/v1/events' || req.method !== 'POST') return json(404, {});
            const token = String(req.headers.authorization || '').slice(7);
            const v = contracts.serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.events' });
            if (!v.ok || !v.claims.cap.includes('events.event.publish') || v.claims.sub !== 'svc:host') return json(403, { code: 'capability.denied' });
            const body = JSON.parse(raw);
            const list = body.events || [body];
            for (const e of list) { const val = contracts.validate('events.event-envelope@1', e); if (!val.valid) return json(422, { errors: val.errors }); received.push(e); }
            const results = list.map((e, i) => ({ event_id: e.event_id, seq: received.length - list.length + i + 1, duplicate: false }));
            return json(200, body.events ? { results } : results[0]);
        });
        const t = await boot({ env: { EVENTS_URL: events.url } });
        network = t.network;
        const alice = t.user('alice');
        const p = await t.project(alice, 'E');
        const s = await t.site(alice, p.id, 'events-site');
        await t.deploy(alice, s.id, { 'index.html': 'x' });
        await t.upload(alice, s.id, { 'bad.php': 'x' });
        await t.ctx.outbox.outbox.flush();
        assert.deepStrictEqual(received.map((e) => e.event_type).sort(), ['host.deploy.activated', 'host.deploy.created', 'host.deploy.failed']);
        assert.ok(received.every((e) => e.source === 'host'));
        assert.strictEqual(t.ctx.outbox.status().pending, 0);
        await t.close();
        await events.close();
    });

    done();
})();
