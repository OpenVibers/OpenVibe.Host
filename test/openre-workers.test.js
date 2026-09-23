'use strict';
/**
 * OpenRe on ovhost: `workerUnits` (the transport worker templates) are listed by status and
 * validate and never started, stopped or restarted; the inventory refuses a worker unit in
 * `units`; a deploy of a git-layout service with worker units restarts only its units; and the
 * example inventory's openre drill starts openre-api alone with OPENRE_DRILL=1 and the side-effect
 * switches, leaving the API, the coordinator and every worker untouched.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scenario, push, test, runTests, SECRET } = require('./helpers');
const { normalise } = require('../lib/inventory');

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));
const RELEASE = '655b98a10aaa';
const OLD = '0123456789ab';
const PROD_DB = '/var/lib/openre/openre.db';
const WORKERS = [`openre-rtmp-ingest@${RELEASE}.service`, `openre-restream-worker@${RELEASE}.service`];

/** The standard fake host plus OpenRe as on openvibe-ovh: release layout, two units, worker instances. */
async function openreHost({ workersRunning = true } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.openre = JSON.parse(JSON.stringify(EXAMPLE.services.openre));
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });

    host.put(`/opt/openre.stream/releases/${RELEASE}/package.json`, '{"name":"openre-stream"}', { owner: 'ubuntu' });
    host.put(`/opt/openre.stream/releases/${RELEASE}/.env.example`, 'OV_OAUTH_CLIENT_ID=openre\nOV_OAUTH_CLIENT_SECRET=\nOPENRE_SECRETS_KEY=\n#OPENRE_DRILL=\n', { owner: 'ubuntu' });
    host.files.get(`/opt/openre.stream/releases/${RELEASE}`).owner = 'ubuntu';
    await host.exec.symlink(`/opt/openre.stream/releases/${RELEASE}`, '/opt/openre.stream/current');
    host.put('/etc/openvibe/openre.env', `OV_OAUTH_CLIENT_ID=openre\nOV_OAUTH_CLIENT_SECRET=${SECRET}\nOPENRE_SECRETS_KEY=${SECRET}-k\nOPENRE_RTMP_BIND=0.0.0.0\n`, { mode: 0o600 });
    host.put('/etc/systemd/system/openre-api.service', [
        '[Service]',
        'User=ubuntu',
        'WorkingDirectory=/opt/openre.stream/current',
        'EnvironmentFile=/etc/openvibe/openre.env',
        'Environment=NODE_ENV=production',
        'Environment=PORT=4500',
        `Environment=OPENRE_DB_PATH=${PROD_DB}`,
        'Environment=PATH=/usr/local/bin:/usr/bin:/bin',
        'ExecStart=/usr/bin/env node server/index.js',
        '',
    ].join('\n'));
    host.addUnit('openre-api.service', { mainPid: 3100 });
    host.addUnit('openre-session-coordinator.service', { mainPid: 3101 });
    host.alivePids.add(3100);
    host.alivePids.add(3101);
    host.listeners.set(4500, [{ pid: 3100, process: 'node' }]);
    host.addUnit(`openre-rtmp-ingest@${RELEASE}.service`, { mainPid: 3102, ...(workersRunning ? {} : { active: 'inactive', sub: 'dead' }) });
    host.addUnit(`openre-restream-worker@${RELEASE}.service`, { mainPid: 3103, ...(workersRunning ? {} : { active: 'inactive', sub: 'dead' }) });
    host.addUnit(`openre-rtmp-ingest@${OLD}.service`, { active: 'inactive', sub: 'dead', mainPid: 0 });
    host.put(PROD_DB, 'sqlite-production', { owner: 'ubuntu', mode: 0o640 });

    const health = '{"status":"ok","service":"openre-api","version":"0.1.0","release":"dev"}';
    const robots = 'User-agent: *\nAllow: /$\n';
    host.http.set('http://127.0.0.1:4500/api/ready', () => ({ status: 200, body: { status: 'ready' } }));
    host.http.set('http://127.0.0.1:4500/api/health', () => ({ status: 200, body: health }));
    host.http.set('http://127.0.0.1:4500/robots.txt', () => ({ status: 200, body: robots }));
    const counts = { stream_definitions: 1, ingest_keys: 1, destinations: 0, migration_map: 0 };
    host.sqliteHandler = (db, sql) => {
        if (/integrity_check/.test(sql)) return [{ integrity_check: 'ok' }];
        const m = /FROM "([a-z_]+)"/.exec(sql);
        return [{ n: m ? counts[m[1]] ?? 0 : 0 }];
    };
    host.onSystemdRun = (spec) => {
        host.listeners.set(14500, [{ pid: spec.pid, process: 'node' }]);
        host.drillEnv = host.read(spec.envFiles[spec.envFiles.length - 1]);
        const alive = (fn) => () => (host.alivePids.has(spec.pid) ? fn() : { status: 0, error: 'ECONNREFUSED' });
        host.http.set('http://127.0.0.1:14500/api/ready', alive(() => ({ status: 200, body: { status: 'ready', mode: 'drill' } })));
        host.http.set('http://127.0.0.1:14500/api/health', alive(() => ({ status: 200, body: health })));
        host.http.set('http://127.0.0.1:14500/robots.txt', alive(() => ({ status: 200, body: robots })));
        return undefined;
    };
    return host;
}

