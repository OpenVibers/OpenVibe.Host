'use strict';
// ovhost reconcile (WS-X11 phase 1, D72): an `auto` service follows main at green CI without a person; a
// documentation-only change deploys nothing; missing, pending or failed CI never deploys; `manual` waits; a dry run
// changes nothing; every pass is recorded for the alert.
const assert = require('assert');
const { scenario, push, test, runTests } = require('./helpers');
const lib = require('../lib');
const { githubSlug, ciStatus } = require('../lib/reconcile');

function setup(policy = 'auto') {
    const host = scenario();
    host.inv.services.live.deploy = { policy };
    const ctx = { exec: host.exec, inv: host.inv, log: () => {} };
    const ci = new Map();   // sha -> check runs
    const hook = (sha) => `https://api.github.com/repos/OpenVibers/openvibe.live/commits/${sha}/check-runs?per_page=100`;
    const setCi = (sha, runs) => { ci.set(sha, runs); host.http.set(hook(sha), () => ({ status: 200, body: { total_count: runs.length, check_runs: runs } })); };
    return { host, ctx, setCi };
}
const only = (pass, id = 'live') => pass.services.find((s) => s.id === id);

runTests([
    test('githubSlug reads https and ssh remotes', () => {
        assert.strictEqual(githubSlug('https://github.com/OpenVibers/OpenVibe.Wiki.git'), 'OpenVibers/OpenVibe.Wiki');
        assert.strictEqual(githubSlug('git@github.com:OpenVibers/OpenVibe.Live.git'), 'OpenVibers/OpenVibe.Live');
        assert.strictEqual(githubSlug('https://gitlab.com/x/y.git'), null);
    }),
    test('up to date: nothing; documentation and tests only: nothing deployed', async () => {
        const { host, ctx } = setup();
        let pass = await lib.reconcile(ctx, { only: ['live'], textfileDir: '/var/lib/prometheus/node-exporter' });
        assert.strictEqual(only(pass).action, 'current');
        push(host, 'live', { 'README.md': '# new docs', 'test/a.test.js': 'x' });
        pass = await lib.reconcile(ctx, { only: ['live'] });
        assert.strictEqual(only(pass).action, 'docs-only');
        assert.ok(!host.calls.some((c) => /systemctl/.test(c.cmd) && (c.args || []).includes('restart')), 'nothing restarted');
    }),
    test('a runtime change waits for CI, is blocked by red CI, and deploys on green', async () => {
        const { host, ctx, setCi } = setup();
        const sha = push(host, 'live', { 'server/index.js': 'console.log(2);' });
        let pass = await lib.reconcile(ctx, { only: ['live'] });
        assert.strictEqual(only(pass).action, 'waiting', 'GitHub has no answer: never deployed on hope');
        setCi(sha, []);
        pass = await lib.reconcile(ctx, { only: ['live'] });
        assert.deepStrictEqual([only(pass).action, only(pass).ci], ['waiting', 'none']);
        setCi(sha, [{ name: 'test', status: 'in_progress', conclusion: null }]);
        assert.strictEqual(only(await lib.reconcile(ctx, { only: ['live'] })).ci, 'pending');
        setCi(sha, [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'security', status: 'completed', conclusion: 'success' }]);
        pass = await lib.reconcile(ctx, { only: ['live'] });
        assert.deepStrictEqual([only(pass).action, only(pass).ci], ['blocked', 'red']);
        assert.match(only(pass).detail, /test: failure/);
        setCi(sha, [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }]);
        const dry = await lib.reconcile(ctx, { only: ['live'], dryRun: true });
        assert.strictEqual(only(dry).action, 'would-deploy');
        pass = await lib.reconcile(ctx, { only: ['live'] });
        assert.strictEqual(only(pass).action, 'deployed', JSON.stringify(only(pass)));
        assert.strictEqual(only(pass).result, 'deployed');
        assert.strictEqual(only(await lib.reconcile(ctx, { only: ['live'] })).action, 'current', 'the next pass finds it current');
        const prom = host.read('/var/lib/prometheus/node-exporter/openvibe_reconcile.prom');
        assert.match(prom, /openvibe_reconcile_services\{action="current"\} 1/);
        assert.match(prom, /openvibe_reconcile_failed_total_last 0/);
        assert.ok(JSON.parse(host.read('/var/lib/openvibe-host/reconcile.json')).services.length >= 1);
    }),
    test('a manual (or gated) service waits for a person, whatever CI says', async () => {
        const { host, ctx, setCi } = setup('manual');
        const sha = push(host, 'live', { 'server/index.js': 'console.log(3);' });
        setCi(sha, [{ name: 'test', status: 'completed', conclusion: 'success' }]);
        const pass = await lib.reconcile(ctx, { only: ['live'] });
        assert.deepStrictEqual([only(pass).policy, only(pass).action], ['manual', 'waiting']);
        assert.throws(() => lib.inventory.normalise({ services: { x: { repo: '/opt/x', deploy: { policy: 'yolo' } } } }), /auto, gated or manual/);
    }),
    test('ciStatus: GitHub unreachable is unknown, never green', async () => {
        const exec = { request: async () => ({ status: 0, error: 'ECONNREFUSED' }) };
        assert.strictEqual((await ciStatus(exec, 'OpenVibers/x', 'abc')).verdict, 'unknown');
    }),
]);
