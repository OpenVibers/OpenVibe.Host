'use strict';
/**
 * The real executor, exercised with HTTP, files in a temp directory, and run() as the current user. No systemctl/git/npm/nginx command is run.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSystemExecutor, asUserArgv } = require('../lib/executor');
const { test, runTests } = require('./helpers');

const exec = createSystemExecutor();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovhost-exec-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

runTests([
    test('http, files, locks and run() behave as the fake host assumes', async () => {
        const server = http.createServer((req, res) => { res.writeHead(req.url === '/ok' ? 200 : 503); res.end(JSON.stringify({ host: req.headers.host })); });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const ok = await exec.http(`${base}/ok`, { headers: { Host: 'openvibe.tools' } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(JSON.parse(ok.body).host, 'openvibe.tools');
        assert.strictEqual((await exec.http(`${base}/no`)).status, 503);
        server.close();
        const refused = await exec.http('http://127.0.0.1:1/');
        assert.strictEqual(refused.status, 0);

        const f = path.join(dir, 'a', 'lock');
        assert.strictEqual(await exec.createExclusive(f, '1'), true);
        assert.strictEqual(await exec.createExclusive(f, '2'), false);
        assert.strictEqual(await exec.readFile(f), '1');
        assert.strictEqual(await exec.readFile(path.join(dir, 'nope')), null);
        const st = await exec.stat(f);
        assert.strictEqual(st.isFile, true);
        assert.strictEqual(st.mode & 0o777, 0o640);

        const r = await exec.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'hi'], { as: await exec.userName() });
        assert.deepStrictEqual([r.code, r.stdout], [0, 'hi']);
    }),

    test('root runs a command as another user through setpriv (no PAM session), runuser only without a passwd entry', async () => {
        const pw = { name: 'ubuntu', uid: 1000, gid: 1000, home: '/home/ubuntu' };
        assert.deepStrictEqual(asUserArgv('ubuntu', pw, 'git', ['-C', '/opt/x', 'fetch'], { path: '/usr/bin:/bin', setpriv: '/usr/bin/setpriv', runuser: '/usr/sbin/runuser' }),
            ['/usr/bin/setpriv', ['--reuid=1000', '--regid=1000', '--init-groups', '--', 'env', 'HOME=/home/ubuntu', 'USER=ubuntu', 'LOGNAME=ubuntu', 'PATH=/usr/bin:/bin', 'git', '-C', '/opt/x', 'fetch']]);
        assert.deepStrictEqual(asUserArgv('ghost', null, 'git', ['status'], { path: '/usr/bin', setpriv: '/usr/bin/setpriv', runuser: '/usr/sbin/runuser' }),
            ['/usr/sbin/runuser', ['-u', 'ghost', '--', 'env', 'HOME=/home/ghost', 'PATH=/usr/bin', 'git', 'status']]);
        assert.deepStrictEqual(asUserArgv('ubuntu', pw, 'git', [], { path: '/usr/bin', setpriv: null, runuser: '/usr/sbin/runuser' })[0], '/usr/sbin/runuser', 'no setpriv: runuser');
    }),

    test('the backup unit can find runuser: /usr/sbin is on its PATH (the 2026-09-24/25 nightly backups failed without it)', async () => {
        const unit = require('fs').readFileSync(path.join(__dirname, '..', 'deploy', 'systemd', 'openvibe-backup.service'), 'utf8');
        const m = /^Environment=PATH=(.+)$/m.exec(unit);
        assert.ok(m, 'the unit sets PATH');
        assert.ok(m[1].split(':').includes('/usr/sbin'), m[1]);
        assert.match(require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'executor.js'), 'utf8'), /\/usr\/sbin\/runuser/, 'and the executor resolves runuser by absolute path');
    }),
]);
