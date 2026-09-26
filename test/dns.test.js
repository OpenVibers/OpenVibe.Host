'use strict';
/**
 * The DNS adapter (lib/dns.js, WS-N task 12): Cloudflare's API with the operator's token (never printed);
 * dry run unless --apply; ensure creates, updates or leaves alone; DNS-only names and service records are
 * never proxied; web records name their proxy mode; duplicate records are refused; runs without an inventory.
 */
const assert = require('assert');
const { scenario, test, runTests } = require('./helpers');
const { createFakeHost } = require('./fake-host');
const { main } = require('../lib/cli');

const TOKEN = 'cf_TOKEN_MUST_NEVER_APPEAR_91b0';
const API = 'https://api.cloudflare.com/client/v4';

function cloudflare(host, records = []) {
    host.cf = { records: records.map((r, i) => ({ id: `rec${i}`, ttl: 1, proxied: false, ...r })), writes: [] };
    const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
    host.http.set(`${API}/zones?name=openvibe.live&per_page=5`, ({ headers }) => { assert.strictEqual(headers.Authorization, `Bearer ${TOKEN}`); return ok([{ id: 'z1', name: 'openvibe.live' }]); });
    for (const n of ['www.openvibe.live', 'ingest.openvibe.live', '_dmarc.openvibe.live', 'new.openvibe.live']) host.http.set(`${API}/zones?name=${n}&per_page=5`, () => ok([]));
    host.http.set(`${API}/zones/z1/dns_records?per_page=100&page=1`, () => ok(host.cf.records));
    for (const [name, type] of [['www.openvibe.live', 'A'], ['new.openvibe.live', 'CNAME'], ['ingest.openvibe.live', 'A'], ['_dmarc.openvibe.live', 'CNAME'], ['dup.openvibe.live', 'A']]) {
        host.http.set(`${API}/zones/z1/dns_records?type=${type}&name=${encodeURIComponent(name)}`, () => ok(host.cf.records.filter((r) => r.name === name && r.type === type)));
    }
    host.http.set(`${API}/zones?name=dup.openvibe.live&per_page=5`, () => ok([]));
    host.http.set(`${API}/zones/z1/dns_records`, ({ method, body }) => { const b = JSON.parse(body); host.cf.writes.push([method, b]); const rec = { id: `rec${host.cf.records.length}`, ...b }; host.cf.records.push(rec); return ok(rec); });
    for (let i = 0; i < 10; i++) {
        host.http.set(`${API}/zones/z1/dns_records/rec${i}`, ({ method, body }) => {
            host.cf.writes.push([method, body ? JSON.parse(body) : null]);
            const k = host.cf.records.findIndex((r) => r.id === `rec${i}`);
            if (method === 'DELETE') { host.cf.records.splice(k, 1); return ok({ id: `rec${i}` }); }
            host.cf.records[k] = { ...host.cf.records[k], ...JSON.parse(body) };
            return ok(host.cf.records[k]);
        });
    }
    return host;
}

