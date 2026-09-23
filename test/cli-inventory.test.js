'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scenario, push, test, runTests } = require('./helpers');
const { normalise } = require('../lib/inventory');
const { createFakeHost } = require('./fake-host');
const { main } = require('../lib/cli');

async function cli(host, ...argv) {
    const lines = [];
    const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {} });
    return { code, out: lines.join('\n') };
}

runTests([
    test('host.example.json is a valid inventory for every service on the host', () => {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));
        const inv = normalise(raw);
        assert.deepStrictEqual(Object.keys(inv.services), ['network', 'live', 'media', 'tools', 'community', 'events', 'games', 'sites', 'host', 'billing', 'chat', 'search', 'sources', 'wiki', 'blog', 'tips', 'vip', 'news', 'reviews', 'deals', 'coupons', 'trade', 'codes', 'ai', 'openre']);
        assert.strictEqual(inv.services.live.socketUnit, 'openvibe-live.socket');
        assert.ok(!inv.services.live.units.includes('openvibe-live.socket'));
        assert.strictEqual(inv.services.live.protected.url, 'http://127.0.0.1:3000/api/streams');
        assert.match(inv.services.media.protected.sql, /is_recording = 1/);
        assert.strictEqual(inv.services.games.managed, false);
        for (const s of Object.values(inv.services)) assert.strictEqual(s.owner, 'ubuntu', `${s.id} checkout owner`);
        const text = JSON.stringify(raw);
        assert.ok(!/(sk_|ghp_|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*\S)/i.test(text), 'no secret values in the example');
    }),

    test('the service manifest proposal is valid against the contracts schema', () => {
        const contracts = require('openvibe-contracts');
        const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'service-manifest-proposal.json'), 'utf8'));
        contracts.assertValid('registry.service-manifest', m);
        assert.strictEqual(m.id, 'host');
        assert.deepStrictEqual(m.capabilities, ['host.site.manage', 'host.deploy.create', 'host.domain.manage'], 'Stage A has no API; the Stage B service enforces these three');
    }),

    test('as root, an inventory that is not root-owned or is writable by others is refused', async () => {
        const host = scenario();
        host.files.get('/etc/openvibe/host.json').owner = 'ubuntu';
        let r = await host.cli('status');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /must be owned by root/);
        host.files.get('/etc/openvibe/host.json').owner = 'root';
        host.files.get('/etc/openvibe/host.json').mode = 0o666;
        r = await host.cli('status');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /must not be group- or world-writable/);
    }),

    test('inventory validation rejects paths and names that could point a root process somewhere else', () => {
        const base = { owner: 'ubuntu' };
        assert.throws(() => normalise({ services: { x: { ...base, repo: 'opt/x' } } }), /absolute path/);
        assert.throws(() => normalise({ services: { x: { ...base, repo: '/opt/x', nginx: { vhost: '../../etc/passwd' } } } }), /file name/);
        assert.throws(() => normalise({ services: { x: { ...base, repo: '/opt/x', ready: { url: 'http://evil.example/ready' } } } }), /loopback/);
        assert.throws(() => normalise({ services: { x: { ...base, repo: '/opt/x', protected: { kind: 'sqlite-count', db: '/d.db', sql: 'DELETE FROM vods' } } } }), /SELECT/);
        assert.throws(() => normalise({ services: { 'X Y': { ...base, repo: '/opt/x' } } }), /service id/);
        assert.throws(() => normalise({ services: { x: { ...base, repo: '/opt/x', unitSources: { 'a.service': '../../etc/shadow' } } } }), /inside the checkout/);
    }),

    test('no inventory, unknown service, unknown command, help', async () => {
        const empty = createFakeHost();
        let r = await cli(empty, 'status');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /no inventory found/);
        const host = scenario();
        r = await host.cli('validate', 'nope');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /unknown service "nope"/);
        r = await host.cli('frobnicate');
        assert.strictEqual(r.code, 1);
        r = await host.cli('--help');
        assert.strictEqual(r.code, 0);
        assert.match(r.out, /ovhost — OpenVibe.Host operator plane/);
        r = await host.cli('releases', '../../etc/x');
        assert.strictEqual(r.code, 1);
        r = await host.cli('deploy', 'live', '--to', '--upload-pack=touch /tmp/x');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /not a sha or ref name/);
        assert.ok(!host.calls.some((c) => c.cmd === 'git' && c.args.some((a) => a.includes('upload-pack'))));
        r = await host.cli('deploy');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /needs a <service>/);
    }),

    test('status covers every service: units, socket, sha, readiness, protected sessions', async () => {
        const host = scenario();
        host.liveStreams = [{ is_live: 1 }];
        host.recording = 2;
        host.units.get('openvibe-events.service').active = 'failed';
        const r = await host.cli('status');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /^live +[0-9a-f]{12} ready +openvibe-live=active socket=active live streams=1$/m);
        assert.match(r.out, /^media .* recordings in progress=2$/m);
        assert.match(r.out, /^tools .*openvibe-tools=active openvibe-tools-maps=active/m);
        assert.match(r.out, /^events .*NOT READY \(502\)/m);
        assert.match(r.out, /^sites .*\(no units\)/m);
        const json = JSON.parse((await host.cli('status', 'live', '--json')).out);
        assert.strictEqual(json.length, 1);
        assert.strictEqual(json[0].protected.count, 1);
        assert.deepStrictEqual(host.restarts(), [], 'status never restarts anything');
    }),

    test('releases prints the log; an unmanaged service refuses deploy; the releases/current layout is refused', async () => {
        const host = scenario();
        push(host, 'live', { 'server/index.js': 'z();' }, 'z change');
        await host.cli('deploy', 'live');
        const r = await host.cli('releases', 'live');
        assert.match(r.out, /deploy +[0-9a-f]{12} → [0-9a-f]{12} +deployed/);
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.events.managed = false;
        raw.services.events.unmanagedReason = 'test';
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        const u = await host.cli('deploy', 'events');
        assert.strictEqual(u.code, 1);
        assert.match(u.out, /not managed by ovhost: test/);
        await host.exec.symlink('/opt/openvibe.media/releases/x', '/opt/openvibe.media/current');
        const rl = await host.cli('deploy', 'media');
        assert.strictEqual(rl.code, 1);
        assert.match(rl.out, /releases\/current layout/);
    }),
]);
