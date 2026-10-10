'use strict';
/**
 * PostgreSQL database helpers (lib/inventory.js accepts no other engine). Every command runs as the postgres
 * OS user over peer auth (`local postgres peer` in roles/data/files/pg_hba.conf): ovhost reads no service env
 * value and never holds a database password except the one it generates itself for a restore drill's role.
 *
 * pgBackRest, not ovhost, is the durability layer for the cluster (roles/data/provision.sh: one
 * stanza `openvibe`, full weekly + differential nightly + WAL to object storage). What ovhost does
 * per night is verify that layer (verifyPgBackRest, walFailedCount) and, on a slower cadence, take
 * a per-service logical dump (dump) that the off-site code encrypts and uploads unchanged.
 */
const crypto = require('crypto');

// The OS user PostgreSQL's own tools run as (peer auth), the stanza provision.sh creates, and the
// direct connection a drill must use: 5432 is the cluster, 6432 is PgBouncer.
const PG_USER = 'postgres';
const PG_STANZA = 'openvibe';
const PG_DIRECT_HOST = '127.0.0.1';
const PG_DIRECT_PORT = 5432;
// A port nothing listens on: a drill instance keeps its production Valkey prefix, so it must not be
// able to reach a real Valkey (it would write into the production keyspace).
const CLOSED_VALKEY_URL = 'redis://127.0.0.1:9/0';

const WORK_TIMEOUT_MS = 6 * 3600 * 1000;

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const scrubbed = (r) => ((r.stderr || r.stdout || '').trim().slice(0, 300) || `exit ${r.code}`);

/** What a log line and a record call this database. */
function label(db) {
    return db.database;
}

/** The file name this database's artifact gets inside a backup directory. */
function fileName(db) {
    return `${db.name}.dump`;
}

/** Whether the database is still there in the cluster. */
async function exists(exec, db) {
    const rows = await exec.psql('postgres', `SELECT 1 AS present FROM pg_database WHERE datname = ${literal(db.database)}`);
    return rows.length > 0;
}

/**
 * A logical dump of one database into `dest` (a `pg_dump -Fc` archive: compressed, and restorable
 * table by table with pg_restore). It runs as postgres, so `dest` must be writable by postgres —
 * the caller's staging directory is owned by postgres when any database is PostgreSQL.
 */
