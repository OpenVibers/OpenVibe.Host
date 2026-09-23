'use strict';
const assert = require('assert');
const path = require('path');
const { scenario, push, test, runTests, pkgJson } = require('./helpers');
const systemd = require('../lib/systemd');
const releases = require('../lib/releases');

const liveServerChange = (host) => push(host, 'live', { 'server/index.js': 'console.log(2);' }, 'server change');

runTests([
    test('deploys a Live server change: ff as ubuntu, restarts only the service unit, polls readiness, logs the release', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        const to = liveServerChange(host);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo('live').head, to);
        assert.deepStrictEqual(host.restarts(), ['openvibe-live.service']);
        assert.deepStrictEqual(host.socketViolations(), []);
        for (const c of host.calls.filter((x) => x.cmd === 'git')) assert.strictEqual(c.as, 'ubuntu', `git ran as ${c.as}: ${c.args.join(' ')}`);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm'), 'no install without a dependency change');
        const [rec] = await releases.list(host.exec, host.inv, 'live');
        assert.strictEqual(rec.result, 'deployed');
        assert.strictEqual(rec.from, from);
        assert.strictEqual(rec.to, to);
        assert.strictEqual(rec.lockfileChanged, false);
        assert.strictEqual(rec.depsVerified, true);
        assert.strictEqual(rec.ready, true);
        assert.match(r.out, /openvibe-live\.socket active — new HTTP connections queue/);
    }),

    test('refuses to restart Live while streams are live; the checkout does not move', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        liveServerChange(host);
        host.liveStreams = [{ id: 1, is_live: 1 }, { id: 2, is_live: 0 }];
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /1 live streams — refusing to restart/);
        assert.match(r.out, /--wait-idle/);
        assert.strictEqual(host.repo('live').head, from);
        assert.deepStrictEqual(host.restarts(), []);
        const [rec] = await releases.list(host.exec, host.inv, 'live');
        assert.strictEqual(rec.result, 'refused');
        assert.strictEqual(rec.protectedSessions.count, 1);
    }),

    test('an unanswerable stream probe counts as live, not as zero', async () => {
        const host = scenario();
        liveServerChange(host);
        host.http.set('http://127.0.0.1:3000/api/streams', () => ({ status: 500, body: 'oops' }));
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /unknown \(HTTP 500\) — treated as active/);
        assert.deepStrictEqual(host.restarts(), []);
    }),

    test('--wait-idle holds until two consecutive idle checks, then deploys', async () => {
        const host = scenario();
        const to = liveServerChange(host);
        host.liveStreams = [{ is_live: true }];
        let polls = 0;
        host.http.set('http://127.0.0.1:3000/api/streams', () => {
            polls += 1;
            return { status: 200, body: { streams: polls < 4 ? host.liveStreams : [] } };
        });
        const r = await host.cli('deploy', 'live', '--wait-idle');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /holding the restart/);
        assert.match(r.out, /idle for 2 checks — proceeding/);
        assert.strictEqual(host.repo('live').head, to);
        assert.deepStrictEqual(host.restarts(), ['openvibe-live.service']);
    }),

    test('--wait-idle gives up after drain.waitMaxSeconds with nothing restarted', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        liveServerChange(host);
        host.liveStreams = [{ is_live: true }];
        const r = await host.cli('deploy', 'live', '--wait-idle');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /gave up; nothing was restarted/);
        assert.strictEqual(host.repo('live').head, from);
        assert.deepStrictEqual(host.restarts(), []);
    }),

    test('--force restarts with streams live, loudly, and records it', async () => {
        const host = scenario();
        liveServerChange(host);
        host.liveStreams = [{ is_live: true }, { is_live: true }];
        const r = await host.cli('deploy', 'live', '--force');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /!!! --force/);
        assert.match(r.out, /2 live streams WILL BE DROPPED/);
        const [rec] = await releases.list(host.exec, host.inv, 'live');
        assert.strictEqual(rec.forced, true);
        assert.deepStrictEqual(host.socketViolations(), []);
    }),

    test('a static-only Live change (public/) deploys without a restart, even with streams live', async () => {
        const host = scenario();
        const to = push(host, 'live', { 'public/app.js': 'app2();' });
        host.liveStreams = [{ is_live: true }];
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo('live').head, to);
        assert.deepStrictEqual(host.restarts(), []);
        assert.match(r.out, /no restart needed/);
    }),

    test('sessions that start during the install stop the restart and put the checkout back', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        push(host, 'live', { 'server/index.js': 'x();', 'package-lock.json': '{"lockfileVersion":3,"v":2}' });
        host.npm = () => { host.liveStreams = [{ is_live: true }]; return undefined; };
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /immediately before the restart/);
        assert.strictEqual(host.repo('live').head, from);
        assert.deepStrictEqual(host.restarts(), []);
    }),

    test('refuses to restart Media while a recording is in progress (read-only query as the service user)', async () => {
        const host = scenario();
        const from = host.repo('media').head;
        push(host, 'media', { 'server/index.js': 'media2();' });
        host.recording = 1;
        const r = await host.cli('deploy', 'media');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /1 recordings in progress — refusing/);
        assert.strictEqual(host.repo('media').head, from);
        assert.deepStrictEqual(host.restarts(), []);
        const q = host.sqliteCalls.find((c) => c.op === 'query');
        assert.strictEqual(q.as, 'ubuntu');
        assert.strictEqual(q.db, '/opt/openvibe.media/data/media.db');
        assert.match(q.sql, /^SELECT count\(\*\) AS n FROM vods WHERE is_recording = 1$/);
    }),

    test('Media deploys once no recording is running', async () => {
        const host = scenario();
        const to = push(host, 'media', { 'server/index.js': 'media2();' });
        const r = await host.cli('deploy', 'media');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo('media').head, to);
        assert.deepStrictEqual(host.restarts(), ['openvibe-media.service']);
    }),

    test('rolls back automatically when readiness fails, reinstalling the previous dependencies', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        const bad = push(host, 'live', { 'server/index.js': 'broken();', 'package-lock.json': '{"lockfileVersion":3,"v":2}' });
        host.badShas.add(bad);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 3, r.out);
        assert.strictEqual(host.repo('live').head, from);
        assert.deepStrictEqual(host.restarts(), ['openvibe-live.service', 'openvibe-live.service']);
        assert.strictEqual(host.units.get('openvibe-live.service').runningSha, from);
        const npmRuns = host.calls.filter((c) => c.cmd === 'npm');
        assert.strictEqual(npmRuns.length, 2, 'installed for the new sha, reinstalled for the old one');
        const [rec] = await releases.list(host.exec, host.inv, 'live');
        assert.strictEqual(rec.result, 'failed-rolled-back');
        assert.strictEqual(rec.autoRollback.ready, true);
        assert.deepStrictEqual(host.socketViolations(), []);
    }),

    test('exit 4 and MANUAL INTERVENTION when the previous release is not ready either', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        const bad = liveServerChange(host);
        host.badShas.add(bad);
        host.badShas.add(from);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 4, r.out);
        assert.match(r.out, /MANUAL INTERVENTION REQUIRED/);
        const [rec] = await releases.list(host.exec, host.inv, 'live');
        assert.strictEqual(rec.result, 'rollback-failed');
    }),

    test('a dependency that still does not resolve after a reinstall aborts before any restart', async () => {
        const host = scenario();
        const from = host.repo('tools').head;
        push(host, 'tools', { 'apps/gateway/package.json': pkgJson('tools-gateway', ['express', 'openvibe-shared', 'openvibe-contracts']) });
        // The Tools incident: npm leaves an empty directory where openvibe-shared should be
        // (here: only for the new revision's package.json).
        host.npm = (cwd) => {
            const pkg = JSON.parse(host.read(path.join(cwd, 'package.json')));
            const broken = 'openvibe-contracts' in pkg.dependencies;
            for (const dep of Object.keys(pkg.dependencies)) {
                if (broken && dep === 'openvibe-shared') { host.files.delete(path.join(cwd, 'node_modules', dep, 'package.json')); host.ensureDir(path.join(cwd, 'node_modules', dep)); } else host.put(path.join(cwd, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep }));
            }
            return { code: 0 };
        };
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /dependencies do not resolve: apps\/gateway: openvibe-shared/);
        assert.match(r.out, /nothing restarted/);
        assert.deepStrictEqual(host.restarts(), []);
        assert.strictEqual(host.repo('tools').head, from, 'checkout restored');
        const [rec] = await releases.list(host.exec, host.inv, 'tools');
        assert.strictEqual(rec.depsVerified, false);
    }),

    test('a dependency that resolves after one reinstall is repaired and the deploy continues', async () => {
        const host = scenario();
        const to = push(host, 'tools', { 'apps/maps/server.js': 'maps2();' });
        host.files.delete('/opt/openvibe.tools/apps/gateway/node_modules/openvibe-shared/package.json');
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /openvibe-shared in apps\/gateway does not resolve .* reinstalling/);
        assert.strictEqual(host.repo('tools').head, to);
        assert.deepStrictEqual(host.restarts(), ['openvibe-tools.service', 'openvibe-tools-maps.service']);
        const [rec] = await releases.list(host.exec, host.inv, 'tools');
        assert.deepStrictEqual(rec.depsRepaired, ['apps/gateway']);
    }),

    test('installs only where the lockfile changed, as the owner, then restores the lockfile npm rewrote', async () => {
        const host = scenario();
        push(host, 'tools', { 'apps/maps/package-lock.json': '{"v":2}' });
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        const npmRuns = host.calls.filter((c) => c.cmd === 'npm');
        assert.strictEqual(npmRuns.length, 1);
        assert.strictEqual(npmRuns[0].cwd, '/opt/openvibe.tools/apps/maps');
        assert.strictEqual(npmRuns[0].as, 'ubuntu');
        assert.ok(host.calls.some((c) => c.cmd === 'git' && c.args.includes('checkout') && c.args.includes('apps/maps/package-lock.json')));
        assert.strictEqual(host.read('/opt/openvibe.tools/apps/maps/package-lock.json'), '{"v":2}');
        const [rec] = await releases.list(host.exec, host.inv, 'tools');
        assert.strictEqual(rec.lockfileChanged, true);
        assert.deepStrictEqual(rec.installed, ['apps/maps']);
    }),

    test('tracked local changes block the deploy', async () => {
        const host = scenario();
        liveServerChange(host);
        host.put('/opt/openvibe.live/server/index.js', 'hotfix();', { owner: 'ubuntu' });
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /tracked local changes \(server\/index\.js\)/);
        assert.deepStrictEqual(host.restarts(), []);
    }),

    test('the socket unit is never stopped or restarted; a down socket is started', async () => {
        const host = scenario();
        await assert.rejects(systemd.systemctl(host.exec, 'restart', 'openvibe-live.socket'), systemd.SocketGuardError);
        await assert.rejects(systemd.systemctl(host.exec, 'reload', 'openvibe-live.socket'), systemd.SocketGuardError);
        await assert.rejects(systemd.systemctl(host.exec, 'stop', 'openvibe-live.service'), /does not run "systemctl stop"/);
        host.units.get('openvibe-live.socket').active = 'inactive';
        liveServerChange(host);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'start' && c.args[1] === 'openvibe-live.socket'));
        assert.deepStrictEqual(host.socketViolations(), []);
        assert.throws(() => require('../lib/inventory').normalise({ services: { x: { repo: '/opt/x', owner: 'ubuntu', units: ['openvibe-live.socket'] } } }), /socket unit/);
    }),

    test('Events (drain policy "report") restarts with SSE connections open and says so', async () => {
        const host = scenario();
        push(host, 'events', { 'server/index.js': 'events2();' });
        host.sseConnections = 7;
        const r = await host.cli('deploy', 'events');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /7 SSE connections; drain policy "report"/);
        assert.deepStrictEqual(host.restarts(), ['openvibe-events.service']);
    }),

    test('a schema change backs up the declared databases (as the service user) before the restart', async () => {
        const host = scenario();
        push(host, 'live', { 'server/db/schema.sql': 'CREATE TABLE b(y);' });
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        const b = host.sqliteCalls.find((c) => c.op === 'backup');
        assert.ok(b, 'backup taken');
        assert.strictEqual(b.as, 'ubuntu');
        assert.match(b.dest, /^\/var\/backups\/openvibe\/live\/\d{8}-\d{6}\/live\.db$/);
        const backupIdx = host.calls.findIndex((c) => c.cmd === 'sqlite-backup');
        const restartIdx = host.calls.findIndex((c) => c.cmd === 'systemctl' && c.args[0] === 'restart');
        assert.ok(backupIdx < restartIdx, 'backup before restart');
    }),

    test('rollback without --to returns to the release before the current one', async () => {
        const host = scenario();
        const first = host.repo('live').head;
        const second = liveServerChange(host);
        assert.strictEqual((await host.cli('deploy', 'live')).code, 0);
        const r = await host.cli('rollback', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo('live').head, first);
        const recs = await releases.list(host.exec, host.inv, 'live');
        assert.strictEqual(recs[1].action, 'rollback');
        assert.strictEqual(recs[1].from, second);
        assert.strictEqual(recs[1].to, first);
        assert.strictEqual(recs[1].result, 'rolled-back');
        // A later deploy fast-forwards again.
        const again = await host.cli('deploy', 'live');
        assert.strictEqual(again.code, 0, again.out);
        assert.strictEqual(host.repo('live').head, second);
    }),

    test('rollback respects protected sessions too', async () => {
        const host = scenario();
        const first = host.repo('live').head;
        liveServerChange(host);
        await host.cli('deploy', 'live');
        host.liveStreams = [{ is_live: true }];
        const r = await host.cli('rollback', 'live', '--to', first);
        assert.strictEqual(r.code, 5, r.out);
        assert.notStrictEqual(host.repo('live').head, first);
    }),

    test('a second operation on the same service is refused while the first holds the lock', async () => {
        const host = scenario();
        host.put('/var/lib/openvibe-host/locks/live.lock', JSON.stringify({ pid: 4242, at: 'x' }));
        host.alivePids.add(4242);
        liveServerChange(host);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /another ovhost operation on live is running \(pid 4242/);
        host.alivePids.delete(4242);
        const r2 = await host.cli('deploy', 'live');
        assert.strictEqual(r2.code, 0, r2.out);
        assert.match(r2.out, /removed a stale lock/);
    }),

    test('Sites: npm ci + build as the owner, vhosts installed with nginx -t; a failing test restores and aborts', async () => {
        const host = scenario();
        push(host, 'sites', { 'deploy/nginx/openvibe.chat.conf': 'server { listen 443; server_name openvibe.chat; } # v2\n', 'build.js': 'build2();' });
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(host.calls.some((c) => c.cmd === 'npm' && c.args[0] === 'ci' && c.as === 'ubuntu'));
        assert.ok(host.calls.some((c) => c.cmd === 'node' && c.args[0] === 'build.js' && c.as === 'ubuntu'));
        assert.match(host.read('/etc/nginx/sites-available/openvibe.chat.conf'), /# v2/);
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload' && c.args[1] === 'nginx.service'));

        const before = host.repo('sites').head;
        push(host, 'sites', { 'deploy/nginx/openvibe.chat.conf': 'server { broken\n' });
        host.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] unexpected end of file' });
        const r2 = await host.cli('deploy', 'sites');
        assert.strictEqual(r2.code, 2, r2.out);
        assert.match(r2.out, /nginx -t failed/);
        assert.match(host.read('/etc/nginx/sites-available/openvibe.chat.conf'), /# v2/, 'previous vhost restored');
        assert.strictEqual(host.repo('sites').head, before, 'checkout restored');
    }),

    test('plan shows the change without moving anything', async () => {
        const host = scenario();
        const from = host.repo('live').head;
        push(host, 'live', { 'server/index.js': 'y();', 'package-lock.json': '{"v":9}' });
        host.liveStreams = [{ is_live: true }];
        const r = await host.cli('plan', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /install \(lockfile changed\)/);
        assert.match(r.out, /restart +yes: openvibe-live\.service \(socket openvibe-live\.socket stays up\)/);
        assert.match(r.out, /protected +1 live streams; drain policy refuse/);
        assert.strictEqual(host.repo('live').head, from);
        assert.deepStrictEqual(host.restarts(), []);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm'));
    }),
]);
