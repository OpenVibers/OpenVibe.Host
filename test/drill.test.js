'use strict';
/**
 * ovhost drill against the fake host: the full flow, integrity failure, readiness timeout, an
 * instance that dies, mismatch reporting, cleanup on failure, refusals (not root, port in use,
 * unsupported, no backup), and the guarantee that nothing outside the drill directory, the lock and
 * the drill log is written.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { normalise } = require('../lib/inventory');
const { compareBodies } = require('../lib/commands/drill');

const DRILL_DIR = '/var/lib/openvibe-drills';
const PROD_DB = '/var/lib/openvibe-community/community.db';
const PASTES = '[{"id":"pst_1","title":"hello"},{"id":"pst_2","title":"world"}]';

function communityEntry(drillOverrides = {}) {
    return {
        repo: '/opt/openvibe.community',
        units: ['openvibe-community.service'],
        envFile: '/etc/openvibe/community.env',
        port: 4200,
        ready: { url: 'http://127.0.0.1:4200/api/ready', timeoutSeconds: 30 },
        databases: [{ name: 'community', path: PROD_DB }],
        drill: {
            port: 14200,
            databases: { community: 'COMMUNITY_DB_PATH' },
            env: { PORT: '{port}', HOST: '127.0.0.1', DISCORD_RELAY_ENABLED: '0', EVENTS_URL: '', UPLOAD_DIR: '{tmp}/data/uploads', GREETING: 'two words' },
            dirs: ['{tmp}/data'],
            compare: [{ path: '/api/pastes?limit=5' }, { path: '/api/v1/pulse?limit=5', ignore: ['generated_at'] }],
            counts: [{ db: 'community', table: 'pastes' }],
            ...drillOverrides,
        },
    };
}

/**
 * The standard fake host plus Community in production, with one `ovhost backup community` taken.
 * The drill instance's behaviour is controlled through `host.drill`.
 */
async function drillScenario({ drill: drillOverrides, backup = true } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.community = communityEntry(drillOverrides);
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });

    const repo = host.createRepo('/opt/openvibe.community', { owner: 'ubuntu' });
    const sha = repo.commit({ 'package.json': '{"name":"openvibe-community"}', 'server/index.js': 'community();' }, { message: 'initial' });
    repo.publish(sha);
    repo.checkout(sha);
    host.addUnit('openvibe-community.service', { mainPid: 2222 });
    host.alivePids.add(2222);
    host.listeners.set(4200, [{ pid: 2222, process: 'node' }]);
    host.put('/etc/systemd/system/openvibe-community.service', [
        '[Service]',
        'User=ubuntu',
        'WorkingDirectory=/opt/openvibe.community',
        'ExecStart=/usr/bin/node server/index.js',
        `Environment=NODE_ENV=production "SESSION_SECRET=${SECRET}-unit"`,
        '',
    ].join('\n'));
    host.put('/etc/openvibe/community.env', `OV_OAUTH_CLIENT_SECRET=${SECRET}\nBASE_URL=https://openvibe.community\n`, { mode: 0o600 });
    host.put(PROD_DB, 'sqlite-production', { owner: 'ubuntu', mode: 0o640 });

    host.http.set('http://127.0.0.1:4200/api/ready', () => ({ status: 200, body: { status: 'ready' } }));
    host.http.set('http://127.0.0.1:4200/api/pastes?limit=5', () => ({ status: 200, body: PASTES }));
    host.http.set('http://127.0.0.1:4200/api/v1/pulse?limit=5', () => ({ status: 200, body: { items: [{ id: 1 }], generated_at: '2026-09-22T12:00:00.000Z' } }));

    host.drill = {
        integrity: [{ integrity_check: 'ok' }],
        productionCount: 892,
        restoredCount: 892,
        ready: () => ({ status: 200, body: { status: 'ready' } }),
        pastes: () => ({ status: 200, body: PASTES }),
        pulse: () => ({ status: 200, body: { items: [{ id: 1 }], generated_at: '2026-09-22T12:00:07.000Z' } }),
        onStart: null,
        ignoreTerm: false,
        ignoreKill: false,
    };
    host.sqliteHandler = (db, sql) => {
        if (/integrity_check/.test(sql)) return host.drill.integrity;
        if (/count\(\*\) AS n FROM "pastes"/.test(sql)) return [{ n: db === PROD_DB ? host.drill.productionCount : host.drill.restoredCount }];
        if (/is_recording/.test(sql)) return [{ n: host.recording }];
        return [{ n: 0 }];
    };
    host.onSystemdRun = (spec) => {
        if (host.drill.onStart) { const r = host.drill.onStart(spec); if (r) return r; }
        host.listeners.set(14200, [{ pid: spec.pid, process: 'node' }]);
        const alive = (fn) => () => (host.alivePids.has(spec.pid) ? fn() : { status: 0, error: 'ECONNREFUSED' });
        host.http.set('http://127.0.0.1:14200/api/ready', alive(() => host.drill.ready()));
        host.http.set('http://127.0.0.1:14200/api/pastes?limit=5', alive(() => host.drill.pastes()));
        host.http.set('http://127.0.0.1:14200/api/v1/pulse?limit=5', alive(() => host.drill.pulse()));
        return undefined;
    };
    host.onKill = (pid, signal) => {
        if (signal === 'SIGTERM' && host.drill.ignoreTerm) return false;
        if (signal === 'SIGKILL' && host.drill.ignoreKill) return false;
        return undefined;
    };

    if (backup) {
        const b = await host.cli('backup', 'community', '--json');
        assert.strictEqual(b.code, 0, b.out);
        host.backupDir = JSON.parse(b.out).dir;
    }
    host.advance(60 * 1000);
    return host;
}

