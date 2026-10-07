'use strict';
/**
 * Host's capabilities and service manifest as openvibe-contracts released them match what the code
 * enforces and emits; and the outbox relay really delivers Host's events to OpenVibe.Events with a
 * Network service token.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./stageb/boot');
const { listen } = require('./stageb/mocks');
const { CAPABILITIES } = require('../server/auth/capabilities');
const { EVENT_TYPES } = require('../server/events/outbox');

(async () => {
    const ids = Object.values(CAPABILITIES);
    const caps = ids.map((id) => contracts.capabilities.get(id));
    const manifest = JSON.parse(fs.readFileSync(require.resolve('openvibe-contracts/manifests/services/host.json'), 'utf8'));

    await check('every capability Host guards is released, active and owned by host', async () => {
        for (const [i, c] of caps.entries()) {
            assert.ok(c, `${ids[i]} is not in openvibe-contracts`);
            assert.strictEqual(c.owner, 'host');
            // Every capability Host guards is active (host.resource.read since openvibe-contracts 0.108.0).
            assert.strictEqual(c.status, 'active', c.id);
        }
    });

    await check('the released capabilities are exactly the ones the routes guard, and every route guards one', async () => {
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...ids].sort());
        const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
        const routes = [...api.matchAll(/router\.(get|post|put|delete)\('([^']+)', guard\('([a-z.]+)'\)/g)].map((m) => ({ method: m[1].toUpperCase(), route: `/api/v1${m[2]}`, cap: m[3] }));
        const all = [...api.matchAll(/router\.(get|post|put|delete)\('/g)].length;
        assert.strictEqual(routes.length, all, 'every API route has exactly one capability guard');
        for (const r of routes) {
            const cap = caps.find((c) => c.id === r.cap);
            assert.ok(cap, r.cap);
            const key = `${r.method} ${r.route}`;
            assert.ok(cap.implementedBy.includes(key), `${key} missing from ${r.cap}.implementedBy`);
        }
    });

    await check('the released service manifest declares every event the service emits', async () => {
        assert.strictEqual(manifest.id, 'host');
        for (const e of EVENT_TYPES) assert.ok(manifest.eventsProduced.includes(e), e);
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
        assert.strictEqual((await t.ctx.outbox.status()).pending, 0);
        await t.close();
        await events.close();
    });

    done();
})();
