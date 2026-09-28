'use strict';
// Per-actor limits on Host's writes (server/http/actor-limits.js; roadmap WS-R task 4): a signed-in person is counted
// by subject and a service by its principal; past the limit 429 rate_limited with Retry-After before the route runs,
// while another actor passes; deploy uploads have their own tighter number; reads and anonymous callers are never
// counted; the window reopens.
//   node test/actor-limits.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createHostActorLimits } = require('../server/http/actor-limits');

console.warn = () => {};
(async () => {
    let t = Date.UTC(2026, 8, 28, 3, 0, 0);
    const app = express();
    app.use((req, res, next) => {
        const who = req.headers['x-who'] || '';
        req.viewer = who.startsWith('svc:') ? { kind: 'service', claims: { sub: who } } : who ? { kind: 'user', subject: who } : { kind: 'anonymous' };
        next();
    });
    app.use(createHostActorLimits({ env: { HOST_LIMITS_MINUTE: '5' }, now: () => t }));
    let ran = 0;
    app.all('*', (req, res) => { ran++; res.json({ ok: true }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, who) => {
        const r = await fetch(base + p, { method, headers: who ? { 'x-who': who } : {} });
        return { status: r.status, retry: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) };
    };
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/sites/s1/rollback', 'usr_a')).status, 200);
        const before = ran;
        const r = await call('POST', '/sites/s1/rollback', 'usr_a');
        assert.deepStrictEqual([r.status, r.body.code, Number(r.retry) > 0, ran], [429, 'rate_limited', true, before]);
        assert.strictEqual((await call('POST', '/sites/s1/rollback', 'svc:tools')).status, 200, 'a service is its own actor');
        for (let i = 0; i < 10; i++) {
            assert.strictEqual((await call('GET', '/projects', 'usr_a')).status, 200, 'reads are never counted');
            assert.strictEqual((await call('POST', '/projects')).status, 200, 'anonymous callers keep the address limit');
        }
        t += 60 * 1000;
        const ups = [];
        for (let i = 0; i < 6; i++) ups.push((await call('POST', '/sites/s1/deploys', 'usr_b')).status);
        assert.deepStrictEqual(ups.slice(0, 5), [200, 200, 200, 200, 200]);
        t += 60 * 1000;
        assert.strictEqual((await call('POST', '/sites/s1/rollback', 'usr_a')).status, 200, 'the next minute');
    } finally {
        server.close();
    }
    assert.strictEqual(require('../server/http/actor-limits').createHostActorLimits({ env: { HOST_ACTOR_LIMITS: 'off' } }).name, 'noLimits', 'the rollback lever turns them off');
    console.log('actor limits: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