/** A Tools-like service: a gateway and apps, each app its own unit and port, data directories. */
function appsEntry(drill = {}) {
    const d = {
        port: 14016,
        unit: 'openvibe-apps-docs.service',
        productionPort: 4016,
        databases: { 'docs-analytics': { env: 'DATA_DIR', dir: true }, 'docs-jobs': { env: 'DATA_DIR', dir: true }, 'yt-analytics': { dir: '{tmp}/yt-data' } },
        env: { PORT: '{port}', HOST: '127.0.0.1', TOOLS_JOB_RESULTS: 'local', EVENTS_PUBLISH: 'off' },
        bind: [{ from: '{tmp}/yt-data', to: '/opt/openvibe.apps/apps/yt/data' }],
        requires: [{ file: 'apps/_shared/jobs/index.js', contains: 'TOOLS_JOB_RESULTS' }],
        ready: '/api/ready',
        compare: ['/release.json'],
        counts: [{ db: 'docs-jobs', table: 'tool_jobs' }],
        ...drill,
    };
    for (const [k, v] of Object.entries(d)) if (v === null) delete d[k];
    return {
        owner: 'ubuntu',
        repo: '/opt/openvibe.apps',
        units: ['openvibe-apps.service', 'openvibe-apps-docs.service', 'openvibe-apps-yt.service'],
        envFile: '/etc/openvibe/apps.env',
        port: 4001,
        ready: { url: 'http://127.0.0.1:4001/api/ready', timeoutSeconds: 30 },
        databases: [
            { name: 'docs-analytics', path: '/opt/openvibe.apps/apps/docs/data/analytics.db' },
            { name: 'docs-jobs', path: '/opt/openvibe.apps/apps/docs/data/jobs.db' },
            { name: 'yt-analytics', path: '/opt/openvibe.apps/apps/yt/data/analytics.db' },
        ],
        drill: d,
    };
}

