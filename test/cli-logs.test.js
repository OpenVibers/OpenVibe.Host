'use strict';
/**
 * `ovhost logs <service> [--tail n]`: the service's units' journal through
 * journalctl, driven against the fake host. Everything the command would
 * execute is recorded in host.journalctlCalls, so the tests assert the exact
 * argv (no shell, nothing interpolated) and the validation around it.
 */
const assert = require('assert');
const { scenario, test, runTests } = require('./helpers');

runTests([
    test('logs runs journalctl for every unit of the service, default tail 200', async () => {
        const host = scenario();
        host.journalctl = (args) => ({ stdout: `journal of ${args.filter((a) => a.endsWith('.service')).join(' ')}\n` });
        const r = await host.cli('logs', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.journalctlCalls, [{
            args: ['-u', 'openvibe-tools.service', '-u', 'openvibe-tools-maps.service', '-n', '200', '--no-pager', '-o', 'short-iso'],
            as: null,
            privileged: true,
        }]);
        assert.match(r.out, /journal of openvibe-tools\.service openvibe-tools-maps\.service/);
    }),

    test('logs --tail n passes -n n (space and = forms)', async () => {
        const host = scenario();
        let r = await host.cli('logs', 'live', '--tail', '5');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.journalctlCalls[0].args, ['-u', 'openvibe-live.service', '-n', '5', '--no-pager', '-o', 'short-iso']);
        host.journalctlCalls.length = 0;
        r = await host.cli('logs', 'live', '--tail=42');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.journalctlCalls[0].args, ['-u', 'openvibe-live.service', '-n', '42', '--no-pager', '-o', 'short-iso']);
        host.journalctlCalls.length = 0;
        r = await host.cli('logs', 'live', '--tail', '2000'); // the maximum
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.journalctlCalls[0].args, ['-u', 'openvibe-live.service', '-n', '2000', '--no-pager', '-o', 'short-iso']);
    }),

    test('logs prints journal output verbatim, newest last', async () => {
        const host = scenario();
        host.journalctl = () => ({ stdout: 'Oct 01 12:00:00 host openvibe-live[1]: started\nOct 01 12:00:01 host openvibe-live[1]: ready\n' });
        const r = await host.cli('logs', 'live', '--tail', '2');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /^Oct 01 12:00:00 host openvibe-live\[1\]: started$/m);
        assert.match(r.out, /^Oct 01 12:00:01 host openvibe-live\[1\]: ready$/m);
    }),

    test('logs --json emits the query and the lines', async () => {
        const host = scenario();
        host.journalctl = () => ({ stdout: 'one\ntwo\n' });
        const r = await host.cli('logs', 'live', '--tail', '3', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const j = JSON.parse(r.out);
        assert.deepStrictEqual(j, { service: 'live', units: ['openvibe-live.service'], tail: 3, code: 0, lines: ['one', 'two'] });
    }),

    test('logs validates --tail: whole number from 1 to 2000, journalctl never runs', async () => {
        const host = scenario();
        for (const bad of ['0', '-1', 'abc', '1.5', '', '2001']) {
            const r = await host.cli('logs', 'live', '--tail', bad);
            assert.strictEqual(r.code, 1, `${bad}: ${r.out}`);
            assert.match(r.out, /--tail must be a whole number from 1 to 2000/);
        }
        assert.deepStrictEqual(host.journalctlCalls, []);
    }),

    test('logs needs a service that the inventory knows — nothing is executed for anything else', async () => {
        const host = scenario();
        let r = await host.cli('logs');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /logs needs a <service>/);
        r = await host.cli('logs', 'nope');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /unknown service "nope"/);
        // A shell metacharacter in the service position is only ever an unknown
        // service name: journalctl takes an argv array, so nothing interpolates.
        r = await host.cli('logs', 'live; touch /tmp/pwned', '--tail', '1');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /unknown service/);
        r = await host.cli('logs', 'live', '--tail', '5; touch /tmp/pwned');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /--tail must be a whole number/);
        assert.deepStrictEqual(host.journalctlCalls, []);
        assert.ok(!host.calls.some((c) => c.cmd === 'journalctl'));
    }),

    test('logs refuses a service with no units instead of dumping the whole journal', async () => {
        const host = scenario();
        const r = await host.cli('logs', 'sites');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /sites declares no units/);
        assert.deepStrictEqual(host.journalctlCalls, []);
    }),

    test('logs reports a journalctl failure and exits 1', async () => {
        const host = scenario();
        host.journalctl = () => ({ code: 1, stdout: '', stderr: 'Failed to get access to the journal' });
        const r = await host.cli('logs', 'live');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /journalctl failed \(exit 1\): Failed to get access to the journal/);
        const j = JSON.parse((await host.cli('logs', 'live', '--json')).out);
        assert.strictEqual(j.code, 1);
        assert.deepStrictEqual(j.lines, []);
    }),

    test('logs runs nothing but journalctl (read-only, no restart, no write)', async () => {
        const host = scenario();
        const before = host.files.size;
        await host.cli('logs', 'live', '--tail', '10');
        assert.deepStrictEqual(host.calls.map((c) => c.cmd), ['journalctl']);
        assert.deepStrictEqual(host.restarts(), []);
        assert.deepStrictEqual(host.socketViolations(), []);
        assert.deepStrictEqual(host.reads, ['/etc/openvibe/host.json']); // the inventory load, nothing else
        assert.strictEqual(host.files.size, before);
    }),
]);
