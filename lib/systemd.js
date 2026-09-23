'use strict';
/**
 * systemd adapter. Every systemctl call ovhost makes goes through systemctl() below, which refuses
 * any action that would stop a socket unit. Socket-activated services (Live) keep their listener in
 * the .socket unit so HTTP connections queue in the kernel through a restart; stopping that unit is
 * what turns a restart into Cloudflare 502s. Only the .service unit is ever restarted.
 */
const SOCKET_SAFE_ACTIONS = new Set(['show', 'is-active', 'is-enabled', 'start', 'cat', 'status']);
const ALLOWED_ACTIONS = new Set(['show', 'is-active', 'is-enabled', 'start', 'restart', 'reload', 'cat', 'status', 'daemon-reload']);
const PROPS = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'UnitFileState', 'DropInPaths', 'PartOf', 'NRestarts'];

class SocketGuardError extends Error {}

async function systemctl(exec, action, unit) {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`ovhost does not run "systemctl ${action}"`);
    if (unit && unit.endsWith('.socket') && !SOCKET_SAFE_ACTIONS.has(action)) {
        throw new SocketGuardError(`refusing "systemctl ${action} ${unit}": socket units are never stopped or restarted (they hold the listener that keeps HTTP up through a restart)`);
    }
    const args = action === 'show' ? ['show', unit, `--property=${PROPS.join(',')}`] : unit ? [action, unit] : [action];
    const privileged = !['show', 'is-active', 'is-enabled', 'cat', 'status'].includes(action);
    return exec.run('systemctl', args, { privileged });
}

async function show(exec, unit) {
    const r = await systemctl(exec, 'show', unit);
    const props = {};
    for (const line of r.stdout.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
        unit,
        load: props.LoadState || 'unknown',
        active: props.ActiveState || 'unknown',
        sub: props.SubState || 'unknown',
        mainPid: Number(props.MainPID || 0),
        fragmentPath: props.FragmentPath || '',
        unitFileState: props.UnitFileState || '',
        dropIns: (props.DropInPaths || '').split(/\s+/).filter(Boolean),
        partOf: (props.PartOf || '').split(/\s+/).filter(Boolean),
        restarts: Number(props.NRestarts || 0),
    };
}

async function restart(exec, unit) {
    const r = await systemctl(exec, 'restart', unit);
    if (r.code !== 0) throw new Error(`systemctl restart ${unit} failed: ${r.stderr.trim()}`);
}

/** A socket unit that is not listening gets started (never restarted): new connections need it. */
async function ensureSocketActive(exec, socketUnit) {
    const st = await show(exec, socketUnit);
    if (st.active === 'active') return { started: false, state: st };
    const r = await systemctl(exec, 'start', socketUnit);
    if (r.code !== 0) throw new Error(`systemctl start ${socketUnit} failed: ${r.stderr.trim()}`);
    return { started: true, state: st };
}

async function daemonReload(exec) {
    const r = await systemctl(exec, 'daemon-reload');
    if (r.code !== 0) throw new Error(`systemctl daemon-reload failed: ${r.stderr.trim()}`);
}

async function reloadNginx(exec) {
    const r = await systemctl(exec, 'reload', 'nginx.service');
    if (r.code !== 0) throw new Error(`systemctl reload nginx failed: ${r.stderr.trim()}`);
}

module.exports = { systemctl, show, restart, ensureSocketActive, daemonReload, reloadNginx, SocketGuardError };
