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
        managed: s.managed !== false,
        unmanagedReason: s.unmanagedReason || null,
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
    return out;
}

function normalise(raw) {
    if (!raw || typeof raw !== 'object' || !raw.services || typeof raw.services !== 'object') throw new InventoryError('inventory needs a "services" object');
    const defaults = raw.defaults || {};
    const inv = {
        host: raw.host || null,
        stateDir: abs(raw.stateDir || '/var/lib/openvibe-host', 'stateDir'),
        backupDir: abs(raw.backupDir || '/var/backups/openvibe', 'backupDir'),
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
