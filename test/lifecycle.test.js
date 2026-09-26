'use strict';
/**
 * Lifecycle declarations (roadmap WS-P task 1) in `ovhost validate`: every required field present
 * (the finding names the service and the field), the shutdown deadline within each unit's stop
 * timeout, the unit's stop signal the declared one, worker drains against their units, and the
 * checkout's openvibe-contracts inside contracts.range. The block comes from the inventory, from
 * --manifest <file>, or from the manifest in the installed openvibe-contracts.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scenario, push, test, runTests, lifecycleDoc } = require('./helpers');
const lifecycle = require('../lib/lifecycle');
const { normalise, InventoryError } = require('../lib/inventory');
const { validate } = require('../lib/commands/validate');

/** Rewrite the inventory file (what the CLI reads) through fn(raw). */
function edit(host, fn) {
    const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
    fn(raw);
    host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640, owner: 'root' });
}

async function findings(host, id, ...extra) {
    const r = await host.cli('validate', id, '--json', ...extra);
    const res = JSON.parse(r.out);
    return { code: r.code, all: res.findings, lc: res.findings.filter((f) => f.area === 'lifecycle') };
}

const errors = (list) => list.filter((f) => f.level === 'error').map((f) => f.message);

runTests([
    test('systemd time spans, unit-file timeouts, signal names and contract ranges', async () => {
        const P = lifecycle.parseSeconds;
        assert.strictEqual(P('1min 30s'), 90);
        assert.strictEqual(P('15s'), 15);
        assert.strictEqual(P('15'), 15);
        assert.strictEqual(P('30min'), 1800);
        assert.strictEqual(P('1h 2min'), 3720);
        assert.strictEqual(P('500ms'), 0.5);
        assert.strictEqual(P('2min 5s 300ms'), 125.3);
        assert.strictEqual(P('infinity'), Infinity);
        assert.strictEqual(P(''), null);
        assert.strictEqual(P('soon'), null);
        assert.strictEqual(lifecycle.unitFileTimeout('[Service]\nTimeoutStopSec=15\nKillSignal=SIGTERM\n'), 15);
        assert.strictEqual(lifecycle.unitFileTimeout('[Service]\nTimeoutStopSec=10\nTimeoutStopSec=30min\n'), 1800, 'the last one wins');
        assert.strictEqual(lifecycle.unitFileTimeout('[Service]\nExecStart=node x.js\n'), null);
        assert.strictEqual(lifecycle.signalName('15'), 'SIGTERM');
        assert.strictEqual(lifecycle.signalName('2'), 'SIGINT');
        assert.strictEqual(lifecycle.signalName('term'), 'SIGTERM');
        const S = lifecycle.satisfies;
        assert.ok(S('0.55.0', '>=0.2.0 <1.0.0') && !S('1.0.0', '>=0.2.0 <1.0.0') && !S('0.1.9', '>=0.2.0 <1.0.0'));
        assert.ok(S('0.1.4', '^0.1.0') && !S('0.2.0', '^0.1.0') && S('1.4.0', '^1.2.0') && !S('2.0.0', '^1.2.0'));
        assert.ok(S('0.49.0', '0.49.0') && !S('0.49.1', '0.49.0') && !S('x', '>=0.1.0') && !S('0.5.0', 'latest'));
    }),

    test('check() names each missing or malformed field; none needs a reason and is refused for liveness and shutdown of a running service', async () => {
        assert.deepStrictEqual(lifecycle.check(lifecycleDoc(), { runs: true }), []);
        assert.deepStrictEqual(lifecycle.check(null), [{ field: 'lifecycle', problem: 'is missing' }]);
        const lc = lifecycleDoc();
        delete lc.shutdown.deadlineSeconds;
        delete lc.leases;
        lc.startupRecovery.resumes.push({ kind: 'magic', what: 'x' });
        lc.contracts = { range: 'latest' };
        const fields = lifecycle.check(lc, { runs: true }).map((p) => `${p.field} ${p.problem}`);
        assert.ok(fields.includes('lifecycle.shutdown.deadlineSeconds is missing'), fields.join('\n'));
        assert.ok(fields.includes('lifecycle.leases is missing'));
        assert.ok(fields.some((f) => f.startsWith('lifecycle.startupRecovery.resumes[1].kind must be one of')));
        assert.ok(fields.includes('lifecycle.contracts.range "latest" is not a version range'));
        const none = lifecycleDoc({ shutdown: { none: 'static' }, leases: { none: '' } });
        const p = lifecycle.check(none, { runs: true }).map((x) => `${x.field} ${x.problem}`);
        assert.ok(p.includes('lifecycle.shutdown is none ("static"), but the service runs units'), p.join('\n'));
        assert.ok(p.includes('lifecycle.leases.none must be the only key, with a reason'));
        assert.deepStrictEqual(lifecycle.check(lifecycleDoc({ shutdown: { none: 'static files' }, liveness: { none: 'static files' } }), { runs: false }), [], 'no units: none is fine');
        assert.ok(lifecycle.check(lifecycleDoc({ shutdown: { signal: 'SIGKILL', deadlineSeconds: 5, drains: ['x'] } }), { runs: true }).some((x) => x.field === 'lifecycle.shutdown.signal'));
    }),

    test('a complete declaration passes: every field, the deadline within the stop timeout, the signal systemd sends', async () => {
        const host = scenario();
        host.units.get('openvibe-live.service').timeoutStop = '15s';
        const r = await findings(host, 'live');
        assert.deepStrictEqual(errors(r.lc), []);
        assert.ok(r.lc.some((f) => f.level === 'ok' && /live: liveness, shutdown, startupRecovery, rollback, contracts and leases declared by the inventory/.test(f.message)));
        assert.ok(r.lc.some((f) => f.level === 'ok' && f.message === 'openvibe-live.service: shutdown deadline 5 s within its stop timeout of 15 s'));
        // systemd's default when the unit sets none (DefaultTimeoutStopSec, 90 s stock).
        const m = await findings(host, 'media');
        assert.ok(m.lc.some((f) => f.message === 'openvibe-media.service: shutdown deadline 70 s within its stop timeout of 90 s'));
        // A static site: liveness and shutdown are none, and nothing is compared.
        const s = await findings(host, 'sites');
        assert.deepStrictEqual(errors(s.lc), []);
    }),

    test('no declaration anywhere fails, naming the service and where it looked', async () => {
        const host = scenario();
        // A manifest id the installed openvibe-contracts does not have (whatever version is pinned).
        edit(host, (raw) => { delete raw.services.live.lifecycle; raw.services.live.manifest = 'not-a-manifest'; });
        const r = await findings(host, 'live');
        assert.strictEqual(r.code, 2);
        const msg = errors(r.lc).join('\n');
        assert.match(msg, /^live: no lifecycle declared \(looked at openvibe-contracts v\d+\.\d+\.\d+ \(no "not-a-manifest" manifest\)\)/);
        assert.match(msg, /set services\.live\.lifecycle/);
        const text = (await host.cli('validate', 'live')).out;
        assert.match(text, /FAIL +lifecycle live: no lifecycle declared/);
        assert.match(text, /live: NOT valid/);
    }),

    test('a missing field fails with a message naming the service and the field', async () => {
        const host = scenario();
        edit(host, (raw) => {
            delete raw.services.live.lifecycle.shutdown.deadlineSeconds;
            delete raw.services.live.lifecycle.leases;
            delete raw.services.live.lifecycle.rollback.window;
        });
        const r = await findings(host, 'live');
        assert.strictEqual(r.code, 2);
        const msgs = errors(r.lc);
        assert.ok(msgs.includes('live: lifecycle.shutdown.deadlineSeconds is missing (from the inventory (services.live.lifecycle))'), msgs.join('\n'));
        assert.ok(msgs.includes('live: lifecycle.leases is missing (from the inventory (services.live.lifecycle))'));
        assert.ok(msgs.includes('live: lifecycle.rollback.window is missing (from the inventory (services.live.lifecycle))'));
        // A running service cannot declare no shutdown.
        edit(host, (raw) => { raw.services.events.lifecycle.shutdown = { none: 'nothing to do' }; });
        const e = await findings(host, 'events');
        assert.ok(errors(e.lc).some((m) => m.startsWith('events: lifecycle.shutdown is none ("nothing to do"), but the service runs units')));
    }),

    test('a deadline longer than the unit\'s stop timeout fails; so does a different stop signal', async () => {
        const host = scenario();
        host.units.get('openvibe-media.service').timeoutStop = '1min';
        let r = await findings(host, 'media');
        assert.strictEqual(r.code, 2);
        assert.ok(errors(r.lc).includes('media: lifecycle.shutdown.deadlineSeconds 70 exceeds the openvibe-media.service stop timeout of 60 s (systemd TimeoutStopUSec=1min); systemd would kill it mid-drain'), errors(r.lc).join('\n'));
        host.units.get('openvibe-media.service').timeoutStop = '1min 20s';
        host.units.get('openvibe-media.service').killSignal = 2;
        r = await findings(host, 'media');
        assert.deepStrictEqual(errors(r.lc), ['media: openvibe-media.service stops with SIGINT (KillSignal) but lifecycle.shutdown.signal is SIGTERM']);
        host.units.get('openvibe-media.service').killSignal = 15;
        r = await findings(host, 'media');
        assert.deepStrictEqual(errors(r.lc), []);
    }),

    test('a unit that is not loaded is compared through TimeoutStopSec in its unit source', async () => {
        const host = scenario();
        const sha = push(host, 'live', { 'deploy/systemd/openvibe-live.service': '[Service]\nExecStart=node server/index.js\nTimeoutStopSec=3\n' });
        host.repo('live').checkout(sha);
        host.units.get('openvibe-live.service').load = 'not-found';
        const r = await findings(host, 'live');
        assert.ok(errors(r.lc).includes('live: lifecycle.shutdown.deadlineSeconds 5 exceeds the openvibe-live.service stop timeout of 3 s (TimeoutStopSec in deploy/systemd/openvibe-live.service); systemd would kill it mid-drain'), errors(r.lc).join('\n'));
        // No TimeoutStopSec in the source either: said, not guessed.
        const sha2 = push(host, 'live', { 'deploy/systemd/openvibe-live.service': '[Service]\nExecStart=node server/index.js\n' });
        host.repo('live').checkout(sha2);
        const r2 = await findings(host, 'live');
        assert.deepStrictEqual(errors(r2.lc), []);
        assert.ok(r2.lc.some((f) => f.level === 'info' && /openvibe-live\.service: stop timeout unknown/.test(f.message)));
    }),

    test('worker units that drain longer than their stop timeout are a warning, never an error', async () => {
        const host = scenario();
        edit(host, (raw) => {
            raw.services.events.workerUnits = ['events-worker@.service'];
            raw.services.events.lifecycle.shutdown.workers = { deadlineSeconds: 86400, drains: ['sessions kept until they end'] };
        });
        host.addUnit('events-worker@r1.service', { timeoutStop: '30min' });
        const r = await findings(host, 'events');
        assert.deepStrictEqual(errors(r.lc), []);
        assert.ok(r.lc.some((f) => f.level === 'warn' && /^events-worker@r1\.service: workers drain for up to 86400 s .* stops them after 1800 s/.test(f.message)));
    }),

    test('the checkout\'s installed openvibe-contracts must be inside contracts.range', async () => {
        const host = scenario();
        host.put('/opt/openvibe.live/node_modules/openvibe-contracts/package.json', JSON.stringify({ name: 'openvibe-contracts', version: '0.1.9' }), { owner: 'ubuntu' });
        let r = await findings(host, 'live');
        assert.ok(errors(r.lc).includes('live: the checkout has openvibe-contracts 0.1.9, outside lifecycle.contracts.range >=0.2.0 <1.0.0'), errors(r.lc).join('\n'));
        host.put('/opt/openvibe.live/node_modules/openvibe-contracts/package.json', JSON.stringify({ name: 'openvibe-contracts', version: '0.55.0' }), { owner: 'ubuntu' });
        r = await findings(host, 'live');
        assert.deepStrictEqual(errors(r.lc), []);
        assert.ok(r.lc.some((f) => f.level === 'ok' && f.message === 'the checkout: openvibe-contracts 0.55.0 within >=0.2.0 <1.0.0'));
        // Tools: each package dir is checked.
        host.put('/opt/openvibe.tools/apps/maps/node_modules/openvibe-contracts/package.json', JSON.stringify({ version: '1.2.0' }), { owner: 'ubuntu' });
        const t = await findings(host, 'tools');
        assert.ok(errors(t.lc).includes('tools: apps/maps has openvibe-contracts 1.2.0, outside lifecycle.contracts.range >=0.2.0 <1.0.0'));
    }),

    test('the declaration is read from --manifest <file> or the installed manifest when the inventory carries none', async () => {
        const host = scenario();
        edit(host, (raw) => { delete raw.services.live.lifecycle; });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovhost-lifecycle-'));
        try {
            const file = path.join(dir, 'live.json');
            fs.writeFileSync(file, JSON.stringify({ id: 'live', lifecycle: lifecycleDoc() }));
            let r = await findings(host, 'live', '--manifest', file);
            assert.deepStrictEqual(errors(r.lc), []);
            assert.ok(r.lc.some((f) => /declared by manifest file live\.json/.test(f.message)));
            fs.writeFileSync(file, JSON.stringify({ id: 'live' }));
            r = await findings(host, 'live', '--manifest', file);
            assert.ok(errors(r.lc).some((m) => m.startsWith('live: no lifecycle declared (looked at manifest file live.json)')));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        // The installed package (injected here): the inventory's manifest id picks the manifest.
        const ctx = host.ctx();
        const inv = normalise(JSON.parse(host.read('/etc/openvibe/host.json')));
        const bare = lifecycleDoc();
        delete bare.contracts;
        const contracts = { version: '0.55.0', services: { get: (id) => (id === 'live' ? { id, lifecycle: bare } : null) } };
        const res = await validate({ ...ctx, inv }, 'live', { contracts });
        const lc = res.findings.filter((f) => f.area === 'lifecycle');
        assert.deepStrictEqual(errors(lc), ['live: lifecycle.contracts is missing (from the "live" manifest in openvibe-contracts v0.55.0)']);
        // The inventory's own block wins over the manifest.
        const withInline = normalise({ ...JSON.parse(host.read('/etc/openvibe/host.json')), services: { live: { ...JSON.parse(host.read('/etc/openvibe/host.json')).services.live, lifecycle: lifecycleDoc() } } });
        const res2 = await validate({ ...ctx, inv: withInline }, 'live', { contracts });
        assert.deepStrictEqual(errors(res2.findings.filter((f) => f.area === 'lifecycle')), []);
    }),

    test('the inventory refuses a lifecycle that is not an object', async () => {
        const doc = JSON.parse(scenario().read('/etc/openvibe/host.json'));
        doc.services.live.lifecycle = ['liveness'];
        assert.throws(() => normalise(doc), (e) => e instanceof InventoryError && /services\.live\.lifecycle must be an object/.test(e.message));
    }),
]);
