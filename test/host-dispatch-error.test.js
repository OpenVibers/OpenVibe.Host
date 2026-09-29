'use strict';
/**
 * Regression (ADR-035): the Host dispatch middleware in server/app.js awaits tenant.resolve and
 * tenant.handle, which read the database asynchronously. Express 4 does not catch a rejected async
 * handler: a transient database error used to escape as an unhandled rejection and leave the request
 * hanging with no response. It must reach the app's error handler instead (a logged 500).
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');

/** The response, or a failure the moment it is clear no response is coming. */
function withDeadline(promise, what) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`${what}: no response after 3000ms — the rejection never reached the error handler`)), 3000);
            promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        }),
    ]);
}

(async () => {
    const t = await boot();
    const alice = t.user('alice');

    await check('a failing Host resolve answers 500 instead of hanging the request', async () => {
        const original = t.ctx.tenant.resolve;
        t.ctx.tenant.resolve = async () => { throw new Error('transient database error'); };
        try {
            const r = await withDeadline(t.get('alice.openvibe.host', '/'), 'resolve');
            assert.strictEqual(r.status, 500, `expected 500, got ${r.status}: ${r.text.slice(0, 120)}`);
            assert.match(r.text, /Something went wrong/);
        } finally {
            t.ctx.tenant.resolve = original;
        }
    });

    await check('a failing tenant handler answers 500 instead of hanging the request', async () => {
        const project = await t.project(alice, 'Dispatch errors');
        const site = await t.site(alice, project.id, 'alice');
        await t.deploy(alice, site.id, { 'index.html': 'hello' });
        const original = t.ctx.tenant.handle;
        t.ctx.tenant.handle = async () => { throw new Error('transient database error'); };
        try {
            const r = await withDeadline(t.get('alice.openvibe.host', '/'), 'handle');
            assert.strictEqual(r.status, 500, `expected 500, got ${r.status}: ${r.text.slice(0, 120)}`);
        } finally {
            t.ctx.tenant.handle = original;
        }
    });

    await check('the site is served normally again once the failure passes', async () => {
        const r = await t.get('alice.openvibe.host', '/');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.text, 'hello');
    });

    await t.close();
    done();
})();
