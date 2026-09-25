'use strict';
/**
 * ovhost drill <service> [--backup <dir>] [--keep]: a restore drill (roadmap Wave 22). It rebuilds
 * the service from a backup next to production and checks that the rebuilt copy answers like
 * production does:
 *
 *   1. Take the latest `ovhost backup` of the service (or --backup <dir>). Copy each database the
 *      drill block names into a fresh directory under <drillDir> owned by the service user, and
 *      run PRAGMA integrity_check on each copy. The result must be `ok`.
 *   2. Start a second instance from the production checkout, as the service user, through
 *      systemd-run. It uses the production unit's ExecStart and WorkingDirectory, the production
 *      env file, and a second env file with the drill's overrides: its port, the restored database
 *      paths, and the switches that turn side effects off. The instance runs sandboxed:
 *      ProtectSystem=strict with only the drill directory writable, a private /tmp, binding only its
 *      drill port, and no addresses beyond loopback unless the inventory says otherwise.
 *      RuntimeMaxSec stops it even if ovhost dies. Loopback stays open (the instance needs Network's
 *      public keys), so the inventory's overrides are what keep it away from production services.
 *   3. Wait for its readiness path. Then compare the declared read-only GETs with production, byte
 *      for byte or as JSON without the listed volatile keys, and compare declared row counts
 *      (production against the restored copy).
 *   4. Stop the instance by its own MainPID (never pkill -f), remove the drill directory unless
 *      --keep, append the result to <stateDir>/drills/<service>.jsonl, and return a Markdown row
 *      for docs/restore-drills.md.
 *
 * ovhost itself writes only inside the drill directory, the lock file and the drill log. It never
 * writes to the checkout, the env file, the database or the backup. It never reads an env value:
 * systemd loads the production env file for the instance, and the override file holds only
 * inventory values. Environment= values from the unit are passed on only if their names do not look
 * secret and the drill does not set them itself (OpenRe's unit sets OPENRE_DB_PATH to production's
 * database: that line never reaches the drill instance).
 */
const path = require('path');
const { service } = require('../inventory');
const envfile = require('../envfile');
const systemd = require('../systemd');
const lock = require('../lock');
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

// ── inputs ───────────────────────────────────────────────────────────────────

/** The backup to restore: --backup <dir>, else the last record in <stateDir>/backups/<id>.jsonl. */
async function resolveBackup(exec, inv, svc, dirArg) {
    let dir = dirArg;
    let takenAt = null;
    if (dir) {
        if (!path.isAbsolute(dir)) throw new DrillError('--backup must be an absolute path');
        dir = path.normalize(dir);
    } else {
        const text = await exec.readFile(path.join(inv.stateDir, 'backups', `${svc.id}.jsonl`));
        // A failed or empty backup (ok: false) is never restored.
        const records = String(text || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.dir && r.ok !== false);
        if (!records.length) throw new DrillError(`no good ovhost backup recorded for ${svc.id}; run \`ovhost backup ${svc.id}\` first or pass --backup <dir>`);
        const last = records[records.length - 1];
        dir = last.dir;
        takenAt = last.at || null;
    }
    const st = await exec.stat(dir);
    if (!st || !st.isDir) throw new DrillError(`backup directory ${dir} not found`);
    const files = [];
    for (const name of Object.keys(svc.drill.databases)) {
        const db = svc.databases.find((d) => d.name === name);
        const file = path.join(dir, `${name}${path.extname(db.path) || '.db'}`);
        const fst = await exec.stat(file);
        if (!fst || !fst.isFile) throw new DrillError(`backup ${dir} has no copy of the ${name} database (${path.basename(file)})`);
        const target = svc.drill.databases[name];
        files.push({ name, file, production: db.path, envName: target.env, dir: target.dir, ext: path.extname(db.path) || '.db' });
    }
    return { dir, takenAt, files };
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
    return { unit, argv, cwd: directives.workingDirectory || svc.repo, unitUser: directives.user, environment, skippedEnvironment };
}

/**
 * The deployed checkout must have every switch the drill's overrides rely on: an older release
 * would ignore them and run its side effects against the world. -> the missing requirements
 */
