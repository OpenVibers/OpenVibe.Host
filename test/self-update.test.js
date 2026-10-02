'use strict';
/**
 * `ovhost self-update [--dry-run]`: update the CLI install itself, driven against the fake host.
 * Nothing here touches the real machine: the install is a fake repo at /usr/local/lib/openvibe-host
 * and every git/npm call is recorded in host.calls, so the tests assert exactly what would run.
 */
const assert = require('assert');
const path = require('path');
const { scenario, test, runTests } = require('./helpers');
const { main } = require('../lib/cli');
const { NPM_CI } = require('../lib/commands/self-update');

const DIR = '/usr/local/lib/openvibe-host';
const SELF = `${DIR}/bin/ovhost`;

function cli(host, ...argv) {
    const lines = [];
    return main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {}, selfPath: SELF })
        .then((code) => ({ code, out: lines.join('\n') }));
}

function installRepo(host, { branch = 'main' } = {}) {
    const repo = host.createRepo(DIR, { owner: 'root', branch });
    const sha = repo.commit({
        'package.json': JSON.stringify({ name: 'openvibe-host', version: '0.3.0', dependencies: { express: '^4.21.2' } }),
        'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
        'bin/ovhost': '#!/usr/bin/env node\n',
        'lib/cli.js': 'old();\n',
    }, { message: 'installed' });
    repo.publish(sha);
    repo.checkout(sha);
    return { repo, sha };
}

const gitCalls = (host) => host.calls.filter((c) => c.cmd === 'git');
const npmCalls = (host) => host.calls.filter((c) => c.cmd === 'npm');

