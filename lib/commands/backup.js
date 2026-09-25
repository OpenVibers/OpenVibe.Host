'use strict';
/**
 * ovhost backup <service>: an online SQLite `.backup` of every database the inventory declares for
 * the service, into <backupDir>/<service>/<YYYYMMDD-HHMMSS>/<name>.db. The copy is made by a worker
 * running as the service user (root never opens a service database — see sqlite-worker.js), checked
 * with PRAGMA quick_check, and recorded in <stateDir>/backups/<service>.jsonl.
 *
 * Permissions: every directory under backupDir is root:root 0700 and every copy root:root 0600,
 * with no -wal/-shm beside it. The worker writes into <backupStagingDir>/<service>-<stamp> (its own,
 * 0700, under a root 0711 parent); root then takes that directory over, checks each copy is a plain
 * file with one link, chowns and chmods it, and renames the directory into place.
 *
 * Every declared database is attempted even when an earlier one fails. A backup with any failed
 * database is still recorded (ok: false, so a drill and retention never treat it as good) and then
 * throws a BackupError carrying the record. A backup that found none of its databases is recorded
 * as ok: false, empty: true and leaves no directory behind.
 *
 * ovhost backup --all (backupAll): every service that declares databases, one after another. A
 * failing service never stops the others. Afterwards each service's backups are pruned to the last
 * 7 daily and 4 weekly good ones (lib/retention.js), and a JSON summary of the run is written to
 * <stateDir>/backup-runs/<run>.json. With --offsite the run is then uploaded (lib/offsite.js).
 */
const path = require('path');
const { service } = require('../inventory');
const lock = require('../lock');
const retention = require('../retention');

class BackupError extends Error {
    constructor(message, record) { super(message); this.record = record; }
}

function stamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d+Z$/, '');
}

/** chown root:root + chmod, through the executor (root, or sudo -n). */
async function lockDown(exec, p, mode) {
    for (const [cmd, args] of [['chown', ['root:root', '--', p]], ['chmod', [mode.toString(8).padStart(4, '0'), '--', p]]]) {
        const r = await exec.run(cmd, args, { privileged: true });
        if (r.code !== 0) throw new Error(`${cmd} ${p} failed: ${r.stderr.trim()}`);
    }
}

/** A directory that is root:root 0700, whatever it was before (older backups were 0750, service-owned). */
async function privateDir(exec, p) {
    await exec.mkdir(p, { owner: 'root', mode: 0o700 });
    await lockDown(exec, p, 0o700);
}