async function missingRequirements(exec, svc) {
    const missing = [];
    for (const r of svc.drill.requires) {
        const text = await exec.readFile(path.join(svc.repo, r.file));
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
    const missing = await missingRequirements(exec, svc);
    if (missing.length) throw new DrillError(`${id}: the deployed checkout (${svc.repo}) does not have what this drill's overrides rely on: ${missing.join('; ')}. Deploy a release with the drill switch first.`);
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
        ready: null,
        compare: [],
        counts: [],
        acceptance: [],
        stop: null,
        kept: false,
        result: 'failed',
        failure: null,
    };
    const fail = (stage, message) => { if (!record.failure) record.failure = { stage, message }; log(`✗ ${stage}: ${message}`); return new Abort(message); };
    let created = false;
    let productionPids = [];

    try {
        if (await exec.stat(tmp)) throw fail('prepare', `${tmp} already exists`);
        await exec.mkdir(inv.drillDir, { mode: 0o711 });
        await exec.mkdir(tmp, { owner: svc.runAs, mode: 0o700 });
        created = true;
        await exec.mkdir(path.join(tmp, 'db'), { owner: svc.runAs, mode: 0o700 });
        const vars = { tmp, port: d.port, db: {} };
        // A data-directory database keeps its production file name: the service finds it by name.
        const dirOf = (f) => (f.dir ? expand(f.dir, vars) : null);
        for (const f of bk.files) vars.db[f.name] = f.dir ? path.join(dirOf(f), path.basename(f.production)) : path.join(tmp, 'db', `${f.name}${f.ext}`);
        for (const dir of new Set(bk.files.filter((f) => f.dir).map(dirOf))) await exec.mkdir(dir, { owner: svc.runAs, mode: 0o700 });
        for (const dir of d.dirs) await exec.mkdir(expand(dir, vars), { owner: svc.runAs, mode: 0o700 });
        for (const b of d.bind) if (!(await exec.stat(expand(b.from, vars)))) await exec.mkdir(expand(b.from, vars), { owner: svc.runAs, mode: 0o700 });

        // 1. restore and check every database copy
        for (const f of bk.files) {
            const dest = vars.db[f.name];
            log(`restoring ${f.file} → ${dest} (owned by ${svc.runAs})`);
            // Backups are root-only (0600), so root copies; install unlinks whatever is at dest
            // before writing, so nothing planted in the drill directory is followed.
            const cp = await exec.run('install', ['-o', svc.runAs, '-m', '0600', '-T', '--', f.file, dest], { privileged: true });
            if (cp.code !== 0) throw fail('restore', `copying ${f.file} failed: ${(cp.stderr || '').trim().slice(0, 200)}`);
            const st = await exec.stat(dest);
            const entry = { name: f.name, source: f.file, copy: dest, bytes: st ? st.size : null, integrity: null };
            record.databases.push(entry);
            let rows;
            try { rows = await exec.sqlite(dest, 'PRAGMA integrity_check', { as: svc.runAs }); } catch (err) { entry.integrity = `error: ${err.message}`; throw fail('integrity', `${f.name}: ${err.message}`); }
            entry.integrity = (rows || []).map((r) => String(Object.values(r)[0])).join('; ') || 'no result';
            if (entry.integrity !== 'ok') throw fail('integrity', `${f.name}: integrity_check = ${entry.integrity.slice(0, 300)}`);
            log(`integrity_check ${f.name}: ok`);
        }
        const restoredCounts = [];
        for (const c of d.counts) restoredCounts.push(await countRows(exec, vars.db[c.db], c.table, svc.runAs));

        // 2. start the drill instance
        const lines = ['# written by ovhost drill; no secret values: the production env file is loaded separately'];
        for (const [k, v] of Object.entries(d.env)) lines.push(envLine(k, expand(v, vars)));
        const dbEnv = new Map();
        for (const f of bk.files) if (f.envName) dbEnv.set(f.envName, f.dir ? dirOf(f) : vars.db[f.name]);
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
            try { production = await countRows(exec, db.path, c.table, svc.runAs); } catch (err) { error = err.message; }
            const row = { db: c.db, table: c.table, production, restored: restoredCounts[i], match: production === restoredCounts[i] };
            if (error) row.error = error;
            record.counts.push(row);
            log(`${row.match ? 'same' : 'DIFFERENT'} ${c.table}: production ${production == null ? `unknown (${error})` : production}, restored ${restoredCounts[i]}`);
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
    }

    // 4. stop, clean up, record
    record.stop = await stopInstance(exec, record.pid, d.port, productionPids, log);
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
    for (const db of r.databases) checks.push(`\`pragma integrity_check\` (${db.name}) = ${db.integrity === 'ok' ? 'ok' : cell(db.integrity).slice(0, 80)}`);
    if (r.ready) checks.push(r.ready.ok ? `drill instance \`${new URL(r.ready.url).pathname}\` ${r.ready.status} after ${r.ready.seconds}s` : `drill instance not ready (${r.ready.status || 'no answer'})`);
    const same = r.compare.filter((c) => c.match).map((c) => `\`${c.path}\``);
    const diff = r.compare.filter((c) => !c.match).map((c) => `\`${c.path}\` differs (${cell(c.detail)})`);
    if (same.length) checks.push(`${same.join(', ')} identical to production${r.compare.some((c) => c.match && c.mode && c.mode !== 'bytes') ? ' (JSON without volatile keys where declared)' : ''}`);
    checks.push(...diff);
    for (const c of r.counts) checks.push(`${c.table} ${c.production == null ? '?' : c.production} ${c.match ? '=' : '≠'} ${c.restored}`);
    const accepted = (r.acceptance || []).filter((a) => a.ok).map((a) => `\`${a.path}\``);
    if (accepted.length) checks.push(`acceptance ${accepted.join(', ')}`);
    if (r.failure && r.failure.stage !== 'compare' && r.failure.stage !== 'acceptance') checks.push(`${r.failure.stage}: ${cell(r.failure.message)}`);
    if (r.failure && r.failure.stage === 'acceptance') checks.push(`acceptance failed: ${cell(r.failure.message)}`);
    const when = r.startedAt.replace('T', ' ').slice(0, 16);
    return `| ${when} | ${r.service} | \`${r.backup}/\` (\`ovhost drill ${r.service}\`) | ${checks.join('; ')} | ${r.result} |`;
}

module.exports = { drill, DrillError, compareBodies };
