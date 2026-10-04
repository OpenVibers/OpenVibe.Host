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

/**
 * Routes Host guards today whose capability entries are only in OpenVibe.Contracts main (OpenVibe.Contracts#18
 * added the git-source routes for the next release; the pinned tag predates it). They are exempt from the
 * "the released manifest lists every route" half of the check until the pin reaches that release, and no
 * further: each key must be a real guarded route with the capability the release gives it, and must not be
 * in the pinned manifest — so when the pin is bumped the exemption turns red and has to be deleted.
 */
const PENDING_CONTRACTS_RELEASE = {
    'GET /api/v1/sites/:id/source': 'host.site.manage',
    'PUT /api/v1/sites/:id/source': 'host.site.manage',
    'DELETE /api/v1/sites/:id/source': 'host.site.manage',
    'POST /api/v1/sites/:id/source/deploys': 'host.deploy.create',
};

(async () => {
    const ids = Object.values(CAPABILITIES);
    const caps = ids.map((id) => contracts.capabilities.get(id));
    const manifest = JSON.parse(fs.readFileSync(require.resolve('openvibe-contracts/manifests/services/host.json'), 'utf8'));

    await check('every capability Host guards is released, active and owned by host', async () => {
        for (const [i, c] of caps.entries()) {
            assert.ok(c, `${ids[i]} is not in openvibe-contracts`);
            assert.strictEqual(c.owner, 'host');
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
            const pending = PENDING_CONTRACTS_RELEASE[key];
            if (pending != null) {
                assert.strictEqual(pending, r.cap, `${key} is exempt for ${pending}, not ${r.cap}`);
                assert.ok(caps.every((c) => !c.implementedBy.includes(key)), `${key} is released now: drop it from PENDING_CONTRACTS_RELEASE`);
                continue;
            }
            assert.ok(cap.implementedBy.includes(key), `${key} missing from ${r.cap}.implementedBy`);
        }
        const guarded = new Set(routes.map((r) => `${r.method} ${r.route}`));
        for (const key of Object.keys(PENDING_CONTRACTS_RELEASE)) assert.ok(guarded.has(key), `${key} is not a guarded route: drop it from PENDING_CONTRACTS_RELEASE`);
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