runTests([
    test('self-update fetches, fast-forwards and runs npm ci in its own install dir', async () => {
        const host = scenario();
        const { repo, sha } = installRepo(host);
        const next = repo.commit({ 'lib/cli.js': 'new();\n', 'lib/self-update.js': 'x();\n' }, { message: 'env-names --set, logs, Bot vhost' });
        repo.publish(next);

        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /ovhost [0-9a-f]{12} → [0-9a-f]{12} \(1 commit\)/);
        assert.strictEqual(repo.head, next);
        assert.ok(gitCalls(host).some((c) => c.args.includes('fetch')), 'fetches origin');
        assert.ok(gitCalls(host).some((c) => c.args.includes('merge') && c.args.includes('--ff-only') && c.args.includes(next)), 'merges --ff-only the fetched sha');
        const npm = npmCalls(host);
        assert.strictEqual(npm.length, 1, 'one npm call');
        assert.deepStrictEqual(npm[0].args, NPM_CI);
        assert.strictEqual(npm[0].cwd, DIR);
        assert.strictEqual(npm[0].as, 'root');
        // The fake npm rewrites package-lock.json; self-update puts the merged one back.
        assert.strictEqual(host.read(path.join(DIR, 'package-lock.json')), '{"lockfileVersion":3,"packages":{}}');
        // A CLI update never touches a unit.
        assert.deepStrictEqual(host.calls.filter((c) => c.cmd === 'systemctl'), []);
    }),

    test('up to date: nothing is merged and nothing is installed', async () => {
        const host = scenario();
        installRepo(host);
        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /ovhost [0-9a-f]{12} is up to date \(origin\/main\)/);
        assert.deepStrictEqual(gitCalls(host).filter((c) => c.args.includes('merge')), []);
        assert.deepStrictEqual(npmCalls(host), []);
    }),

    test('--dry-run prints the plan and changes nothing', async () => {
        const host = scenario();
        const { repo, sha } = installRepo(host);
        const next = repo.commit({ 'lib/cli.js': 'new();\n' }, { message: 'change' });
        repo.publish(next);

        const r = await cli(host, 'self-update', '--dry-run');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /\(1 commit\) \(dry run: nothing changed\)/);
        assert.match(r.out, /would: git fetch origin main; git merge --ff-only origin\/main; npm ci --omit=dev --no-audit --no-fund in /);
        assert.strictEqual(repo.head, sha, 'HEAD is untouched');
        assert.deepStrictEqual(gitCalls(host).filter((c) => c.args.includes('merge')), []);
        assert.deepStrictEqual(npmCalls(host), []);
    }),

    test('a dirty tree is refused before anything is fetched', async () => {
        const host = scenario();
        const { repo, sha } = installRepo(host);
        host.put(path.join(DIR, 'lib/cli.js'), 'hand-edited();\n');
        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /has local changes \(lib\/cli\.js\)/);
        assert.deepStrictEqual(gitCalls(host).filter((c) => c.args.includes('fetch')), []);
        assert.strictEqual(repo.head, sha);
    }),

    test('a branch other than main is refused', async () => {
        const host = scenario();
        installRepo(host, { branch: 'release' });
        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /on branch "release", not "main"/);
    }),

    test('a divergence (not a fast-forward) is refused and nothing is merged', async () => {
        const host = scenario();
        const { repo, sha } = installRepo(host);
        const local = repo.commit({ 'lib/cli.js': 'local();\n' }, { message: 'hand edit' });
        repo.checkout(local);
        const remote = repo.commit({ 'lib/cli.js': 'remote();\n' }, { parent: sha, message: 'upstream' });
        repo.publish(remote);

        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /diverged from origin\/main .* not a fast-forward/);
        assert.strictEqual(repo.head, local);
        assert.deepStrictEqual(gitCalls(host).filter((c) => c.args.includes('merge')), []);
        assert.deepStrictEqual(npmCalls(host), []);
    }),

    test('a failed npm ci exits 2 and says the checkout is at the new sha', async () => {
        const host = scenario();
        const { repo } = installRepo(host);
        const next = repo.commit({ 'lib/cli.js': 'new();\n' }, { message: 'change' });
        repo.publish(next);
        host.npm = () => ({ code: 1, stderr: 'npm ERR! network timeout\n' });

        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /npm ci --omit=dev --no-audit --no-fund" failed \(exit 1\)/);
        assert.match(r.out, /re-run it there by hand/);
        assert.strictEqual(repo.head, next, 'the checkout did move; only dependencies are missing');
    }),

    test('not root: refused before any git or npm call', async () => {
        const host = scenario();
        installRepo(host);
        host.exec.isRoot = async () => false;
        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /must run as root \(sudo ovhost self-update\)/);
        assert.deepStrictEqual(gitCalls(host), []);
        assert.deepStrictEqual(npmCalls(host), []);
    }),

    test('a real path that is not <install>/bin/ovhost is refused', async () => {
        const host = scenario();
        installRepo(host);
        const code = await main(['self-update'], { exec: host.exec, out: () => {}, env: {}, selfPath: '/usr/local/bin/ovhost' });
        assert.strictEqual(code, 1);
        assert.deepStrictEqual(npmCalls(host), []);
    }),

    test('an install dir that is not a git checkout is refused', async () => {
        const host = scenario();
        host.ensureDir(`${DIR}/bin`, 'root');
        host.put(SELF, '#!/usr/bin/env node\n', { owner: 'root', mode: 0o755 });
        const r = await cli(host, 'self-update');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /is not a git checkout/);
    }),

    test('--json reports the shas, the commit count and what npm was run', async () => {
        const host = scenario();
        const { repo, sha } = installRepo(host);
        const mid = repo.commit({ 'a.js': 'a();\n' }, { message: 'one' });
        const next = repo.commit({ 'b.js': 'b();\n' }, { parent: mid, message: 'two' });
        repo.publish(next);

        const r = await cli(host, 'self-update', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const doc = JSON.parse(r.out);
        assert.strictEqual(doc.installDir, DIR);
        assert.strictEqual(doc.oldSha, sha);
        assert.strictEqual(doc.newSha, next);
        assert.strictEqual(doc.commits, 2);
        assert.strictEqual(doc.updated, true);
        assert.strictEqual(doc.lockfileRestored, true);
        assert.deepStrictEqual(doc.npm, { code: 0 });
    }),
]);
