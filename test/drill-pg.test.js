'use strict';
/**
 * ovhost drill for a PostgreSQL service (lib/dbengine.js): the artifact is a `.dump` in the backup,
 * a PostgreSQL dump. The drill copies it into <tmp>/pg owned by postgres, verifies it with
 * `pg_restore --list`, creates a scratch database and login role, restores into them, points
 * drill.env at the scratch database (and at a closed Valkey), and always drops both again in a
 * finally. Covered: the generated URLs and their password, the refusal when an override is missing,
 * cleanup on failure, counts with tolerance, artifact selection and the free-space refusal.
 */
const assert = require('assert');
const path = require('path');
const { scenario, test, runTests } = require('./helpers');

const ITEMS = '[{"id":"it_1","title":"hello"},{"id":"it_2","title":"world"}]';
// The production password in trade.env: the drill's generated password must never be this.
const PROD_PASSWORD = 'prod-password-must-not-be-reused';

function tradeEntry(drillOverrides = {}) {
    return {
        repo: '/opt/openvibe.trade',
        units: ['openvibe-trade.service'],
        envFile: '/etc/openvibe/trade.env',
        port: 4500,
        ready: { url: 'http://127.0.0.1:4500/api/ready', timeoutSeconds: 30 },
        databases: [{ name: 'trade', engine: 'postgresql', database: 'ov_trade' }],
        drill: {
            port: 14500,
            databases: { trade: { url: 'DATABASE_URL', directUrl: 'DATABASE_DIRECT_URL' } },
            env: { PORT: '{port}', HOST: '127.0.0.1', TRADE_DRILL: '1', VALKEY_URL: 'redis://127.0.0.1:9/0' },
            compare: [{ path: '/api/items?limit=5' }],
            counts: [{ db: 'trade', table: 'items' }],
            ...drillOverrides,
        },
    };
}

/**
 * The standard fake host plus Trade in production, its cluster database and a good pgBackRest layer,
 * with one `ovhost backup trade` taken (a logical pg_dump). The drill instance's answers and the two
 * row counts are controlled through `host.drill`.
 */
async function pgScenario({ drill: drillOverrides, backup = true } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.trade = tradeEntry(drillOverrides);
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });

    const repo = host.createRepo('/opt/openvibe.trade', { owner: 'ubuntu' });
    const sha = repo.commit({ 'package.json': '{"name":"openvibe-trade"}', 'server/index.js': 'trade();' }, { message: 'initial' });
    repo.publish(sha);
    repo.checkout(sha);
    host.addUnit('openvibe-trade.service', { mainPid: 2222 });
    host.alivePids.add(2222);
    host.listeners.set(4500, [{ pid: 2222, process: 'node' }]);
    host.put('/etc/systemd/system/openvibe-trade.service', [
        '[Service]',
        'User=ubuntu',
        'WorkingDirectory=/opt/openvibe.trade',
        'EnvironmentFile=/etc/openvibe/trade.env',
        'ExecStart=/usr/bin/node server/index.js',
        '',
    ].join('\n'));
    // The production app's own connection strings: the drill must not let either reach the instance.
    host.put('/etc/openvibe/trade.env', `DATABASE_URL=postgresql://trade_app:${PROD_PASSWORD}@127.0.0.1:6432/ov_trade\nDATABASE_DIRECT_URL=postgresql://trade_app:${PROD_PASSWORD}@127.0.0.1:5432/ov_trade\nVALKEY_URL=redis://valkey-production:6379/7\n`, { mode: 0o600 });

    // The cluster: the production database, and a healthy pgBackRest stanza so `ovhost backup` passes.
    host.pgDatabases.add('ov_trade');
    host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(Date.parse('2026-09-22T12:00:00Z') / 1000) } }];
    host.drill = {
        productionCount: 500,
        restoredCount: 500,
        ready: () => ({ status: 200, body: { status: 'ready' } }),
        items: () => ({ status: 200, body: ITEMS }),
    };
    host.psqlHandler = (database, sql) => {
        if (/left\((datname|rolname)/.test(sql)) return undefined;   // leftover-scratch lookups: the fake's catalog
        if (/pg_stat_archiver/i.test(sql)) return [{ n: String(host.pgArchiver.failed_count) }];
        if (/FROM "([a-z_]+)"/.test(sql)) return [{ n: String(database === 'ov_trade' ? host.drill.productionCount : host.drill.restoredCount) }];
        return [{ n: '0' }];
    };
    host.http.set('http://127.0.0.1:4500/api/items?limit=5', () => ({ status: 200, body: ITEMS }));
    host.onSystemdRun = (spec) => {
        const envFile = spec.envFiles[spec.envFiles.length - 1];
        host.drillEnv = host.read(envFile);
        host.listeners.set(14500, [{ pid: spec.pid, process: 'node' }]);
        const alive = (fn) => () => (host.alivePids.has(spec.pid) ? fn() : { status: 0, error: 'ECONNREFUSED' });
        host.http.set('http://127.0.0.1:14500/api/ready', alive(() => host.drill.ready()));
        host.http.set('http://127.0.0.1:14500/api/items?limit=5', alive(() => host.drill.items()));
        return undefined;
    };

    if (backup) {
        const b = await host.cli('backup', 'trade', '--json');
        assert.strictEqual(b.code, 0, b.out);
        host.backupDir = JSON.parse(b.out).dir;
    }
    host.advance(60 * 1000);
    return host;
}

