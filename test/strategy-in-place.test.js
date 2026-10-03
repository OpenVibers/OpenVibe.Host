'use strict';
/**
 * The in-place strategies against the fake host: multi-app (Tools' deploy.sh), static-build (Sites'
 * deploy.sh), pnpm-build (Games' manual deploy) and git-checkout with installUnits (Network's
 * deploy.sh), plus `ovhost capabilities` and `--version`, which the per-repository wrappers probe.
 */
const assert = require('assert');
const path = require('path');
const { test, runTests } = require('./helpers');
const { toolsHost, sitesHost, gamesHost, networkHost } = require('./strategy-hosts');
const releases = require('../lib/releases');

const lastRecord = async (host, id) => (await releases.list(host.exec, host.inv, id)).pop();
const HOST_ENV = '/etc/openvibe/host.env';

/** Host's credentials and a stand-in Events, for the per-placeholder notifications (Sites). */
function withEvents(host) {
    host.put(HOST_ENV, 'OV_OAUTH_CLIENT_ID=host\nOV_OAUTH_CLIENT_SECRET="s3cr3t-value"\nEVENTS_URL=http://127.0.0.1:4300\nOV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000\n', { mode: 0o600 });
    host.published = [];
    host.http.set('http://127.0.0.1:4000/oauth/token', () => ({ status: 200, body: { access_token: 'tok', token_type: 'Bearer' } }));
    host.http.set('http://127.0.0.1:4300/api/v1/events', ({ body }) => { const e = JSON.parse(body); host.published.push(e); return { status: 201, body: { event_id: e.event_id, seq: host.published.length } }; });
    return host;
}

/** The running commit tracks node_modules as a symlink; npm on the host replaced it with a real
 *  directory; the incoming release deletes node_modules. Returns the setup so a test can add the
 *  skip-worktree bit before deploying. */
function nodeModulesReplaced() {
    const host = toolsHost();
    const link = host.repo.commit({ node_modules: 'shared/node_modules' }, { message: 'track the node_modules symlink' });
    host.repo.checkout(link);
    host.exec.removeFile('/opt/openvibe.tools/node_modules');
    host.put('/opt/openvibe.tools/node_modules/express/package.json', JSON.stringify({ name: 'express' }), { owner: 'ubuntu' });
    const to = host.repo.commit({ node_modules: null }, { parent: link, message: 'stop tracking node_modules' });
    host.repo.publish(to);
    return { host, link, to };
}

