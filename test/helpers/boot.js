'use strict';
/** Boot the catalog with a temporary PGlite database and mock Network. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork } = require('./network');
const { cookieNames } = require('../../server/auth/sso');

function makeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

const SECRET = 'shh-host-secret-value';
const DASHBOARD = 'openvibe.host';

async function boot(opts = {}) {
    const network = await startNetwork();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-host-test-'));
    const clock = opts.clock || makeClock();
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: `https://${DASHBOARD}`, TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'host', OV_OAUTH_CLIENT_SECRET: SECRET, COOKIE_SECURE: 'false',
        HOST_FORM_SECRET: 'test-form-secret', HOST_WORKER: 'off',
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const { createStore } = require('../../server/db');
    // One database per boot; a restart keeps it.
    const testdb = await require('./db').testDb();
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    let server = null;
    let built = null;
    const t = { network, clock, dir, env, SECRET };

    async function start() {
        const config = configLib.load(env);
        built = await createApp({ config, store: createStore(testdb.db, { now: clock.now }), now: clock.now, log: quiet, fetchImpl: opts.fetchImpl });
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.port = server.address().port;
        t.app = built.app;
        t.ctx = built.ctx;
        t.config = config;
    }
    async function stop() {
        if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); built.ctx.stopMetrics(); }
        server = null; built = null;
    }

    /** Raw request. o: method, host, path, headers, body (Buffer|string), as (user|token), session (user) */
    function request(o) {
        return new Promise((resolve, reject) => {
            const headers = { ...(o.headers || {}) };
            if (o.host !== undefined) headers.host = o.host;
            if (o.as && typeof o.as === 'object') headers.authorization = `Bearer ${network.userToken(o.as)}`;
            if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
            // A dashboard session is Host's own cookie (server/auth/sso.js); ov_token is display-only.
            if (o.session) headers.cookie = [headers.cookie, `${cookieNames(t.config).session}=${network.userToken(o.session)}`].filter(Boolean).join('; ');
            let body = o.body;
            if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
            if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
            if (body != null && headers['content-length'] == null) headers['content-length'] = Buffer.byteLength(body);
            const req = http.request({ host: '127.0.0.1', port: t.port, method: o.method || 'GET', path: o.path, headers, setHost: o.host === undefined }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const text = buf.toString('utf8');
                    resolve({ status: res.statusCode, headers: res.headers, body: buf, text, json() { return JSON.parse(text); } });
                });
            });
            req.on('error', reject);
            if (body != null) req.write(body);
            req.end();
        });
    }

    t.request = request;
    t.api = (method, p, o = {}) => request({ ...o, method, host: DASHBOARD, path: p });
    t.get = (host, p, o = {}) => request({ ...o, method: o.method || 'GET', host, path: p });

    t.user = (name, extra) => network.addUser(name, extra);
    t.restart = async () => { await stop(); await start(); };
    t.close = async () => { await stop(); await testdb.close(); await network.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    await start();
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock, DASHBOARD, SECRET };
