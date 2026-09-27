'use strict';
/**
 * systemd adapter. Every systemctl call ovhost makes goes through systemctl() below, which refuses
 * any action that would stop a socket unit. Socket-activated services (Live) keep their listener in
 * the .socket unit so HTTP connections queue in the kernel through a restart; stopping that unit is
 * what turns a restart into Cloudflare 502s. Only the .service unit is ever restarted.
 */
const SOCKET_SAFE_ACTIONS = new Set(['show', 'is-active', 'is-enabled', 'start', 'enable', 'cat', 'status', 'list-units', 'list-unit-files']);
const ALLOWED_ACTIONS = new Set(['show', 'is-active', 'is-enabled', 'start', 'enable', 'restart', 'reload', 'cat', 'status', 'daemon-reload', 'list-units', 'list-unit-files']);
const READ_ONLY_ACTIONS = ['show', 'is-active', 'is-enabled', 'cat', 'status', 'list-units', 'list-unit-files'];
const PROPS = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'UnitFileState', 'DropInPaths', 'PartOf', 'NRestarts', 'TimeoutStopUSec', 'KillSignal'];

class SocketGuardError extends Error {}

async function systemctl(exec, action, unit) {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`ovhost does not run "systemctl ${action}"`);
    if (unit && unit.endsWith('.socket') && !SOCKET_SAFE_ACTIONS.has(action)) {
        throw new SocketGuardError(`refusing "systemctl ${action} ${unit}": socket units are never stopped or restarted (they hold the listener that keeps HTTP up through a restart)`);
    }
    let args;
    if (action === 'show') args = ['show', unit, `--property=${PROPS.join(',')}`];
    else if (action === 'list-units') args = ['list-units', '--all', '--plain', '--no-legend', '--no-pager', unit];
    else if (action === 'list-unit-files') args = ['list-unit-files', '--no-legend', '--no-pager', unit];
    else args = unit ? [action, unit] : [action];
    const privileged = !READ_ONLY_ACTIONS.includes(action);
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
        // The effective stop timeout ("1min 30s", "infinity") and stop signal (a number), unit file,
        // drop-ins and systemd's defaults applied; '' when systemctl does not report them.
        timeoutStop: props.TimeoutStopUSec || '',
        killSignal: props.KillSignal || '',
    };
}

/**
 * Loaded instances of a worker unit (read-only): `name@.service` lists every `name@*.service`, a
 * plain unit lists itself. -> [{ unit, load, active, sub }]
 */
async function instances(exec, workerUnit) {
    const pattern = workerUnit.endsWith('@.service') ? `${workerUnit.slice(0, -'.service'.length)}*.service` : workerUnit;
    const r = await systemctl(exec, 'list-units', pattern);
    if (r.code !== 0) throw new Error(`systemctl list-units ${pattern} failed: ${(r.stderr || '').trim()}`);
    const out = [];
    for (const line of String(r.stdout || '').split('\n')) {
        const [unit, load, active, sub] = line.trim().split(/\s+/);
        if (unit && unit.endsWith('.service')) out.push({ unit, load, active, sub });
    }
    return out;
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

/** Unit files matching a glob (read-only): the units a multi-app service has on this host. -> [unit] */
async function listUnitFiles(exec, pattern) {
    const r = await systemctl(exec, 'list-unit-files', pattern);
    if (r.code !== 0 && String(r.stdout || '').trim()) throw new Error(`systemctl list-unit-files ${pattern} failed: ${(r.stderr || '').trim()}`);
    return String(r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && u.endsWith('.service') && !u.endsWith('@.service'));
}

async function enable(exec, unit) {
    const r = await systemctl(exec, 'enable', unit);
    return r.code === 0;
}

/**
 * Does pid 1 (systemd) hold the listener on `port`? `is-active` is not enough: a socket unit whose
 * descriptor was dropped still reads active while the service binds the port itself, and then every
 * restart refuses connections (Live, 2026-09-25 to 2026-09-26). -> { held, holders }
 */
async function socketHeld(exec, port) {
    const holders = await exec.listeners(port);
    return { held: holders.some((h) => h.pid === 1 && (!h.process || h.process === 'systemd')), holders };
}

const REBIND_REASONS = new Set(['socket-changed', 'socket-not-held']);

/**
 * The one sequence in ovhost that stops a service and restarts its socket unit, and only for the two
 * reasons Live's deploy.sh had: the socket unit file changed (after daemon-reload systemd may drop its
 * descriptor), or systemd does not hold the listener. Stop the service (it may hold the port itself),
 * restart the socket, start the service on it. HTTP is refused for that moment, once. Every other
 * path goes through systemctl(), which refuses to stop or restart a socket unit.
 */
async function rebindSocket(exec, serviceUnit, socketUnit, reason) {
    if (!REBIND_REASONS.has(reason)) throw new SocketGuardError(`refusing to rebind ${socketUnit}: "${reason}" is not a reason to restart a socket unit`);
    if (!serviceUnit.endsWith('.service') || !socketUnit.endsWith('.socket')) throw new SocketGuardError(`rebind needs a .service and a .socket unit (got ${serviceUnit}, ${socketUnit})`);
    const stop = await exec.run('systemctl', ['stop', serviceUnit], { privileged: true });
    const sock = await exec.run('systemctl', ['restart', socketUnit], { privileged: true });
    const start = await exec.run('systemctl', ['start', serviceUnit], { privileged: true });
    if (start.code !== 0) throw new Error(`systemctl start ${serviceUnit} failed after rebinding ${socketUnit}: ${(start.stderr || '').trim()}`);
    return { stopped: stop.code === 0, socketRestarted: sock.code === 0 };
}

async function daemonReload(exec) {
    const r = await systemctl(exec, 'daemon-reload');
    if (r.code !== 0) throw new Error(`systemctl daemon-reload failed: ${r.stderr.trim()}`);
}

async function reloadNginx(exec) {
    const r = await systemctl(exec, 'reload', 'nginx.service');
    if (r.code !== 0) throw new Error(`systemctl reload nginx failed: ${r.stderr.trim()}`);
}

module.exports = { systemctl, show, instances, restart, ensureSocketActive, daemonReload, reloadNginx, listUnitFiles, enable, socketHeld, rebindSocket, SocketGuardError };
