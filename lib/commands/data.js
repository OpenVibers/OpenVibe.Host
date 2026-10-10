'use strict';
/** ovhost data provision runs the data role from this installation. */
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
    // The data role requires root.
    if (!(await ctx.exec.isRoot())) throw new OpError(`data ${action} must run as root (sudo ovhost data ${action} ${svc.id})`, EXIT.USAGE);
    const r = await ctx.exec.run(script, args, { privileged: true, env });
    return { ...result, code: r.code, ok: r.code === 0, stdout: redact(r.stdout), stderr: redact(r.stderr) };
}

async function provision(ctx, id, { selfPath, dryRun = false } = {}) {
    const svc = inventoryService(ctx.inv, id);
    const script = await locate(ctx.exec, selfPath, 'add-service.sh', 'provision', svc.id);
    return run(ctx, svc, { action: 'provision', script, args: [svc.id], dryRun });
}

module.exports = { provision, redact, dataDirFor };
