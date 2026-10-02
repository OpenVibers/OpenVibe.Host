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
        assert.doesNotMatch(result.out, /production|127\.0\.0\.1|4630|https:\/\/openvibe\.bot|sk_live_/);
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
        assert.match(r.remaining.join('\n'), /service-principal\.js create bot --env-file \/etc\/openvibe\/bot\.env/);
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
        assert.match(result.out, /node server\/setup\/service-principal\.js create bot --env-file \/etc\/openvibe\/bot\.env/);
        assert.match(result.out, /^then: ovhost validate bot; ovhost deploy bot --restart$/m);
        assert.doesNotMatch(result.out, new RegExp(`production|127\\.0\\.0\\.1|4630|https://openvibe\\.bot|${SECRET}`));
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
]);