runTests([
    // ── multi-app (Tools) ──
    test('tools: per-app installs skip apps/_shared, preflight runs in each app, every unit restarts, the gateway serves the new sha', async () => {
        const host = toolsHost();
        host.addUnit('openvibe-tools-docs.service', { runningSha: host.repo.head });
        // A timer's oneshot job the glob also matches (production's openvibe-toolsjob.service): never restarted or waited on.
        host.addUnit('openvibe-toolsjob.service', { type: 'oneshot', active: 'inactive', sub: 'dead' });
        const to = host.push({ 'apps/img/package.json': JSON.stringify({ name: 'tools-img', version: '1.0.1', dependencies: { express: '^1', 'better-sqlite3': '^1', 'openvibe-contracts': '^1', 'openvibe-sdk': '^1', sharp: '^1' } }), 'apps/_shared/guard/index.js': 'guard2();' }, 'img: sharp');
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo.head, to);
        const npm = host.calls.filter((c) => c.cmd === 'npm');
        assert.deepStrictEqual(npm.map((c) => c.cwd), ['/opt/openvibe.tools/apps/img'], 'only the app whose dependencies changed');
        assert.ok(npm.every((c) => c.as === 'ubuntu'));
        assert.ok(!host.calls.some((c) => c.cwd && c.cwd.includes('apps/_shared')), 'apps/_shared is a package, not an app: nothing runs there');
        // Preflight: the jobs runtime in img, the guard in every app (as the service user), data/ made first.
        const checks = host.nodeChecks().map((c) => `${path.basename(c.cwd)}:${/jobs/.test(c.args[1]) ? 'jobs' : 'guard'}:${c.as}`);
        assert.deepStrictEqual(checks, ['img:jobs:ubuntu', 'gateway:guard:ubuntu', 'img:guard:ubuntu', 'maps:guard:ubuntu']);
        for (const app of ['gateway', 'img', 'maps']) assert.strictEqual(host.files.get(`/opt/openvibe.tools/apps/${app}/data`).owner, 'ubuntu');
        const firstCheck = host.calls.findIndex((c) => c.cmd === 'node');
        assert.ok(firstCheck < host.calls.findIndex((c) => c.cmd === 'systemctl' && c.args[0] === 'restart'));
        // Every unit, including one on the host the inventory does not list (unitsMatch), named loudly.
        assert.deepStrictEqual(host.restarts(), ['openvibe-tools.service', 'openvibe-tools-img.service', 'openvibe-tools-maps.service', 'openvibe-tools-docs.service']);
        assert.match(r.out, /openvibe-tools-docs\.service match openvibe-tools\*\.service but are not in the inventory's units/);
        assert.ok(!host.restarts().includes('openvibe-toolsjob.service'), 'a oneshot job is not restarted');
        const rec = await lastRecord(host, 'tools');
        assert.strictEqual(rec.result, 'deployed');
        assert.strictEqual(rec.strategy, 'multi-app');
        assert.deepStrictEqual(rec.preflight, { ok: true, checks: 4, syntaxChecked: 0 });
        // Host: openvibe.tools reached both the ready URL and /release.json.
        assert.ok(host.calls.some((c) => c.cmd === 'curl' && c.args[0] === 'http://127.0.0.1:4001/release.json'));
    }),

    test('tools: nothing new does nothing', async () => {
        const host = toolsHost();
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /nothing to do/);
        assert.deepStrictEqual(host.restarts(), []);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm' || c.cmd === 'node'));
    }),

    test('tools: an untracked lockfile the release tracks is removed before the merge (as the owner)', async () => {
        const host = toolsHost();
        host.put('/opt/openvibe.tools/apps/maps/package-lock.json', '{"generated":"by npm on the host"}', { owner: 'ubuntu' });
        host.push({ 'apps/maps/package-lock.json': '{"v":1}' }, 'maps: track the lockfile');
        const plan = await host.cli('plan', 'tools');
        assert.match(plan.out, /untracked +apps\/maps\/package-lock\.json is removed before the merge/);
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        const rm = host.calls.findIndex((c) => c.cmd === 'rm' && c.args.includes('/opt/openvibe.tools/apps/maps/package-lock.json'));
        const merge = host.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('merge'));
        assert.ok(rm >= 0 && rm < merge, 'removed before the merge');
        assert.strictEqual(host.calls[rm].as, 'ubuntu');
        assert.strictEqual(host.read('/opt/openvibe.tools/apps/maps/package-lock.json'), '{"v":1}');
        assert.deepStrictEqual((await lastRecord(host, 'tools')).removedUntracked, ['apps/maps/package-lock.json']);
    }),

    // ── a tracked path the release stops tracking (npm replaced the node_modules symlink) ──

    test('tools: a tracked node_modules symlink npm replaced with a directory is dropped from the index before the merge; the directory stays', async () => {
        const { host, to } = nodeModulesReplaced();
        const plan = await host.cli('plan', 'tools');
        assert.match(plan.out, /tracked changes\s+none/, plan.out);
        assert.match(plan.out, /untracked +node_modules is untracked before the merge \(the release stops tracking it\)/);
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo.head, to);
        const git = (s) => host.calls.findIndex((c) => c.cmd === 'git' && c.args.includes(s));
        const idx = host.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('update-index'));
        const rm = host.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('rm') && c.args.includes('--cached'));
        const merge = git('merge');
        assert.ok(idx >= 0 && rm >= 0 && idx < merge && rm < merge, 'skip-worktree cleared and the path removed from the index before the merge');
        assert.strictEqual(host.calls[idx].as, 'ubuntu');
        assert.strictEqual(host.calls[rm].as, 'ubuntu');
        assert.ok(host.read('/opt/openvibe.tools/node_modules/express/package.json'), 'node_modules is never deleted from disk');
        assert.deepStrictEqual((await lastRecord(host, 'tools')).droppedFromIndex, ['node_modules']);
    }),

    test('tools: the same with skip-worktree set — git status hides it, the merge still refuses unless it leaves the index', async () => {
        const { host, to } = nodeModulesReplaced();
        // No --force: the real merge fails on the local typechange even under skip-worktree, so the
        // deploy only succeeds because the path leaves the index first.
        await host.exec.run('git', ['-C', '/opt/openvibe.tools', 'update-index', '--skip-worktree', '--', 'node_modules'], { as: 'ubuntu' });
        const plan = await host.cli('plan', 'tools');
        assert.match(plan.out, /untracked +node_modules is untracked before the merge/);
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo.head, to);
        assert.ok(host.read('/opt/openvibe.tools/node_modules/express/package.json'));
        assert.deepStrictEqual((await lastRecord(host, 'tools')).droppedFromIndex, ['node_modules']);
    }),

    test('tools: a dirty tracked file the release still tracks is still refused, nothing dropped from the index', async () => {
        const host = toolsHost();
        host.put('/opt/openvibe.tools/apps/img/server/index.js', 'locally-edited();', { owner: 'ubuntu' });
        host.push({ 'apps/img/server/index.js': 'img2();' }, 'img change');
        const plan = await host.cli('plan', 'tools');
        assert.match(plan.out, /tracked changes\s+apps\/img\/server\/index\.js — deploy will refuse/);
        assert.doesNotMatch(plan.out, /untracked +apps/);
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /tracked local changes \(apps\/img\/server\/index\.js\)/);
        assert.ok(!host.calls.some((c) => c.cmd === 'git' && (c.args.includes('rm') || c.args.includes('update-index'))), 'the index is untouched');
    }),

    test('tools: a preflight that fails (the jobs runtime does not load) aborts before any restart and restores the checkout', async () => {
        const host = toolsHost();
        const from = host.repo.head;
        host.push({ 'apps/img/server/index.js': 'img2();' }, 'img');
        host.onNode = (args, opts) => (/jobs/.test(args[1]) && opts.cwd.endsWith('apps/img') ? { code: 1, stderr: "Error: The module 'better_sqlite3.node' was compiled against a different Node.js version" } : undefined);
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /preflight failed: jobs runtime loads failed in apps\/img: Error: The module 'better_sqlite3\.node'/);
        assert.match(r.out, /checkout restored/);
        assert.strictEqual(host.repo.head, from);
        assert.deepStrictEqual(host.restarts(), []);
        assert.strictEqual((await lastRecord(host, 'tools')).preflight.ok, false);
    }),

    test('tools: readiness requires the new sha on /release.json and every unit active; else it rolls back (exit 3)', async () => {
        const host = toolsHost();
        const from = host.repo.head;
        host.push({ 'apps/gateway/server/index.js': 'gw2();' }, 'gw');
        // A satellite that crash-loops after the restart.
        const orig = host.onRestart;
        host.onRestart = (unit, u) => { orig(unit, u); if (unit === 'openvibe-tools-maps.service') u.active = host.repo.head === from ? 'active' : 'activating'; };
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 3, r.out);
        assert.match(r.out, /not active: openvibe-tools-maps\.service \(activating\)/);
        assert.strictEqual(host.repo.head, from);
        assert.strictEqual((await lastRecord(host, 'tools')).result, 'failed-rolled-back');

        const host2 = toolsHost();
        host2.push({ 'apps/gateway/server/index.js': 'gw2();' }, 'gw');
        host2.gatewayRelease = '0123456789ab';
        const r2 = await host2.cli('deploy', 'tools', '--ready-timeout', '5');
        assert.match(r2.out, /\/release\.json names 0123456789ab/);
        assert.notStrictEqual(r2.code, 0);
    }),

    test('tools: running jobs are reported (drain policy report); --wait-idle holds until they finish', async () => {
        const host = toolsHost();
        host.push({ 'apps/img/server/index.js': 'img2();' }, 'img');
        host.jobs = 2;
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /2 running tool jobs; drain policy "report"/);

        const host2 = toolsHost();
        host2.push({ 'apps/img/server/index.js': 'img2();' }, 'img');
        let polls = 0;
        host2.sqliteHandler = () => { polls += 1; return [{ n: polls < 3 ? 1 : 0 }]; };
        const w = await host2.cli('deploy', 'tools', '--wait-idle');
        assert.strictEqual(w.code, 0, w.out);
        assert.match(w.out, /--wait-idle: holding the restart/);
        assert.match(w.out, /idle for 2 checks — proceeding/);
    }),

    test('tools: a freeze refuses the deploy (exit 6) and moves nothing', async () => {
        const host = toolsHost();
        const from = host.repo.head;
        host.push({ 'apps/img/server/index.js': 'img2();' }, 'img');
        host.freeze('all');
        const r = await host.cli('deploy', 'tools');
        assert.strictEqual(r.code, 6, r.out);
        assert.match(r.out, /tools is frozen \(all services\)/);
        assert.strictEqual(host.repo.head, from);
        assert.deepStrictEqual(host.restarts(), []);
    }),

    // ── static-build (Sites) ──
    test('sites: build output from the last build is restored first, npm ci + build, vhosts installed behind nginx -t, one notification per placeholder', async () => {
        const host = withEvents(sitesHost());
        // The previous deploy's build left the tracked dist/ dirty (today's date): that never blocks a deploy.
        host.put('/opt/openvibe.sites/dist/openvibe.news/index.html', '<h1>News</h1> 2026-09-20', { owner: 'ubuntu' });
        host.push({ 'dist/openvibe.news/index.html': '<h1>News!</h1> 2026-09-21', 'dist/openvibe.news/release.json': JSON.stringify({ service: 'news', release: 'cccccccccccc' }), 'deploy/nginx/openvibe.news.conf': 'server { listen 443; server_name openvibe.news; } # v2\n' }, 'news copy');
        const plan = await host.cli('plan', 'sites');
        assert.match(plan.out, /tracked changes +none \(1 build output file\(s\) restored from git first\)/);
        assert.match(plan.out, /announce +one release notification per dist\/\*\/release\.json/);
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 0, r.out);
        const order = host.calls.filter((c) => ['git', 'npm', 'node', 'nginx'].includes(c.cmd) || (c.cmd === 'systemctl' && c.args[0] === 'reload')).map((c) => (c.cmd === 'git' ? `git ${c.args[2]}` : c.cmd === 'systemctl' ? 'reload nginx' : `${c.cmd} ${c.args[0]}`));
        const idx = (x) => order.indexOf(x);
        assert.ok(idx('git checkout') < idx('git merge') && idx('git merge') < idx('npm ci') && idx('npm ci') < idx('node build.js') && idx('node build.js') < idx('nginx -t') && idx('nginx -t') < idx('reload nginx'), order.join(', '));
        assert.match(host.read('/etc/nginx/sites-available/openvibe.news.conf'), /# v2/);
        assert.ok(host.files.get('/etc/nginx/sites-enabled/openvibe.news.conf'), 'enabled');
        assert.deepStrictEqual(host.restarts(), [], 'Sites has no process');
        // One release notification per placeholder, with its own release and origin.
        assert.deepStrictEqual(host.published.map((e) => [e.payload.service, e.payload.release, e.payload.origin]), [['news', 'cccccccccccc', 'https://openvibe.news'], ['tips', 'bbbbbbbbbbbb', 'https://openvibe.tips']]);
        assert.ok(!r.out.includes('s3cr3t-value'));
        // The build rewrote the tracked dist/ again; the next deploy is not blocked by it.
        host.push({ 'sites.json': '{"sites":["openvibe.news","openvibe.tips","openvibe.vip"]}' }, 'vip');
        const again = await host.cli('deploy', 'sites');
        assert.strictEqual(again.code, 0, again.out);
    }),

    test('sites: an untracked build output the release now tracks byte for byte is removed before the merge; a different one still refuses', async () => {
        const host = sitesHost();
        host.put('/opt/openvibe.sites/deploy/nginx/openvibe.work.conf', '# work v1', { owner: 'ubuntu' });   // the last build generated it
        host.push({ 'deploy/nginx/openvibe.work.conf': '# work v1' }, 'track the work vhost');
        const plan = await host.cli('plan', 'sites');
        assert.match(plan.out, /untracked +deploy\/nginx\/openvibe\.work\.conf is removed before the merge/);
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 0, r.out);
        const rm = host.calls.findIndex((c) => c.cmd === 'rm' && c.args.includes('/opt/openvibe.sites/deploy/nginx/openvibe.work.conf'));
        const merge = host.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('merge'));
        assert.ok(rm >= 0 && rm < merge, 'removed before the merge'); assert.strictEqual(host.calls[rm].as, 'ubuntu');
        assert.strictEqual(host.read('/opt/openvibe.sites/deploy/nginx/openvibe.work.conf'), '# work v1');
        assert.deepStrictEqual((await lastRecord(host, 'sites')).removedUntracked, ['deploy/nginx/openvibe.work.conf']);
        // Different bytes are someone's file: never removed, the merge refuses as before.
        const h2 = sitesHost();
        h2.put('/opt/openvibe.sites/deploy/nginx/local.conf', '# a hand edit', { owner: 'ubuntu' });
        h2.push({ 'deploy/nginx/local.conf': '# from the repository' }, 'track local.conf');
        const r2 = await h2.cli('deploy', 'sites');
        assert.notStrictEqual(r2.code, 0, r2.out); assert.match(r2.out, /deploy\/nginx\/local\.conf \/ Please move or remove them before you merge/);
        assert.strictEqual(h2.read('/opt/openvibe.sites/deploy/nginx/local.conf'), '# a hand edit');
        assert.ok(!h2.calls.some((c) => c.cmd === 'rm' && c.args.includes('/opt/openvibe.sites/deploy/nginx/local.conf')));
    }),

    test('sites: nothing new does nothing', async () => {
        const host = sitesHost();
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /nothing to do/);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm' || c.cmd === 'nginx'));
    }),

    test('sites: a vhost assigned to another service is never installed over its proxy', async () => {
        const host = sitesHost();
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.sites.nginx = { repoVhosts: 'deploy/nginx/*.conf', installOnDeploy: true, skipVhosts: ['openvibe.bot.conf'] };
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        host.put('/etc/nginx/sites-available/openvibe.bot.conf', 'server { proxy_pass http://127.0.0.1:4630; }');
        host.push({ 'deploy/nginx/openvibe.bot.conf': 'server { root /opt/openvibe.sites/dist/openvibe.bot; }' }, 'bot placeholder');
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.read('/etc/nginx/sites-available/openvibe.bot.conf'), 'server { proxy_pass http://127.0.0.1:4630; }');
        assert.ok(host.read('/etc/nginx/sites-available/openvibe.news.conf'), 'other Sites vhosts still install');
    }),

    test('sites: nginx -t failing never reloads nginx: the previous vhosts, checkout and build come back (exit 2)', async () => {
        const host = sitesHost();
        assert.strictEqual((await host.cli('deploy', 'sites', '--restart')).code, 0);
        host.put('/etc/nginx/sites-available/openvibe.news.conf', 'server { listen 443; server_name openvibe.news; }\n');
        const from = host.repo.head;
        host.calls.length = 0;
        host.push({ 'deploy/nginx/openvibe.news.conf': 'server { broken\n', 'dist/openvibe.news/index.html': '<h1>Broken</h1>' }, 'broken vhost');
        host.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] unexpected end of file' });
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /nginx -t failed; the previous vhost files were restored/);
        assert.ok(!host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload'), 'nginx is never reloaded after a failed nginx -t');
        assert.strictEqual(host.read('/etc/nginx/sites-available/openvibe.news.conf'), 'server { listen 443; server_name openvibe.news; }\n');
        assert.strictEqual(host.repo.head, from);
        assert.match(host.read('/opt/openvibe.sites/dist/openvibe.news/index.html'), /<h1>News<\/h1>/, 'what nginx serves is the previous release again');
        assert.strictEqual(host.calls.filter((c) => c.cmd === 'node' && c.args[0] === 'build.js').length, 2, 'built, then rebuilt for the restored checkout');
    }),

    test('sites: a failing build restores the checkout; a vhost that left the repo is named, never removed', async () => {
        const host = sitesHost();
        const from = host.repo.head;
        host.buildFails = host.push({ 'build.js': 'build2();' }, 'build');
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /build step "node build\.js" failed/);
        assert.strictEqual(host.repo.head, from);

        const host2 = sitesHost();
        host2.put('/etc/nginx/sites-available/openvibe.tips.conf', 'server { listen 443; server_name openvibe.tips; }\n');
        host2.push({ 'deploy/nginx/openvibe.tips.conf': null, 'dist/openvibe.tips/index.html': null, 'dist/openvibe.tips/release.json': null }, 'tips launched as its own service');
        const d = await host2.cli('deploy', 'sites');
        assert.strictEqual(d.code, 0, d.out);
        assert.match(d.out, /openvibe\.tips\.conf is no longer in the repository and stays installed/);
        assert.ok(host2.read('/etc/nginx/sites-available/openvibe.tips.conf'), 'the installed vhost is left alone');
    }),

    test('sites: a freeze refuses the deploy (exit 6)', async () => {
        const host = sitesHost();
        host.push({ 'build.js': 'build2();' }, 'build');
        host.freeze('sites');
        const r = await host.cli('deploy', 'sites');
        assert.strictEqual(r.code, 6, r.out);
        assert.ok(!host.calls.some((c) => c.cmd === 'npm'));
    }),

    // ── pnpm-build (Games) ──
    test('games: pnpm install --frozen-lockfile and pnpm build as the owner, the preflight, one restart; tracked dist-types never block', async () => {
        const host = gamesHost();
        host.put('/opt/openvibe.games/apps/server/dist-types/main.d.ts', 'export {}; // built by an earlier deploy\n', { owner: 'ubuntu' });
        const to = host.push({ 'apps/server/src/main.ts': 'main2();' }, 'server change');
        const r = await host.cli('deploy', 'games');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.repo.head, to);
        const pnpm = host.calls.filter((c) => c.cmd === 'pnpm');
        assert.deepStrictEqual(pnpm.map((c) => c.args.join(' ')), ['install --frozen-lockfile --config.confirmModulesPurge=false', 'build'], 'never waits on pnpm\'s purge prompt');
        assert.ok(pnpm.every((c) => c.as === 'ubuntu' && c.cwd === '/opt/openvibe.games'));
        assert.ok(host.calls.filter((c) => c.cmd === 'git').every((c) => c.as === 'ubuntu'), 'git as the checkout owner, never root');
        const check = host.nodeChecks()[0];
        assert.strictEqual(check.cwd, '/opt/openvibe.games/apps/server');
        assert.deepStrictEqual(host.restarts(), ['openvibe-games.service']);
        assert.match(host.read('/opt/openvibe.games/apps/client/dist/index.html'), new RegExp(to));
        assert.match(r.out, /every dependency resolves \(apps\/client, apps\/server, packages\/shared\)/);
        // The build rewrote tracked dist-types: validate says so without calling it a local change.
        const v = JSON.parse((await host.cli('validate', 'games', '--json')).out);
        assert.ok(v.findings.some((f) => f.area === 'checkout' && f.level === 'info' && /build output/.test(f.message)));
        assert.ok(!v.findings.some((f) => f.area === 'checkout' && f.level === 'error'), JSON.stringify(v.findings));
    }),

    test('games: nothing new does nothing', async () => {
        const host = gamesHost();
        const r = await host.cli('deploy', 'games');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(!host.calls.some((c) => c.cmd === 'pnpm'));
        assert.deepStrictEqual(host.restarts(), []);
    }),

    test('games: a failing preflight aborts before the restart; the checkout is restored and rebuilt', async () => {
        const host = gamesHost();
        const from = host.repo.head;
        host.push({ 'apps/server/src/main.ts': 'main2();' }, 'server change');
        host.onNode = () => ({ code: 1, stderr: 'Error: Could not locate the bindings file' });
        const r = await host.cli('deploy', 'games');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /better-sqlite3 loads under this Node failed in apps\/server/);
        assert.strictEqual(host.repo.head, from);
        assert.deepStrictEqual(host.restarts(), []);
        assert.strictEqual(host.builds, 2, 'built for the new sha, rebuilt for the restored one');
        assert.match(host.read('/opt/openvibe.games/apps/client/dist/index.html'), new RegExp(from), 'the served client is the running release again');
    }),

    test('games: not ready after the restart rolls back: reinstall, rebuild, restart (exit 3)', async () => {
        const host = gamesHost();
        const from = host.repo.head;
        host.badShas.add(host.push({ 'apps/server/src/main.ts': 'broken();' }, 'broken'));
        const r = await host.cli('deploy', 'games');
        assert.strictEqual(r.code, 3, r.out);
        assert.strictEqual(host.repo.head, from);
        assert.deepStrictEqual(host.restarts(), ['openvibe-games.service', 'openvibe-games.service']);
        assert.deepStrictEqual(host.calls.filter((c) => c.cmd === 'pnpm').map((c) => c.args[0]), ['install', 'build', 'install', 'build']);
        assert.match(host.read('/opt/openvibe.games/apps/client/dist/index.html'), new RegExp(from));
        assert.strictEqual((await lastRecord(host, 'games')).result, 'failed-rolled-back');
    }),

    test('games: players online are reported (drain policy report); --wait-idle holds until nobody plays; a freeze refuses', async () => {
        const host = gamesHost();
        host.players = 3;
        host.push({ 'apps/server/src/main.ts': 'main2();' }, 'server change');
        const r = await host.cli('deploy', 'games');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /3 players online; drain policy "report": they reconnect after the restart/);

        const host2 = gamesHost();
        host2.push({ 'apps/server/src/main.ts': 'main2();' }, 'server change');
        let polls = 0;
        host2.http.set('http://127.0.0.1:8000/api/ready', () => { polls += 1; return { status: 200, body: { status: 'ready', checks: { sessions: { detail: { online: polls < 4 ? 2 : 0 } } } } }; });
        const w = await host2.cli('deploy', 'games', '--wait-idle');
        assert.strictEqual(w.code, 0, w.out);
        assert.match(w.out, /2 players online; --wait-idle: holding the restart/);

        const host3 = gamesHost();
        host3.push({ 'apps/server/src/main.ts': 'main2();' }, 'server change');
        host3.freeze('games');
        assert.strictEqual((await host3.cli('deploy', 'games')).code, 6);
        assert.ok(!host3.calls.some((c) => c.cmd === 'pnpm'));
    }),

    // ── git-checkout (Network): unit files installed on every deploy ──
    test('network: installUnits installs a changed unit file on deploy (daemon-reload) without --install-units', async () => {
        const host = networkHost();
        host.push({ 'deploy/systemd/openvibe-network.service': '[Service]\nExecStart=node server/index.js\nTimeoutStopSec=20\n', 'server/index.js': 'net2();' }, 'unit');
        const r = await host.cli('deploy', 'network');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(host.read('/etc/systemd/system/openvibe-network.service'), /TimeoutStopSec=20/);
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'daemon-reload'));
        assert.deepStrictEqual((await lastRecord(host, 'network')).unitsInstalled, ['openvibe-network.service']);
        assert.strictEqual((await lastRecord(host, 'network')).strategy, 'git-checkout');
    }),

    test('unit bootstrap enables an installed service before its first restart', async () => {
        const host = networkHost();
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.network.enableUnits = true;
        raw.services.network.nginx = { vhost: 'openvibe.bot.conf', repoVhost: 'deploy/nginx/openvibe.bot.conf', installOnDeploy: true };
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        host.push({ 'deploy/systemd/openvibe-network.service': '[Service]\nExecStart=node server/index.js\nTimeoutStopSec=20\n', 'deploy/nginx/openvibe.bot.conf': 'server { proxy_pass http://127.0.0.1:4630; }', 'server/index.js': 'net2();' }, 'unit and vhost');
        const r = await host.cli('deploy', 'network');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(host.read('/etc/nginx/sites-available/openvibe.bot.conf'), 'server { proxy_pass http://127.0.0.1:4630; }');
        const actions = host.calls.filter((c) => c.cmd === 'systemctl').map((c) => c.args[0]);
        assert.ok(actions.indexOf('daemon-reload') < actions.indexOf('enable'), actions.join(', '));
        assert.ok(actions.indexOf('enable') < actions.indexOf('restart'), actions.join(', '));
    }),

    // ── what the wrappers probe ──
    test('capabilities and --version: what a deploy wrapper checks before handing over to ovhost', async () => {
        const host = gamesHost();
        const v = await host.cli('--version');
        assert.strictEqual(v.code, 0);
        assert.match(v.out, /^ovhost \d+\.\d+\.\d+$/);
        const c = await host.cli('capabilities', 'games');
        assert.strictEqual(c.code, 0, c.out);
        assert.match(c.out, /^deploy-api=1$/m);
        assert.match(c.out, /^strategies=git-checkout,multi-app,static-build,pnpm-build,release-layout$/m);
        assert.match(c.out, /^strategy=pnpm-build$/m);
        assert.match(c.out, /^managed=yes$/m);
        const unknown = await host.cli('capabilities', 'nope');
        assert.strictEqual(unknown.code, 1, 'an unknown service: the wrapper falls back');
        const json = JSON.parse((await host.cli('capabilities', 'games', '--json')).out);
        assert.strictEqual(json.strategy, 'pnpm-build');
        const bare = await host.cli('capabilities', '--inventory', '/nope.json');
        assert.strictEqual(bare.code, 1);
        host.push({ 'apps/server/src/main.ts': 'main2();' }, 'server change');
        const prep = await host.cli('deploy', 'games', '--prepare-only');
        assert.strictEqual(prep.code, 1, prep.out);
        assert.match(prep.out, /--prepare-only needs a release-layout service; games is pnpm-build/);
    }),
]);
