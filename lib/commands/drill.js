'use strict';
/**
 * ovhost drill <service> [--backup <dir>] [--keep]: a restore drill (roadmap Wave 22). It rebuilds
 * the service from a backup next to production and checks that the rebuilt copy answers like
 * production does:
 *
 *   1. Take the latest `ovhost backup` of the service (or --backup <dir>). Every database the drill
 *      block names is restored, per engine (lib/dbengine.js):
 *        SQLite      copy the file into a fresh directory under <drillDir> owned by the service user
 *                    and run PRAGMA integrity_check on the copy. The result must be `ok`.
 *        PostgreSQL  check free space first, copy the pg_dump -Fc archive into <tmp>/pg owned by
 *                    postgres, verify it with `pg_restore --list`, then create a scratch database and
 *                    a login role `ov_<id>_drill_<stamp>` and `pg_restore --no-owner --role=…` the
 *                    archive into the scratch database. Both are dropped again in a finally.
 *      Every object directory the service declares is also restored: its archive is extracted into
 *      <tmp>/<name> (owned by the service user, never the live directory) and every blob is checked
 *      against the sha256 in its file name.
 *   2. Start a second instance from the production checkout, as the service user, through
 *      systemd-run. It uses the production unit's ExecStart and WorkingDirectory, the production
 *      env file, and a second env file with the drill's overrides: its port, the restored database
 *      paths (or the scratch database's URLs), and the switches that turn side effects off. The
 *      instance runs sandboxed: ProtectSystem=strict with only the drill directory writable, a
 *      private /tmp, binding only its drill port, and no addresses beyond loopback unless the
 *      inventory says otherwise. RuntimeMaxSec stops it even if ovhost dies. Loopback stays open
 *      (the instance needs Network's public keys), so the inventory's overrides are what keep it away
 *      from production services.
 *   3. Wait for its readiness path. Then compare the declared read-only GETs with production, byte
 *      for byte or as JSON without the listed volatile keys, and compare declared row counts
 *      (production against the restored copy, allowing countsTolerance rows).
 *   4. Stop the instance by its own MainPID (never pkill -f), drop the scratch database and role,
 *      remove the drill directory unless --keep, append the result to <stateDir>/drills/<service>.jsonl,
 *      and return a Markdown row for docs/restore-drills.md.
 *
 * ovhost itself writes only inside the drill directory, the lock file and the drill log. It never
 * writes to the checkout, the env file, the database or the backup. It never reads an env value:
 * systemd loads the production env file for the instance, and the override file holds only
 * inventory values. Environment= values from the unit are passed on only if their names do not look
 * secret and the drill does not set them itself (OpenRestream's unit sets DATABASE_URL to production's
 * database: that line never reaches the drill instance).
 *
 * The production env file is loaded FIRST, so any variable the drill does not set keeps its
 * production value. For a PostgreSQL service the drill therefore refuses to start unless the drill
 * block overrides all three of the database URL, the direct database URL and VALKEY_URL: an
 * un-overridden direct URL would migrate production, an un-overridden URL would serve production
 * data, and an un-neutralised Valkey URL would write into production's keyspace (the sandbox still
 * allows loopback).
 */
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { service } = require('../inventory');
const envfile = require('../envfile');
const systemd = require('../systemd');
const lock = require('../lock');
const dbengine = require('../dbengine');
const { stamp } = require('./backup');

class DrillError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

/** Raised inside the run to jump to cleanup once record.failure is set. */
class Abort extends Error {}

const STOP_GRACE_MS = 20000;

// ── helpers ──────────────────────────────────────────────────────────────────

function expand(value, vars) {
    return value.replace(/\{(tmp|port|db:[A-Za-z0-9._-]+)\}/g, (_, k) => {
        if (k === 'tmp') return vars.tmp;
        if (k === 'port') return String(vars.port);
        return vars.db[k.slice(3)];
    });
}

/** A line for a systemd EnvironmentFile. Values are quoted only when they need it. */
function envLine(name, value) {
    if (value === '') return `${name}=`;
    if (/^[A-Za-z0-9_./:,@%+=-]+$/.test(value)) return `${name}=${value}`;
    return `${name}="${value.replace(/["\\$`]/g, '\\$&')}"`;
}

