'use strict';
/**
 * The release-layout strategy (lib/release-layout.js) against the fake host, as Live and OpenRestream run on
 * the real one: every rule of Live's deploy/scripts/deploy.sh (release layout) and OpenRestream's
 * deploy.sh release + api, driven through `ovhost plan|deploy|rollback`.
 */
const assert = require('assert');
const path = require('path');
const { test, runTests } = require('./helpers');
const { liveHost, openreHost, LIVE_SOCKET, SECRET } = require('./strategy-hosts');
const releases = require('../lib/releases');

const lastRecord = async (host, id) => (await releases.list(host.exec, host.inv, id)).pop();
const socketCalls = (host) => host.calls.filter((c) => c.cmd === 'systemctl' && String(c.args[1]).endsWith('.socket') && !['show', 'is-active', 'is-enabled', 'list-units', 'list-unit-files', 'enable'].includes(c.args[0]));
const worktreeAdds = (host) => host.calls.filter((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('add'));

runTests([
    // ── Live ──
    test('live: a server change is prepared as a new release while the old one serves, then switched and restarted', async () => {
        const host = await liveHost();
        const first = host.firstRelease;
        const to = host.push({ 'server/index.js': 'console.log(2);' }, 'server change');
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        const now = host.current();
        assert.notStrictEqual(now, first);
        assert.match(now, new RegExp(`^\\d{8}-\\d{6}-${to.slice(0, 8)}$`), 'release id is <time>-<sha8>');
        assert.strictEqual(host.currentSha(), to);
        // node_modules hard-linked from the running release (same lockfile), the data link made.
        assert.ok(host.calls.some((c) => c.cmd === 'cp' && c.args[0] === '-al' && c.args[1].endsWith(`${first}/node_modules`)), 'cp -al of node_modules');
        assert.ok(!host.calls.some((c) => c.cmd === 'npm'), 'no install without a dependency change');
        assert.strictEqual(await host.exec.readlink(`/opt/openvibe.live/releases/${now}/data`), '../../shared/data');
        // Live's syntax check: every changed .js file, in the new release, before anything restarts.
        const check = host.nodeChecks().find((c) => c.args[0] === '--check');
        assert.ok(check && check.args[1] === `/opt/openvibe.live/releases/${now}/server/index.js`);
        const checkIdx = host.calls.indexOf(check);
        const restartIdx = host.calls.findIndex((c) => c.cmd === 'systemctl' && c.args[0] === 'restart');
        assert.ok(checkIdx < restartIdx);
        // Only the service restarted; the socket was never stopped or restarted; git ran as root (the clone's owner).
        assert.deepStrictEqual(host.restarts(), ['openvibe-live.service']);
        assert.deepStrictEqual(socketCalls(host), []);
        assert.match(r.out, /openvibe-live\.socket holds the listener — new HTTP connections queue/);
        for (const c of host.calls.filter((x) => x.cmd === 'git')) assert.strictEqual(c.as, 'root', c.args.join(' '));
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.result, 'deployed');
        assert.strictEqual(rec.strategy, 'release-layout');
        assert.strictEqual(rec.fromRelease, first);
        assert.strictEqual(rec.toRelease, now);
        assert.strictEqual(rec.ready, true);
        assert.strictEqual(rec.socketHeld, true);
        assert.ok(!r.out.includes(SECRET));
    }),

    test('live: nothing new is a no-op: nothing prepared, nothing restarted, nothing logged', async () => {
        const host = await liveHost();
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /nothing to deploy/);
        assert.deepStrictEqual(worktreeAdds(host), []);
        assert.deepStrictEqual(host.restarts(), []);
        assert.deepStrictEqual(await releases.list(host.exec, host.inv, 'live'), []);
    }),

    test('live: a public/-only change switches current without a restart, even with streams live', async () => {
        const host = await liveHost();
        host.liveStreams = [{ is_live: 1 }];
        host.push({ 'public/app.js': 'app2();' }, 'static');
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /switched to .* without a restart/);
        assert.deepStrictEqual(host.restarts(), []);
        assert.strictEqual(host.read('/opt/openvibe.live/current/public/app.js'), 'app2();');
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.result, 'deployed');
        assert.strictEqual(rec.restarted, false);
        assert.strictEqual(rec.switched, true);
    }),

    test('live: a static switch the site does not survive is switched back (exit 3)', async () => {
        const host = await liveHost();
        const first = host.firstRelease;
        host.push({ 'public/app.js': 'app2();' }, 'static');
        let probes = 0;
        host.http.set('http://127.0.0.1:3000/api/ready', () => { probes += 1; return probes === 1 ? { status: 500 } : { status: 200, body: {} }; });
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 3, r.out);
        assert.strictEqual(host.current(), first);
        assert.strictEqual((await lastRecord(host, 'live')).result, 'failed-rolled-back');
    }),

    test('live: a lockfile change installs into the new release only; rollback returns to the old release and its own node_modules', async () => {
        const host = await liveHost();
        const first = host.firstRelease;
        const firstSha = host.currentSha();
        host.push({ 'package-lock.json': '{"lockfileVersion":3,"v":2}', 'server/index.js': 'v2();' }, 'deps');
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        const second = host.current();
        const npm = host.calls.filter((c) => c.cmd === 'npm');
        assert.strictEqual(npm.length, 1);
        assert.deepStrictEqual(npm[0].args.slice(0, 2), ['ci', '--omit=dev']);
        assert.strictEqual(npm[0].cwd, `/opt/openvibe.live/releases/${second}`);
        assert.match(r.out, /installing dependencies in the new release \(lockfile changed\) — nothing interrupted yet/);
        assert.strictEqual(JSON.parse(host.read(`/opt/openvibe.live/releases/${first}/node_modules/express/package.json`)).lock, '{"lockfileVersion":3,"v":1}', 'the old release keeps its own node_modules');

        const rb = await host.cli('rollback', 'live');
        assert.strictEqual(rb.code, 0, rb.out);
        assert.match(rb.out, new RegExp(`rolling back to ${first} \\(the release ${second} replaced, from the release log\\)`));
        assert.strictEqual(host.current(), first);
        assert.strictEqual(host.units.get('openvibe-live.service').runningSha, firstSha);
        assert.strictEqual(host.calls.filter((c) => c.cmd === 'npm').length, 1, 'a rollback installs nothing');
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.action, 'rollback');
        assert.strictEqual(rec.result, 'rolled-back');
        assert.strictEqual(rec.fromRelease, second);
        assert.strictEqual(rec.toRelease, first);
        // A rollback is never frozen.
        host.freeze('live');
        const again = await host.cli('rollback', 'live', '--to', second);
        assert.strictEqual(again.code, 0, again.out);
        assert.strictEqual(host.current(), second);
    }),

    test('live: a failing preflight (syntax error) removes the new release and restarts nothing (exit 2)', async () => {
        const host = await liveHost();
        const first = host.firstRelease;
        host.push({ 'server/index.js': 'console.log(2;' }, 'broken syntax');
        host.onNode = (args) => (args[0] === '--check' ? { code: 1, stderr: 'SyntaxError: missing ) after argument list' } : undefined);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /preflight failed: syntax error in server\/index\.js: SyntaxError/);
        assert.match(r.out, new RegExp(`${first} untouched; nothing restarted`));
        assert.strictEqual(host.current(), first);
        assert.deepStrictEqual(await host.releaseIds(), [first], 'the prepared release is removed again');
        assert.deepStrictEqual(host.restarts(), []);
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.result, 'failed');
        assert.strictEqual(rec.preflight.ok, false);
    }),

    test('live: not ready after the restart: current switches back, the old units come back, exit 3', async () => {
        const host = await liveHost();
        const first = host.firstRelease;
        const firstSha = host.currentSha();
        const bad = host.push({ 'server/index.js': 'broken();', 'deploy/systemd/release/openvibe-live.service': `${'[Service]\nWorkingDirectory=/opt/openvibe.live/current\n'}ExecStart=/usr/bin/env node --bad server/index.js\n` }, 'bad release');
        host.badShas.add(bad);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 3, r.out);
        assert.strictEqual(host.current(), first);
        assert.strictEqual(host.units.get('openvibe-live.service').runningSha, firstSha);
        assert.deepStrictEqual(host.restarts(), ['openvibe-live.service', 'openvibe-live.service']);
        assert.strictEqual(host.read('/etc/systemd/system/openvibe-live.service'), host.read(`/opt/openvibe.live/releases/${first}/deploy/systemd/release/openvibe-live.service`), 'the previous release\'s unit file is back');
        assert.deepStrictEqual(socketCalls(host), []);
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.result, 'failed-rolled-back');
        assert.strictEqual(rec.autoRollback.ready, true);
        assert.ok((await host.releaseIds()).includes(rec.toRelease), 'the failed release is kept for inspection');
    }),

    test('live: /release.json must name the new sha (ready.release); a survivor answering is not ready', async () => {
        const host = await liveHost();
        host.push({ 'server/index.js': 'v2();' }, 'v2');
        host.http.set('http://127.0.0.1:3000/release.json', () => ({ status: 200, body: { service: 'live', release: 'deadbeef' } }));
        const r = await host.cli('deploy', 'live', '--ready-timeout', '5');
        assert.strictEqual(r.code, 4, r.out);
        assert.match(r.out, /\/release\.json names deadbeef/);
        assert.match(r.out, /MANUAL INTERVENTION/);
    }),

    test('live: exit 4 when the previous release is not ready either', async () => {
        const host = await liveHost();
        host.badShas.add(host.currentSha());
        host.badShas.add(host.push({ 'server/index.js': 'x();' }));
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 4, r.out);
        assert.strictEqual((await lastRecord(host, 'live')).result, 'rollback-failed');
    }),

    test('live: systemd not holding :3000 (the socket lost its descriptor) is the one case the socket is restarted: stop, restart socket, start', async () => {
        const host = await liveHost();
        host.listeners.set(3000, [{ pid: 4242, process: 'node' }]);
        host.onSocketRestart = () => host.listeners.set(3000, [{ pid: 1, process: 'systemd' }]);
        host.push({ 'server/index.js': 'v2();' }, 'v2');
        const plan = await host.cli('plan', 'live');
        assert.match(plan.out, /socket +NOT held by systemd on :3000 — a restart rebinds it/);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /openvibe-live\.socket is not holding its listener \(pid 1 does not hold :3000\) — stopping openvibe-live\.service, restarting the socket/);
        const seq = host.calls.filter((c) => c.cmd === 'systemctl' && ['stop', 'restart', 'start'].includes(c.args[0])).map((c) => `${c.args[0]} ${c.args[1]}`);
        assert.deepStrictEqual(seq, ['stop openvibe-live.service', 'restart openvibe-live.socket', 'start openvibe-live.service']);
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.socketRebind, 'socket-not-held');
        assert.strictEqual(rec.socketHeld, true);
        assert.strictEqual(host.units.get('openvibe-live.service').runningSha, host.currentSha());
    }),

    test('live: a changed socket unit file is installed and rebound; a listener still not systemd\'s afterwards is reported', async () => {
        const host = await liveHost();
        host.push({ 'deploy/systemd/release/openvibe-live.socket': LIVE_SOCKET.replace('Backlog=511', 'Backlog=1024') }, 'socket backlog');
        // The rebind does not bring pid 1 back on the port (the 2026-09-25 state): said loudly.
        host.onSocketRestart = () => host.listeners.set(3000, [{ pid: 4242, process: 'node' }]);
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(host.read('/etc/systemd/system/openvibe-live.socket'), /Backlog=1024/);
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'daemon-reload'));
        assert.match(r.out, /openvibe-live\.socket changed — stopping openvibe-live\.service, restarting the socket/);
        assert.match(r.out, /✗ socket activation is not in effect: systemd does not hold :3000/);
        const rec = await lastRecord(host, 'live');
        assert.strictEqual(rec.socketRebind, 'socket-changed');
        assert.strictEqual(rec.socketHeld, false);
        assert.deepStrictEqual(rec.unitsInstalled, ['openvibe-live.socket']);
    }),

    test('live: streams live refuse the restart (exit 5): the prepared release is removed, current never moves', async () => {
        const host = await liveHost();
        const first = host.firstRelease;
        host.liveStreams = [{ is_live: 1 }, { is_live: 0 }];
        host.push({ 'server/index.js': 'v2();' }, 'v2');
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /1 live streams — refusing to restart/);
        assert.strictEqual(host.current(), first);
        assert.deepStrictEqual(await host.releaseIds(), [first]);
        assert.deepStrictEqual(host.restarts(), []);
        assert.strictEqual((await lastRecord(host, 'live')).result, 'refused');
    }),

    test('live: --wait-idle holds until two idle checks, then deploys; --force drops streams loudly', async () => {
        const host = await liveHost();
        const to = host.push({ 'server/index.js': 'v2();' }, 'v2');
        let polls = 0;
        host.http.set('http://127.0.0.1:3000/api/streams', () => { polls += 1; return { status: 200, body: { streams: polls < 4 ? [{ is_live: true }] : [] } }; });
        const r = await host.cli('deploy', 'live', '--wait-idle');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /holding the restart \(before the switch\)/);
        assert.match(r.out, /idle for 2 checks — proceeding/);
        assert.strictEqual(host.currentSha(), to);

        const host2 = await liveHost();
        host2.liveStreams = [{ is_live: true }, { is_live: true }];
        host2.push({ 'server/index.js': 'v2();' }, 'v2');
        const f = await host2.cli('deploy', 'live', '--force');
        assert.strictEqual(f.code, 0, f.out);
        assert.match(f.out, /2 live streams WILL BE DROPPED/);
        assert.strictEqual((await lastRecord(host2, 'live')).forced, true);
    }),

    test('live: a freeze refuses the deploy (exit 6) before anything is prepared; --force goes through loudly', async () => {
        const host = await liveHost();
        host.push({ 'server/index.js': 'v2();' }, 'v2');
        host.freeze('live');
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 6, r.out);
        assert.match(r.out, /live is frozen/);
        assert.deepStrictEqual(worktreeAdds(host), []);
        assert.deepStrictEqual(host.restarts(), []);
        const f = await host.cli('deploy', 'live', '--force');
        assert.strictEqual(f.code, 0, f.out);
        assert.match(f.out, /!!! --force: deploying live through the freeze/);
    }),

    test('live: a schema change backs up the database before the switch and restart', async () => {
        const host = await liveHost();
        host.push({ 'server/db/schema.sql': 'CREATE TABLE b(y);' }, 'schema');
        const r = await host.cli('deploy', 'live');
        assert.strictEqual(r.code, 0, r.out);
        const b = host.calls.findIndex((c) => c.cmd === 'pg_dump');
        const mv = host.calls.findIndex((c) => c.cmd === 'mv' && c.args.includes('/opt/openvibe.live/current'));
        const restart = host.calls.findIndex((c) => c.cmd === 'systemctl' && c.args[0] === 'restart');
        assert.ok(b >= 0 && b < mv && mv < restart, 'backup, then switch, then restart');
        assert.strictEqual(host.dumps.find((c) => c.database === 'ov_live').as, 'postgres');
    }),

    test('live: plan shows the new release, node_modules reuse, the socket and the restart; changes nothing', async () => {
        const host = await liveHost();
        host.liveStreams = [{ is_live: true }];
        host.push({ 'server/index.js': 'v2();', 'deploy/nginx/openvibe.live.conf': 'server { listen 443; } # v2\n' }, 'v2');
        const r = await host.cli('plan', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /strategy +release-layout \(release layout, keep 3\)/);
        assert.match(r.out, new RegExp(`release +${host.firstRelease} → \\d{8}-\\d{6}-[0-9a-f]{8} \\(new, prepared while`));
        assert.match(r.out, /dependencies unchanged — node_modules hard-linked from/);
        assert.match(r.out, /preflight +syntax check of changed \.js\/\.json/);
        assert.match(r.out, /restart +yes: openvibe-live\.service \(socket openvibe-live\.socket stays up\)/);
        assert.match(r.out, /socket +held by systemd on :3000/);
        assert.match(r.out, /protected +1 live streams; drain policy refuse/);
        assert.match(r.out, /the repo vhost changed and is NOT installed by a deploy/);
        assert.deepStrictEqual(worktreeAdds(host), []);
        assert.deepStrictEqual(host.restarts(), []);
    }),

    test('live: old releases are pruned to release.keep, never current or the one just left', async () => {
        const host = await liveHost();
        for (let i = 2; i <= 6; i++) {
            host.exec.sleep(1000);
            host.push({ 'server/index.js': `v${i}();` }, `v${i}`);
            const r = await host.cli('deploy', 'live');
            assert.strictEqual(r.code, 0, r.out);
        }
        const ids = await host.releaseIds();
        assert.strictEqual(ids.length, 3, ids.join(' '));
        assert.ok(ids.includes(host.current()));
        assert.ok(host.calls.some((c) => c.cmd === 'git' && c.args.includes('remove')), 'pruned through git worktree remove');
    }),

    test('live: the entry may name the current link as its repo; the release root is its parent', async () => {
        const { normalise } = require('../lib/inventory');
        const inv = normalise({ services: { live: { repo: '/opt/openvibe.live/current', owner: 'root', strategy: 'release-layout', units: ['openvibe-live.service'] } } });
        assert.strictEqual(inv.services.live.repo, '/opt/openvibe.live');
        assert.strictEqual(inv.services.live.codeDir, '/opt/openvibe.live/current');
        assert.strictEqual(inv.services.live.release.git, '/opt/openvibe.live/repo');
        assert.strictEqual(inv.services.live.managed, true);
        assert.throws(() => normalise({ services: { x: { repo: '/opt/x', owner: 'root', strategy: 'release-layout', release: { links: { data: '../../../../etc' } } } } }), /must point inside/);
        assert.throws(() => normalise({ services: { x: { repo: '/opt/x', owner: 'root', strategy: 'tarball' } } }), /strategy must be one of/);
        assert.throws(() => normalise({ services: { x: { repo: '/opt/x', owner: 'root', strategy: 'git-checkout', layout: 'release' } } }), /needs strategy "release-layout"/);
        assert.throws(() => normalise({ services: { x: { repo: '/opt/x', owner: 'root', layout: 'release' } } }), /needs strategy "release-layout"/);
    }),

    // ── OpenRestream ──
    test('openre: release <sha12> with npm ci and chown to ubuntu, API and coordinator restarted, workers never touched', async () => {
        const host = await openreHost();
        const first = host.firstRelease;
        const to = host.push({ 'server/index.js': 'api2();' }, 'api change');
        const r = await host.cli('deploy', 'openre');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.current(), to.slice(0, 12));
        const npm = host.calls.filter((c) => c.cmd === 'npm');
        assert.strictEqual(npm.length, 1, 'OpenRestream installs into every release (reuseModules false)');
        assert.strictEqual(npm[0].cwd, `/opt/openre.stream/releases/${to.slice(0, 12)}`);
        assert.ok(host.calls.some((c) => c.cmd === 'chown' && c.args.join(' ') === `-R ubuntu:ubuntu /opt/openre.stream/releases/${to.slice(0, 12)}`));
        assert.strictEqual(host.files.get(`/opt/openre.stream/releases/${to.slice(0, 12)}/server/index.js`).owner, 'ubuntu');
        assert.deepStrictEqual(host.restarts(), ['openre-api.service', 'openre-session-coordinator.service']);
        assert.ok(!host.calls.some((c) => c.cmd === 'systemctl' && /openre-(rtmp-ingest|restream-worker|jsmpeg)@/.test(String(c.args[1])) && c.args[0] !== 'show'), 'no worker unit is started, stopped or restarted');
        assert.ok((await host.releaseIds()).includes(first), 'the release the workers run from is kept');
        // A second deploy prunes to keep (2), but never the release a worker instance runs from.
        host.advance(1000);
        host.push({ 'server/index.js': 'api3();' }, 'api3');
        assert.strictEqual((await host.cli('deploy', 'openre')).code, 0);
        host.advance(1000);
        host.push({ 'server/index.js': 'api4();' }, 'api4');
        assert.strictEqual((await host.cli('deploy', 'openre')).code, 0);
        const ids = await host.releaseIds();
        assert.ok(ids.includes(first), `the workers' release survives pruning (${ids.join(' ')})`);
        assert.ok(!ids.includes(to.slice(0, 12)), 'an unused old release is pruned');
    }),

    test('openre: a release only its JSMPEG worker runs from survives pruning', async () => {
        const host = await openreHost();
        const first = host.firstRelease;
        // The RTMP and restream workers have moved on; only openre-jsmpeg@<first> is still running from
        // the first release, so it is the only thing keeping that release alive.
        for (const w of ['openre-rtmp-ingest', 'openre-restream-worker']) {
            const u = host.units.get(`${w}@${first}.service`);
            u.active = 'inactive';
            u.sub = 'dead';
        }
        host.push({ 'server/index.js': 'api2();' }, 'api2');
        assert.strictEqual((await host.cli('deploy', 'openre')).code, 0);
        host.push({ 'server/index.js': 'api3();' }, 'api3');
        assert.strictEqual((await host.cli('deploy', 'openre')).code, 0);
        const ids = await host.releaseIds();
        assert.ok(ids.includes(first), `the JSMPEG worker's release survives pruning (${ids.join(' ')})`);
        // Listing it is all ovhost ever does: the JSMPEG worker unit is never started, stopped or restarted.
        assert.ok(!host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] !== 'show' && String(c.args[1]).includes('openre-jsmpeg')), 'the JSMPEG worker unit is only ever read');
    }),

    test('openre: an ingest session refuses the API restart; --to <sha12> rolls back; a docs-only change needs no restart', async () => {
        const host = await openreHost();
        const first = host.firstRelease;
        host.push({ 'server/index.js': 'api2();' }, 'api2');
        host.sessions = 1;
        const r = await host.cli('deploy', 'openre');
        assert.strictEqual(r.code, 5, r.out);
        assert.match(r.out, /1 ingest sessions — refusing/);
        assert.strictEqual(host.current(), first);
        host.sessions = 0;
        assert.strictEqual((await host.cli('deploy', 'openre')).code, 0);
        const n = host.restarts().length;
        host.push({ 'docs/README.md': '# OpenRe v2' }, 'docs');
        const d = await host.cli('deploy', 'openre');
        assert.strictEqual(d.code, 0, d.out);
        assert.strictEqual(host.restarts().length, n, 'no restart for docs');
        const rb = await host.cli('rollback', 'openre', '--to', first);
        assert.strictEqual(rb.code, 0, rb.out);
        assert.strictEqual(host.current(), first);
        assert.strictEqual(host.restarts().length, n + 2, 'the rollback restarts the API and the coordinator (code differs)');
    }),

    test('openre: --prepare-only makes the release and stops (deploy.sh release); deploy --to <sha12> switches to it (deploy.sh api)', async () => {
        const host = await openreHost();
        const first = host.firstRelease;
        const to = host.push({ 'server/index.js': 'api2();' }, 'api2');
        const p = await host.cli('deploy', 'openre', '--prepare-only');
        assert.strictEqual(p.code, 0, p.out);
        assert.match(p.out, /is prepared; .* keeps serving \(--prepare-only: nothing switched or restarted\)/);
        assert.strictEqual(host.current(), first);
        assert.ok((await host.releaseIds()).includes(to.slice(0, 12)));
        assert.deepStrictEqual(host.restarts(), []);
        const npmBefore = host.calls.filter((c) => c.cmd === 'npm').length;
        const a = await host.cli('deploy', 'openre', '--to', to.slice(0, 12));
        assert.strictEqual(a.code, 0, a.out);
        assert.match(a.out, /already exists; checking it again/);
        assert.strictEqual(host.current(), to.slice(0, 12));
        assert.strictEqual(host.calls.filter((c) => c.cmd === 'npm').length, npmBefore, 'a prepared release is not installed twice');
        assert.deepStrictEqual(host.restarts(), ['openre-api.service', 'openre-session-coordinator.service']);
        assert.deepStrictEqual((await releases.list(host.exec, host.inv, 'openre')).map((r) => r.result), ['prepared', 'deployed']);
    }),

    test('openre: plan and status read the release root; capabilities say it is managed by release-layout', async () => {
        const host = await openreHost();
        const c = await host.cli('capabilities', 'openre');
        assert.strictEqual(c.code, 0, c.out);
        assert.match(c.out, /^strategy=release-layout$/m);
        assert.match(c.out, /^managed=yes$/m);
        const st = await host.cli('status', 'openre');
        assert.match(st.out, new RegExp(`openre +${host.firstRelease}`));
        assert.strictEqual(path.basename(host.resolve('/opt/openre.stream/current')), host.firstRelease);
        // A deployed release belongs to ubuntu (release.chown): validate accepts it.
        host.push({ 'server/index.js': 'api2();' }, 'api2');
        assert.strictEqual((await host.cli('deploy', 'openre')).code, 0);
        assert.strictEqual(host.files.get(host.resolve('/opt/openre.stream/current')).owner, 'ubuntu');
        const v = JSON.parse((await host.cli('validate', 'openre', '--json')).out);
        assert.ok(v.findings.some((f) => f.area === 'checkout' && /releases are made from \/opt\/openre\.stream\/repo/.test(f.message)), JSON.stringify(v.findings));
        assert.deepStrictEqual(v.findings.filter((f) => f.area === 'checkout' && f.level === 'error'), []);
    }),
]);
