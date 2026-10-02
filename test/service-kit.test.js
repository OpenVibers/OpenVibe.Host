'use strict';
/**
 * Host's shutdown moved onto openvibe-sdk/service (plan T1 lane A): main() hands the signal to gracefulStop,
 * whose stop step keeps the old order (worker stops first), whose close steps keep the old order (outbox,
 * metrics, then the database, each best effort) and whose exit 0 on a blown deadline matches the old 5 s
 * exit-0 timer. Host's manifest (OpenVibe.Contracts manifests/services/host.json lifecycle.shutdown) declares
 * deadlineSeconds 5, and the 10 min upload requestTimeout stays: drainMs 4000 is what cuts an in-flight upload
 * 5 s after SIGTERM today.
 *
 * The first checks read server/index.js itself (the entry point cannot be inspected through its exports alone);
 * the last boots the real main() with a temp PGlite database and drives the returned shutdown with process.exit
 * stubbed, so the stop steps can be observed in order.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, done } = require('./stageb/boot');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

(async () => {
    await check('server/index.js imports gracefulStop from openvibe-sdk/service', () => {
        const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]openvibe-sdk\/service['"]\)/);
        assert.ok(m, "require('openvibe-sdk/service')'s exports are not destructured");
        assert.ok(/\bgracefulStop\b/.test(m[1]), 'gracefulStop is not imported');
    });

    await check('server/index.js leaves the signal handlers to the kit', () => {
        assert.ok(!/process\.on\(\s*['"]SIGTERM['"]/.test(src), 'server/index.js still installs its own SIGTERM handler');
        assert.ok(!/process\.on\(\s*['"]SIGINT['"]/.test(src), 'server/index.js still installs its own SIGINT handler');
        assert.ok(/gracefulStop\(\{/.test(src), 'gracefulStop is not called in main()');
    });

    await check("gracefulStop is named 'Host' and keeps the 5 s deadline and exit 0", () => {
        assert.ok(/name:\s*['"]Host['"]/.test(src), "gracefulStop is not named 'Host'");
        assert.ok(/drainMs:\s*4000/.test(src), 'drainMs is not 4000');
        assert.ok(/deadlineMs:\s*5000/.test(src), 'deadlineMs is not 5000');
        assert.ok(/deadlineExitCode:\s*0/.test(src), 'deadlineExitCode is not 0');
    });

    await check('the worker stop is a stop step and the database closes after the drain; the 10 min upload timeout is kept', () => {
        const stop = src.indexOf('() => ctx.worker.stop()');
        const close = src.indexOf('() => ctx.store.close()');
        assert.ok(stop !== -1 && close !== -1, 'worker.stop / store.close steps not found');
        assert.ok(stop < close, 'worker.stop must be a stop step (before the drain and the close steps)');
        assert.ok(/server\.requestTimeout\s*=\s*10\s*\*\s*60_000/.test(src), 'server.requestTimeout is no longer 10 * 60_000');
    });

    // Boot the real entry point on a temp PGlite database, worker and limits off; main() reads process.env.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-host-kit-'));
    Object.assign(process.env, {
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        BASE_URL: 'http://host.test',
        HOST_ACTOR_LIMITS: 'off',
        HOST_WORKER: 'off',
        HOST_MIN_FREE_BYTES: '0',
        HOST_FORM_SECRET: 'test-form-secret',
        HOST_PGLITE_DIR: path.join(dir, 'pglite'),
        HOST_STORAGE_DIR: path.join(dir, 'objects'),
        COOKIE_SECURE: 'false',
        OV_NETWORK_URL: 'http://127.0.0.1:1',
        OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:1',
        OV_OAUTH_CLIENT_ID: 'host',
        OV_OAUTH_CLIENT_SECRET: 'shh',
    });
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_DIRECT_URL;
    delete process.env.VALKEY_URL;
    delete process.env.EVENTS_URL;

    let h = null;
    await check('main() boots and returns a shutdown handle', async () => {
        const { main } = require('../server/index');
        h = await main();
        assert.strictEqual(typeof h.shutdown, 'function', 'main() returned a shutdown function');
    });

    await check('the returned shutdown stops the worker then the outbox, metrics and store, and exits 0', async () => {
        if (!h) return;
        const ctx = h.app.locals.ctx;
        const order = [];
        const wrap = (obj, name, tag) => { const orig = obj[name].bind(obj); obj[name] = (...a) => { order.push(tag); return orig(...a); }; };
        wrap(ctx.worker, 'stop', 'worker.stop');
        wrap(ctx.outbox, 'stop', 'outbox.stop');
        wrap(ctx, 'stopMetrics', 'stopMetrics');
        wrap(ctx.store, 'close', 'store.close');

        const realExit = process.exit;
        let exitCode = null;
        process.exit = (code) => { exitCode = code; };
        let code;
        try { code = await h.shutdown(); } finally { process.exit = realExit; }

        assert.strictEqual(exitCode, 0, 'exit() is called with 0');
        assert.strictEqual(code, 0, 'the shutdown resolves with exit code 0');
        assert.strictEqual(h.server.listening, false, 'the HTTP server stops listening');
        assert.deepStrictEqual(order, ['worker.stop', 'outbox.stop', 'stopMetrics', 'store.close'],
            `the steps ran in the old order (saw ${order.join(', ')})`);

        // The kit starts the stop once: a second call is the same promise, no step runs again.
        const again = await h.shutdown();
        assert.strictEqual(again, 0, 'a second stop resolves with the same code');
        assert.strictEqual(order.length, 4, 'a second stop runs no step again');
    });

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the PGlite handle may hold it open */ }
    done();
})();