function environmentProperty(name, value) {
    const a = `${name}=${value}`;
    return /[\s"'\\]/.test(a) ? `Environment="${a.replace(/["\\]/g, '\\$&')}"` : `Environment=${a}`;
}

function stripKeys(v, keys) {
    if (Array.isArray(v)) return v.map((x) => stripKeys(x, keys));
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (!keys.includes(k)) out[k] = stripKeys(x, keys);
        return out;
    }
    return v;
}

function diffPaths(a, b, p = '$', out = []) {
    if (out.length >= 5) return out;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) { out.push(`${p}.length ${b.length} ≠ ${a.length}`); return out; }
        a.forEach((x, i) => diffPaths(x, b[i], `${p}[${i}]`, out));
        return out;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (!(k in a)) out.push(`${p}.${k} only in the drill instance`);
            else if (!(k in b)) out.push(`${p}.${k} missing in the drill instance`);
            else diffPaths(a[k], b[k], `${p}.${k}`, out);
            if (out.length >= 5) break;
        }
        return out;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(p);
    return out;
}

/** Compare one path. `prod` and `drill` are exec.http results. */
function compareBodies(entry, prod, drill) {
    const res = { path: entry.path, productionStatus: prod.status || 0, drillStatus: drill.status || 0, match: false };
    if (!(prod.status >= 200 && prod.status < 300)) { res.detail = `production answered ${prod.status || prod.error || 'nothing'}`; return res; }
    if (prod.status !== drill.status) { res.detail = `status ${drill.status || drill.error || 'no answer'} ≠ production ${prod.status}`; return res; }
    if (!entry.ignore.length) {
        if (prod.body === drill.body) { res.match = true; res.mode = 'bytes'; return res; }
        const a = Buffer.from(prod.body || '');
        const b = Buffer.from(drill.body || '');
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        res.detail = `bodies differ: ${b.length} bytes vs production ${a.length}, first difference at byte ${i}`;
        return res;
    }
    let pa;
    let pb;
    try { pa = JSON.parse(prod.body); pb = JSON.parse(drill.body); } catch { res.detail = 'ignore keys are declared but a body is not JSON'; return res; }
    const diffs = diffPaths(stripKeys(pa, entry.ignore), stripKeys(pb, entry.ignore));
    res.mode = `json without ${entry.ignore.join(', ')}`;
    if (!diffs.length) { res.match = true; return res; }
    res.detail = `JSON differs at ${diffs.join('; ')}`;
    return res;
}

function countSql(table) { return `SELECT count(*) AS n FROM "${table}"`; }

async function countRows(exec, db, table, as) {
    const rows = await exec.sqlite(db, countSql(table), { as });
    const n = Number(rows && rows[0] ? Object.values(rows[0])[0] : NaN);
    if (!Number.isFinite(n)) throw new Error(`count of ${table} returned no number`);
    return n;
}

// A content-addressed blob is named by its own sha256: that name is the whole integrity check.
const BLOB_RE = /^[0-9a-f]{64}$/;

/** Every non-directory entry under `dir`, recursively (regular files and anything else tar restored). */
async function walkFiles(exec, dir) {
    const out = [];
    for (const e of (await exec.readdir(dir)) || []) {
        const p = path.join(dir, e.name);
        const st = await exec.stat(p);
        if (!st) continue;
        // Never follow a symlink: `exec.stat` follows it, so a restored member `x -> /` would otherwise
        // be recursed into and walk (and hash) files outside the scratch directory as root. It is
        // returned as a leaf so verifyObjectBlobs refuses it.
        if (st.isDir && !st.isSymlink) out.push(...await walkFiles(exec, p));
        else out.push(p);
    }
    return out;
}

/** The sha256 of a file, streamed so a large blob is never held in memory. */
async function sha256Stream(exec, p) {
    const hash = crypto.createHash('sha256');
    await pipeline(exec.readStream(p), hash);
    return hash.digest('hex');
}

/**
 * Check a restored object directory: every regular file is a blob named by its own sha256. A file
 * whose name is not a sha256 is not a blob (Host keeps transient write scratch under its store
 * root) and is counted as skipped, never verified. Any symlink or special file (device, fifo,
 * socket) in the restored tree is refused whatever its name, as is a blob-named entry that is not a
 * plain file, as in a database copy. `entry` gets the counts and the sha256 mismatch list.
 */
async function verifyObjectBlobs(exec, dir, entry) {
    const bad = [];
    for (const p of await walkFiles(exec, dir)) {
        const st = await exec.stat(p);
        if (!st) continue;
        const name = path.basename(p);
        // walkFiles returns symlinks as leaves; a special file is neither a file nor a directory.
        if (st.isSymlink || !st.isFile) { bad.push(`${path.relative(dir, p)} (symlink or special file)`); continue; }
        if (!BLOB_RE.test(name)) { entry.skipped += 1; entry.bytes += st.size; continue; }
        if (st.nlink !== 1) { bad.push(`${path.relative(dir, p)} (not a plain file)`); continue; }
        entry.bytes += st.size;
        const hash = await sha256Stream(exec, p);
        if (hash !== name) { bad.push(`${path.relative(dir, p)} (sha256 ${hash})`); continue; }
        entry.blobs += 1;
    }
    entry.mismatches = bad.length;
    if (bad.length) throw new Error(`${bad.length} blob(s) do not match their name: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', …' : ''}`);
}

/**
 * A `tar -tvzf` listing line: permissions, owner/group, size, date, time, name. Only a regular file
 * ('-') or a directory ('d') may be extracted as root; a symlink, hard link or special file, or an
 * absolute or `..` name, could write outside the scratch directory. -> the first offending member.
 */
function tarMemberProblem(listing) {
    for (const line of String(listing || '').split('\n')) {
        if (!line.trim()) continue;
        const m = /^(\S+)\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/.exec(line);
        if (!m) return `unparsable tar listing line: ${line.trim().slice(0, 80)}`;
        const type = m[1][0];
        const name = m[2].replace(/ -> .*$/, '').trim();
        if (type !== '-' && type !== 'd') return `member ${name} is not a regular file or directory (${type})`;
        if (name.startsWith('/') || name.split('/').includes('..')) return `member ${name} is not a safe relative path`;
    }
    return null;
}

// ── inputs ───────────────────────────────────────────────────────────────────

/** The backup to restore: --backup <dir>, else the newest usable record in <stateDir>/backups/<id>.jsonl. */
async function resolveBackup(exec, inv, svc, dirArg) {
    let dir = dirArg;
    let takenAt = null;
    let record = null;
    const restored = Object.keys(svc.drill.databases).map((name) => svc.databases.find((d) => d.name === name));
    const pgTargets = restored.filter((d) => d.engine === 'postgresql');
    if (dir) {
        if (!path.isAbsolute(dir)) throw new DrillError('--backup must be an absolute path');
        dir = path.normalize(dir);
    } else {
        const text = await exec.readFile(path.join(inv.stateDir, 'backups', `${svc.id}.jsonl`));
        // A failed or empty backup (ok: false) is never restored. PostgreSQL records a verification-
        // only run too (ok: true, no dir, files: []), which holds no artifact to restore: pick the
        // newest record that carries a .dump entry for every PostgreSQL database, not merely the last.
        const records = String(text || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.dir && r.ok !== false);
        const usable = pgTargets.length
            ? records.filter((r) => pgTargets.every((d) => (r.files || []).some((f) => f.file === dbengine.fileName(d))))
            : records;
        if (!usable.length) throw new DrillError(`no good ovhost backup recorded for ${svc.id}; run \`ovhost backup ${svc.id}\` first or pass --backup <dir>`);
        const last = usable[usable.length - 1];
        dir = last.dir;
        takenAt = last.at || null;
        record = last;
    }
    const st = await exec.stat(dir);
    if (!st || !st.isDir) throw new DrillError(`backup directory ${dir} not found`);
    const files = [];
    for (const name of Object.keys(svc.drill.databases)) {
        const db = svc.databases.find((d) => d.name === name);
        const target = svc.drill.databases[name];
        const file = path.join(dir, db.engine === 'postgresql' ? dbengine.fileName(db) : `${name}${path.extname(db.path) || '.db'}`);
        const fst = await exec.stat(file);
        if (!fst || !fst.isFile) throw new DrillError(`backup ${dir} has no copy of the ${name} database (${path.basename(file)})`);
        if (db.engine === 'postgresql') files.push({ name, file, production: db, engine: 'postgresql', url: target.url, directUrl: target.directUrl });
        else files.push({ name, file, production: db.path, envName: target.env, dir: target.dir, ext: path.extname(db.path) || '.db', engine: 'sqlite' });
    }
    // Object directories are restored from the same backup: the archive holds the declared
    // directory's contents, so the drill must not run without it (there would be nothing to verify).
    const objects = [];
    for (const obj of svc.objects) {
        const file = path.join(dir, `${obj.name}.tar.gz`);
        const fst = await exec.stat(file);
        if (!fst || !fst.isFile) throw new DrillError(`backup ${dir} has no copy of the ${obj.name} object directory (${path.basename(file)})`);
        // The uncompressed size recorded at backup time (`du -sb`), so the drill can check it has room
        // to extract. A --backup directory has no record; its compressed size is the best we can do.
        const rec = record && (record.files || []).find((f) => f.file === `${obj.name}.tar.gz`);
        const sourceBytes = rec && Number.isFinite(rec.sourceBytes) ? rec.sourceBytes : fst.size;
        objects.push({ name: obj.name, file, production: obj.path, sourceBytes });
    }
    return { dir, takenAt, files, objects };
}

/** How production starts the service: ExecStart, WorkingDirectory and non-secret Environment=. */
async function startSpec(exec, svc) {
    const d = svc.drill;
    if (!svc.units.length && !d.command) throw new DrillError(`${svc.id} has no unit to copy ExecStart from; set drill.command`);
    if (svc.units.length > 1 && !d.command && !d.unit) throw new DrillError(`${svc.id} runs ${svc.units.length} units; a drill starts one process, so set drill.unit (or drill.command, or mark the drill unsupported)`);
    const unit = d.unit || svc.units[0];
    let directives = { execStart: null, rawExecStart: null, workingDirectory: null, user: null, environment: [] };
    if (unit) {
        const st = await systemd.show(exec, unit);
        const texts = [];
        for (const f of [st.fragmentPath, ...st.dropIns].filter(Boolean)) {
            const t = await exec.readFile(f, { privileged: true });
            if (t != null) texts.push(t);
        }
        directives = envfile.unitDirectives(texts);
    }
    let argv = d.command;
    if (!argv) {
        if (!directives.execStart || !directives.execStart.length) throw new DrillError(`no ExecStart found for ${unit}; set drill.command`);
        if (/[$%]/.test(directives.rawExecStart) || /^[^-:+!]*@/.test(directives.rawExecStart.split(/\s/)[0])) throw new DrillError(`${unit} ExecStart uses substitutions or specifiers; set drill.command`);
        argv = directives.execStart;
    }
    if (!path.isAbsolute(argv[0])) throw new DrillError(`the drill command must start with an absolute path (got ${argv[0]}); set drill.command`);
    const environment = [];
    const skippedEnvironment = [];
    for (const e of directives.environment) {
        if (envfile.SECRET_NAME_RE.test(e.name)) skippedEnvironment.push(e.name);
        else environment.push(e);
    }
    return { unit, argv, cwd: directives.workingDirectory || svc.codeDir, unitUser: directives.user, environment, skippedEnvironment };
}

/**
 * The deployed checkout must have every switch the drill's overrides rely on: an older release
 * would ignore them and run its side effects against the world. -> the missing requirements
 */
async function missingRequirements(exec, svc) {
    const missing = [];
    for (const r of svc.drill.requires) {
        const text = await exec.readFile(path.join(svc.codeDir, r.file));
        if (text == null || !text.includes(r.contains)) missing.push(`${r.contains} in ${r.file}${text == null ? ' (file not found)' : ''}`);
    }
    return missing;
}

// ── the drill ────────────────────────────────────────────────────────────────

async function drill(ctx, id, { backup: backupArg = null, keep = false } = {}) {
    const { exec, inv, log } = ctx;
    const svc = service(inv, id);
    if (!(await exec.isRoot())) throw new DrillError('ovhost drill must run as root (sudo ovhost drill …): it copies databases as the service user and starts the drill instance through systemd-run');
    if (!svc.drill) throw new DrillError(`${id} has no drill block in the inventory`);
    if (!svc.drill.supported) throw new DrillError(`${id} does not support restore drills: ${svc.drill.reason}`);
    const d = svc.drill;
    if (d.compare.length && !d.productionPort) throw new DrillError(`${id} declares compare paths but no production port`);
    // The production env file is loaded first, so an override the drill does not set keeps its
    // production value. Refuse before creating or starting anything if a PostgreSQL service is not
    // fully pointed at its scratch database and away from production Valkey.
    const pgRestored = svc.databases.filter((db) => db.engine === 'postgresql' && Object.prototype.hasOwnProperty.call(d.databases, db.name));
    // A PostgreSQL database the drill does not restore would leave the instance on production's URLs
    // (and its migrations on production's direct URL): every one must be in drill.databases.
    const pgUnmapped = svc.databases.filter((db) => db.engine === 'postgresql' && !Object.prototype.hasOwnProperty.call(d.databases, db.name));
    if (pgUnmapped.length) throw new DrillError(`${id}: drill.databases must map every PostgreSQL database (${pgUnmapped.map((db) => db.name).join(', ')} is missing): otherwise the drill instance would run on production's database`);
    if (pgRestored.length) {
        const missingEnv = [];
        for (const db of pgRestored) {
            const t = d.databases[db.name];
            if (!t.url) missingEnv.push(`${db.engine} ${db.database} has no url env var`);
            if (!t.directUrl) missingEnv.push(`${db.engine} ${db.database} has no directUrl env var`);
        }
        if (typeof d.env.VALKEY_URL !== 'string' || d.env.VALKEY_URL === '') missingEnv.push('VALKEY_URL: without it the drill instance would write into the production Valkey keyspace');
        if (missingEnv.length) throw new DrillError(`${id}: drill.env must set ${missingEnv.join('; ')}`);
    }
    const missing = await missingRequirements(exec, svc);
    if (missing.length) throw new DrillError(`${id}: the deployed checkout (${svc.codeDir}) does not have what this drill's overrides rely on: ${missing.join('; ')}. Deploy a release with the drill switch first.`);
    if (svc.envFile && !(await exec.stat(svc.envFile))) throw new DrillError(`${svc.envFile} not found`);
    const busy = await exec.listeners(d.port);
    if (busy.length) throw new DrillError(`port ${d.port} is already in use (${busy.map((l) => `${l.process || '?'} pid ${l.pid || '?'}`).join(', ')}); free it or change drill.port`);
    const bk = await resolveBackup(exec, inv, svc, backupArg);
    const spec = await startSpec(exec, svc);
    if (spec.unitUser && spec.unitUser !== svc.runAs) log(`warning: ${spec.unit} runs as ${spec.unitUser}, the inventory says ${svc.runAs}; the drill runs as ${svc.runAs}`);
    if (spec.skippedEnvironment.length) log(`not passing on unit Environment= with secret-looking names: ${spec.skippedEnvironment.join(', ')}`);

    const held = await lock.acquire(exec, inv, `${id}-drill`);
    const at = stamp(exec.now());
    const tmp = path.join(inv.drillDir, `${id}-${at}`);
    const unitName = `ovhost-drill-${id}-${at}.service`;
    const logFile = path.join(tmp, 'drill.log');
    const record = {
        service: id,
        startedAt: new Date(exec.now()).toISOString(),
        operator: process.env.SUDO_USER || (await exec.userName()),
        host: inv.host,
        backup: bk.dir,
        backupTakenAt: bk.takenAt,
        port: d.port,
        dir: tmp,
        unit: unitName,
        pid: null,
        databases: [],
        objects: [],
        ready: null,
        compare: [],
        counts: [],
        acceptance: [],
        stop: null,
        scratch: null,
        kept: false,
        result: 'failed',
        failure: null,
    };
    const fail = (stage, message) => { if (!record.failure) record.failure = { stage, message }; log(`✗ ${stage}: ${message}`); return new Abort(message); };
    let created = false;
    let productionPids = [];
    const scratches = [];

    try {
        // Free space before anything is restored: pg_restore needs room for the restored tables on
        // top of the archive plus the database's own WAL and temporary files.
        const pgFiles = bk.files.filter((f) => f.engine === 'postgresql');
        if (pgFiles.length) {
            let dumpSize = 0;
            for (const f of pgFiles) { const s = await exec.stat(f.file); dumpSize += s ? s.size : 0; }
            const needed = 2 * dumpSize + 1024 ** 3;
            // The drill directory may not exist yet on a host that has never run a drill, and statfs
            // works on an existing path; create it first (the mkdir below is then a harmless no-op).
            await exec.mkdir(inv.drillDir, { mode: 0o711 });
            const free = (await exec.statfs(inv.drillDir)).free;
            if (free < needed) throw fail('space', `not enough free space under ${inv.drillDir}: ${free} bytes free, need ${needed} (2 × ${dumpSize} bytes of dump + 1 GiB)`);
            // A drill killed before its finally ran leaves its scratch database and role behind. This
            // service's drill lock is held, so anything under its prefix belongs to no running drill.
            const prefix = `ov_${id.replace(/[^a-z0-9_]/g, '_')}_drill_`;
            const left = await dbengine.scratchLeftovers(exec, prefix);
            for (const name of left.databases) { log(`dropping a scratch database an earlier drill left: ${name}`); await dbengine.dropDatabase(exec, name); }
            for (const name of left.roles) { log(`dropping a scratch role an earlier drill left: ${name}`); await dbengine.dropRole(exec, name); }
        }
        // Free space for the object archives too: extracting one writes its whole uncompressed
        // contents under the drill directory. The size `du -sb` measured at backup time travels in the
        // backup record; a --backup directory falls back to the archive's compressed size.
        const objectBytes = bk.objects.reduce((n, o) => n + (o.sourceBytes || 0), 0);
        if (objectBytes) {
            await exec.mkdir(inv.drillDir, { mode: 0o711 });
            const free = (await exec.statfs(inv.drillDir)).free;
            if (free < objectBytes) throw fail('space', `not enough free space under ${inv.drillDir}: ${free} bytes free, need ${objectBytes} (the object directories' contents)`);
        }
        if (await exec.stat(tmp)) throw fail('prepare', `${tmp} already exists`);
        await exec.mkdir(inv.drillDir, { mode: 0o711 });
        // postgres reads the dump copy in <tmp>/pg, so it must be able to traverse <tmp> (0711: no listing;
        // every file inside keeps its own restrictive mode). A SQLite-only drill keeps <tmp> at 0700.
        await exec.mkdir(tmp, { owner: svc.runAs, mode: pgFiles.length ? 0o711 : 0o700 });
        created = true;
        await exec.mkdir(path.join(tmp, 'db'), { owner: svc.runAs, mode: 0o700 });
        // postgres (not the service user) reads a PostgreSQL dump, so it gets its own directory; the
        // copy inside is 0600 postgres (the backup itself is root-only, which postgres cannot read).
        if (pgFiles.length) await exec.mkdir(path.join(tmp, 'pg'), { owner: dbengine.PG_USER, mode: 0o700 });
        const vars = { tmp, port: d.port, db: {} };
        // A data-directory database keeps its production file name: the service finds it by name.
        const dirOf = (f) => (f.dir ? expand(f.dir, vars) : null);
        for (const f of bk.files) { if (f.engine === 'postgresql') continue; vars.db[f.name] = f.dir ? path.join(dirOf(f), path.basename(f.production)) : path.join(tmp, 'db', `${f.name}${f.ext}`); }
        for (const dir of new Set(bk.files.filter((f) => f.dir).map(dirOf))) await exec.mkdir(dir, { owner: svc.runAs, mode: 0o700 });
        for (const dir of d.dirs) await exec.mkdir(expand(dir, vars), { owner: svc.runAs, mode: 0o700 });
        for (const b of d.bind) if (!(await exec.stat(expand(b.from, vars)))) await exec.mkdir(expand(b.from, vars), { owner: svc.runAs, mode: 0o700 });

        // 1. restore and check every database copy
        const sid = id.replace(/[^a-z0-9_]/g, '_');
        const scratchFor = (name) => scratches.find((s) => s.name === name);
        for (const f of bk.files) {
            if (f.engine === 'postgresql') {
                // A PostgreSQL restore replaces the file copy: root copies the root-only archive into
                // <tmp>/pg owned by postgres, verifies it, then creates a scratch database and role and
                // restores the archive into them (--no-owner, --role: the archive names production's
                // role, and every object must end up owned by the drill role the instance connects as).
                const copy = path.join(tmp, 'pg', `${f.name}.dump`);
                log(`restoring ${f.file} → ${copy} (owned by ${dbengine.PG_USER})`);
                const cp = await exec.run('install', ['-o', dbengine.PG_USER, '-m', '0600', '-T', '--', f.file, copy], { privileged: true });
                if (cp.code !== 0) throw fail('restore', `copying ${f.file} failed: ${(cp.stderr || '').trim().slice(0, 200)}`);
                const st = await exec.stat(copy);
                const entry = { name: f.name, source: f.file, copy, bytes: st ? st.size : null, integrity: null, engine: 'postgresql' };
                record.databases.push(entry);
                try { await dbengine.verifyDump(exec, copy, { as: dbengine.PG_USER }); } catch (err) { entry.integrity = `error: ${err.message}`; throw fail('integrity', `${f.name}: ${err.message}`); }
                entry.integrity = 'pg_restore --list ok';
                log(`pg_restore --list ${f.name}: ok`);
                // The role and the database share the same name (separate namespaces); dbengine always
                // quotes the identifier, so the stamp's hyphen is fine.
                const name = `ov_${sid}_drill_${at}${pgFiles.length > 1 ? `_${pgFiles.indexOf(f)}` : ''}`;
                const { password } = await dbengine.createRole(exec, name, {});
                const scratch = { name: f.name, database: name, role: name, password, dropped: null, error: null };
                scratches.push(scratch);
                if (!record.scratch) record.scratch = { database: name, role: name };
                await dbengine.createDatabase(exec, name, { owner: name });
                await dbengine.restore(exec, f.production, { dump: copy, database: name, role: name, log });
                continue;
            }
            const dest = vars.db[f.name];
            log(`restoring ${f.file} → ${dest} (owned by ${svc.runAs})`);
            // Backups are root-only (0600), so root copies; install unlinks whatever is at dest
            // before writing, so nothing planted in the drill directory is followed.
            const cp = await exec.run('install', ['-o', svc.runAs, '-m', '0600', '-T', '--', f.file, dest], { privileged: true });
            if (cp.code !== 0) throw fail('restore', `copying ${f.file} failed: ${(cp.stderr || '').trim().slice(0, 200)}`);
            const st = await exec.stat(dest);
            const entry = { name: f.name, source: f.file, copy: dest, bytes: st ? st.size : null, integrity: null, engine: 'sqlite' };
            record.databases.push(entry);
            let rows;
            try { rows = await exec.sqlite(dest, 'PRAGMA integrity_check', { as: svc.runAs }); } catch (err) { entry.integrity = `error: ${err.message}`; throw fail('integrity', `${f.name}: ${err.message}`); }
            entry.integrity = (rows || []).map((r) => String(Object.values(r)[0])).join('; ') || 'no result';
            if (entry.integrity !== 'ok') throw fail('integrity', `${f.name}: integrity_check = ${entry.integrity.slice(0, 300)}`);
            log(`integrity_check ${f.name}: ok`);
        }
        // 1b. restore every declared object directory and check every blob's sha256. The archive is
        // root-only, so root extracts it into the drill's own scratch directory — never over the live
        // object directory, whose path reaches the drill instance only through its env override.
        for (const obj of bk.objects) {
            const dest = path.join(tmp, obj.name);
            await exec.mkdir(dest, { owner: svc.runAs, mode: 0o700 });
            // List the archive before extracting as root: only regular files and directories, with
            // relative names, may be written. `--no-same-owner --no-same-permissions` then keeps the
            // archive from restoring production's ownership or modes onto the drill copy.
            const list = await exec.run('tar', ['-tvzf', obj.file], { privileged: true, env: { LC_ALL: 'C' } });
            if (list.code !== 0) throw fail('objects', `listing ${obj.file} failed: ${(list.stderr || '').trim().slice(0, 200)}`);
            if (/Removing leading|Member name contains '\.\.'/.test(list.stderr || '')) throw fail('objects', `${obj.file}: the archive holds an absolute or '..' member`);
            const problem = tarMemberProblem(list.stdout);
            if (problem) throw fail('objects', `${obj.file}: ${problem}`);
            const x = await exec.run('tar', ['-xzf', obj.file, '-C', dest, '--no-same-owner', '--no-same-permissions'], { privileged: true });
            if (x.code !== 0) throw fail('objects', `extracting ${obj.file} failed: ${(x.stderr || '').trim().slice(0, 200)}`);
            const entry = { name: obj.name, source: obj.file, copy: dest, blobs: 0, skipped: 0, bytes: 0, mismatches: 0, integrity: null };
            record.objects.push(entry);
            log(`restoring object directory ${obj.file} → ${dest} (${svc.runAs})`);
            try { await verifyObjectBlobs(exec, dest, entry); } catch (err) { entry.integrity = `error: ${err.message}`; throw fail('objects', `${obj.name}: ${err.message}`); }
            entry.integrity = 'sha256 ok';
            log(`object directory ${obj.name}: ${entry.blobs} blob(s) sha256 ok${entry.skipped ? `, ${entry.skipped} non-blob file(s) skipped` : ''}`);
        }
        const restoredCounts = [];
        for (const c of d.counts) {
            const rdb = svc.databases.find((x) => x.name === c.db);
            // PostgreSQL counts come from the scratch database over psql, SQLite from the restored file.
            if (rdb.engine === 'postgresql') restoredCounts.push(await dbengine.countRows(exec, { engine: 'postgresql', database: scratchFor(c.db).database }, countSql(c.table)));
            else restoredCounts.push(await countRows(exec, vars.db[c.db], c.table, svc.runAs));
        }

        // 2. start the drill instance
        const lines = ['# written by ovhost drill; no secret values: the production env file is loaded separately'];
        for (const [k, v] of Object.entries(d.env)) lines.push(envLine(k, expand(v, vars)));
        const dbEnv = new Map();
        for (const f of bk.files) {
            if (f.engine === 'postgresql') {
                // Both names point at the scratch database over the direct cluster port (5432, never
                // PgBouncer's 6432: the scratch database and role exist only in the cluster). The
                // password is generated per drill and lives only in this file the instance reads.
                const s = scratchFor(f.name);
                const url = dbengine.databaseUrl({ database: s.database, role: s.role, password: s.password });
                dbEnv.set(f.url, url);
                dbEnv.set(f.directUrl, url);
            } else if (f.envName) dbEnv.set(f.envName, f.dir ? dirOf(f) : vars.db[f.name]);
        }
        for (const [k, v] of dbEnv) lines.push(envLine(k, v));
        const envPath = path.join(tmp, 'drill.env');
        await exec.writeFile(envPath, `${lines.join('\n')}\n`, { mode: 0o640 });
        // A unit Environment= the drill sets itself (its port, a restored database path) is not passed
        // on at all: the override file would win anyway (EnvironmentFile= beats Environment=), but a
        // production path must never reach the drill instance's environment.
        const drillNames = new Set([...Object.keys(d.env), ...dbEnv.keys()]);
        const props = [
            'Type=exec',
            ...spec.environment.filter((e) => !drillNames.has(e.name)).map((e) => environmentProperty(e.name, e.value)),
            ...(svc.envFile ? [`EnvironmentFile=${svc.envFile}`] : []),
            `EnvironmentFile=${envPath}`,
            `StandardOutput=append:${logFile}`,
            `StandardError=append:${logFile}`,
            'ProtectSystem=strict',
            `ReadWritePaths=${tmp}`,
            'PrivateTmp=yes',
            'ProtectHome=read-only',
            'NoNewPrivileges=yes',
            // Paths the service opens relative to its checkout, redirected into the drill directory
            // inside this unit's own mount namespace; production's files are never opened.
            ...d.bind.map((b) => `BindPaths=${expand(b.from, vars)}:${b.to}`),
            `SocketBindAllow=tcp:${d.port}`,
            'SocketBindDeny=any',
            `RuntimeMaxSec=${d.runtimeMaxSeconds}`,
            'TimeoutStopSec=15',
            ...(d.outbound ? [] : ['IPAddressDeny=any', 'IPAddressAllow=localhost']),
        ];
        if (d.outbound) log(`warning: the drill instance may reach non-loopback addresses (drill.outbound${d.outboundReason ? `: ${d.outboundReason}` : ''})`);
        const args = ['--unit', unitName, '--description', `ovhost restore drill of ${id}`, '--collect', '--quiet', `--uid=${svc.runAs}`, `--working-directory=${spec.cwd}`];
        for (const p of props) args.push('-p', p);
        args.push('--', ...spec.argv.map((a) => expand(a, vars)));
        for (const u of svc.units) { const st = await systemd.show(exec, u); if (st.mainPid) productionPids.push(st.mainPid); }
        if (d.bind.length) log(`bind mounts in the drill instance only: ${d.bind.map((b) => `${expand(b.from, vars)} → ${b.to}`).join(', ')}`);
        log(`starting ${spec.argv.join(' ')} in ${spec.cwd} as ${svc.runAs} on port ${d.port} (${unitName})`);
        const run = await exec.run('systemd-run', args, { privileged: true });
        if (run.code !== 0) throw fail('start', `systemd-run failed: ${(run.stderr || '').trim().slice(0, 300)}`);
        const st = await systemd.show(exec, unitName);
        if (!st.mainPid) throw fail('start', `the drill instance exited right away (${st.active}/${st.sub}); rerun with --keep and read ${logFile}`);
        if (productionPids.includes(st.mainPid)) throw fail('start', `pid ${st.mainPid} is production's; not touching it`);
        record.pid = st.mainPid;

        // 3. readiness, then comparisons
        const headers = (svc.ready && svc.ready.headers) || {};
        const readyUrl = `http://127.0.0.1:${d.port}${d.ready}`;
        const t0 = exec.now();
        let last = null;
        record.ready = { url: readyUrl, ok: false };
        while (exec.now() - t0 < d.readyTimeoutSeconds * 1000) {
            last = await exec.http(readyUrl, { timeoutMs: 5000, headers });
            if (last.status >= 200 && last.status < 300) break;
            if (!(await exec.pidAlive(record.pid))) {
                record.ready = { url: readyUrl, ok: false, status: last.status || 0, seconds: Math.round((exec.now() - t0) / 1000) };
                record.pid = null;
                throw fail('ready', `the drill instance exited before it was ready; rerun with --keep and read ${logFile}`);
            }
            await exec.sleep(1000);
        }
        record.ready = { url: readyUrl, ok: !!(last && last.status >= 200 && last.status < 300), status: last ? last.status || 0 : 0, seconds: Math.round((exec.now() - t0) / 1000) };
        if (!record.ready.ok) throw fail('ready', `${readyUrl} not ready after ${d.readyTimeoutSeconds}s (${last ? last.status || last.error : 'never probed'})`);
        log(`drill instance ready: ${d.ready} ${record.ready.status} after ${record.ready.seconds}s`);

        for (const c of d.compare) {
            const h = { ...headers, ...c.headers };
            const prod = await exec.http(`http://127.0.0.1:${d.productionPort}${c.path}`, { timeoutMs: 10000, headers: h });
            const drl = await exec.http(`http://127.0.0.1:${d.port}${c.path}`, { timeoutMs: 10000, headers: h });
            const res = compareBodies(c, prod, drl);
            record.compare.push(res);
            log(`${res.match ? 'same' : 'DIFFERENT'} ${c.path}${res.detail ? `: ${res.detail}` : ''}`);
        }
        for (let i = 0; i < d.counts.length; i++) {
            const c = d.counts[i];
            const db = svc.databases.find((x) => x.name === c.db);
            let production = null;
            let error = null;
            // PostgreSQL counts come from the cluster over psql (the inventory entry itself, never
            // .path, which a PostgreSQL entry does not have); SQLite from the production file.
            try { production = db.engine === 'postgresql' ? await dbengine.countRows(exec, db, countSql(c.table)) : await countRows(exec, db.path, c.table, svc.runAs); } catch (err) { error = err.message; }
            const tol = d.countsTolerance || 0;
            // A busy table drifts between the backup and now: countsTolerance (default 0) allows it.
            const match = production != null && restoredCounts[i] != null && Math.abs(production - restoredCounts[i]) <= tol;
            const row = { db: c.db, table: c.table, production, restored: restoredCounts[i], match };
            if (tol) row.tolerance = tol;
            if (error) row.error = error;
            record.counts.push(row);
            log(`${row.match ? 'same' : 'DIFFERENT'} ${c.table}: production ${production == null ? `unknown (${error})` : production}, restored ${restoredCounts[i]}${tol ? ` (±${tol})` : ''}`);
        }
        const bad = [...record.compare.filter((r) => !r.match).map((r) => `${r.path} (${r.detail})`), ...record.counts.filter((r) => !r.match).map((r) => `${r.table} ${r.production} ≠ ${r.restored}`)];
        if (bad.length) throw fail('compare', `differs from production: ${bad.join('; ')}`);
        // The acceptance subset (WS-S task 2): the restored instance alone answers each declared GET with
        // the declared status and, for JSON, the declared top-level keys.
        for (const a of (d.acceptance || [])) {
            const r = await exec.http(`http://127.0.0.1:${d.port}${a.path}`, { timeoutMs: 10000, headers: { ...headers, ...a.headers } });
            let detail = null;
            if (r.status !== a.status) detail = `status ${r.status || r.error || 0}, expected ${a.status}`;
            else if (a.keys.length) {
                let body = null;
                try { body = JSON.parse(r.body || ''); } catch { body = null; }
                const missing = body && typeof body === 'object' ? a.keys.filter((k) => !(k in body)) : a.keys;
                if (missing.length) detail = `missing ${missing.join(', ')}`;
            }
            record.acceptance.push({ path: a.path, ok: !detail, ...(detail ? { detail } : {}) });
            log(`${detail ? 'FAILED' : 'ok'} ${a.path}${detail ? `: ${detail}` : ''}`);
        }
        const unaccepted = record.acceptance.filter((r) => !r.ok).map((r) => `${r.path} (${r.detail})`);
        if (unaccepted.length) throw fail('acceptance', unaccepted.join('; '));
    } catch (err) {
        if (!(err instanceof Abort)) fail('error', err.message);
    } finally {
        // Cleanup ALWAYS, on success and on failure: stop the drill instance first (so nothing is
        // connected to the scratch database), then drop the scratch database and role. dropdb is
        // attempted before dropRole so a dropdb refusal (a session still connected) cannot stop the
        // role attempt. A failure to drop is logged and recorded, never thrown: it must not mask the
        // drill's own outcome.
        // A throw while stopping must not skip the drops below (the leftover sweep only runs on the next drill).
        try { record.stop = await stopInstance(exec, record.pid, d.port, productionPids, log); } catch (err) { record.stop = { ok: false, detail: `stop failed: ${err.message}` }; log(`could not stop the drill instance: ${err.message}`); }
        for (const s of scratches) {
            try { await dbengine.dropDatabase(exec, s.database); } catch (err) { s.dropped = false; s.error = `dropdb: ${err.message}`; log(`could not drop the scratch database ${s.database}: ${err.message}`); }
            try { await dbengine.dropRole(exec, s.role); } catch (err) { s.dropped = false; s.error = [s.error, `droprole: ${err.message}`].filter(Boolean).join('; '); log(`could not drop the scratch role ${s.role}: ${err.message}`); }
            if (s.dropped === null) s.dropped = true;
        }
        if (record.scratch && scratches.length) {
            record.scratch.dropped = scratches.every((s) => s.dropped);
            const dropErrors = scratches.filter((s) => s.error).map((s) => s.error);
            if (dropErrors.length) record.scratch.error = dropErrors.join('; ');
        }
    }

    // 4. stop outcome, remove the drill directory, record
    if (record.stop && !record.stop.ok) fail('stop', record.stop.detail);
    if (created) {
        const safe = tmp.startsWith(`${inv.drillDir}/`) && /^[a-z][a-z0-9-]*-\d{8}-\d{6}$/.test(path.basename(tmp));
        if (keep) { record.kept = true; log(`kept ${tmp} (--keep)`); } else if (record.stop && !record.stop.ok) {
            record.kept = true;
            log(`kept ${tmp}: the drill instance could not be confirmed stopped`);
        } else if (safe) {
            const rm = await exec.run('rm', ['-rf', '--one-file-system', '--', tmp], { privileged: true });
            if (rm.code !== 0) { record.kept = true; log(`could not remove ${tmp}: ${(rm.stderr || '').trim()}`); }
        }
    }
    record.finishedAt = new Date(exec.now()).toISOString();
    record.result = record.failure ? 'failed' : 'passed';
    record.markdown = markdownRow(record);
    try {
        await exec.appendFile(path.join(inv.stateDir, 'drills', `${id}.jsonl`), `${JSON.stringify(record)}\n`);
    } finally {
        await held.release();
    }
    return { exitCode: record.failure ? 2 : 0, record };
}

/** SIGTERM the drill's own MainPID, then SIGKILL after the grace period. Never anything else. */
async function stopInstance(exec, pid, port, productionPids, log) {
    if (!pid) return null;
    if (productionPids.includes(pid)) return { ok: false, detail: `refusing to signal production pid ${pid}` };
    log(`stopping the drill instance (pid ${pid})`);
    await exec.kill(pid, 'SIGTERM');
    let signal = 'SIGTERM';
    const t0 = exec.now();
    while (await exec.pidAlive(pid)) {
        if (exec.now() - t0 >= STOP_GRACE_MS) {
            if (signal === 'SIGKILL') return { ok: false, pid, signal, detail: `pid ${pid} survived SIGKILL` };
            log(`pid ${pid} still running after ${STOP_GRACE_MS / 1000}s; SIGKILL`);
            await exec.kill(pid, 'SIGKILL');
            signal = 'SIGKILL';
        }
        await exec.sleep(500);
    }
    const left = await exec.listeners(port);
    if (left.length) return { ok: false, pid, signal, detail: `port ${port} is still in use after pid ${pid} stopped (${left.map((l) => l.pid).join(', ')})` };
    return { ok: true, pid, signal };
}

function cell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

/** A row for the table in docs/restore-drills.md. */
function markdownRow(r) {
    const checks = [];
    for (const db of r.databases) checks.push(db.engine === 'postgresql'
        ? `\`pg_restore --list\` (${db.name}) = ${db.integrity === 'pg_restore --list ok' ? 'ok' : cell(db.integrity).slice(0, 80)}`
        : `\`pragma integrity_check\` (${db.name}) = ${db.integrity === 'ok' ? 'ok' : cell(db.integrity).slice(0, 80)}`);
    for (const o of r.objects || []) checks.push(o.integrity === 'sha256 ok'
        ? `object store \`${o.name}\` ${o.blobs} blob(s) sha256 ok`
        : `object store \`${o.name}\`: ${cell(o.integrity).slice(0, 80)}`);
    if (r.ready) checks.push(r.ready.ok ? `drill instance \`${new URL(r.ready.url).pathname}\` ${r.ready.status} after ${r.ready.seconds}s` : `drill instance not ready (${r.ready.status || 'no answer'})`);
    const same = r.compare.filter((c) => c.match).map((c) => `\`${c.path}\``);
    const diff = r.compare.filter((c) => !c.match).map((c) => `\`${c.path}\` differs (${cell(c.detail)})`);
    if (same.length) checks.push(`${same.join(', ')} identical to production${r.compare.some((c) => c.match && c.mode && c.mode !== 'bytes') ? ' (JSON without volatile keys where declared)' : ''}`);
    checks.push(...diff);
    for (const c of r.counts) checks.push(`${c.table} ${c.production == null ? '?' : c.production} ${c.match ? '=' : '≠'} ${c.restored}${c.tolerance ? ` (±${c.tolerance})` : ''}`);
    const accepted = (r.acceptance || []).filter((a) => a.ok).map((a) => `\`${a.path}\``);
    if (accepted.length) checks.push(`acceptance ${accepted.join(', ')}`);
    if (r.failure && r.failure.stage !== 'compare' && r.failure.stage !== 'acceptance') checks.push(`${r.failure.stage}: ${cell(r.failure.message)}`);
    if (r.failure && r.failure.stage === 'acceptance') checks.push(`acceptance failed: ${cell(r.failure.message)}`);
    const when = r.startedAt.replace('T', ' ').slice(0, 16);
    return `| ${when} | ${r.service} | \`${r.backup}/\` (\`ovhost drill ${r.service}\`) | ${checks.join('; ')} | ${r.result} |`;
}

module.exports = { drill, DrillError, compareBodies, verifyObjectBlobs, tarMemberProblem };
