'use strict';
/**
 * The real executor, exercised only where that is safe on any machine: the SQLite worker against a
 * temp database, HTTP against a local server, files in a temp directory, and run() as the current
 * user. No systemctl/git/npm/nginx command is run.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createSystemExecutor } = require('../lib/executor');
const { test, runTests } = require('./helpers');

const exec = createSystemExecutor();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovhost-exec-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

runTests([
    test('sqlite: read-only count as the current user; writes are refused', async () => {
        const dbPath = path.join(dir, 'media.db');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE vods (id INTEGER PRIMARY KEY, is_recording INTEGER); INSERT INTO vods (is_recording) VALUES (1), (0), (1);');
        const me = await exec.userName();
        const rows = await exec.sqlite(dbPath, 'SELECT count(*) AS n FROM vods WHERE is_recording = 1', { as: me });
        assert.deepStrictEqual(rows, [{ n: 2 }]);
        await assert.rejects(exec.sqlite(dbPath, 'DELETE FROM vods', { as: me }), /read-only|readonly/);
        assert.strictEqual(db.prepare('SELECT count(*) AS n FROM vods').get().n, 3);
        await assert.rejects(exec.sqlite(path.join(dir, 'missing.db'), 'SELECT 1'), /cannot open/);
        db.close();
    }),

    test('sqlite backup: consistent copy that passes quick_check; never overwrites', async () => {
        const src = path.join(dir, 'src.db');
        const db = new Database(src);
        db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);');
        const dest = path.join(dir, 'backup.db');
        await exec.sqliteBackup(src, dest);
        const copy = new Database(dest, { readonly: true });
        assert.strictEqual(copy.prepare('SELECT count(*) AS n FROM t').get().n, 2);
        copy.close();
        await assert.rejects(exec.sqliteBackup(src, dest), /refusing to overwrite/);
        db.close();
    }),

    test('sqlite backup of a WAL database: one 0600 file in rollback-journal mode, no -wal/-shm left', async () => {
        const src = path.join(dir, 'wal-src.db');
        const db = new Database(src);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3);');
        const out = fs.mkdtempSync(path.join(dir, 'bk-'));
        const dest = path.join(out, 'wal.db');
        await exec.sqliteBackup(src, dest);
        db.close();
        assert.deepStrictEqual(fs.readdirSync(out), ['wal.db']);
        assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600);
        const copy = new Database(dest, { readonly: true });
        assert.strictEqual(copy.pragma('journal_mode', { simple: true }), 'delete');
        assert.strictEqual(copy.prepare('SELECT count(*) AS n FROM t').get().n, 3);
        copy.close();
        assert.deepStrictEqual(fs.readdirSync(out), ['wal.db'], 'reading the copy leaves no side files');
    }),

    test('drill primitives: integrity_check through the worker, kill() signals exactly one pid', async () => {
        const dbPath = path.join(dir, 'restored.db');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE pastes (id INTEGER PRIMARY KEY); INSERT INTO pastes DEFAULT VALUES;');
        db.close();
        const me = await exec.userName();
        assert.deepStrictEqual(await exec.sqlite(dbPath, 'PRAGMA integrity_check', { as: me }), [{ integrity_check: 'ok' }]);
        assert.deepStrictEqual(await exec.sqlite(dbPath, 'SELECT count(*) AS n FROM "pastes"', { as: me }), [{ n: 1 }]);

        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        const exited = new Promise((r) => child.on('exit', (code, signal) => r(signal)));
        assert.strictEqual(await exec.pidAlive(child.pid), true);
        assert.strictEqual(await exec.kill(child.pid, 'SIGTERM'), true);
        assert.strictEqual(await exited, 'SIGTERM');
        assert.strictEqual(await exec.kill(child.pid, 'SIGTERM'), false, 'a pid that is gone');
        await assert.rejects(exec.kill(1, 'SIGTERM'), /refusing/);
        await assert.rejects(exec.kill(0, 'SIGTERM'), /refusing/);
    }),

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
]);