async function appsScenario({ switchInCheckout = true, drill } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.apps = appsEntry(drill);
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    const repo = host.createRepo('/opt/openvibe.apps', { owner: 'ubuntu' });
    const sha = repo.commit({
        'package.json': '{"name":"apps"}',
        'apps/_shared/jobs/index.js': switchInCheckout ? "const want = env.TOOLS_JOB_RESULTS || 'local';" : 'jobs();',
    }, { message: 'initial' });
    repo.publish(sha);
    repo.checkout(sha);
    const unit = (name, dir, port) => {
        host.addUnit(name, { mainPid: 3000 + port });
        host.alivePids.add(3000 + port);
        host.listeners.set(port, [{ pid: 3000 + port, process: 'node' }]);
        host.put(`/etc/systemd/system/${name}`, ['[Service]', 'User=ubuntu', `WorkingDirectory=/opt/openvibe.apps/apps/${dir}`, 'Environment=NODE_ENV=production', `Environment=PORT=${port}`, `ExecStart=/usr/bin/env node /opt/openvibe.apps/apps/${dir}/server/index.js`, ''].join('\n'));
    };
    unit('openvibe-apps.service', 'gateway', 4001);
    unit('openvibe-apps-docs.service', 'docs', 4016);
    unit('openvibe-apps-yt.service', 'yt', 4013);
    host.put('/etc/openvibe/apps.env', `OV_OAUTH_CLIENT_SECRET=${SECRET}\n`, { mode: 0o600 });
    for (const db of appsEntry().databases) host.put(db.path, `sqlite-${db.name}`, { owner: 'ubuntu', mode: 0o640 });
    host.http.set('http://127.0.0.1:4001/release.json', () => ({ status: 200, body: '{"service":"gateway"}' }));
    host.http.set('http://127.0.0.1:4016/release.json', () => ({ status: 200, body: '{"service":"docs"}' }));
    host.sqliteHandler = (db, sql) => {
        if (/integrity_check/.test(sql)) return [{ integrity_check: 'ok' }];
        if (/count\(\*\)/.test(sql)) return [{ n: 3 }];
        return [{ n: 0 }];
    };
    host.onSystemdRun = (spec) => {
        const envFile = spec.envFiles[spec.envFiles.length - 1];
        host.drillEnv = host.read(envFile);
        host.listeners.set(14016, [{ pid: spec.pid, process: 'node' }]);
        const alive = (fn) => () => (host.alivePids.has(spec.pid) ? fn() : { status: 0, error: 'ECONNREFUSED' });
        host.http.set('http://127.0.0.1:14016/api/ready', alive(() => ({ status: 200, body: { status: 'ready' } })));
        host.http.set('http://127.0.0.1:14016/release.json', alive(() => ({ status: 200, body: '{"service":"docs"}' })));
        return undefined;
    };
    const b = await host.cli('backup', 'apps', '--json');
    assert.strictEqual(b.code, 0, b.out);
    host.advance(60 * 1000);
    return host;
}

/** Every file entry as "type:owner:mode:content", to diff the fake filesystem. */
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

function lastLog(host) {
    const text = host.read('/var/lib/openvibe-host/drills/community.jsonl');
    const lines = text.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
}

const allowedWrite = (p, tmp) => p === DRILL_DIR || p === tmp || p.startsWith(`${tmp}/`)
    || p === '/var/lib/openvibe-host/drills' || p === '/var/lib/openvibe-host/drills/community.jsonl'
    || p === '/var/lib/openvibe-host/locks' || p === '/var/lib/openvibe-host/locks/community-drill.lock';