async function backup(ctx, id, { reason = 'manual' } = {}) {
    const { exec, inv, log } = ctx;
    const svc = service(inv, id);
    if (!svc.databases.length) throw new Error(`${id} declares no databases`);
    const st = stamp(exec.now());
    const dir = path.join(inv.backupDir, id, st);
    if (await exec.stat(dir)) throw new Error(`${dir} already exists; a backup never overwrites another`);
    // Backups hold user data: every directory under backupDir is root:root 0700 and every copy is
    // root:root 0600. The worker must run as the service user (root never opens a service database),
    // so it writes into a staging directory of its own, which root then takes over before the move.
    await privateDir(exec, inv.backupDir);
    await privateDir(exec, path.join(inv.backupDir, id));
    await exec.mkdir(inv.backupStagingDir, { owner: 'root', mode: 0o711 });
    await lockDown(exec, inv.backupStagingDir, 0o711);
    const stage = path.join(inv.backupStagingDir, `${id}-${st}`);
    if (await exec.stat(stage)) await exec.run('rm', ['-rf', '--', stage], { privileged: true });
    await exec.mkdir(stage, { owner: svc.runAs, mode: 0o700 });
    const files = [];
    try {
        for (const db of svc.databases) {
            if (!(await exec.stat(db.path))) { files.push({ name: db.name, source: db.path, skipped: 'not found' }); log(`skip ${db.path}: not found`); continue; }
            // Named by the inventory name: two databases may share a file name (community.db twice).
            const file = `${db.name}${path.extname(db.path) || '.db'}`;
            log(`backing up ${db.path} → ${path.join(dir, file)} (as ${svc.runAs})`);
            const t0 = exec.now();
            try {
                // The worker runs PRAGMA quick_check on the copy and fails unless it answers ok.
                await exec.sqliteBackup(db.path, path.join(stage, file), { as: svc.runAs });
            } catch (err) {
                files.push({ name: db.name, source: db.path, dest: path.join(dir, file), error: err.message });
                log(`FAILED ${db.path}: ${err.message}`);
                continue;
            }
            files.push({ name: db.name, source: db.path, dest: path.join(dir, file), file, check: 'quick_check ok', seconds: Math.round((exec.now() - t0) / 1000) });
        }
        // Take the staging directory back first: after this the service user can no longer reach
        // anything inside it, so what is checked below cannot change underneath.
        await lockDown(exec, stage, 0o700);
        for (const f of files.filter((x) => x.file && !x.error)) {
            const p = path.join(stage, f.file);
            const fst = await exec.stat(p);
            // A link would let the move below hand root's ownership to some other file.
            if (!fst || !fst.isFile || fst.isSymlink || fst.nlink !== 1) { f.error = 'the copy is not a plain file'; continue; }
            await lockDown(exec, p, 0o600);
            f.bytes = fst.size;
        }
        // Anything else (a stray -wal/-shm) is not part of the backup.
        const wanted = new Set(files.filter((x) => x.file && !x.error).map((x) => x.file));
        for (const e of (await exec.readdir(stage)) || []) {
            if (!wanted.has(e.name)) await exec.run('rm', ['-rf', '--', path.join(stage, e.name)], { privileged: true });
        }
        if (wanted.size) {
            const mv = await exec.run('mv', ['-T', '--', stage, dir], { privileged: true });
            if (mv.code !== 0) throw new Error(`moving ${stage} to ${dir} failed: ${mv.stderr.trim()}`);
            await lockDown(exec, dir, 0o700);
        }
    } finally {
        if (await exec.stat(stage)) await exec.run('rm', ['-rf', '--', stage], { privileged: true });
    }
    for (const f of files) delete f.file;
    const failed = files.filter((f) => f.error);
    const copied = files.filter((f) => f.dest && !f.error);
    const record = { service: id, at: new Date(exec.now()).toISOString(), reason, dir, ok: !failed.length && copied.length > 0, files };
    // Nothing existed to back up (a service not deployed yet): no directory is left, so an empty
    // backup can never stand in for a real one in retention or a drill.
    if (!copied.length && !failed.length) record.empty = true;
    await exec.appendFile(path.join(inv.stateDir, 'backups', `${id}.jsonl`), `${JSON.stringify(record)}\n`);
    if (failed.length) throw new BackupError(failed.map((f) => `${f.name}: ${f.error}`).join('; '), record);
    return record;
}

async function records(exec, inv, id) {
    const text = await exec.readFile(path.join(inv.stateDir, 'backups', `${id}.jsonl`));
    return String(text || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.dir);
}

/**
 * Prune <backupDir>/<id>/<stamp> directories. Only directories named by a stamp and recorded in the
 * service's backup log are candidates; anything else in the directory is left alone. A directory is
 * good when any record for it has ok !== false (records before ok existed count as good).
 *   good      kept by the retention policy, else removed
 *   not good  (a failed backup) removed once a newer good backup exists
 * Nothing is removed while the service has no good backup at all.
 */
