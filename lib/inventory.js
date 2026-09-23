'use strict';
/**
 * The host inventory: one JSON file describing every service on the host (see host.example.json).
 * The real file lives at /etc/openvibe/host.json and is never committed.
 *
 * load() normalises every entry and rejects anything that could turn a typo into damage: relative
 * paths, unit names that are not units, a socket unit listed as a service unit, vhost names with a
 * path in them. When ovhost runs as root the inventory must be root-owned and not group/world
 * writable — otherwise anyone who can edit it could point a root process at arbitrary files.
 */
const path = require('path');

const DEFAULT_PATHS = ['/etc/openvibe/host.json'];

class InventoryError extends Error {}

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const UNIT_RE = /^[A-Za-z0-9@._-]+\.(service|socket)$/;
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const DRAIN_POLICIES = ['refuse', 'wait', 'report'];
const PROBE_KINDS = ['http-json-count', 'sqlite-count'];

function abs(value, where) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new InventoryError(`${where} must be an absolute path`);
    return path.normalize(value);
}

function rel(value, where) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.normalize(value).startsWith('..')) throw new InventoryError(`${where} must be a path inside the checkout`);
    return path.normalize(value);
}

function normaliseService(id, raw, defaults) {
    if (!ID_RE.test(id)) throw new InventoryError(`service id "${id}" must match ${ID_RE}`);
    const where = `services.${id}`;
    const s = { ...defaults, ...raw };
    const out = {
        id,
        manifest: s.manifest || id,
        description: s.description || null,
        repo: abs(s.repo, `${where}.repo`),
        owner: s.owner,
        runAs: s.runAs || s.owner,
        remote: s.remote || 'origin',
        branch: s.branch || 'main',
        // 'git' (a checkout ovhost can move) or 'release' (releases/<id> behind a `current` symlink,
        // installed by the service's own deploy script: never managed here).
        layout: s.layout === 'release' ? 'release' : 'git',
        managed: s.layout === 'release' ? false : s.managed !== false,
        unmanagedReason: s.unmanagedReason || (s.layout === 'release' ? 'release layout: deployed by its own deploy script' : null),
        units: s.units || [],
        socketUnit: s.socketUnit || null,
        unitSources: s.unitSources || {},
        envFile: s.envFile ? abs(s.envFile, `${where}.envFile`) : null,
        env: { required: (s.env && s.env.required) || [], example: (s.env && s.env.example) || '.env.example' },
        port: s.port == null ? null : Number(s.port),
        ready: s.ready || null,
        health: s.health || null,
        packages: s.packages || ['.'],
        install: {
            command: (s.install && s.install.command) || ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
            always: !!(s.install && s.install.always),
            restoreLockfile: !(s.install && s.install.restoreLockfile === false),
        },
        build: s.build || [],
        noRestartPaths: s.noRestartPaths || [],
        protected: s.protected || null,
        drain: { policy: 'refuse', waitMaxSeconds: 8 * 3600, pollSeconds: 60, quietChecks: 2, ...(s.drain || {}) },
        databases: (s.databases || []).map((d, i) => {
            const name = d.name || path.basename(String(d.path), '.db');
            if (!FILE_NAME_RE.test(name)) throw new InventoryError(`${where}.databases[${i}].name must be a plain name`);
            return { name, path: abs(d.path, `${where}.databases[${i}].path`) };
        }),
        backupOnChange: s.backupOnChange || [],
        nginx: s.nginx || null,
        drill: null,
    };
    if (typeof out.owner !== 'string' || !/^[a-z_][a-z0-9_-]*$/.test(out.owner)) throw new InventoryError(`${where}.owner must be a user name`);
    if (!/^[a-z_][a-z0-9_-]*$/.test(out.runAs)) throw new InventoryError(`${where}.runAs must be a user name`);
    if (!Array.isArray(out.units)) throw new InventoryError(`${where}.units must be an array`);
    for (const u of out.units) {
        if (!UNIT_RE.test(u)) throw new InventoryError(`${where}.units: "${u}" is not a unit name`);
        if (u.endsWith('.socket')) throw new InventoryError(`${where}.units: "${u}" is a socket unit — declare it as socketUnit; ovhost never restarts or stops socket units`);
    }
    if (out.socketUnit && !(UNIT_RE.test(out.socketUnit) && out.socketUnit.endsWith('.socket'))) throw new InventoryError(`${where}.socketUnit must be a .socket unit`);
    for (const [unit, src] of Object.entries(out.unitSources)) {
        if (!UNIT_RE.test(unit) && !/^[A-Za-z0-9@._-]+\.(service|socket)\.d\/[A-Za-z0-9._-]+\.conf$/.test(unit)) throw new InventoryError(`${where}.unitSources: "${unit}" is not a unit or drop-in name`);
        rel(src, `${where}.unitSources.${unit}`);
    }
    if (out.port !== null && !(Number.isInteger(out.port) && out.port > 0 && out.port < 65536)) throw new InventoryError(`${where}.port must be a TCP port`);
    if (out.ready) {
        if (typeof out.ready.url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(out.ready.url)) throw new InventoryError(`${where}.ready.url must be a loopback http:// URL`);
        out.ready = { timeoutSeconds: 90, headers: {}, ...out.ready };
    }
    for (const p of out.packages) if (p !== '.') rel(p.replace(/\/\*$/, ''), `${where}.packages`);
    if (!Array.isArray(out.install.command) || !out.install.command.length) throw new InventoryError(`${where}.install.command must be an argv array`);
    for (const b of out.build) if (!Array.isArray(b) || !b.length) throw new InventoryError(`${where}.build entries must be argv arrays`);
    if (!DRAIN_POLICIES.includes(out.drain.policy)) throw new InventoryError(`${where}.drain.policy must be one of ${DRAIN_POLICIES.join(', ')}`);
    if (out.protected) {
        const p = out.protected;
        if (!PROBE_KINDS.includes(p.kind)) throw new InventoryError(`${where}.protected.kind must be one of ${PROBE_KINDS.join(', ')}`);
        if (p.kind === 'http-json-count' && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(p.url || '')) throw new InventoryError(`${where}.protected.url must be a loopback http:// URL`);
        if (p.kind === 'sqlite-count') {
            abs(p.db, `${where}.protected.db`);
            if (!/^\s*select\b/i.test(p.sql || '')) throw new InventoryError(`${where}.protected.sql must be a SELECT`);
        }
    }
    if (out.nginx) {
        const n = out.nginx;
        if (n.vhost && !FILE_NAME_RE.test(n.vhost)) throw new InventoryError(`${where}.nginx.vhost must be a file name, not a path`);
        if (n.repoVhost) rel(n.repoVhost, `${where}.nginx.repoVhost`);
        if (n.repoVhosts) rel(n.repoVhosts.replace(/\*\.conf$/, 'x.conf'), `${where}.nginx.repoVhosts`);
        if (n.variant && !['http', 'sse', 'websocket'].includes(n.variant)) throw new InventoryError(`${where}.nginx.variant must be http, sse or websocket`);
        if (n.certName && !FILE_NAME_RE.test(n.certName)) throw new InventoryError(`${where}.nginx.certName must be a name`);
    }
    for (const p of out.backupOnChange) rel(p, `${where}.backupOnChange`);
    if (s.drill) out.drill = normaliseDrill(s.drill, out, where);
    return out;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{(tmp|port|db:[A-Za-z0-9._-]+)\}/g;

/**
 * The `drill` block (Wave 22 restore drills): how to start a second, side-effect-free instance of
 * the service against restored copies of its databases, and what to compare with production.
 *
 *   supported   false (with a reason) when a second instance cannot run safely
 *   port        spare loopback port for the drill instance (never the service's own port)
 *   databases   { <database name>: <ENV VAR that points the service at that file> }
 *   env         { NAME: value } overrides that turn side effects off; values may use {tmp}, {port}
 *               and {db:<name>}
 *   dirs        directories to create (owned by the service user) inside {tmp} before the start
 *   command     argv to start the service; default: the production unit's ExecStart
 *   ready       readiness path; default: the path of the service's ready URL
 *   compare     [{ path, ignore: [volatile keys], headers }] read-only GETs compared with production
 *   counts      [{ db, table }] row counts compared between production and the restored copy
 *   outbound    true lets the instance reach non-loopback addresses (default: loopback only)
 */
function normaliseDrill(raw, svc, where) {
    const w = `${where}.drill`;
    if (!raw || typeof raw !== 'object') throw new InventoryError(`${w} must be an object`);
    if (raw.supported === false) {
        if (typeof raw.reason !== 'string' || !raw.reason.trim()) throw new InventoryError(`${w}.reason is required when supported is false`);
        return { supported: false, reason: raw.reason };
    }
    const port = Number(raw.port);
    if (!(Number.isInteger(port) && port >= 1024 && port < 65536)) throw new InventoryError(`${w}.port must be a TCP port from 1024`);
    if (port === svc.port) throw new InventoryError(`${w}.port must differ from the service's own port`);
    if (!svc.databases.length) throw new InventoryError(`${w}: a drill restores databases, and ${svc.id} declares none`);
    const dbNames = svc.databases.map((d) => d.name);
    const databases = raw.databases || {};
    if (typeof databases !== 'object' || Array.isArray(databases) || !Object.keys(databases).length) throw new InventoryError(`${w}.databases must map at least one database name to an env var name`);
    for (const [name, envName] of Object.entries(databases)) {
        if (!dbNames.includes(name)) throw new InventoryError(`${w}.databases: "${name}" is not one of ${svc.id}'s databases (${dbNames.join(', ')})`);
        if (!ENV_NAME_RE.test(envName)) throw new InventoryError(`${w}.databases.${name} must be an env var name`);
    }
    const env = raw.env || {};
    for (const [k, v] of Object.entries(env)) {
        if (!ENV_NAME_RE.test(k)) throw new InventoryError(`${w}.env: "${k}" is not an env var name`);
        if (typeof v !== 'string' || /[\n\r\0]/.test(v)) throw new InventoryError(`${w}.env.${k} must be a one-line string`);
        for (const m of v.matchAll(PLACEHOLDER_RE)) {
            if (m[1].startsWith('db:') && !Object.keys(databases).includes(m[1].slice(3))) throw new InventoryError(`${w}.env.${k}: {${m[1]}} is not a restored database`);
        }
    }
    if (!Object.values(env).some((v) => v.includes('{port}')) && !(raw.command || []).some((a) => String(a).includes('{port}'))) throw new InventoryError(`${w}.env must point the instance at its port with {port} (e.g. "PORT": "{port}")`);
    for (const envName of Object.values(databases)) if (envName in env) throw new InventoryError(`${w}.env.${envName} is already set by drill.databases`);
    const dirs = raw.dirs || [];
    for (const d of dirs) if (typeof d !== 'string' || !/^\{tmp\}\/[A-Za-z0-9._/-]+$/.test(d) || d.includes('..')) throw new InventoryError(`${w}.dirs entries must be paths under {tmp}`);
    if (raw.command != null && (!Array.isArray(raw.command) || !raw.command.length || raw.command.some((a) => typeof a !== 'string'))) throw new InventoryError(`${w}.command must be an argv array`);
    if (raw.command && !path.isAbsolute(raw.command[0])) throw new InventoryError(`${w}.command[0] must be an absolute path`);
    let ready = raw.ready || null;
    if (!ready && svc.ready) ready = new URL(svc.ready.url).pathname;
    if (!ready || !/^\/[^/]/.test(ready)) throw new InventoryError(`${w}.ready must be a path such as /api/ready (or declare the service's ready URL)`);
    const compare = (raw.compare || []).map((c, i) => {
        const cc = typeof c === 'string' ? { path: c } : c;
        if (!cc || typeof cc.path !== 'string' || !/^\/[^/]/.test(cc.path) || /\s/.test(cc.path)) throw new InventoryError(`${w}.compare[${i}].path must be a path such as /api/items?limit=5`);
        const ignore = cc.ignore || [];
        if (!Array.isArray(ignore) || ignore.some((k) => typeof k !== 'string' || !k)) throw new InventoryError(`${w}.compare[${i}].ignore must be a list of key names`);
        return { path: cc.path, ignore, headers: cc.headers || {} };
    });
    const counts = (raw.counts || []).map((c, i) => {
        if (!c || !Object.keys(databases).includes(c.db)) throw new InventoryError(`${w}.counts[${i}].db must be a restored database`);
        if (!TABLE_RE.test(c.table || '')) throw new InventoryError(`${w}.counts[${i}].table must be a table name`);
        return { db: c.db, table: c.table };
    });
    if (!compare.length && !counts.length) throw new InventoryError(`${w} needs at least one compare path or row count`);
    const readyTimeoutSeconds = Number(raw.readyTimeoutSeconds || (svc.ready && svc.ready.timeoutSeconds) || 90);
    return {
        supported: true,
        port,
        databases,
        env,
        dirs,
        command: raw.command || null,
        ready,
        readyTimeoutSeconds,
        compare,
        counts,
        outbound: raw.outbound === true,
        outboundReason: raw.outboundReason || null,
        runtimeMaxSeconds: Number(raw.runtimeMaxSeconds || 1800),
    };
}

function normalise(raw) {
    if (!raw || typeof raw !== 'object' || !raw.services || typeof raw.services !== 'object') throw new InventoryError('inventory needs a "services" object');
    const defaults = raw.defaults || {};
    const inv = {
        host: raw.host || null,
        stateDir: abs(raw.stateDir || '/var/lib/openvibe-host', 'stateDir'),
        backupDir: abs(raw.backupDir || '/var/backups/openvibe', 'backupDir'),
        drillDir: abs(raw.drillDir || '/var/lib/openvibe-drills', 'drillDir'),
        nginx: {
            sitesAvailable: abs((raw.nginx && raw.nginx.sitesAvailable) || '/etc/nginx/sites-available', 'nginx.sitesAvailable'),
            sitesEnabled: abs((raw.nginx && raw.nginx.sitesEnabled) || '/etc/nginx/sites-enabled', 'nginx.sitesEnabled'),
            bin: (raw.nginx && raw.nginx.bin) || 'nginx',
        },
        services: {},
    };
    for (const [id, svc] of Object.entries(raw.services)) {
        if (id.startsWith('_')) continue;
        inv.services[id] = normaliseService(id, svc, defaults);
    }
    const ports = new Map(Object.values(inv.services).filter((s) => s.port).map((s) => [s.port, s.id]));
    const drillPorts = new Map();
    for (const s of Object.values(inv.services)) {
        if (!s.drill || !s.drill.supported) continue;
        if (ports.has(s.drill.port)) throw new InventoryError(`services.${s.id}.drill.port ${s.drill.port} is ${ports.get(s.drill.port)}'s port`);
        if (drillPorts.has(s.drill.port)) throw new InventoryError(`services.${s.id}.drill.port ${s.drill.port} is also ${drillPorts.get(s.drill.port)}'s drill port`);
        drillPorts.set(s.drill.port, s.id);
    }
    return inv;
}

/** Resolve and read the inventory through the executor. Root requires a root-owned, non-writable file. */
async function load(exec, { file, env = process.env } = {}) {
    const candidates = file ? [file] : env.OVHOST_INVENTORY ? [env.OVHOST_INVENTORY] : DEFAULT_PATHS;
    for (const f of candidates) {
        const st = await exec.stat(f);
        if (!st) continue;
        if (await exec.isRoot()) {
            if (st.uid !== 0) throw new InventoryError(`${f} must be owned by root when ovhost runs as root`);
            if (st.mode & 0o022) throw new InventoryError(`${f} must not be group- or world-writable when ovhost runs as root`);
        }
        const text = await exec.readFile(f, { privileged: true });
        let raw;
        try { raw = JSON.parse(text); } catch (err) { throw new InventoryError(`${f} is not valid JSON: ${err.message}`); }
        const inv = normalise(raw);
        inv.file = f;
        return inv;
    }
    throw new InventoryError(`no inventory found (looked at ${candidates.join(', ')}); copy host.example.json to /etc/openvibe/host.json`);
}

function service(inv, id) {
    const s = inv.services[id];
    if (!s) throw new InventoryError(`unknown service "${id}" (inventory has: ${Object.keys(inv.services).join(', ')})`);
    return s;
}

module.exports = { load, normalise, service, InventoryError };
