#!/usr/bin/env node
'use strict';
/**
 * Runs one SQLite operation in its own process so the executor can start it AS THE SERVICE USER
 * (runuser/sudo -u). Root never opens a service's database: a root-owned -wal/-shm file left under
 * /opt would stop the service from writing its own database.
 *
 *   node sqlite-worker.js '{"op":"query","db":"/opt/x/data/x.db","sql":"SELECT count(*) AS n FROM t"}'
 *   node sqlite-worker.js '{"op":"backup","db":"/opt/x/data/x.db","dest":"/var/backups/openvibe/x/…/x.db"}'
 *
 * The source database is always opened read-only (fileMustExist); a query that tries to write fails.
 * Prints one JSON line: { ok: true, rows } | { ok: true, bytes } | { ok: false, error }.
 *
 * Backup copies hold user data, so the worker runs with umask 077 and leaves exactly one file,
 * mode 0600: the copy is switched to journal_mode=DELETE (a WAL source gives a WAL-mode copy), which
 * checkpoints and removes its -wal/-shm, and any side file still present is deleted.
 */
const fs = require('fs');

process.umask(0o077);

function done(obj, code = 0) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    process.exit(code);
}

let req;
try { req = JSON.parse(process.argv[2] || ''); } catch { done({ ok: false, error: 'bad request' }, 2); }

let Database;
try { Database = require('better-sqlite3'); } catch (err) { done({ ok: false, error: `better-sqlite3 unavailable: ${err.message}` }, 2); }

let db;
try {
    db = new Database(req.db, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
} catch (err) {
    done({ ok: false, error: `cannot open ${req.db}: ${err.message}` }, 1);
}

if (req.op === 'query') {
    try {
        const stmt = db.prepare(req.sql);
        if (!stmt.reader) done({ ok: false, error: 'only read-only statements are allowed' }, 1);
        done({ ok: true, rows: stmt.all() });
    } catch (err) {
        done({ ok: false, error: err.message }, 1);
    }
} else if (req.op === 'backup') {
    if (!req.dest) done({ ok: false, error: 'dest required' }, 2);
    if (fs.existsSync(req.dest)) done({ ok: false, error: `refusing to overwrite ${req.dest}` }, 1);
    db.backup(req.dest).then(() => {
        const check = new Database(req.dest);
        check.pragma('journal_mode = DELETE');
        const result = check.pragma('quick_check', { simple: true });
        check.close();
        for (const side of ['-wal', '-shm', '-journal']) fs.rmSync(`${req.dest}${side}`, { force: true });
        fs.chmodSync(req.dest, 0o600);
        if (result !== 'ok') done({ ok: false, error: `backup failed quick_check: ${result}` }, 1);
        done({ ok: true, bytes: fs.statSync(req.dest).size });
    }, (err) => done({ ok: false, error: err.message }, 1));
} else {
    done({ ok: false, error: `unknown op ${req.op}` }, 2);
}
