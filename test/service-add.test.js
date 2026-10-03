'use strict';
const assert = require('assert');
const { scenario, test, runTests, SECRET, lifecycleDoc } = require('./helpers');
const { main } = require('../lib/cli');

const SELF = '/opt/ovhost-install/bin/ovhost';
const URL = 'https://github.com/OpenVibers/OpenVibe.Bot.git';

function setup() {
    const host = scenario();
    host.put('/opt/ovhost-install/host.example.json', JSON.stringify({ services: { bot: {
        _note: 'example-only note', repo: '/opt/openvibe.bot', owner: 'ubuntu', units: [],
        envFile: '/etc/openvibe/bot.env', env: { required: 'from-example' }, port: 4630,
        nginx: { vhost: 'openvibe.bot.conf' }, lifecycle: lifecycleDoc(),
        databases: [{ name: 'bot', engine: 'postgresql', database: 'ov_bot' }],
    } } }));
    host.remoteRepos.set(URL, { '.env.example': `NODE_ENV=development\nHOST=0.0.0.0\nPORT=3000\nBASE_URL=https://example.invalid\nDATABASE_URL=\nOV_OAUTH_CLIENT_SECRET=\nEXAMPLE_SECRET=${SECRET}\n` });
    host.put('/opt/ovhost-install/roles/data/add-service.sh', '#!/bin/sh\n', { mode: 0o755 });
    const provision = [];
    const run = host.exec.run;
    host.exec.run = async (cmd, args, opts) => {
        if (cmd.endsWith('/roles/data/add-service.sh')) {
            provision.push({ cmd, args, opts });
            return { code: 0, stdout: 'DATABASE_URL and VALKEY_URL set (values not shown)', stderr: '' };
        }
        return run(cmd, args, opts);
    };
    const cli = async (...argv) => {
        const lines = [];
        const code = await main(argv, { exec: host.exec, out: (line) => lines.push(line), env: {}, selfPath: SELF });
        return { code, out: lines.join('\n') };
    };
    return { host, cli, provision };
}