async function dump(exec, db, dest, { log } = {}) {
    // -w: peer auth needs no password, and a prompt in the nightly unit would hang until the timeout.
    const r = await exec.run('pg_dump', ['-w', '-Fc', '-f', dest, '-d', db.database], { as: PG_USER, timeoutMs: WORK_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`pg_dump ${db.database} failed: ${scrubbed(r)}`);
    if (log) log(`pg_dump ${db.database} → ${dest}`);
    return dest;
}

/**
 * Whether `file` is a readable pg_dump archive (pg_restore --list parses its table of contents).
 * --list only reads the file and contacts no server, so a caller holding a root-only copy can pass
 * `as: null` and check it as itself rather than making it readable to postgres.
 */
async function verifyDump(exec, file, { as = PG_USER } = {}) {
    const r = await exec.run('pg_restore', ['--list', file], { as, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`pg_restore --list ${file} failed: ${scrubbed(r)}`);
    return true;
}

/** A database role with a freshly generated password. -> { role, password } */
async function createRole(exec, role, { password = null } = {}) {
    const pw = password || crypto.randomBytes(24).toString('hex');
    // The password reaches psql on stdin, never in argv: /proc/<pid>/cmdline is world-readable.
    const sql = `CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(pw)};\n`;
    const r = await exec.run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-f', '-'], { as: PG_USER, input: sql, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`creating role ${role} failed: ${scrubbed(r)}`);
    return { role, password: pw };
}

async function createDatabase(exec, database, { owner = null } = {}) {
    const args = ['-w'];
    if (owner) args.push(`--owner=${owner}`);
    args.push(database);
    const r = await exec.run('createdb', args, { as: PG_USER, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`createdb ${database} failed: ${scrubbed(r)}`);
    return database;
}

async function dropDatabase(exec, database) {
    // --force ends any session still connected (a drill instance that did not stop): only ever called
    // with a scratch database's name, never a production one.
    const r = await exec.run('dropdb', ['-w', '--if-exists', '--force', database], { as: PG_USER, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`dropdb ${database} failed: ${scrubbed(r)}`);
}

async function dropRole(exec, role) {
    const sql = `DROP ROLE IF EXISTS ${ident(role)};\n`;
    const r = await exec.run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-f', '-'], { as: PG_USER, input: sql, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`dropping role ${role} failed: ${scrubbed(r)}`);
}

/**
 * Restore a pg_dump archive into `database`, under `role`. --no-owner because the archive names the
 * production role (which the scratch database must not depend on); --role makes every object land
 * owned by the drill role, so the drilled service can read and write it.
 */
async function restore(exec, db, { dump: dumpFile, database, role, log } = {}) {
    // --no-privileges: the archive's GRANTs name production roles; the scratch copy must not hand them anything.
    const args = ['-w', '--no-owner', '--no-privileges'];
    if (role) args.push(`--role=${role}`);
    args.push('-d', database, dumpFile);
    const r = await exec.run('pg_restore', args, { as: PG_USER, timeoutMs: WORK_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`pg_restore into ${database} failed: ${scrubbed(r)}`);
    if (log) log(`pg_restore ${dumpFile} → ${database} (as ${role || PG_USER})`);
    return database;
}

/**
 * Scratch databases and roles an earlier drill left behind (killed before its cleanup ran): every name
 * that starts with `prefix` (ov_<service>_drill_). -> { databases: [], roles: [] }
 */
async function scratchLeftovers(exec, prefix) {
    const p = literal(prefix);
    const databases = await exec.psql('postgres', `SELECT datname AS name FROM pg_database WHERE left(datname, length(${p})) = ${p}`);
    const roles = await exec.psql('postgres', `SELECT rolname AS name FROM pg_roles WHERE left(rolname, length(${p})) = ${p}`);
    const names = (rows) => (rows || []).map((r) => r.name).filter((n) => typeof n === 'string' && n.startsWith(prefix));
    return { databases: names(databases), roles: names(roles) };
}

/** A row count from PostgreSQL. `sql` must return the number in its first column. */
async function countRows(exec, db, sql) {
    const rows = await exec.psql(db.database, sql);
    const n = Number(rows && rows[0] ? Object.values(rows[0])[0] : NaN);
    if (!Number.isFinite(n)) throw new Error(`count of ${label(db)} returned no number`);
    return n;
}

/** The connection URL a drill instance must use: the cluster directly, never PgBouncer. */
function databaseUrl({ database, role, password }) {
    return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${PG_DIRECT_HOST}:${PG_DIRECT_PORT}/${encodeURIComponent(database)}`;
}

/** `pgbackrest info --output=json` as postgres. */
async function pgbackrestInfo(exec) {
    const r = await exec.run('pgbackrest', [`--stanza=${PG_STANZA}`, 'info', '--output=json'], { as: PG_USER, timeoutMs: 300000 });
    if (r.code !== 0) throw new Error(`pgbackrest info failed: ${scrubbed(r)}`);
    let stanzas;
    try { stanzas = JSON.parse(r.stdout); } catch { throw new Error(`pgbackrest info did not answer JSON: ${String(r.stdout).trim().slice(0, 200)}`); }
    return Array.isArray(stanzas) ? stanzas : [];
}

/** The newest backup in a stanza's `info`: { type, stop (epoch seconds) } or null. */
function newestBackup(stanza) {
    let best = null;
    for (const b of stanza.backup || []) {
        const stop = b && b.timestamp ? Number(b.timestamp.stop) : NaN;
        if (!Number.isFinite(stop)) continue;
        if (!best || stop > best.stop) best = { type: b.type || 'unknown', stop };
    }
    return best;
}

/**
 * The every-run pgBackRest verification: the stanza exists and is ok, and its newest backup stopped
 * within `maxAgeSeconds` (26 h: nightly differentials at 02:15, with room for a slow one).
 * -> { type, stop (ISO), ageSeconds }
 */
async function verifyPgBackRest(exec, { now, maxAgeSeconds = 26 * 3600 } = {}) {
    const stanzas = await pgbackrestInfo(exec);
    const stanza = stanzas.find((s) => s && s.name === PG_STANZA);
    if (!stanza) throw new Error(`pgBackRest has no stanza ${PG_STANZA}: the cluster is not being backed up`);
    const code = Number((stanza.status && stanza.status.code) || 0);
    if (code !== 0) throw new Error(`pgBackRest stanza ${PG_STANZA} is not ok: ${(stanza.status && stanza.status.message) || `status code ${code}`}`);
    const newest = newestBackup(stanza);
    if (!newest) throw new Error(`pgBackRest stanza ${PG_STANZA} holds no backup at all`);
    const age = Math.floor(now / 1000) - newest.stop;
    if (age > maxAgeSeconds) throw new Error(`the newest pgBackRest backup (${newest.type}) stopped ${(age / 3600).toFixed(1)}h ago (limit ${maxAgeSeconds / 3600}h)`);
    return { type: newest.type, stop: new Date(newest.stop * 1000).toISOString(), ageSeconds: age };
}

/** `pg_stat_archiver.failed_count`: the cluster-wide count of WAL segments archiving ever failed on. */
async function walFailedCount(exec) {
    const rows = await exec.psql('postgres', 'SELECT failed_count::text AS n FROM pg_stat_archiver');
    const n = Number(rows && rows[0] ? rows[0].n : NaN);
    if (!Number.isFinite(n)) throw new Error('pg_stat_archiver returned no failed_count');
    return n;
}

module.exports = {
    PG_USER,
    PG_STANZA,
    PG_DIRECT_HOST,
    PG_DIRECT_PORT,
    CLOSED_VALKEY_URL,
    label,
    fileName,
    exists,
    dump,
    verifyDump,
    restore,
    createRole,
    createDatabase,
    dropDatabase,
    dropRole,
    scratchLeftovers,
    countRows,
    databaseUrl,
    pgbackrestInfo,
    verifyPgBackRest,
    newestBackup,
    walFailedCount,
};
