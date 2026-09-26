'use strict';
/**
 * systemd adapter. Every systemctl call ovhost makes goes through systemctl() below, which refuses
 * any action that would stop a socket unit. Socket-activated services (Live) keep their listener in
 * the .socket unit so HTTP connections queue in the kernel through a restart; stopping that unit is
 * what turns a restart into Cloudflare 502s. Only the .service unit is ever restarted.
 */
const SOCKET_SAFE_ACTIONS = new Set(['show', 'is-active', 'is-enabled', 'start', 'cat', 'status', 'list-units']);
const ALLOWED_ACTIONS = new Set(['show', 'is-active', 'is-enabled', 'start', 'restart', 'reload', 'cat', 'status', 'daemon-reload', 'list-units']);
const READ_ONLY_ACTIONS = ['show', 'is-active', 'is-enabled', 'cat', 'status', 'list-units'];
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

async function daemonReload(exec) {
    const r = await systemctl(exec, 'daemon-reload');
    if (r.code !== 0) throw new Error(`systemctl daemon-reload failed: ${r.stderr.trim()}`);
}

async function reloadNginx(exec) {
    const r = await systemctl(exec, 'reload', 'nginx.service');
    if (r.code !== 0) throw new Error(`systemctl reload nginx failed: ${r.stderr.trim()}`);
}

module.exports = { systemctl, show, instances, restart, ensureSocketActive, daemonReload, reloadNginx, SocketGuardError };
