'use strict';
/**
 * ovhost backup <service>: an online SQLite `.backup` of every database the inventory declares for
 * the service, into <backupDir>/<service>/<YYYYMMDD-HHMMSS>/<name>.db. The copy is made by a worker
 * running as the service user (root never opens a service database — see sqlite-worker.js), checked
 * with PRAGMA quick_check, and recorded in <stateDir>/backups/<service>.jsonl.
 *
 * Backups are consistent snapshots taken while the service runs; they are not a restore drill
 * (that is Wave 22's job) and nothing here prunes old backups.
 */
const path = require('path');
const { service } = require('../inventory');

function stamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d+Z$/, '');
}

async function backup(ctx, id, { reason = 'manual' } = {}) {
    const { exec, inv, log } = ctx;
    const svc = service(inv, id);
    if (!svc.databases.length) throw new Error(`${id} declares no databases`);
    const dir = path.join(inv.backupDir, id, stamp(exec.now()));
    // The worker writes as the service user, so the base must be traversable and the service's
    // directory its own.
    await exec.mkdir(inv.backupDir, { mode: 0o755 });
    await exec.mkdir(path.join(inv.backupDir, id), { owner: svc.runAs, mode: 0o750 });
    await exec.mkdir(dir, { owner: svc.runAs, mode: 0o750 });
    const files = [];
    for (const db of svc.databases) {
        if (!(await exec.stat(db.path))) { files.push({ name: db.name, source: db.path, skipped: 'not found' }); log(`skip ${db.path}: not found`); continue; }
        // Named by the inventory name: two databases may share a file name (community.db twice).
        const dest = path.join(dir, `${db.name}${path.extname(db.path) || '.db'}`);
        log(`backing up ${db.path} → ${dest} (as ${svc.runAs})`);
        const t0 = exec.now();
        await exec.sqliteBackup(db.path, dest, { as: svc.runAs });
        const st = await exec.stat(dest);
        files.push({ name: db.name, source: db.path, dest, bytes: st ? st.size : null, seconds: Math.round((exec.now() - t0) / 1000) });
    }
    const record = { service: id, at: new Date(exec.now()).toISOString(), reason, dir, files };
    await exec.appendFile(path.join(inv.stateDir, 'backups', `${id}.jsonl`), `${JSON.stringify(record)}\n`);
    return record;
}

module.exports = { backup, stamp };
