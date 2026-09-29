'use strict';
/**
 * The PostgreSQL side of `ovhost backup`: every run verifies pgBackRest (a fresh stanza, and a WAL
 * archiver failed_count that has not risen), and a per-service pg_dump -Fc only on a slower cadence
 * (the weekly one, or --logical). SQLite services must be untouched. Against the fake host; no
 * pg_dump, pgbackrest or psql ever runs for real.
 */
const assert = require('assert');
const path = require('path');
const { scenario, test, runTests } = require('./helpers');
const { normalise } = require('../lib/inventory');

const DAY = 86400000;
const STATE = '/var/lib/openvibe-host';
const PROM = '/var/lib/prometheus/node-exporter/openvibe_backup.prom';

/** The standard fake host plus a PostgreSQL-only service "trade", and a fresh nightly differential. */
function pgHost() {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.trade = { repo: '/opt/openvibe.trade', units: [], databases: [{ name: 'trade', engine: 'postgresql', database: 'ov_trade' }] };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    host.pgDatabases.add('ov_trade');
    host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 3600 } }];
    return host;
}

/** The newest record in a service's backup log. */
function lastRecord(host, id) {
    const lines = host.read(`${STATE}/backups/${id}.jsonl`).trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
}

/** A prior GOOD logical-dump record `ageMs` old, as an earlier weekly run would have written. */
function seedDump(host, ageMs) {
    const dir = '/var/backups/openvibe/trade/20200101-000000';
    const rec = {
        service: 'trade', at: new Date(host.exec.now() - ageMs).toISOString(), reason: 'scheduled', engine: 'postgresql', ok: true, dir,
        files: [{ name: 'trade', source: 'ov_trade', dest: `${dir}/trade.dump`, file: 'trade.dump', check: 'pg_dump -Fc', bytes: 1 }],
    };
    host.put(`${STATE}/backups/trade.jsonl`, `${JSON.stringify(rec)}\n`);
}

