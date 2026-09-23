'use strict';
/**
 * Boots Host Stage B on a temp database and object store, with a controllable clock, a DNS table
 * for custom-domain checks and a mock Network, and returns a raw HTTP client that can send any Host
 * header and any request target (encoded traversal, absolute-form, …).
 *
 *   const t = await boot();
 *   await t.api('POST', '/api/v1/projects', { as: user, json: { name: 'x' } })
 *   await t.get('mysite.openvibe.host', '/index.html')
 *   t.dns.set('_openvibe-host.www.example.org', ['openvibe-host-verification=…'])
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork } = require('./mocks');
const { site: siteTar } = require('./tar');

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
    const dns = new Map();
    const dnsCalls = [];
    const resolver = {
        async resolveTxt(name) {
            dnsCalls.push(name);
            if (dns.get('__fail__')) { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; }
            if (!dns.has(name)) { const e = new Error(`queryTxt ENOTFOUND ${name}`); e.code = 'ENOTFOUND'; throw e; }
            return dns.get(name).map((v) => [v]);
        },
    };
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: `https://${DASHBOARD}`, TRUST_PROXY: '1',
        HOST_DB_PATH: path.join(dir, 'host.db'), HOST_STORAGE_DIR: path.join(dir, 'objects'),
        HOST_SITES_DOMAIN: 'openvibe.host',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'host', OV_OAUTH_CLIENT_SECRET: SECRET, COOKIE_SECURE: 'false',
        HOST_FORM_SECRET: 'test-form-secret', HOST_WORKER: 'off',
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    let server = null;
    let built = null;
    const t = { network, clock, dns, dnsCalls, dir, env, SECRET };

    async function start() {
        const config = configLib.load(env);
        built = createApp({ config, now: clock.now, log: quiet, resolver, fetchImpl: opts.fetchImpl });
        await built.ctx.auth.ensureKey();
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.port = server.address().port;
        t.app = built.app;
        t.ctx = built.ctx;
        t.config = config;
    }
    async function stop() {
        if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); built.ctx.stopMetrics(); built.ctx.store.close(); }
        server = null; built = null;
    }

    /** Raw request. o: method, host, path, headers, body (Buffer|string), as (user|token), session (user) */
    function request(o) {
        return new Promise((resolve, reject) => {
            const headers = { ...(o.headers || {}) };
            if (o.host !== undefined) headers.host = o.host;
            if (o.as && typeof o.as === 'object') headers.authorization = `Bearer ${network.userToken(o.as)}`;
            if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
            if (o.session) headers.cookie = [headers.cookie, `ov_host_session=${network.userToken(o.session)}`].filter(Boolean).join('; ');
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

    /** Outbox rows as parsed envelopes. */
    t.events = (type = null) => t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => !type || e.event_type === type);

    t.user = (name, extra) => network.addUser(name, extra);
    t.project = async (user, name = 'Project', extra = {}) => {
        const r = await t.api('POST', '/api/v1/projects', { as: user, json: { name, ...extra } });
        if (r.status !== 201) throw new Error(`project: ${r.status} ${r.text}`);
        return r.json().project;
    };
    t.site = async (user, projectId, name) => {
        const r = await t.api('POST', `/api/v1/projects/${projectId}/sites`, { as: user, json: { name } });
        if (r.status !== 201) throw new Error(`site: ${r.status} ${r.text}`);
        return r.json().site;
    };
    /** Upload { path: content } as a tar.gz; returns the response. */
    t.upload = (user, siteId, files, { activate = true, query = '', gzip = true, raw = null, contentType = 'application/gzip' } = {}) => t.api('POST', `/api/v1/sites/${siteId}/deploys${activate ? '?activate=1' : '?'}${query ? `&${query}` : ''}`, {
        as: user, body: raw || siteTar(files, { gzip }), headers: { 'content-type': contentType },
    });
    t.deploy = async (user, siteId, files, o) => {
        const r = await t.upload(user, siteId, files, o);
        if (r.status !== 201) throw new Error(`deploy: ${r.status} ${r.text}`);
        return r.json().deploy;
    };

    t.restart = async () => { await stop(); await start(); };
    t.close = async () => { await stop(); await network.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    await start();
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock, DASHBOARD, SECRET };