async function prune(ctx, id, { daily = 7, weekly = 4 } = {}) {
    const { exec, inv, log } = ctx;
    const base = path.join(inv.backupDir, id);
    const entries = (await exec.readdir(base)) || [];
    const recs = await records(exec, inv, id);
    const recorded = new Map();
    for (const r of recs) {
        if (path.dirname(path.normalize(r.dir)) !== base) continue;
        const name = path.basename(r.dir);
        recorded.set(name, (recorded.get(name) || false) || r.ok !== false);
    }
    const dirs = entries.filter((e) => e.isDir && retention.STAMP_RE.test(e.name)).map((e) => e.name);
    const good = dirs.filter((d) => recorded.get(d) === true);
    const unrecorded = dirs.filter((d) => !recorded.has(d));
    if (!good.length) return { kept: dirs, removed: [], unrecorded };
    const keepSet = retention.keep(good, { daily, weekly });
    const newestGood = good.slice().sort().pop();
    const remove = dirs.filter((d) => recorded.has(d) && (recorded.get(d) ? !keepSet.has(d) : d < newestGood));
    for (const d of remove) {
        const full = path.join(base, d);
        // Belt and braces: exactly <backupDir>/<id>/<stamp>, nothing else.
        if (path.dirname(full) !== base || !retention.STAMP_RE.test(path.basename(full))) continue;
        const r = await exec.run('rm', ['-rf', '--', full], { privileged: true });
        if (r.code !== 0) throw new Error(`could not remove ${full}: ${r.stderr.trim()}`);
        log(`pruned ${full}`);
    }
    return { kept: dirs.filter((d) => !remove.includes(d)), removed: remove, unrecorded };
}

async function backupAll(ctx, { daily = 7, weekly = 4, prune: doPrune = true, offsite = null } = {}) {
    const { exec, inv, log } = ctx;
    const held = await lock.acquire(exec, inv, '_backup-all');
    const started = exec.now();
    const run = stamp(started);
    const summary = { run, host: inv.host || null, startedAt: new Date(started).toISOString(), finishedAt: null, ok: true, retention: { daily, weekly }, services: [], offsite: null };
    const file = path.join(inv.stateDir, 'backup-runs', `${run}.json`);
    try {
        for (const svc of Object.values(inv.services)) {
            if (!svc.databases.length) continue;
            const entry = { service: svc.id, status: 'ok', dir: null, files: [], error: null, pruned: [] };
            summary.services.push(entry);
            try {
                const rec = await backup(ctx, svc.id, { reason: `scheduled ${run}` });
                entry.dir = rec.empty ? null : rec.dir;
                entry.files = rec.files;
                if (rec.empty) entry.status = 'skipped';
            } catch (err) {
                entry.status = 'failed';
                entry.error = err.message;
                if (err.record) { entry.dir = err.record.dir; entry.files = err.record.files; }
                log(`✗ ${svc.id}: ${err.message}`);
            }
            if (doPrune) {
                try { entry.pruned = (await prune(ctx, svc.id, { daily, weekly })).removed; } catch (err) {
                    entry.status = 'failed';
                    entry.error = [entry.error, `prune: ${err.message}`].filter(Boolean).join('; ');
                }
            }
        }
        summary.ok = !summary.services.some((s) => s.status === 'failed');
        if (offsite) {
            try {
                summary.offsite = await offsite(summary);
            } catch (err) {
                summary.offsite = { ok: false, error: err.message };
            }
            if (!summary.offsite.ok) summary.ok = false;
        }
    } finally {
        summary.finishedAt = new Date(exec.now()).toISOString();
        await exec.mkdir(path.join(inv.stateDir, 'backup-runs'), { mode: 0o750 });
        await exec.writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o640 });
        await held.release();
        // The metrics never fail a backup (WS-S task 3).
        try { await writeMetrics(ctx, summary); } catch (err) { log(`backup metrics not written: ${err.message}`); }
    }
    summary.file = file;
    return summary;
}

const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';

/**
 * The last backup --all run for Prometheus, through node_exporter's textfile collector (WS-S task 3;
 * alerts OpenVibeBackupFailed and OpenVibeBackupMissed in deploy/prometheus/openvibe-rules.yml):
 *
 *   openvibe_backup_last_run_timestamp_seconds       when the last run finished
 *   openvibe_backup_last_run_ok                      1 when every service (and the off-site copy) succeeded
 *   openvibe_backup_last_success_timestamp_seconds   the last run that succeeded (read back from backup-runs)
 *   openvibe_backup_services{status}                 services ok, failed and skipped in the last run
 *   openvibe_backup_offsite_ok                       1/0 for the last run's off-site copy, when it made one
 *
 * Written only where the collector's directory exists (inventory `textfileDir`, default the Debian
 * package's). A small file written in place: a scrape that caught it half-written would only miss once.
 */