runTests([
    test('full flow: restore, integrity, sandboxed second instance, identical answers, stop by pid, cleanup, log row', async () => {
        const host = await drillScenario();
        const before = fsSnapshot(host);
        const callsBefore = host.calls.length;
        const r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 0, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.result, 'passed');
        assert.strictEqual(rec.failure, null);
        assert.strictEqual(rec.backup, host.backupDir);
        const tmp = rec.dir;
        assert.match(tmp, /^\/var\/lib\/openvibe-drills\/community-\d{8}-\d{6}$/);
        assert.deepStrictEqual(rec.databases.map((d) => [d.name, d.integrity, d.copy]), [['community', 'ok', `${tmp}/db/community.db`]]);
        assert.deepStrictEqual(rec.compare.map((c) => [c.path, c.match]), [['/api/pastes?limit=5', true], ['/api/v1/pulse?limit=5', true]]);
        assert.deepStrictEqual(rec.counts, [{ db: 'community', table: 'pastes', production: 892, restored: 892, match: true }]);
        assert.strictEqual(rec.ready.ok, true);
        assert.strictEqual(rec.stop.ok, true);
        assert.strictEqual(rec.stop.signal, 'SIGTERM');

        const calls = host.calls.slice(callsBefore);
        // The copy is made as the service user; integrity and counts run as the service user.
        // Backups are root-only: root copies, and the copy belongs to the service user, 0600.
        const cp = calls.find((c) => c.cmd === 'install' && c.args.includes(`${tmp}/db/community.db`));
        assert.strictEqual(cp.privileged, true);
        assert.deepStrictEqual(cp.args, ['-o', 'ubuntu', '-m', '0600', '-T', '--', `${host.backupDir}/community.db`, `${tmp}/db/community.db`]);
        const integrity = host.sqliteCalls.find((c) => /integrity_check/.test(c.sql));
        assert.deepStrictEqual([integrity.db, integrity.as], [`${tmp}/db/community.db`, 'ubuntu']);

        // systemd-run: production ExecStart/WorkingDirectory, production env file then the override file,
        // sandbox properties, loopback-only networking, the service user.
        assert.strictEqual(host.systemdRuns.length, 1);
        const run = host.systemdRuns[0];
        assert.strictEqual(run.uid, 'ubuntu');
        assert.strictEqual(run.cwd, '/opt/openvibe.community');
        assert.deepStrictEqual(run.argv, ['/usr/bin/node', 'server/index.js']);
        assert.deepStrictEqual(run.envFiles, ['/etc/openvibe/community.env', `${tmp}/drill.env`]);
        for (const p of ['ProtectSystem=strict', `ReadWritePaths=${tmp}`, 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'SocketBindAllow=tcp:14200', 'SocketBindDeny=any', 'Environment=NODE_ENV=production']) {
            assert.ok(run.props.includes(p), `systemd-run -p ${p}`);
        }
        assert.ok(!run.props.some((p) => p.includes('SESSION_SECRET')), 'a secret-looking unit Environment= is not passed on');
        const runCall = calls.find((c) => c.cmd === 'systemd-run');
        assert.strictEqual(runCall.privileged, true);

        // Stopped by its own pid with SIGTERM; production's pid is never signalled; no pkill.
        const kills = calls.filter((c) => c.cmd === 'kill');
        assert.deepStrictEqual(kills.map((c) => c.args), [['SIGTERM', run.pid]]);
        assert.ok(!calls.some((c) => /pkill|killall/.test(c.cmd)));
        assert.ok(host.alivePids.has(2222), 'production still running');
        assert.strictEqual(host.units.get('openvibe-community.service').restarts, 0);
        assert.ok(!host.restarts().length, 'nothing restarted');

        // Only the drill directory (now removed), the lock (released) and the drill log changed.
        const after = fsSnapshot(host);
        const changed = changedPaths(before, after);
        for (const p of changed) assert.ok(allowedWrite(p, tmp), `unexpected write: ${p}`);
        assert.ok(!host.files.has(tmp), 'temp dir removed');
        assert.ok(!host.files.has('/var/lib/openvibe-host/locks/community-drill.lock'), 'lock released');

        // Secrets: nothing ovhost printed, logged or passed on carries a value.
        const everything = [r.out, host.read('/var/lib/openvibe-host/drills/community.jsonl'), JSON.stringify(host.calls), JSON.stringify(host.systemdRuns)].join('\n');
        assert.ok(!everything.includes(SECRET), 'a secret value leaked');
        assert.ok(!host.reads.includes('/etc/openvibe/community.env'), 'ovhost never reads the env file for a drill');

        // Markdown row ready for docs/restore-drills.md.
        assert.match(r.out, /\| 2026-09-22 12:01 \| community \| `\/var\/backups\/openvibe\/community\/20260922-120000\/` \(`ovhost drill community`\) \| `pragma integrity_check` \(community\) = ok; drill instance `\/api\/ready` 200 after 0s; `\/api\/pastes\?limit=5`, `\/api\/v1\/pulse\?limit=5` identical to production \(JSON without volatile keys where declared\); pastes 892 = 892 \| passed \|/);
        assert.strictEqual(rec.markdown, r.out.split('\n').pop());
    }),

    test('--keep leaves the drill directory; the override file holds inventory values only', async () => {
        const host = await drillScenario();
        const before = fsSnapshot(host);
        const r = await host.cli('drill', 'community', '--keep');
        assert.strictEqual(r.code, 0, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.kept, true);
        const tmp = rec.dir;
        assert.strictEqual(host.files.get(tmp).owner, 'ubuntu');
        assert.strictEqual(host.files.get(tmp).mode, 0o700);
        assert.strictEqual(host.files.get(`${tmp}/db/community.db`).owner, 'ubuntu');
        assert.strictEqual(host.read(`${tmp}/db/community.db`), host.read(`${host.backupDir}/community.db`));
        assert.strictEqual(host.files.get(`${tmp}/data`).owner, 'ubuntu');
        const env = host.read(`${tmp}/drill.env`);
        for (const line of ['PORT=14200', 'HOST=127.0.0.1', 'DISCORD_RELAY_ENABLED=0', 'EVENTS_URL=', `UPLOAD_DIR=${tmp}/data/uploads`, 'GREETING="two words"', `COMMUNITY_DB_PATH=${tmp}/db/community.db`]) {
            assert.ok(env.split('\n').includes(line), `drill.env has ${line}`);
        }
        assert.ok(!env.includes(SECRET));
        for (const p of changedPaths(before, fsSnapshot(host))) assert.ok(allowedWrite(p, tmp), `unexpected write: ${p}`);
        // The production database and the backup are untouched.
        assert.strictEqual(host.read(PROD_DB), 'sqlite-production');
    }),

    test('integrity failure: nothing is started, the copy is removed, the log says failed', async () => {
        const host = await drillScenario();
        host.drill.integrity = [{ integrity_check: '*** in database main ***' }, { integrity_check: 'Page 5: btree page has a bad cell' }];
        const r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.result, 'failed');
        assert.strictEqual(rec.failure.stage, 'integrity');
        assert.match(rec.failure.message, /bad cell/);
        assert.strictEqual(host.systemdRuns.length, 0);
        assert.ok(!host.files.has(rec.dir));
        assert.match(r.out, /\| failed \|$/);
    }),

    test('readiness timeout: the instance is stopped by its pid and the directory removed', async () => {
        const host = await drillScenario();
        host.drill.ready = () => ({ status: 503, body: { status: 'not_ready' } });
        const r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'ready');
        assert.match(rec.failure.message, /not ready after 30s \(503\)/);
        assert.strictEqual(rec.compare.length, 0, 'nothing compared');
        const pid = host.systemdRuns[0].pid;
        assert.deepStrictEqual(host.calls.filter((c) => c.cmd === 'kill').map((c) => c.args), [['SIGTERM', pid]]);
        assert.ok(!host.alivePids.has(pid));
        assert.ok(!host.files.has(rec.dir));
        assert.ok(!host.listeners.has(14200));
    }),

    test('an instance that exits before it is ready fails the drill without signalling anything', async () => {
        const host = await drillScenario();
        let probes = 0;
        host.drill.ready = () => { probes += 1; if (probes === 2) host.alivePids.delete(host.systemdRuns[0].pid); return { status: 503 }; };
        const r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'ready');
        assert.match(rec.failure.message, /exited before it was ready/);
        assert.ok(!host.calls.some((c) => c.cmd === 'kill'));
        assert.ok(!host.files.has(rec.dir));
    }),

    test('mismatches are reported per path and per table; volatile keys are ignored only where declared', async () => {
        const host = await drillScenario();
        host.drill.pastes = () => ({ status: 200, body: PASTES.replace('world', 'World') });
        host.drill.pulse = () => ({ status: 200, body: { items: [{ id: 2 }], generated_at: 'different, but ignored' } });
        host.drill.productionCount = 900;
        const r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'compare');
        const [pastes, pulse] = rec.compare;
        assert.strictEqual(pastes.match, false);
        assert.match(pastes.detail, /first difference at byte 55/);
        assert.strictEqual(pulse.match, false);
        assert.match(pulse.detail, /\$\.items\[0\]\.id/);
        assert.ok(!/generated_at/.test(pulse.detail));
        assert.deepStrictEqual(rec.counts[0], { db: 'community', table: 'pastes', production: 900, restored: 892, match: false });
        assert.match(rec.markdown, /`\/api\/pastes\?limit=5` differs \(bodies differ/);
        assert.match(rec.markdown, /pastes 900 ≠ 892 \| failed \|$/);
        // Still stopped and cleaned up.
        assert.ok(!host.alivePids.has(host.systemdRuns[0].pid));
        assert.ok(!host.files.has(rec.dir));
    }),

    test('compare: a status mismatch or a failing production answer is never a match', () => {
        const e = { path: '/x', ignore: [] };
        assert.strictEqual(compareBodies(e, { status: 500, body: 'e' }, { status: 500, body: 'e' }).match, false);
        assert.match(compareBodies(e, { status: 200, body: 'a' }, { status: 404, body: 'a' }).detail, /status 404/);
        assert.strictEqual(compareBodies({ path: '/x', ignore: ['t'] }, { status: 200, body: '{"a":1,"t":1}' }, { status: 200, body: '{"a":1,"t":2}' }).match, true);
        assert.match(compareBodies({ path: '/x', ignore: ['t'] }, { status: 200, body: '<html>' }, { status: 200, body: '<html>' }).detail, /not JSON/);
    }),

    test('cleanup on failure: systemd-run fails → directory removed, lock released, row logged', async () => {
        const host = await drillScenario();
        const before = fsSnapshot(host);
        host.drill.onStart = () => ({ code: 1, stderr: 'Failed to start transient service unit: Unit already exists.' });
        const r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 2, r.out);
        const rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'start');
        assert.match(rec.failure.message, /systemd-run failed/);
        assert.ok(!host.files.has(rec.dir));
        assert.ok(!host.files.has('/var/lib/openvibe-host/locks/community-drill.lock'));
        for (const p of changedPaths(before, fsSnapshot(host))) assert.ok(allowedWrite(p, rec.dir), `unexpected write: ${p}`);
        // A second drill can run straight after.
        host.drill.onStart = null;
        host.advance(1000);
        assert.strictEqual((await host.cli('drill', 'community')).code, 0);
    }),

    test('an instance that ignores SIGTERM gets SIGKILL; one that survives SIGKILL keeps its directory and fails', async () => {
        let host = await drillScenario();
        host.drill.ignoreTerm = true;
        let r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 0, r.out);
        let rec = lastLog(host);
        assert.strictEqual(rec.stop.signal, 'SIGKILL');
        assert.deepStrictEqual(host.calls.filter((c) => c.cmd === 'kill').map((c) => c.args[0]), ['SIGTERM', 'SIGKILL']);

        host = await drillScenario();
        host.drill.ignoreTerm = true;
        host.drill.ignoreKill = true;
        r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 2, r.out);
        rec = lastLog(host);
        assert.strictEqual(rec.failure.stage, 'stop');
        assert.strictEqual(rec.kept, true);
        assert.ok(host.files.has(rec.dir), 'directory kept while the instance may still hold it');
        assert.ok(host.alivePids.has(2222), 'production untouched');
        assert.ok(!host.calls.some((c) => c.cmd === 'kill' && c.args[1] === 2222));
    }),

    test('refusals: not root, port in use, unsupported service, no drill block, no backup, missing database copy', async () => {
        let host = await drillScenario();
        host.exec.isRoot = async () => false;
        let r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /must run as root/);
        assert.strictEqual(host.systemdRuns.length, 0);

        host = await drillScenario();
        host.listeners.set(14200, [{ pid: 777, process: 'python3' }]);
        const before = fsSnapshot(host);
        r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /port 14200 is already in use \(python3 pid 777\)/);
        assert.strictEqual(host.systemdRuns.length, 0);
        assert.deepStrictEqual(changedPaths(before, fsSnapshot(host)), [], 'a refusal writes nothing');

        host = await drillScenario({ drill: { supported: false, reason: 'workers have no off switch' } });
        r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /does not support restore drills: workers have no off switch/);

        host = await drillScenario();
        r = await host.cli('drill', 'media');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /media has no drill block/);

        host = await drillScenario({ backup: false });
        r = await host.cli('drill', 'community');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /no good ovhost backup recorded for community/);

        host = await drillScenario({ backup: false });
        host.ensureDir('/srv/old-backup');
        r = await host.cli('drill', 'community', '--backup', '/srv/old-backup');
        assert.strictEqual(r.code, 1);
        assert.match(r.out, /has no copy of the community database/);
        host.put('/srv/old-backup/community.db', 'older sqlite', { owner: 'ubuntu' });
        r = await host.cli('drill', 'community', '--backup', '/srv/old-backup', '--json');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(JSON.parse(r.out).backup, '/srv/old-backup');
        r = await host.cli('drill', 'community', '--backup', 'relative/dir');
        assert.strictEqual(r.code, 1);
    }),

    test('one app of a multi-unit service: drill.unit, data-directory databases, a bind mount, its own production port', async () => {
        const host = await appsScenario();
        const r = await host.cli('drill', 'apps');
        assert.strictEqual(r.code, 0, r.out);
        const rec = JSON.parse(host.read('/var/lib/openvibe-host/drills/apps.jsonl').trim().split('\n').pop());
        assert.strictEqual(rec.result, 'passed', JSON.stringify(rec.failure));
        const tmp = rec.dir;
        // Data-directory databases keep their production file names under {tmp}/data.
        assert.deepStrictEqual(rec.databases.map((d) => [d.name, d.copy]).sort(), [['docs-analytics', `${tmp}/data/analytics.db`], ['docs-jobs', `${tmp}/data/jobs.db`], ['yt-analytics', `${tmp}/yt-data/analytics.db`]].sort());
        const run = host.systemdRuns[0];
        // The docs unit's ExecStart and WorkingDirectory, not the gateway's.
        assert.strictEqual(run.cwd, '/opt/openvibe.apps/apps/docs');
        assert.deepStrictEqual(run.argv, ['/usr/bin/env', 'node', '/opt/openvibe.apps/apps/docs/server/index.js']);
        assert.ok(run.props.includes('Environment=NODE_ENV=production'));
        assert.ok(!run.props.some((p) => p.startsWith('Environment=PORT=')), 'the unit\'s PORT never reaches the drill');
        assert.ok(run.props.includes(`BindPaths=${tmp}/yt-data:/opt/openvibe.apps/apps/yt/data`), run.props.join('\n'));
        const env = host.drillEnv;
        assert.match(env, new RegExp(`^DATA_DIR=${tmp}/data$`, 'm'));
        assert.match(env, /^PORT=14016$/m);
        assert.ok(!/analytics\.db/.test(env), 'a data-directory database is found by its file name, not an env var');
        // Compared with the docs app's production port, not the gateway's.
        assert.deepStrictEqual(rec.compare.map((c) => [c.path, c.match]), [['/release.json', true]]);
        assert.ok(host.calls.some((c) => c.cmd === 'curl' && c.args[0] === 'http://127.0.0.1:4016/release.json'));
        assert.ok(!host.calls.some((c) => c.cmd === 'curl' && c.args[0].startsWith('http://127.0.0.1:4001/')));
        assert.ok(!host.restarts().length, 'nothing restarted');
    }),

    test('requires: a checkout without the drill switch is refused before anything is created', async () => {
        const host = await appsScenario({ switchInCheckout: false });
        const before = fsSnapshot(host);
        const r = await host.cli('drill', 'apps');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /TOOLS_JOB_RESULTS in apps\/_shared\/jobs\/index\.js/);
        assert.match(r.out, /Deploy a release with the drill switch first/);
        assert.strictEqual(host.systemdRuns.length, 0);
        assert.deepStrictEqual(changedPaths(before, fsSnapshot(host)), []);
    }),

    test('inventory: unit, productionPort, bind, requires and data-directory databases are validated', () => {
        const entry = appsEntry();
        const inv = (drill) => normalise({ services: { apps: { ...entry, drill: { ...entry.drill, ...drill } } } });
        assert.strictEqual(inv({}).services.apps.drill.unit, 'openvibe-apps-docs.service');
        assert.throws(() => inv({ unit: 'openvibe-live.service' }), /unit must be one of apps's units/);
        assert.throws(() => inv({ productionPort: 14016 }), /productionPort must differ/);
        assert.throws(() => inv({ bind: [{ from: '/tmp/x', to: '/opt/openvibe.apps/apps/yt/data' }] }), /bind\[0\]\.from/);
        assert.throws(() => inv({ bind: [{ from: '{tmp}/x', to: '/etc/openvibe' }] }), /inside the checkout/);
        assert.throws(() => inv({ bind: [{ from: '{tmp}/x', to: '/opt/openvibe.apps/../etc' }] }), /plain absolute path/);
        assert.throws(() => inv({ requires: [{ file: '../etc/passwd', contains: 'x' }] }), /inside the checkout/);
        assert.throws(() => inv({ requires: [{ file: 'a.js' }] }), /contains/);
        assert.throws(() => inv({ databases: { 'docs-analytics': { env: 'DATA_DIR' } } }), /"dir": true/);
        assert.throws(() => inv({ databases: { 'docs-analytics': { env: 'DATA_DIR', dir: true }, 'yt-analytics': { dir: true } } }), /would both be \{tmp\}\/data\/analytics\.db/);
        assert.throws(() => inv({ databases: { 'docs-analytics': { env: 'DATA_DIR', dir: '/var/lib/x' } } }), /dir must be true or/);
        assert.throws(() => inv({ databases: { 'docs-analytics': { env: 'DATA_DIR', dir: true }, 'docs-jobs': { env: 'DATA_DIR', dir: '{tmp}/other' } } }), /two different places/);
        const multi = { ...entry, drill: { ...entry.drill } };
        delete multi.drill.unit;
        normalise({ services: { apps: multi } });   // valid inventory; the drill itself refuses (below)
    }),

    test('several units and neither drill.unit nor drill.command: refused', async () => {
        const host = await appsScenario({ drill: { unit: null } });
        const r = await host.cli('drill', 'apps');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /set drill\.unit/);
    }),

    test('inventory: drill blocks are validated', () => {
        const base = { owner: 'ubuntu' };
        const svc = (drill, extra = {}) => normalise({ services: { community: { ...base, ...communityEntry(), ...extra, drill: { ...communityEntry().drill, ...drill } } } });
        assert.throws(() => svc({ port: 4200 }), /must differ from the service's own port/);
        assert.throws(() => svc({ databases: { nope: 'X_DB' } }), /not one of community's databases/);
        assert.throws(() => svc({ env: { HOST: '127.0.0.1' } }), /\{port\}/);
        assert.throws(() => svc({ env: { PORT: '{port}', COMMUNITY_DB_PATH: '/x' } }), /already set by drill.databases/);
        assert.throws(() => svc({ env: { PORT: '{port}\nEVIL=1' } }), /one-line/);
        assert.throws(() => svc({ dirs: ['/opt/openvibe.community/data'] }), /under \{tmp\}/);
        assert.throws(() => svc({ counts: [{ db: 'community', table: 'x; drop table y' }] }), /table name/);
        assert.throws(() => svc({ compare: [{ path: 'http://evil/' }] }), /path/);
        assert.throws(() => svc({ supported: false }), /reason is required/);
        assert.throws(() => normalise({ services: { a: { ...base, repo: '/opt/a', port: 14200 }, community: { ...base, ...communityEntry() } } }), /14200 is a's port/);
        assert.strictEqual(svc({}).services.community.drill.ready, '/api/ready');
    }),

    test('host.example.json: every service with a database has a drill block; unsupported ones give a reason', () => {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));
        const inv = normalise(raw);
        for (const s of Object.values(inv.services)) {
            if (!s.databases.length) continue;
            assert.ok(s.drill, `${s.id} has a drill block`);
            if (!s.drill.supported) { assert.ok(s.drill.reason.length > 20, `${s.id} explains why`); continue; }
            assert.ok(s.drill.compare.length || s.drill.counts.length);
            assert.ok(Object.keys(s.drill.env).length >= 2, `${s.id} overrides at least its port and one side effect`);
        }
    }),
]);
