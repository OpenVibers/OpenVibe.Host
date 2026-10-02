'use strict';
/**
 * ovhost data provision | switch — run the data role's own scripts from the ovhost install
 * (roles/data/add-service.sh, roles/data/switch-service.sh; ADR-035). The agent pipeline may run
 * only ovhost through its broker, so giving a service its PostgreSQL database and switching it
 * over from SQLite has to go through here too.
 *
 *   ovhost data provision <service>                 -> roles/data/add-service.sh <service>
 *   ovhost data switch <service> [--sqlite <file>]  -> roles/data/switch-service.sh <service> [<file>],
 *                                                      with SWITCH_UNITS/SWITCH_DIR from the inventory
 *
 * add-service.sh prints names only. Whatever the scripts say, their output passes through redact():
 * a connection URL (postgres://, redis://, valkey://) or a NAME=value whose name carries PASSWORD
 * never reaches a terminal, a log or --json. The scripts' own exit code is passed through.
 */
const path = require('path');
const { service: inventoryService } = require('../inventory');
const { OpError, EXIT } = require('../release-ops');
const { installDirFor } = require('./self-update');

const URL_RE = /\b(?:postgres(?:ql)?|rediss?|valkey):\/\/[^\s"'`]+/gi;
const PASSWORD_RE = /\b([A-Za-z0-9_]*PASSWORD[A-Za-z0-9_]*=)\S+/gi;

function redact(text) {
    return String(text == null ? '' : text)
        .replace(URL_RE, '<redacted-url>')
        .replace(PASSWORD_RE, '$1<redacted>');
}

/** <install>/roles/data: from ovhost's own path, or from this file when none is given. */
function dataDirFor(selfPath) {
    const dir = selfPath ? installDirFor(selfPath).dir : path.join(__dirname, '..', '..');
    return path.join(dir, 'roles', 'data');
}

/** A template worker unit is stopped as a glob: openre-rtmp-ingest@.service -> openre-rtmp-ingest@*.service. */
function unitPattern(unit) {
    return unit.endsWith('@.service') ? `${unit.slice(0, -'.service'.length)}*.service` : unit;
}

/** The SWITCH_UNITS/SWITCH_DIR the script would otherwise default to (roles/data/switch-service.sh). */
function switchEnv(svc) {
    const env = {};
    const units = [...svc.units, ...svc.workerUnits].map(unitPattern);
    // Deploys restart every unit matching unitsMatch (release-ops), so the switch stops them too.
    if (svc.unitsMatch && !units.includes(svc.unitsMatch)) units.push(svc.unitsMatch);
    if (units.length) env.SWITCH_UNITS = units.join(' ');
    env.SWITCH_DIR = svc.repo;
    return env;
}

function printable(script, args, env) {
    const assigns = Object.entries(env || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    return redact(`${assigns ? `${assigns} ` : ''}${script}${args.map((a) => ` ${JSON.stringify(a)}`).join('')}`);
}

async function locate(exec, selfPath, script, action, id) {
    const p = path.join(dataDirFor(selfPath), script);
    const st = await exec.stat(p);
    if (!st || !st.isFile) {
        throw new OpError(`${p} is not in the ovhost install — cannot ${action} ${id}; run this from the installed ovhost (sudo ovhost self-update updates it)`, EXIT.USAGE);
    }
    return p;
}

async function run(ctx, svc, { action, script, args, env = {}, dryRun = false }) {
    const result = { service: svc.id, action, script, args, env, dryRun };
    if (dryRun) return { ...result, command: printable(script, args, env), code: null, ok: true, stdout: '', stderr: '' };
    // Both scripts need root (add-service.sh exits otherwise; switch uses systemctl, setpriv, chown),
    // and sudo's env_reset would drop SWITCH_UNITS/SWITCH_DIR, silently switching the wrong units/dir.
    if (!(await ctx.exec.isRoot())) throw new OpError(`data ${action} must run as root (sudo ovhost data ${action} ${svc.id})`, EXIT.USAGE);
    const r = await ctx.exec.run(script, args, { privileged: true, env });
    return { ...result, code: r.code, ok: r.code === 0, stdout: redact(r.stdout), stderr: redact(r.stderr) };
}

async function provision(ctx, id, { selfPath, dryRun = false } = {}) {
    const svc = inventoryService(ctx.inv, id);
    const script = await locate(ctx.exec, selfPath, 'add-service.sh', 'provision', svc.id);
    return run(ctx, svc, { action: 'provision', script, args: [svc.id], dryRun });
}

async function switchService(ctx, id, { selfPath, sqlite, dryRun = false } = {}) {
    const svc = inventoryService(ctx.inv, id);
    const script = await locate(ctx.exec, selfPath, 'switch-service.sh', 'switch', svc.id);
    const args = [svc.id];
    if (sqlite) args.push(sqlite);
    return run(ctx, svc, { action: 'switch', script, args, env: switchEnv(svc), dryRun });
}

module.exports = { provision, switch: switchService, redact, dataDirFor, switchEnv, unitPattern };
