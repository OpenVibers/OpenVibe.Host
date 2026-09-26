'use strict';
/**
 * Host fetches no URL or host a tenant chose (roadmap WS-R task 5, the SSRF class). The one place a
 * tenant names a host is a custom domain, and it is proven by a DNS TXT record read through the
 * configured resolver, never by a request to the domain: this suite adds custom domains that name
 * or resolve to internal addresses in every spelling (loopback, decimal, IPv6, metadata, private
 * ranges, internal names), verifies and rechecks them, serves requests with those Host headers and
 * absolute-form targets, and records every outbound request of the process: none may go to any of
 * them. (host-isolation.test.js pins that a tenant reaches only its own site through Host headers,
 * paths and absolute-form targets.) And a ratchet over the files in server/ that make outbound
 * requests.
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');

const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => { outbound.push(String((url && url.url) || url)); return realFetch(url, opts); };
const connects = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (o && typeof o === 'object' && o.host) connects.push(`${o.host}:${o.port}`);
    return realConnect.apply(this, args);
};

const { boot, check, done } = require('./stageb/boot');

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const p = await t.project(alice, 'A');
    const s = await t.site(alice, p.id, 'alice-site');
    await t.deploy(alice, s.id, { 'index.html': 'ALICE' });

    await check('custom domains naming internal hosts are refused or proven by TXT only, never requested', async () => {
        const before = connects.length;
        const names = ['www.alice-example.org', 'localhost', '127.0.0.1', '2130706433', '0x7f000001', '[::1]', '::ffff:127.0.0.1', '169.254.169.254', '10.0.0.1', 'metadata.google.internal',
            'admin.localhost', 'intranet.local', 'db.internal', '127.0.0.1.nip.io'];
        const added = [];
        for (const hostname of names) {
            const r = await t.api('POST', `/api/v1/sites/${s.id}/domains`, { as: alice, json: { hostname } });
            if (r.status !== 201) continue;
            added.push(hostname);
            const dom = r.json().domain;
            if (t.dns) t.dns.set(`_openvibe-host.${dom.hostname}`, [dom.instructions.verification.value]);
            await t.api('POST', `/api/v1/domains/${dom.id}/verify`, { as: alice, json: {} });
            await t.get(dom.hostname, '/');
        }
        for (const target of ['http://127.0.0.1:1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
            await t.request({ method: 'GET', host: 'alice-site.openvibe.host', path: target });
        }
        assert.ok(added.includes('www.alice-example.org'), `a real domain was added and verified (control): ${added.join(', ')}`);
        assert.ok(t.dnsCalls.length > 0, 'verification asked the resolver for TXT records');
        // The only outbound requests are to the stand-in Network (keys, tokens); every connection goes
        // to the dashboard itself or to it.
        const mine = new URL(t.network.url);
        assert.deepStrictEqual(outbound.filter((u) => !u.startsWith(t.network.url)), [], 'Host requested something other than Network');
        const allowed = new Set([String(t.port), mine.port]);
        const odd = connects.slice(before).filter((c) => !(/^(127\.0\.0\.1|::1|localhost):/.test(c) && allowed.has(c.split(':').pop())));
        assert.deepStrictEqual(odd, [], 'a connection went to a tenant-named host');
    });

    await check('ratchet: every file in server/ that makes an outbound request itself is reviewed', () => {
        const REVIEWED = {
            'server/auth/sso.js': 'Network JWKS, OAuth token and revoke (configured)',
        };
        const root = path.join(__dirname, '..');
        const found = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                    if (/(^|[^.\w])fetch\(|\bhttps?\.(get|request)\(|new WebSocket\(|\bnet\.connect\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
                }
            }
        };
        walk(path.join(root, 'server'));
        assert.ok(found.length >= 1, `the scan finds the known site (${found.join(', ')})`);
        assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a tenant-chosen host goes through openvibe-shared/egress; then add the file here with where it goes');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
