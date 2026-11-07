'use strict';
const assert = require('assert');
const { scenario, push, test, runTests } = require('./helpers');
const { liveHost } = require('./strategy-hosts');

const tick = () => new Promise((resolve) => setImmediate(resolve));

runTests([
    test('concurrent deploys serialize preparation across services', async () => {
        const host = scenario();
        push(host, 'live', { 'package-lock.json': '{"lockfileVersion":3,"v":2}', 'server/index.js': 'v2();' });
        const oldMedia = host.repo('media').head;
        push(host, 'media', { 'server/index.js': 'v2();' });
        const originalRun = host.exec.run.bind(host.exec);
        let entered;
        const installing = new Promise((resolve) => { entered = resolve; });
        let continueInstall;
        const barrier = new Promise((resolve) => { continueInstall = resolve; });
        host.exec.run = async (cmd, args, opts) => {
            if (cmd === 'npm' && !host.installPaused) {
                host.installPaused = true;
                entered();
                await barrier;
            }
            return originalRun(cmd, args, opts);
        };
        const first = host.cli('deploy', 'live');
        await installing;
        const second = host.cli('deploy', 'media');
        await tick();
        assert.deepStrictEqual(host.deployLockEvents.slice(0, 2), ['acquire:live', 'wait:media:live']);
        assert.strictEqual(host.repo('media').head, oldMedia, 'media did not prepare while live installed');
        continueInstall();
        const [a, b] = await Promise.all([first, second]);
        assert.strictEqual(a.code, 0, a.out);
        assert.strictEqual(b.code, 0, b.out);
        assert.match(b.out, /waiting for live's deploy to finish/);
        assert.deepStrictEqual(host.deployLockEvents, ['acquire:live', 'wait:media:live', 'release:live', 'acquire:media', 'release:media']);
    }),

    test('--wait-idle releases the host lock while streams are active', async () => {
        const host = scenario();
        push(host, 'live', { 'server/index.js': 'v2();' });
        push(host, 'media', { 'server/index.js': 'v2();' });
        let probes = 0;
        host.http.set('http://127.0.0.1:3000/api/streams', () => ({ status: 200, body: { streams: ++probes <= 2 ? [{ is_live: true }] : [] } }));
        const originalSleep = host.exec.sleep.bind(host.exec);
        let sleeping;
        const entered = new Promise((resolve) => { sleeping = resolve; });
        let resume;
        const barrier = new Promise((resolve) => { resume = resolve; });
        host.exec.sleep = async (ms) => {
            if (ms === 60000 && !host.waitPaused) { host.waitPaused = true; sleeping(); await barrier; }
            return originalSleep(ms);
        };
        const first = host.cli('deploy', 'live', '--wait-idle');
        await entered;
        assert.deepStrictEqual(host.deployLockEvents.slice(0, 2), ['acquire:live', 'release:live']);
        const other = await host.cli('deploy', 'media');
        assert.strictEqual(other.code, 0, other.out);
        resume();
        const result = await first;
        assert.strictEqual(result.code, 0, result.out);
        assert.deepStrictEqual(host.deployLockEvents, ['acquire:live', 'release:live', 'acquire:media', 'release:media', 'acquire:live', 'release:live']);
    }),

    test('memory guard waits for MemAvailable and then installs', async () => {
        const host = scenario();
        push(host, 'live', { 'package-lock.json': '{"lockfileVersion":3,"v":2}' });
        const readings = [512, 768, 2048];
        host.memAvailableMiB = () => readings.shift() || 2048;
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /MemAvailable is 512 MiB, below 1536 MiB/);
        assert.match(r.out, /MemAvailable is 2048 MiB; proceeding/);
        assert.ok(host.calls.some((c) => c.cmd === 'npm'));
    }),

    test('memory guard times out without starting npm or restarting', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        push(host, 'live', { 'package-lock.json': '{"lockfileVersion":3,"v":2}' });
        host.memAvailableMiB = 512;
        const inventory = JSON.parse(host.read('/etc/openvibe/host.json'));
        inventory.deployGuard = { memoryWaitSeconds: 10 };
        host.put('/etc/openvibe/host.json', JSON.stringify(inventory), { mode: 0o640, owner: 'root' });
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /MemAvailable stayed below 1536 MiB for 10s/);
        assert.strictEqual(host.repo('live').head, from);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm'));
        assert.deepStrictEqual(host.restarts(), []);
    }),
    test('release-layout memory timeout removes the prepared release', async () => {
        const host = await liveHost();
        host.push({ 'package-lock.json': '{"lockfileVersion":3,"v":2}' }, 'dependencies');
        host.memAvailableMiB = 512;
        const inventory = JSON.parse(host.read('/etc/openvibe/host.json'));
        inventory.deployGuard = { memoryWaitSeconds: 10 };
        host.put('/etc/openvibe/host.json', JSON.stringify(inventory), { mode: 0o640, owner: 'root' });
        const result = await host.cli('deploy', 'live');
        assert.strictEqual(result.code, 2, result.out);
        assert.deepStrictEqual(await host.releaseIds(), [host.firstRelease]);
        assert.strictEqual(host.current(), host.firstRelease);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm'));
        assert.deepStrictEqual(host.restarts(), []);
    }),
]);