const envOf = (text) => Object.fromEntries(text.trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const lastLog = (host) => JSON.parse(host.read('/var/lib/openvibe-host/drills/trade.jsonl').trim().split('\n').pop());

function fsSnapshot(host) {
    const m = new Map();
    for (const [k, v] of host.files) m.set(k, `${v.type}:${v.owner}:${v.mode}:${v.type === 'file' ? String(v.content) : v.target || ''}`);
    return m;
}

function changedPaths(before, after) {
    const out = [];
    for (const [k, v] of after) if (before.get(k) !== v) out.push(k);
    for (const k of before.keys()) if (!after.has(k)) out.push(k);
    return out.sort();
}

runTests([
    test('leftovers of a killed drill are dropped first; restores skip GRANTs; scratch drops are forced', async () => {
        const host = await pgScenario();
        const old = 'ov_trade_drill_20260101-000000';
        host.pgDatabases.add(old);
        host.pgRoles.set(old, { password: 'x' });
        host.pgDatabases.add('ov_tradex');   // another name that only looks alike stays
        const callsBefore = host.calls.length;
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(!host.pgDatabases.has(old), 'the leftover scratch database is dropped');
        assert.ok(!host.pgRoles.has(old), 'the leftover scratch role is dropped');
        assert.ok(host.pgDatabases.has('ov_trade') && host.pgDatabases.has('ov_tradex'), 'production and look-alike databases are untouched');
        const calls = host.calls.slice(callsBefore);
        const restore = calls.find((c) => c.cmd === 'pg_restore' && !c.args.includes('--list'));
        assert.ok(restore.args.includes('--no-privileges') && restore.args.includes('--no-owner'), restore.args.join(' '));
        for (const c of calls.filter((x) => x.cmd === 'dropdb')) assert.ok(c.args.includes('--force'), c.args.join(' '));
    }),
    test('full flow: pg_restore --list, a scratch database and role, drill.env pointed at them, cleanup', async () => {
        const host = await pgScenario();
        const callsBefore = host.calls.length;
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 0, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.result, 'passed', JSON.stringify(rec.failure));
        assert.strictEqual(rec.failure, null);

        const tmp = rec.dir;
        assert.match(tmp, /^\/var\/lib\/openvibe-drills\/trade-\d{8}-\d{6}$/);
        assert.deepStrictEqual(rec.databases.map((d) => [d.name, d.engine, d.integrity, d.copy]), [['trade', 'postgresql', 'pg_restore --list ok', `${tmp}/pg/trade.dump`]]);
        assert.deepStrictEqual(rec.counts, [{ db: 'trade', table: 'items', production: 500, restored: 500, match: true }]);
        assert.strictEqual(rec.ready.ok, true);
        assert.strictEqual(rec.stop.ok, true);

        // The scratch database and role share the derived name and are recorded on the drill record.
        const at = path.basename(tmp).slice('trade-'.length);
        const scratch = `ov_trade_drill_${at}`;
        assert.deepStrictEqual(rec.scratch, { database: scratch, role: scratch, dropped: true });
        assert.ok(host.restores.some((x) => x.database === scratch && x.role === scratch && x.file === `${tmp}/pg/trade.dump`));
        assert.ok(host.createdDatabases.some((c) => c.name === scratch && c.owner === scratch && c.as === 'postgres'));
        // The scratch database and role are dropped again; production's database is untouched.
        assert.ok(host.droppedDatabases.some((c) => c.name === scratch && c.as === 'postgres'));
        assert.ok(!host.pgRoles.has(scratch), 'the scratch role is gone');
        assert.ok(host.pgDatabases.has('ov_trade'), 'production database still there');

        // drill.env points the instance at the scratch database over the direct port, and at a closed
        // Valkey from the inventory. The password is generated, not production's, and never in argv.
        const env = envOf(host.drillEnv);
        assert.strictEqual(env.VALKEY_URL, 'redis://127.0.0.1:9/0');
        const url = `postgresql://${scratch}:`;
        assert.ok(env.DATABASE_URL.startsWith(url), env.DATABASE_URL);
        assert.ok(env.DATABASE_URL.endsWith(`@127.0.0.1:5432/${scratch}`), env.DATABASE_URL);
        assert.strictEqual(env.DATABASE_DIRECT_URL, env.DATABASE_URL);
        const password = /^postgresql:\/\/[^:]+:([^@]+)@/.exec(env.DATABASE_URL)[1];
        assert.notStrictEqual(password, PROD_PASSWORD);
        assert.ok(!JSON.stringify(host.calls.slice(callsBefore)).includes(password), 'the generated password never reaches an argv');
        assert.ok(!host.drillEnv.includes(PROD_PASSWORD), 'the production password never reaches drill.env');

        // The dump is copied as postgres (the backup is root-only, so postgres cannot read it directly).
        const cp = host.calls.slice(callsBefore).find((c) => c.cmd === 'install' && c.args.includes(`${tmp}/pg/trade.dump`));
        assert.deepStrictEqual(cp.args, ['-o', 'postgres', '-m', '0600', '-T', '--', `${host.backupDir}/trade.dump`, `${tmp}/pg/trade.dump`]);
        assert.strictEqual(cp.privileged, true);

        // The Markdown row reports the dump archive check.
        assert.match(r.out, /`pg_restore --list` \(trade\) = ok/);
        assert.strictEqual(rec.markdown, r.out.split('\n').pop());
    }),

    test('refuses before anything is created when drill.env would leave a production value', async () => {
        const host = await pgScenario({ backup: false, drill: { env: { PORT: '{port}', HOST: '127.0.0.1', TRADE_DRILL: '1' } } });
        const before = fsSnapshot(host);
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /VALKEY_URL/);
        assert.match(r.out, /production Valkey keyspace/);
        assert.strictEqual(host.createdDatabases.length, 0, 'nothing created');
        assert.strictEqual(host.dumps.length, 0, 'no pg_dump');
        assert.strictEqual(host.restores.length, 0, 'no pg_restore');
        assert.strictEqual(host.systemdRuns.length, 0, 'nothing started');
        assert.deepStrictEqual(changedPaths(before, fsSnapshot(host)), [], 'a refusal writes nothing');
    }),

    test('refuses when a PostgreSQL database is not mapped in drill.databases (it would run on production)', async () => {
        const host = await pgScenario({ backup: false });
        const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
        doc.services.trade.databases.push({ name: 'ledger', engine: 'postgresql', database: 'ov_trade_ledger' });
        host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
        const before = fsSnapshot(host);
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /must map every PostgreSQL database \(ledger is missing\)/);
        assert.strictEqual(host.createdDatabases.length + host.restores.length + host.systemdRuns.length, 0, 'nothing created or started');
        assert.deepStrictEqual(changedPaths(before, fsSnapshot(host)), [], 'a refusal writes nothing');
    }),

    test('the drill directory is traversable by postgres (0711) and the dump copy stays 0600 postgres', async () => {
        const host = await pgScenario();
        const r = await host.cli('drill', 'trade', '--keep');
        assert.strictEqual(r.code, 0, r.out);
        const tmp = lastLog(host).dir;
        assert.strictEqual(host.files.get(tmp).mode, 0o711);
        const copy = host.files.get(`${tmp}/pg/trade.dump`);
        assert.strictEqual(copy.owner, 'postgres');
        assert.strictEqual(copy.mode, 0o600);
    }),

    test('cleanup on failure: a failed comparison still drops the scratch database and role', async () => {
        const host = await pgScenario();
        host.drill.productionCount = 500;
        host.drill.restoredCount = 400;
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.result, 'failed');
        assert.strictEqual(rec.failure.stage, 'compare');
        assert.deepStrictEqual(rec.counts, [{ db: 'trade', table: 'items', production: 500, restored: 400, match: false }]);
        // The scratch database and role are dropped by the finally, even though the drill failed.
        assert.strictEqual(rec.scratch.dropped, true);
        assert.ok(host.droppedDatabases.some((c) => c.name === rec.scratch.database));
        assert.ok(!host.pgRoles.has(rec.scratch.role), 'the drill role was dropped');
        assert.ok(host.pgDatabases.has('ov_trade'), 'production database still there');
    }),

    test('cleanup on failure: an instance that never becomes ready still drops the scratch', async () => {
        const host = await pgScenario();
        host.drill.ready = () => ({ status: 503, body: { status: 'not_ready' } });
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'ready');
        assert.ok(host.droppedDatabases.some((c) => c.name === rec.scratch.database));
        assert.ok(!host.pgRoles.has(rec.scratch.role));
        assert.ok(!host.files.has(rec.dir), 'the drill directory is removed');
    }),

    test('counts: a match passes; 2 rows off fails at tolerance 0 but passes at 3', async () => {
        let host = await pgScenario({ drill: { countsTolerance: 0 } });
        host.drill.productionCount = 502;
        host.drill.restoredCount = 500;
        let r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 2, r.out);
        let rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'compare');
        assert.deepStrictEqual(rec.counts, [{ db: 'trade', table: 'items', production: 502, restored: 500, match: false }], 'no tolerance field at 0');

        host = await pgScenario({ drill: { countsTolerance: 3 } });
        host.drill.productionCount = 502;
        host.drill.restoredCount = 500;
        r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 0, r.out);
        rec = lastLog(host);
        assert.deepStrictEqual(rec.counts, [{ db: 'trade', table: 'items', production: 502, restored: 500, match: true, tolerance: 3 }]);
        assert.match(rec.markdown, /items 502 = 500 \(±3\)/);
        assert.match(r.out, /items: production 502, restored 500 \(±3\)/);
    }),

    test('artifact selection: --backup uses <dir>/<name>.dump; a verification-only record is skipped', async () => {
        // (a) --backup selects the .dump file in the named directory.
        let host = await pgScenario({ backup: false });
        host.ensureDir('/srv/old-backup');
        host.put('/srv/old-backup/trade.dump', 'pg_dump -Fc of ov_trade', { owner: 'root', mode: 0o600 });
        let r = await host.cli('drill', 'trade', '--backup', '/srv/old-backup', '--json');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(JSON.parse(r.out).backup, '/srv/old-backup');
        assert.strictEqual(lastLog(host).databases[0].source, '/srv/old-backup/trade.dump');

        // (b) a newer verification-only record (no dir, no dump) is not picked: the newest record that
        // actually holds a .dump entry wins.
        host = await pgScenario({ backup: false });
        const goodDir = '/var/backups/openvibe/trade/20260922-115500';
        host.ensureDir(goodDir);
        host.put(`${goodDir}/trade.dump`, 'pg_dump -Fc of ov_trade', { owner: 'root', mode: 0o600 });
        const good = { service: 'trade', at: '2026-09-22T11:55:00.000Z', engine: 'postgresql', ok: true, dir: goodDir, files: [{ name: 'trade', source: 'ov_trade', dest: `${goodDir}/trade.dump`, file: 'trade.dump', bytes: 23 }] };
        const verificationOnly = { service: 'trade', at: '2026-09-22T12:00:30.000Z', engine: 'postgresql', ok: true, files: [], verified: { type: 'diff', stop: '2026-09-22T02:20:11.000Z', walOk: true, ok: true } };
        host.put('/var/lib/openvibe-host/backups/trade.jsonl', `${JSON.stringify(good)}\n${JSON.stringify(verificationOnly)}\n`, { mode: 0o640 });
        r = await host.cli('drill', 'trade', '--json');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(JSON.parse(r.out).backup, goodDir);

        // (c) only a verification-only record: refused, as if there were no backup at all.
        host = await pgScenario({ backup: false });
        host.put('/var/lib/openvibe-host/backups/trade.jsonl', `${JSON.stringify(verificationOnly)}\n`, { mode: 0o640 });
        r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /no good ovhost backup recorded for trade/);
    }),

    test('free-space: a drill root that does not exist yet is created before measuring, so the first drill runs', async () => {
        const host = await pgScenario();
        // A host that has never run a drill has no <drillDir>; statfs() works on existing paths only.
        assert.ok(!host.files.has('/var/lib/openvibe-drills'), 'the drill root does not exist yet');
        const r = await host.cli('drill', 'trade');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(host.files.has('/var/lib/openvibe-drills'), 'the drill root was created before measuring');
        assert.strictEqual(lastLog(host).result, 'passed');
    }),

    test('free-space: refuses before restoring when the drill directory has almost no room', async () => {
        const host = await pgScenario({ backup: false });
        host.ensureDir('/srv/old-backup');
        host.put('/srv/old-backup/trade.dump', 'pg_dump -Fc of ov_trade', { owner: 'root', mode: 0o600 });
        host.statfsFree = 1024;
        const r = await host.cli('drill', 'trade', '--backup', '/srv/old-backup');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /not enough free space under \/var\/lib\/openvibe-drills/);
        assert.match(r.out, /1024 bytes free/);
        assert.strictEqual(host.restores.length, 0, 'no pg_restore ran');
        assert.strictEqual(host.dumps.length, 0, 'no pg_dump ran');
        assert.strictEqual(host.systemdRuns.length, 0);
    }),
]);