runTests([
    test('list, then ensure: dry run by default, create / update / unchanged with --apply; the token never shows', async () => {
        const host = cloudflare(scenario(), [{ name: 'www.openvibe.live', type: 'A', content: '203.0.113.5', proxied: true }]);
        const env = { CLOUDFLARE_API_TOKEN: TOKEN };
        const cli = (...a) => main(a, { exec: host.exec, out: (s) => (host.lines = (host.lines || []).concat(s)), env });
        const run = async (...a) => { host.lines = []; const code = await cli(...a); return { code, out: host.lines.join('\n') }; };
        let r = await run('dns', 'list', 'openvibe.live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /zone openvibe\.live: 1 record\(s\)/);
        assert.match(r.out, /www\.openvibe\.live {2}A {2}203\.0\.113\.5 {2}proxied/);
        r = await run('dns', 'ensure', 'www.openvibe.live', 'A', '203.0.113.5', '--proxied');
        assert.match(r.out, /unchanged in openvibe\.live/);
        r = await run('dns', 'ensure', 'www.openvibe.live', 'A', '203.0.113.9', '--proxied');
        assert.match(r.out, /would update in openvibe\.live \(dry run; --apply to change\)/);
        assert.strictEqual(host.cf.writes.length, 0, 'a dry run writes nothing');
        r = await run('dns', 'ensure', 'www.openvibe.live', 'A', '203.0.113.9', '--proxied', '--apply');
        assert.match(r.out, /^update in openvibe\.live/m);
        assert.deepStrictEqual(host.cf.writes[0], ['PUT', { type: 'A', name: 'www.openvibe.live', content: '203.0.113.9', ttl: 1, proxied: true }]);
        r = await run('dns', 'ensure', 'new.openvibe.live', 'CNAME', 'openvibe.live', '--proxied', '--apply');
        assert.match(r.out, /^create in openvibe\.live/m);
        r = await run('dns', 'delete', 'new.openvibe.live', 'CNAME');
        assert.match(r.out, /would delete/);
        r = await run('dns', 'delete', 'new.openvibe.live', 'CNAME', '--apply');
        assert.match(r.out, /^delete in openvibe\.live/m);
        assert.ok(!JSON.stringify(host.calls).includes(TOKEN) && !r.out.includes(TOKEN), 'the token appears in no call record or output');
    }),
    test('guards: proxy mode required, DNS-only names and service records never proxied, duplicates refused, bad input', async () => {
        const host = cloudflare(scenario(), [{ name: 'dup.openvibe.live', type: 'A', content: '1.1.1.1' }, { name: 'dup.openvibe.live', type: 'A', content: '1.1.1.2' }]);
        const env = { CLOUDFLARE_API_TOKEN: TOKEN };
        const run = async (...a) => { const lines = []; const code = await main(a, { exec: host.exec, out: (s) => lines.push(s), env }); return { code, out: lines.join('\n') }; };
        let r = await run('dns', 'ensure', 'www.openvibe.live', 'A', '203.0.113.5');
        assert.deepStrictEqual([r.code, /need --proxied or --dns-only/.test(r.out)], [1, true]);
        r = await run('dns', 'ensure', 'ingest.openvibe.live', 'A', '203.0.113.5', '--proxied');
        assert.deepStrictEqual([r.code, /DNS-only by the inventory/.test(r.out)], [1, true]);
        r = await run('dns', 'ensure', '_dmarc.openvibe.live', 'CNAME', 'x.example', '--proxied');
        assert.deepStrictEqual([r.code, /never proxied/.test(r.out)], [1, true]);
        r = await run('dns', 'ensure', 'dup.openvibe.live', 'A', '1.1.1.1', '--dns-only');
        assert.deepStrictEqual([r.code, /2 A records named dup\.openvibe\.live/.test(r.out)], [2, true]);
        assert.strictEqual((await run('dns', 'ensure', 'Not A Name', 'A', '1.1.1.1', '--dns-only')).code, 1);
        assert.strictEqual((await run('dns', 'ensure', 'www.openvibe.live', 'SRV', 'x', '--dns-only')).code, 1);
        assert.strictEqual((await run('dns', 'ensure', 'www.openvibe.live', 'A', '1.1.1.1', '--proxied', '--dns-only')).code, 1);
        assert.strictEqual(host.cf.writes.length, 0);
    }),
    test('no token: a clear refusal; no inventory needed on the workstation', async () => {
        const bare = createFakeHost();   // no /etc/openvibe/host.json
        const lines = [];
        const code = await main(['dns', 'list', 'openvibe.live'], { exec: bare.exec, out: (s) => lines.push(s), env: {} });
        assert.strictEqual(code, 1);
        assert.match(lines.join('\n'), /no Cloudflare token/);
        const other = await main(['status'], { exec: bare.exec, out: () => {}, env: {} });
        assert.strictEqual(other, 1, 'other commands still need the inventory');
    }),
]);