runTests([
    test('dry run gives a names-only plan and changes nothing', async () => {
        const { host, cli, provision } = setup();
        const before = host.read('/etc/openvibe/host.json');
        const result = await cli('service', 'add', 'bot', '--dry-run');
        assert.strictEqual(result.code, 0, result.out);
        assert.match(result.out, /clone .*OpenVibe\.Bot\.git/);
        assert.match(result.out, /data provision bot/);
        assert.strictEqual(host.read('/etc/openvibe/host.json'), before);
        assert.strictEqual(host.read('/etc/openvibe/bot.env'), null);
        assert.deepStrictEqual(provision, []);
        assert.doesNotMatch(result.out, /development|example\.invalid|sk_live_/);
    }),
    test('adds inventory, checkout, production env and data with no values in output', async () => {
        const { host, cli, provision } = setup();
        const result = await cli('service', 'add', 'bot', '--json');
        assert.strictEqual(result.code, 0, result.out);
        assert.doesNotMatch(result.out, /NODE_ENV=production|127\.0\.0\.1|4630|https:\/\/openvibe\.bot|sk_live_/);
        const live = JSON.parse(host.read('/etc/openvibe/host.json'));
        assert.ok(live.services.bot);
        assert.ok(!Object.hasOwn(live.services.bot, '_note'));
        const backup = JSON.parse(result.out).backup;
        assert.ok(host.read(backup));
        assert.strictEqual((await host.exec.stat(backup)).mode, 0o640);
        assert.strictEqual((await host.exec.stat('/etc/openvibe/host.json')).mode, 0o640);
        assert.strictEqual((await host.exec.stat('/etc/openvibe/bot.env')).mode, 0o600);
        assert.strictEqual((await host.exec.stat('/opt/openvibe.bot')).owner, 'ubuntu');
        const env = host.read('/etc/openvibe/bot.env');
        assert.match(env, /^NODE_ENV=production$/m);
        assert.match(env, /^HOST=127\.0\.0\.1$/m);
        assert.match(env, /^PORT=4630$/m);
        assert.match(env, /^BASE_URL=https:\/\/openvibe\.bot$/m);
        assert.match(env, new RegExp(SECRET));
        assert.deepStrictEqual(provision.map((r) => r.args), [['bot']]);
        assert.strictEqual(provision[0].opts.privileged, true);
        assert.ok(host.calls.some((c) => c.cmd === 'git' && c.args[0] === 'clone' && c.as === 'ubuntu'));
        const r = JSON.parse(result.out);
        assert.deepStrictEqual(r.unset, ['OV_OAUTH_CLIENT_SECRET']);
        const step = r.remaining.join('\n');
        assert.ok(step.includes('sudo systemd-run'), step);
        assert.ok(step.includes('-p EnvironmentFile=/etc/openvibe/network.env'), step);
        assert.ok(step.includes('-p WorkingDirectory=/opt/openvibe.network'), step);
        assert.ok(step.includes("service-principal.js list | grep -Eq '^bot[[:space:]]'"), step);
        assert.ok(step.includes('then verb=rotate; else verb=create; fi'), step);
        assert.ok(step.includes('"$verb" bot --env-file /etc/openvibe/bot.env'), step);
        assert.match(r.remaining.join('\n'), /ovhost validate bot; ovhost deploy bot --restart/);
        const repeat = await cli('service', 'add', 'bot');
        assert.strictEqual(repeat.code, 1);
        assert.match(repeat.out, /already exists/);
    }),
    test('text output names what is still empty and the remaining steps, never values', async () => {
        const { cli } = setup();
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 0, result.out);
        assert.match(result.out, /^still empty in \/etc\/openvibe\/bot\.env: OV_OAUTH_CLIENT_SECRET$/m);
        assert.ok(result.out.includes('sudo systemd-run'), result.out);
        assert.ok(result.out.includes('-p EnvironmentFile=/etc/openvibe/network.env'), result.out);
        assert.ok(result.out.includes('-p WorkingDirectory=/opt/openvibe.network'), result.out);
        assert.ok(result.out.includes("service-principal.js list | grep -Eq '^bot[[:space:]]'"), result.out);
        assert.ok(result.out.includes('then verb=rotate; else verb=create; fi'), result.out);
        assert.ok(result.out.includes('"$verb" bot --env-file /etc/openvibe/bot.env'), result.out);
        assert.match(result.out, /^then: ovhost validate bot; ovhost deploy bot --restart$/m);
        assert.doesNotMatch(result.out, new RegExp(`NODE_ENV=production|127\\.0\\.0\\.1|4630|https://openvibe\\.bot|${SECRET}`));
    }),
    test("the principal step uses the inventory's Network checkout and env file", async () => {
        const { host, cli } = setup();
        const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
        doc.services.network = { repo: '/srv/net', owner: 'ubuntu', units: [], envFile: '/etc/openvibe/net-prod.env', port: 4000, lifecycle: lifecycleDoc() };
        host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 0, result.out);
        assert.ok(result.out.includes('-p EnvironmentFile=/etc/openvibe/net-prod.env'), result.out);
        assert.ok(result.out.includes('-p WorkingDirectory=/srv/net'), result.out);
        assert.doesNotMatch(result.out, new RegExp(SECRET));
    }),
    test('refuses an occupied checkout before changing the inventory', async () => {
        const { host, cli } = setup();
        host.put('/opt/openvibe.bot/keep.txt', 'keep');
        const before = host.read('/etc/openvibe/host.json');
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 1);
        assert.strictEqual(host.read('/etc/openvibe/host.json'), before);
        assert.strictEqual(host.read('/opt/openvibe.bot/keep.txt'), 'keep');
    }),
    test('a wiki-like service without a public URL adds successfully and omits BASE_URL', async () => {
        const { host, cli, provision } = setup();
        const example = JSON.parse(host.read('/opt/ovhost-install/host.example.json'));
        example.services.wiki = {
            repo: '/opt/openvibe.wiki', owner: 'ubuntu', units: [],
            envFile: '/etc/openvibe/wiki.env', env: { required: 'from-example' }, port: 4800,
            lifecycle: lifecycleDoc(),
        };
        host.put('/opt/ovhost-install/host.example.json', JSON.stringify(example));
        host.remoteRepos.set('https://github.com/OpenVibers/OpenVibe.Wiki.git', {
            '.env.example': 'NODE_ENV=development\nHOST=0.0.0.0\nPORT=3000\nSITE_TITLE=Wiki\n',
        });
        const result = await cli('service', 'add', 'wiki', '--json');
        assert.strictEqual(result.code, 0, result.out);
        assert.deepStrictEqual(JSON.parse(result.out).envNames, ['NODE_ENV', 'HOST', 'PORT']);
        assert.doesNotMatch(host.read('/etc/openvibe/wiki.env'), /^BASE_URL=/m);
        assert.ok(JSON.parse(host.read('/etc/openvibe/host.json')).services.wiki);
        assert.deepStrictEqual(provision, []);
    }),
    test('an unresolved optional BASE_URL remains empty and is listed for setup', async () => {
        const { host, cli } = setup();
        const example = JSON.parse(host.read('/opt/ovhost-install/host.example.json'));
        delete example.services.bot.nginx;
        host.put('/opt/ovhost-install/host.example.json', JSON.stringify(example));
        host.remoteRepos.set(URL, { '.env.example': 'NODE_ENV=development\nBASE_URL=\n' });
        const result = await cli('service', 'add', 'bot', '--json');
        assert.strictEqual(result.code, 0, result.out);
        assert.ok(JSON.parse(result.out).unset.includes('BASE_URL'));
        assert.match(host.read('/etc/openvibe/bot.env'), /^BASE_URL=$/m);
    }),
    test('an explicitly required URL without an inventory origin is refused before changes', async () => {
        const { host, cli } = setup();
        const example = JSON.parse(host.read('/opt/ovhost-install/host.example.json'));
        delete example.services.bot.nginx;
        example.services.bot.env.required = ['BASE_URL'];
        host.put('/opt/ovhost-install/host.example.json', JSON.stringify(example));
        const before = host.read('/etc/openvibe/host.json');
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 1);
        assert.match(result.out, /requires BASE_URL/);
        assert.strictEqual(host.read('/etc/openvibe/host.json'), before);
        assert.strictEqual(host.read('/opt/openvibe.bot/.env.example'), null);
    }),
    test('reports an incomplete setup and its backup when provisioning fails', async () => {
        const { host, cli } = setup();
        const run = host.exec.run;
        host.exec.run = async (cmd, args, opts) => cmd.endsWith('/roles/data/add-service.sh')
            ? { code: 2, stdout: `DATABASE_URL=${SECRET}`, stderr: `password=${SECRET}` }
            : run(cmd, args, opts);
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 2);
        assert.match(result.out, /setup is incomplete; inventory backup:/);
        assert.doesNotMatch(result.out, new RegExp(SECRET));
        assert.ok(JSON.parse(host.read('/etc/openvibe/host.json')).services.bot);
    }),
    test('a symlinked .env.example is refused and its target never reaches the env file', async () => {
        const { host, cli } = setup();
        host.put('/etc/openvibe/network.env', `OV_SECRET=${SECRET}\n`, { mode: 0o600 });
        const run = host.exec.run;
        host.exec.run = async (cmd, args, opts) => {
            const r = await run(cmd, args, opts);
            if (cmd === 'git' && args[0] === 'clone') {
                await host.exec.removeFile('/opt/openvibe.bot/.env.example');
                await host.exec.symlink('/etc/openvibe/network.env', '/opt/openvibe.bot/.env.example');
            }
            return r;
        };
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 2, result.out);
        assert.match(result.out, /must be a regular file/);
        assert.strictEqual(host.read('/etc/openvibe/bot.env'), null);
        assert.doesNotMatch(result.out, new RegExp(SECRET));
    }),
    test('reads .env.example as the checkout owner', async () => {
        const { host, cli } = setup();
        const result = await cli('service', 'add', 'bot');
        assert.strictEqual(result.code, 0, result.out);
        assert.ok(host.calls.some((c) => c.cmd === 'cat' && c.args.at(-1) === '/opt/openvibe.bot/.env.example' && c.as === 'ubuntu'));
        assert.ok(!host.reads.includes('/opt/openvibe.bot/.env.example'));
    }),
    test('a held inventory lock refuses the add and leaves the inventory alone; success releases it', async () => {
        const { host, cli } = setup();
        const lockFile = '/var/lib/openvibe-host/locks/_inventory.lock';
        host.put(lockFile, JSON.stringify({ pid: 4242, at: 'earlier' }));
        host.alivePids.add(4242);
        const before = host.read('/etc/openvibe/host.json');
        const held = await cli('service', 'add', 'bot');
        assert.strictEqual(held.code, 1, held.out);
        assert.match(held.out, /another ovhost operation on _inventory is running/);
        assert.strictEqual(host.read('/etc/openvibe/host.json'), before);
        assert.ok(!host.calls.some((c) => c.cmd === 'git' && c.args[0] === 'clone'));
        host.alivePids.delete(4242);
        const ok = await cli('service', 'add', 'bot');
        assert.strictEqual(ok.code, 0, ok.out);
        assert.strictEqual(host.read(lockFile), null);
    }),
]);
