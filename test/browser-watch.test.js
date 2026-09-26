'use strict';
/**
 * The release UX check (lib/browser-watch.js, WS-H task 11): a site is checked in a browser when its release
 * changes and once a day, as ovcheck; a failure is confirmed by a second run; a run that broke records
 * nothing; the outcome reaches the textfile collector for OpenVibeBrowserCheckFailed.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const { scenario, test, runTests } = require('./helpers');
const { watch, failingChecks, DAY_MS } = require('../lib/browser-watch');
const { runBrowserCheck } = require('../lib/browser-check-hook');

const PROM = '/var/lib/prometheus/node-exporter/openvibe_browsercheck.prom';
const pass = [{ base: 'https://openvibe.live', ok: true, summary: { checks: { status: { fail: 0 }, console: { fail: 0 } } } }];
const fail = [{ base: 'https://openvibe.live', ok: false, summary: { checks: { status: { fail: 0 }, console: { fail: 2 }, overflow: { fail: 1 } } },
    routes: [{ path: '/', ok: false, axe: { violations: [{ id: 'color-contrast', impact: 'serious', targets: ['.live-card .badge', '.b', '.c', '.d'] }] }, errors: [], widths: [{ width: 390, errors: [{ text: 'WebSocket closed' }], overflow: true, offenders: ['.wide'] }] }, { path: '/ok', ok: true }] }];

function site({ release = 'abc1234def56' } = {}) {
    const host = scenario();
    host.inv.services.live.origin = 'https://openvibe.live';
    host.put('/var/lib/prometheus/node-exporter/.keep', '');
    host.release = release;
    host.http.set('https://openvibe.live/release.json', () => ({ status: 200, body: { service: 'live', release: host.release, booted_at: host.bootedAt || '2026-09-01T00:00:00Z' } }));
    host.runs = [];
    host.answers = [];
    host.check = async (s, opts) => { host.runs.push({ s, opts }); const a = host.answers.shift() || { code: 0, reports: pass }; return { code: a.code, stdout: a.reports ? JSON.stringify(a.reports) : '', error: a.error || null }; };
    return host;
}

runTests([
    test('a new release is checked as ovcheck with --json; the same release is skipped; a day later it is checked again', async () => {
        const host = site();
        const now = Date.parse('2026-09-26T14:00:00Z');
        let r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now });
        assert.deepStrictEqual(r.sites.map((x) => [x.site, x.release, x.action, x.ok]), [['live', 'abc1234def56', 'checked', true]]);
        assert.deepStrictEqual(host.runs.map((x) => [x.s, x.opts.asUser, x.opts.home, x.opts.args]), [['live', 'ovcheck', '/var/lib/ovcheck', ['--json']]]);
        assert.match(host.files.get(PROM).content, /^openvibe_browser_check_ok\{service="live"\} 1$/m);
        assert.match(host.files.get(PROM).content, /^openvibe_browser_check_release_info\{service="live",release="abc1234def56"\} 1$/m);
        assert.match(host.files.get(PROM).content, /^openvibe_browser_check_failing_checks\{service="live"\} 0$/m);
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now: now + 60000 });
        assert.strictEqual(r.sites[0].action, 'skipped');
        assert.strictEqual(host.runs.length, 1);
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now: now + DAY_MS + 1 });
        assert.strictEqual(r.sites[0].action, 'checked', 'daily even without a release');
        host.release = 'fff0000aaa11';
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now: now + DAY_MS + 60000 });
        assert.deepStrictEqual([r.sites[0].action, r.sites[0].release], ['checked', 'fff0000aaa11']);
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now: now + DAY_MS + 120000, force: true });
        assert.strictEqual(r.sites[0].action, 'checked', '--force');
    }),
    test('a failure is confirmed by a second run before it counts; one flake then a pass is a pass', async () => {
        let host = site();
        host.answers.push({ code: 1, reports: fail }, { code: 1, reports: fail });
        let r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check });
        assert.strictEqual(host.runs.length, 2);
        assert.deepStrictEqual([r.sites[0].ok, r.sites[0].failing], [false, [{ check: 'console', fail: 2 }, { check: 'overflow', fail: 1 }]]);
        assert.match(host.files.get(PROM).content, /^openvibe_browser_check_ok\{service="live"\} 0$/m);
        assert.match(host.files.get(PROM).content, /^openvibe_browser_check_failing_checks\{service="live"\} 2$/m);
        const st = JSON.parse(host.files.get('/var/lib/openvibe-host/browser-watch/live.json').content);
        assert.deepStrictEqual(st.details, [
            { route: '/', check: 'axe', rule: 'color-contrast', impact: 'serious', targets: ['.live-card .badge', '.b', '.c'] },
            { route: '/', check: 'errors', width: 390, message: 'WebSocket closed' },
            { route: '/', check: 'overflow', width: 390, offenders: ['.wide'] },
        ], 'what failed is kept for the operator');
        host = site();
        host.answers.push({ code: 1, reports: fail }, { code: 0, reports: pass });
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check });
        assert.deepStrictEqual([host.runs.length, r.sites[0].ok], [2, true]);
    }),
    test('a release that just booted settles for 3 minutes before it is judged; --force does not wait', async () => {
        const host = site();
        const now = Date.parse('2026-09-26T16:30:00Z');
        host.bootedAt = '2026-09-26T16:29:00Z';
        let r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now });
        assert.deepStrictEqual([r.sites[0].action, r.sites[0].reason, host.runs.length], ['skipped', 'the release is settling', 0]);
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now: now + 3 * 60 * 1000 });
        assert.strictEqual(r.sites[0].action, 'checked');
        host.bootedAt = '2026-09-26T16:40:00Z';
        host.release = 'bbb1111ccc22';
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, now: Date.parse('2026-09-26T16:40:30Z'), force: true });
        assert.strictEqual(r.sites[0].action, 'checked');
    }),
    test('the confirming second run waits first', async () => {
        const host = site();
        host.answers.push({ code: 1, reports: fail }, { code: 0, reports: pass });
        const waits = [];
        await watch(host.ctx(), { check: host.check, retryDelayMs: 60000, sleep: async (ms) => { waits.push(ms); } });
        assert.deepStrictEqual(waits, [60000]);
    }),
    test('a run that broke (exit 2) records nothing and is retried by the next timer run', async () => {
        const host = site();
        host.answers.push({ code: 2, error: 'Chrome not found' });
        let r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check });
        assert.deepStrictEqual([r.sites[0].action, r.sites[0].reason, host.runs.length], ['error', 'Chrome not found', 1]);
        assert.ok(!host.files.has('/var/lib/openvibe-host/browser-watch/live.json'));
        r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check });
        assert.strictEqual(r.sites[0].action, 'checked');
    }),
    test('bad ids and sites without an origin are errors, not checks; the CLI exits 1 on a failed check and 2 on an error', async () => {
        const host = site();
        const r = await watch(host.ctx(), { retryDelayMs: 0, check: host.check, sites: ['Bad!', 'nosuchservice'], contracts: { services: { get: () => null } } });
        assert.deepStrictEqual(r.sites.map((x) => x.action), ['error', 'error']);
        assert.strictEqual(host.runs.length, 0);
        const c = await scenario().cli('browser-watch', '--sites', 'Bad!');
        assert.strictEqual(c.code, 2);
        assert.match(c.out, /ERR {2}Bad!: not a service id/);
    }),
    test('failingChecks reads the reports; the hook runs as another user through runuser with HOME', async () => {
        assert.deepStrictEqual(failingChecks([{ summary: { checks: { a: { fail: 0 }, b: { fail: 3 } } } }, { error: 'boom', summary: { checks: {} } }]), [{ check: 'b', fail: 3 }, { check: 'run', fail: 1 }]);
        const seen = [];
        const fake = (cmd, args) => { seen.push([cmd, ...args]); return spawn(process.execPath, ['-e', 'process.stdout.write("[]")']); };
        const r = await runBrowserCheck('live', { args: ['--json'], asUser: 'ovcheck', home: '/var/lib/ovcheck', spawnFn: fake });
        assert.deepStrictEqual([r.code, r.stdout], [0, '[]']);
        assert.deepStrictEqual(seen[0].slice(0, 6), ['runuser', '-u', 'ovcheck', '--', 'env', 'HOME=/var/lib/ovcheck']);
        assert.ok(seen[0].includes('--sites') && seen[0].includes('live') && seen[0].includes('--json'));
    }),
]);