/** systemctl calls that could change a unit's state. */
const stateChanges = (host) => host.calls.filter((c) => c.cmd === 'systemctl' && !['show', 'is-active', 'is-enabled', 'cat', 'status', 'list-units'].includes(c.args[0]));

runTests([
    test('the example inventory declares the OpenRe worker templates and a supported drill', () => {
        const inv = normalise(EXAMPLE);
        const o = inv.services.openre;
        assert.deepStrictEqual(o.units, ['openre-api.service', 'openre-session-coordinator.service']);
        assert.deepStrictEqual(o.workerUnits, ['openre-rtmp-ingest@.service', 'openre-restream-worker@.service']);
        assert.strictEqual(o.layout, 'release');
        assert.strictEqual(o.managed, false);
        assert.strictEqual(o.drill.supported, true);
        assert.strictEqual(o.drill.port, 14500);
        assert.deepStrictEqual(o.drill.command, ['/usr/bin/node', 'server/index.js']);
        assert.strictEqual(o.drill.env.OPENRE_DRILL, '1');
        for (const k of ['EVENTS_URL', 'OV_OAUTH_CLIENT_SECRET', 'MEDIA_API_KEY']) assert.strictEqual(o.drill.env[k], '', k);
        assert.strictEqual(o.drill.env.MEDIA_URL, 'http://127.0.0.1:9');
        assert.deepStrictEqual(o.drill.databases, { openre: { env: 'OPENRE_DB_PATH', dir: false } });
        // every other service keeps an empty list
        assert.deepStrictEqual(inv.services.live.workerUnits, []);
    }),

    test('a worker unit, or an instance of a worker template, is refused in units', () => {
        const base = { owner: 'ubuntu', repo: '/opt/x' };
        assert.throws(() => normalise({ services: { x: { ...base, units: ['x-api.service', 'x-worker@abc.service'], workerUnits: ['x-worker@.service'] } } }), /"x-worker@abc\.service" is a worker unit \(x-worker@\.service\)/);
        assert.throws(() => normalise({ services: { x: { ...base, units: ['x-w.service'], workerUnits: ['x-w.service'] } } }), /is a worker unit/);
        assert.throws(() => normalise({ services: { x: { ...base, workerUnits: ['x.socket'] } } }), /not a \.service unit or template/);
        assert.throws(() => normalise({ services: { x: { ...base, workerUnits: ['../x.service'] } } }), /not a \.service unit or template/);
        assert.throws(() => normalise({ services: { x: { ...base, workerUnits: 'x@.service' } } }), /must be an array/);
        const ok = normalise({ services: { x: { ...base, units: ['x-worker-api.service'], workerUnits: ['x-worker@.service'] } } });
        assert.deepStrictEqual(ok.services.x.workerUnits, ['x-worker@.service'], 'a unit that only shares a prefix without the @ is fine');
    }),

    test('status lists worker instances read-only and never changes a unit', async () => {
        const host = await openreHost();
        const r = await host.cli('status', 'openre');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, new RegExp(`openre\\s+${RELEASE}\\s+ready\\s+openre-api=active openre-session-coordinator=active workers\\[openre-rtmp-ingest@${RELEASE}=active openre-rtmp-ingest@${OLD}=inactive openre-restream-worker@${RELEASE}=active\\] \\[unmanaged\\]`));
        const json = JSON.parse((await host.cli('status', 'openre', '--json')).out);
        assert.deepStrictEqual(json[0].workers.map((w) => [w.unit, w.active]), [[`openre-rtmp-ingest@${RELEASE}.service`, 'active'], [`openre-rtmp-ingest@${OLD}.service`, 'inactive'], [`openre-restream-worker@${RELEASE}.service`, 'active']]);
        const lists = host.calls.filter((c) => c.cmd === 'systemctl' && c.args[0] === 'list-units');
        assert.deepStrictEqual(lists[0].args, ['list-units', '--all', '--plain', '--no-legend', '--no-pager', 'openre-rtmp-ingest@*.service']);
        assert.ok(lists.every((c) => !c.privileged), 'listing needs no privileges');
        assert.deepStrictEqual(stateChanges(host), []);
    }),

    test('validate lists the workers as info, warns when none runs, and changes nothing', async () => {
        let host = await openreHost();
        let res = JSON.parse((await host.cli('validate', 'openre', '--json')).out);
        const workers = res.findings.filter((f) => f.area === 'units' && /^worker /.test(f.message));
        assert.deepStrictEqual(workers.map((f) => f.level), ['info', 'info', 'info']);
        assert.match(workers[0].message, /never starts, stops or restarts it/);
        assert.ok(!res.findings.some((f) => /no running instance/.test(f.message)));
        assert.deepStrictEqual(stateChanges(host), []);
        host = await openreHost({ workersRunning: false });
        res = JSON.parse((await host.cli('validate', 'openre', '--json')).out);
        assert.deepStrictEqual(res.findings.filter((f) => /no running instance/.test(f.message)).map((f) => [f.level, f.message]), [
            ['warn', 'no running instance of worker unit openre-rtmp-ingest@.service'],
            ['warn', 'no running instance of worker unit openre-restream-worker@.service'],
        ]);
        assert.deepStrictEqual(stateChanges(host), []);
        assert.ok(!JSON.stringify(res).includes(SECRET));
    }),

    test('a deploy of a git-layout service with worker units restarts its units only', async () => {
        const host = scenario();
        const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
        doc.services.events.workerUnits = ['openvibe-events-worker@.service'];
        host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
        host.addUnit('openvibe-events-worker@a1.service', { mainPid: 5001 });
        push(host, 'events', { 'server/index.js': 'events(2);' });
        const r = await host.cli('deploy', 'events');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.restarts(), ['openvibe-events.service']);
        assert.ok(!host.calls.some((c) => c.cmd === 'systemctl' && c.args.includes('openvibe-events-worker@a1.service')), 'the worker instance is never named in a systemctl call');
        assert.strictEqual(host.units.get('openvibe-events-worker@a1.service').restarts, 0);
    }),

    test('ovhost drill openre: openre-api alone, OPENRE_DRILL=1, side effects off, production untouched', async () => {
        const host = await openreHost();
        const b = await host.cli('backup', 'openre', '--json');
        assert.strictEqual(b.code, 0, b.out);
        host.advance(60 * 1000);
        const callsBefore = host.calls.length;
        const r = await host.cli('drill', 'openre');
        assert.strictEqual(r.code, 0, r.out);
        const rec = JSON.parse(host.read('/var/lib/openvibe-host/drills/openre.jsonl').trim().split('\n').pop());
        assert.strictEqual(rec.result, 'passed', JSON.stringify(rec.failure));
        assert.deepStrictEqual(rec.compare.map((c) => [c.path, c.match]), [['/api/health', true], ['/robots.txt', true]]);
        assert.deepStrictEqual(rec.counts.map((c) => [c.table, c.match]), [['stream_definitions', true], ['ingest_keys', true], ['destinations', true], ['migration_map', true]]);

        assert.strictEqual(host.systemdRuns.length, 1, 'one process');
        const run = host.systemdRuns[0];
        assert.deepStrictEqual(run.argv, ['/usr/bin/node', 'server/index.js'], 'the API, never a worker or the coordinator');
        assert.strictEqual(run.cwd, '/opt/openre.stream/current');
        assert.strictEqual(run.uid, 'ubuntu');
        assert.deepStrictEqual(run.envFiles, ['/etc/openvibe/openre.env', `${rec.dir}/drill.env`]);
        for (const p of ['SocketBindAllow=tcp:14500', 'SocketBindDeny=any', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'Environment=NODE_ENV=production']) assert.ok(run.props.includes(p), p);
        assert.ok(run.props.includes('Environment=PATH=/usr/local/bin:/usr/bin:/bin'), 'other unit Environment= is passed on');
        assert.ok(!run.props.some((p) => /OPENRE_DB_PATH|Environment=PORT=/.test(p)), 'the production database path and port from the unit never reach the drill instance');
        const env = Object.fromEntries(host.drillEnv.trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
        assert.deepStrictEqual(env, {
            PORT: '14500', HOST: '127.0.0.1', OPENRE_DRILL: '1', EVENTS_URL: '', OV_OAUTH_CLIENT_SECRET: '', MEDIA_URL: 'http://127.0.0.1:9', MEDIA_API_KEY: '', OPENRE_RECORDING: 'off',
            OPENRE_DB_PATH: `${rec.dir}/db/openre.db`,
        });

        const calls = host.calls.slice(callsBefore);
        assert.deepStrictEqual(calls.filter((c) => c.cmd === 'kill').map((c) => c.args), [['SIGTERM', run.pid]], 'only the drill instance is signalled');
        assert.deepStrictEqual(stateChanges(host), [], 'no unit was started, stopped or restarted');
        for (const u of ['openre-api.service', 'openre-session-coordinator.service', ...WORKERS]) {
            assert.strictEqual(host.units.get(u).active, 'active', u);
            assert.strictEqual(host.units.get(u).restarts, 0, u);
            assert.ok(!calls.some((c) => c.args && c.args.includes(u) && c.args[0] !== 'show'), `${u} is only ever read`);
        }
        assert.ok(host.alivePids.has(3100) && host.alivePids.has(3101));
        assert.strictEqual(host.read(PROD_DB), 'sqlite-production');
        assert.ok(!(r.out + JSON.stringify(host.systemdRuns) + host.read('/var/lib/openvibe-host/drills/openre.jsonl')).includes(SECRET));
    }),
]);
