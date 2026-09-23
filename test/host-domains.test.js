'use strict';
/**
 * Custom domains are served only after DNS TXT verification, belong to one site, can never be an
 * OpenVibe domain, lapse when the proof disappears, and never carry certificates through the API.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');

const DAY = 24 * 3600 * 1000;

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const bob = t.user('bob');
    const pa = await t.project(alice, 'A');
    const pb = await t.project(bob, 'B');
    const sa = await t.site(alice, pa.id, 'alice-site');
    const sb = await t.site(bob, pb.id, 'bob-site');
    await t.deploy(alice, sa.id, { 'index.html': 'ALICE' });
    await t.deploy(bob, sb.id, { 'index.html': 'BOB' });
    const HOST = 'www.alice-example.org';
    let dom;

    await check('adding a custom domain returns the TXT and routing records; it is NOT served yet', async () => {
        const r = await t.api('POST', `/api/v1/sites/${sa.id}/domains`, { as: alice, json: { hostname: 'WWW.Alice-Example.org.' } });
        assert.strictEqual(r.status, 201, r.text);
        dom = r.json().domain;
        assert.strictEqual(dom.hostname, HOST);
        assert.strictEqual(dom.status, 'pending');
        assert.strictEqual(dom.served, false);
        assert.strictEqual(dom.instructions.verification.type, 'TXT');
        assert.strictEqual(dom.instructions.verification.name, `_openvibe-host.${HOST}`);
        assert.match(dom.instructions.verification.value, /^openvibe-host-verification=[0-9a-f]{40}$/);
        assert.deepStrictEqual(dom.instructions.routing[0], { type: 'CNAME', name: HOST, value: 'alice-site.openvibe.host', note: 'for a subdomain such as www.example.org' });
        assert.ok(!/BEGIN|privkey|fullchain/.test(r.text), 'no certificate material');
        const g = await t.get(HOST, '/');
        assert.strictEqual(g.status, 404);
        assert.match(g.text, /Unknown host/);
    });

    await check('verification: missing record and a wrong value keep it pending (and unserved)', async () => {
        let r = await t.api('POST', `/api/v1/domains/${dom.id}/verify`, { as: alice });
        assert.strictEqual(r.json().domain.status, 'pending');
        assert.match(r.json().domain.last_error, /no TXT record/);
        t.clock.advance(10_000);
        t.dns.set(`_openvibe-host.${HOST}`, ['openvibe-host-verification=wrong']);
        r = await t.api('POST', `/api/v1/domains/${dom.id}/verify`, { as: alice });
        assert.strictEqual(r.json().domain.status, 'pending');
        assert.match(r.json().domain.last_error, /not the expected value/);
        t.clock.advance(10_000);
        t.dns.set('__fail__', true);
        r = await t.api('POST', `/api/v1/domains/${dom.id}/verify`, { as: alice });
        assert.match(r.json().domain.last_error, /DNS lookup failed \(ETIMEOUT\)/);
        t.dns.delete('__fail__');
        assert.strictEqual((await t.get(HOST, '/')).status, 404);
    });

    await check('another tenant can claim the same name while pending, but only the first verified proof wins', async () => {
        const b = await t.api('POST', `/api/v1/sites/${sb.id}/domains`, { as: bob, json: { hostname: HOST } });
        assert.strictEqual(b.status, 201);
        t.clock.advance(10_000);
        t.dns.set(`_openvibe-host.${HOST}`, [dom.instructions.verification.value, 'v=spf1 -all']);
        const r = await t.api('POST', `/api/v1/domains/${dom.id}/verify`, { as: alice });
        assert.strictEqual(r.json().domain.status, 'verified');
        assert.strictEqual(r.json().domain.served, true);
        const ev = t.events('host.domain.verified');
        assert.strictEqual(ev.length, 1);
        assert.deepStrictEqual(ev[0].payload, { project_id: pa.id, site_id: sa.id, site: 'alice-site', hostname: HOST });
        const g = await t.get(HOST, '/');
        assert.strictEqual(g.text, 'ALICE');
        assert.match(g.headers['content-security-policy'], /default-src 'self'/);
        // Bob publishes his own proof afterwards: too late.
        t.dns.set(`_openvibe-host.${HOST}`, [b.json().domain.instructions.verification.value]);
        const bv = await t.api('POST', `/api/v1/domains/${b.json().domain.id}/verify`, { as: bob });
        assert.strictEqual(bv.json().domain.status, 'failed');
        assert.match(bv.json().domain.last_error, /verified for another site first/);
        assert.strictEqual((await t.get(HOST, '/')).text, 'ALICE');
        const again = await t.api('POST', `/api/v1/sites/${sb.id}/domains`, { as: bob, json: { hostname: 'apex-free.example.org' } });
        assert.strictEqual(again.status, 201);
        const taken = await t.api('POST', `/api/v1/projects/${pb.id}/sites`, { as: bob, json: { name: 'bob-two' } });
        const dup = await t.api('POST', `/api/v1/sites/${taken.json().site.id}/domains`, { as: bob, json: { hostname: HOST } });
        assert.strictEqual(dup.status, 409);
        assert.strictEqual(dup.json().code, 'domain.taken');
    });

    await check('OpenVibe domains, the sites domain and non-hostnames can never be claimed', async () => {
        for (const h of ['openvibe.live', 'evil.openvibe.network', 'x.openvibe.host', 'openvibe.host', 'openvibe.xyz', 'a.b.openvibe.media', 'events.openvibe.network', 'openre.stream', 'play.openvibe.games',
            'localhost', '127.0.0.1', 'example', '-bad.example.org', 'a_b.example.org', 'ex ample.org', 'xn--.example.org']) {
            const r = await t.api('POST', `/api/v1/sites/${sa.id}/domains`, { as: alice, json: { hostname: h } });
            assert.strictEqual(r.status, 422, `${h} → ${r.status} ${r.text}`);
        }
    });

    await check('the default domain cannot be removed; removing a custom domain stops serving it at once', async () => {
        const list = (await t.api('GET', `/api/v1/sites/${sa.id}/domains`, { as: alice })).json().domains;
        const def = list.find((d) => d.kind === 'default');
        assert.strictEqual((await t.api('DELETE', `/api/v1/domains/${def.id}`, { as: alice })).status, 409);
        const d2 = await t.api('POST', `/api/v1/sites/${sa.id}/domains`, { as: alice, json: { hostname: 'docs.alice-example.org' } });
        const d2v = d2.json().domain;
        t.dns.set(d2v.instructions.verification.name, [d2v.instructions.verification.value]);
        assert.strictEqual((await t.api('POST', `/api/v1/domains/${d2v.id}/verify`, { as: alice })).json().domain.status, 'verified');
        assert.strictEqual((await t.get('docs.alice-example.org', '/')).text, 'ALICE');
        assert.strictEqual((await t.api('DELETE', `/api/v1/domains/${d2v.id}`, { as: alice })).status, 200);
        assert.strictEqual((await t.get('docs.alice-example.org', '/')).status, 404);
    });

    await check('worker: pending domains verify in the background and fail after the pending window', async () => {
        const p = await t.api('POST', `/api/v1/sites/${sb.id}/domains`, { as: bob, json: { hostname: 'late.example.org' } });
        const pd = p.json().domain;
        t.clock.advance(11 * 60 * 1000);
        t.dns.set(pd.instructions.verification.name, [pd.instructions.verification.value]);
        const s = await t.ctx.worker.domainTick();
        assert.ok(s.verified >= 1);
        assert.strictEqual((await t.get('late.example.org', '/')).text, 'BOB');
        const never = (await t.api('POST', `/api/v1/sites/${sb.id}/domains`, { as: bob, json: { hostname: 'never.example.org' } })).json().domain;
        t.clock.advance(8 * DAY);
        await t.ctx.worker.domainTick();
        const after = t.ctx.domains.get(never.id);
        assert.strictEqual(after.status, 'failed');
    });

    await check('worker: a verified domain whose TXT record is gone for the lapse window stops being served', async () => {
        t.dns.delete(`_openvibe-host.${HOST}`);
        t.clock.advance(DAY + 1000);
        await t.ctx.worker.domainTick();
        assert.strictEqual(t.ctx.domains.get(dom.id).status, 'verified', 'still served during the grace period');
        assert.ok(t.ctx.domains.get(dom.id).record_missing_since);
        for (let i = 0; i < 8; i++) { t.clock.advance(DAY + 1000); await t.ctx.worker.domainTick(); }
        assert.strictEqual(t.ctx.domains.get(dom.id).status, 'lapsed');
        assert.strictEqual((await t.get(HOST, '/')).status, 404);
    });

    await check('deleting a site stops its custom domains', async () => {
        assert.strictEqual((await t.get('late.example.org', '/')).text, 'BOB');
        await t.api('DELETE', `/api/v1/sites/${sb.id}`, { as: bob });
        assert.strictEqual((await t.get('late.example.org', '/')).status, 404);
    });

    await t.close();
    done();
})();