async function writeMetrics(ctx, summary) {
    const { exec, inv } = ctx;
    const dir = inv.textfileDir || TEXTFILE_DIR;
    if (!(await exec.readdir(dir))) return false;
    const at = (iso) => Math.floor(Date.parse(iso) / 1000);
    let lastOk = summary.ok ? summary.finishedAt : null;
    if (!lastOk) {
        const runs = ((await exec.readdir(path.join(inv.stateDir, 'backup-runs'))) || []).map((e) => e.name).filter((n) => n.endsWith('.json')).sort().reverse();
        for (const name of runs) {
            let r = null;
            try { r = JSON.parse((await exec.readFile(path.join(inv.stateDir, 'backup-runs', name))) || 'null'); } catch { r = null; }
            if (r && r.ok && r.finishedAt) { lastOk = r.finishedAt; break; }
        }
    }
    const count = (st) => summary.services.filter((x) => x.status === st).length;
    const lines = [
        '# HELP openvibe_backup_last_run_timestamp_seconds When the last ovhost backup --all run finished.',
        '# TYPE openvibe_backup_last_run_timestamp_seconds gauge',
        `openvibe_backup_last_run_timestamp_seconds ${at(summary.finishedAt)}`,
        '# HELP openvibe_backup_last_run_ok 1 when every service and the off-site copy succeeded in the last run.',
        '# TYPE openvibe_backup_last_run_ok gauge',
        `openvibe_backup_last_run_ok ${summary.ok ? 1 : 0}`,
        '# HELP openvibe_backup_services Services by outcome in the last run.',
        '# TYPE openvibe_backup_services gauge',
        ...['ok', 'failed', 'skipped'].map((st) => `openvibe_backup_services{status="${st}"} ${count(st)}`),
    ];
    if (lastOk) lines.push('# HELP openvibe_backup_last_success_timestamp_seconds When the last fully successful run finished.', '# TYPE openvibe_backup_last_success_timestamp_seconds gauge', `openvibe_backup_last_success_timestamp_seconds ${at(lastOk)}`);
    if (summary.offsite) lines.push('# HELP openvibe_backup_offsite_ok 1 when the last run\'s off-site copy succeeded.', '# TYPE openvibe_backup_offsite_ok gauge', `openvibe_backup_offsite_ok ${summary.offsite.ok ? 1 : 0}`);
    await exec.writeFile(path.join(dir, 'openvibe_backup.prom'), `${lines.join('\n')}\n`, { mode: 0o644 });
    return true;
}

/** The summary of a backup --all run (the latest when run is null). */
async function readRun(exec, inv, run = null) {
    const dir = path.join(inv.stateDir, 'backup-runs');
    let name = run;
    if (!name) {
        const list = ((await exec.readdir(dir)) || []).map((e) => e.name).filter((n) => /^\d{8}-\d{6}\.json$/.test(n)).sort();
        if (!list.length) return null;
        name = list[list.length - 1].replace(/\.json$/, '');
    }
    if (!retention.STAMP_RE.test(name)) throw new Error(`--run must be a run id such as 20260923-033000 (got ${JSON.stringify(name)})`);
    const text = await exec.readFile(path.join(dir, `${name}.json`));
    if (text == null) return null;
    const summary = JSON.parse(text);
    summary.file = path.join(dir, `${name}.json`);
    return summary;
}

async function writeRun(exec, summary) {
    const { file, ...rest } = summary;
    await exec.writeFile(file, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o640 });
}

module.exports = { backup, backupAll, prune, records, readRun, writeRun, writeMetrics, stamp, lockDown, BackupError };