runTests([
    test('a fresh pgBackRest backup: verified, recorded on the run, and left for Prometheus', async () => {
        const host = pgHost();
        host.put('/var/lib/prometheus/node-exporter/.keep', '');
        const r = await host.cli('backup', '--all');
        assert.strictEqual(r.code, 0, r.out);

        const rec = lastRecord(host, 'trade');
        assert.strictEqual(rec.engine, 'postgresql');
        assert.strictEqual(rec.verified.ok, true);
        assert.strictEqual(rec.verified.type, 'diff');
        assert.strictEqual(rec.verified.walOk, true);
        assert.strictEqual(rec.verified.stop, new Date((Math.floor(host.exec.now() / 1000) - 3600) * 1000).toISOString());
        // No prior record: a logical dump was due on the first run.
        assert.ok(rec.dir);
        assert.strictEqual(host.dumps.length, 1);
        assert.ok(host.files.has(`${rec.dir}/trade.dump`));

        const prom = host.read(PROM);
        assert.match(prom, /^openvibe_backup_pg_verified\{service="trade"\} 1$/m);
        assert.match(prom, /^openvibe_backup_services\{status="verified"\} 0$/m);
        assert.match(prom, /^openvibe_pgbackrest_last_backup_age_seconds 3600$/m);
    }),

    test('a stale pgBackRest backup: the run is failed, never skipped, and the summary says so', async () => {
        const host = pgHost();
        host.pgBackups = [{ type: 'full', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 27 * 3600 } }];
        const r = await host.cli('backup', '--all', '--json');
        assert.strictEqual(r.code, 2, r.out);
        const s = JSON.parse(r.out);
        assert.strictEqual(s.ok, false);
        const trade = s.services.find((x) => x.service === 'trade');
        assert.strictEqual(trade.status, 'failed', 'a verification failure is failed, not skipped');
        assert.strictEqual(trade.verified.ok, false);
        assert.match(trade.error, /stopped 27\.0h ago/);

        const rec = lastRecord(host, 'trade');
        assert.strictEqual(rec.ok, false);
        assert.strictEqual(rec.verified.ok, false);
        assert.match(rec.verified.error, /stopped 27\.0h ago/);
        assert.ok(!('dir' in rec), 'a failed verification leaves no directory');
        assert.strictEqual(host.dumps.length, 0);
    }),

    test('the WAL archiver failed_count: a rise fails the run, an unchanged value does not', async () => {
        const host = pgHost();
        const first = await host.cli('backup', 'trade');
        assert.strictEqual(first.code, 0, first.out);
        assert.strictEqual(lastRecord(host, 'trade').verified.walOk, true);
        const state = host.files.get(`${STATE}/pgbackrest-archiver.json`);
        assert.strictEqual(JSON.parse(state.content).failedCount, 0);
        assert.strictEqual(state.mode, 0o640, 'the recorded count is root-only 0640');

        // The same value: still ok.
        host.advance(1000);
        const same = await host.cli('backup', 'trade');
        assert.strictEqual(same.code, 0, same.out);
        assert.strictEqual(lastRecord(host, 'trade').verified.walOk, true);

        // It rose: failed, and the new value is remembered for the next run.
        host.advance(1000);
        host.pgArchiver.failed_count = 3;
        const risen = await host.cli('backup', 'trade');
        assert.strictEqual(risen.code, 2, risen.out);
        const rec = lastRecord(host, 'trade');
        assert.strictEqual(rec.ok, false);
        assert.strictEqual(rec.verified.walOk, false);
        assert.match(rec.verified.error, /failed_count rose from 0 to 3/);
        assert.strictEqual(JSON.parse(host.files.get(`${STATE}/pgbackrest-archiver.json`).content).failedCount, 3);
    }),

    test('weekly cadence: no dump while the last good one is recent, a dump when it is stale, --logical forces one', async () => {
        const host = pgHost();

        seedDump(host, 3 * DAY);
        const recent = await host.cli('backup', 'trade');
        assert.strictEqual(recent.code, 0, recent.out);
        assert.strictEqual(host.dumps.length, 0, 'no pg_dump three days after the last good one');
        const rec = lastRecord(host, 'trade');
        assert.strictEqual(rec.ok, true);
        assert.deepStrictEqual(rec.files, []);
        assert.strictEqual(rec.verified.ok, true);
        assert.ok(!('dir' in rec), 'a verification-only run writes no directory');
        assert.ok(!('empty' in rec), 'a verification-only run is never empty');

        seedDump(host, 8 * DAY);
        host.advance(1000);
        const stale = await host.cli('backup', 'trade');
        assert.strictEqual(stale.code, 0, stale.out);
        assert.strictEqual(host.dumps.length, 1);
        assert.strictEqual(host.dumps[0].database, 'ov_trade');
        assert.strictEqual(host.dumps[0].as, 'postgres');
        const dumped = lastRecord(host, 'trade');
        assert.strictEqual(dumped.files.length, 1);
        assert.strictEqual(dumped.files[0].file, 'trade.dump');
        assert.strictEqual(dumped.files[0].check, 'pg_dump -Fc');
        assert.ok(host.files.has(`${dumped.dir}/trade.dump`));

        // --logical ignores the cadence.
        seedDump(host, 3 * DAY);
        host.advance(1000);
        const forced = await host.cli('backup', 'trade', '--logical');
        assert.strictEqual(forced.code, 0, forced.out);
        assert.strictEqual(host.dumps.length, 2);
    }),

    test('staging ownership: postgres owns the directory while pg_dump runs; SQLite stays the service user', async () => {
        const host = pgHost();
        const stages = [];
        const mkdir = host.exec.mkdir;
        host.exec.mkdir = async (p, o) => { if (String(p).startsWith('/var/backups/openvibe.staging/')) stages.push([path.basename(p), o && o.owner]); return mkdir(p, o); };

        await host.cli('backup', 'trade');
        assert.deepStrictEqual(stages, [['trade-20260922-120000', 'postgres']], 'pg_dump must have a postgres-owned staging directory');
        assert.strictEqual(host.dumps[0].as, 'postgres');

        await host.cli('backup', 'live');
        assert.strictEqual(stages[1][1], 'ubuntu', 'a SQLite service keeps the service user');
        assert.strictEqual(stages[1][0], 'live-20260922-120000');

        // Root takes every copy back once the staging directory is back to root:root.
        const copy = host.files.get(`${lastRecord(host, 'trade').dir}/trade.dump`);
        assert.deepStrictEqual([copy.owner, copy.mode], ['root', 0o600]);
    }),

    test('backup --all: SQLite and PostgreSQL services in one run; verified differs from ok and failed', async () => {
        const host = pgHost();
        seedDump(host, 3 * DAY); // the weekly dump is not due: trade is verification-only this run
        const r = await host.cli('backup', '--all', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const s = JSON.parse(r.out);
        assert.strictEqual(s.ok, true);
        assert.deepStrictEqual(s.services.map((x) => [x.service, x.status]), [['live', 'ok'], ['media', 'ok'], ['trade', 'verified']]);
        const trade = s.services.find((x) => x.service === 'trade');
        assert.strictEqual(trade.dir, null);
        assert.deepStrictEqual(trade.files, []);
        assert.strictEqual(trade.verified.ok, true);

        // A stale stanza then fails that service; the others are unaffected and the run exits 2.
        host.advance(1000);
        host.pgBackups = [{ type: 'full', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 30 * 3600 } }];
        const bad = await host.cli('backup', '--all', '--json');
        assert.strictEqual(bad.code, 2);
        const s2 = JSON.parse(bad.out);
        assert.strictEqual(s2.ok, false);
        assert.deepStrictEqual(s2.services.map((x) => [x.service, x.status]), [['live', 'ok'], ['media', 'ok'], ['trade', 'failed']]);
    }),
]);
