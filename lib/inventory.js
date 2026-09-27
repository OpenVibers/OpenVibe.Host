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
// A worker unit is a template (`name@.service`) or a plain service unit.
const WORKER_UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/;
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const DRAIN_POLICIES = ['refuse', 'wait', 'report'];
const PROBE_KINDS = ['http-json-count', 'sqlite-count', 'sum'];

function abs(value, where) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new InventoryError(`${where} must be an absolute path`);
    return path.normalize(value);
}

function rel(value, where) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.normalize(value).startsWith('..')) throw new InventoryError(`${where} must be a path inside the checkout`);
    return path.normalize(value);
}

function httpsOrigin(value, where) {
    let u;
    try { u = new URL(String(value)); } catch { throw new InventoryError(`${where} must be an https:// origin`); }
    if (u.protocol !== 'https:' || u.username || u.password || u.origin !== String(value).replace(/\/+$/, '')) throw new InventoryError(`${where} must be an https:// origin such as https://openvibe.live`);
    return u.origin;
}

/**
 * Deploy strategies (roadmap WS-N task 11; docs/deploy-strategies.md). A strategy is the engine plus
 * the defaults the per-repository deploy script it replaces encoded; every default can be overridden
 * in the service entry.
 *
 *   git-checkout    an in-place checkout (Network, Events, Media, …): the default
 *   multi-app       an in-place checkout of several apps (Tools): per-app installs (apps/_* skipped),
 *                   untracked lockfiles the release tracks are removed first, preflight loads
 *   static-build    an in-place checkout with a build and repo vhosts and no process (Sites)
 *   pnpm-build      an in-place pnpm workspace with a build (Games)
 *   release-layout  releases/<id> behind a `current` symlink (Live, OpenRe): a new release is prepared
 *                   while the old one serves, switching is an atomic rename, rollback switches back
 */
const STRATEGIES = ['git-checkout', 'multi-app', 'static-build', 'pnpm-build', 'release-layout'];
const NPM_CI = ['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'];
const PRESETS = {
    'git-checkout': {},
    'multi-app': { packages: ['apps/*'], skipPackages: ['apps/_*'], removeUntrackedLockfiles: true },
    'static-build': {
        install: { command: NPM_CI, always: true },
        build: [['node', 'build.js']],
        generated: ['dist/'],
        nginx: { repoVhosts: 'deploy/nginx/*.conf', installOnDeploy: true },
        announce: { releaseFiles: 'dist/*/release.json' },
    },
    'pnpm-build': {
        packages: ['apps/*', 'packages/*'],
        install: { command: ['pnpm', 'install', '--frozen-lockfile'], always: true, lockfile: 'pnpm-lock.yaml', restoreLockfile: false, workspace: true },
        build: [['pnpm', 'build']],
    },
    'release-layout': { install: { command: NPM_CI } },
};
const NESTED = ['install', 'nginx', 'announce', 'preflight', 'release'];

function withPreset(s, strategy) {
    const preset = PRESETS[strategy] || {};
    const out = { ...preset, ...s };
    for (const k of NESTED) {
        if (preset[k] && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) out[k] = { ...preset[k], ...s[k] };
    }
    return out;
}

const REL_ID_FORMATS = ['time-sha8', 'sha12'];

/** The `release` block of a release-layout service: where the git clone, the releases and `current` are. */
function normaliseRelease(raw, base, where) {
    const r = raw || {};
    const w = `${where}.release`;
    const inside = (v, dflt, name) => {
        const p = v == null ? path.join(base, dflt) : abs(path.isAbsolute(String(v)) ? v : path.join(base, String(v)), `${w}.${name}`);
        return path.normalize(p);
    };
    const out = {
        git: inside(r.git, 'repo', 'git'),
        releasesDir: inside(r.releases, 'releases', 'releases'),
        current: inside(r.current, 'current', 'current'),
        id: r.id == null ? 'time-sha8' : r.id,
        links: r.links || {},
        reuseModules: r.reuseModules !== false,
        chown: r.chown == null ? null : r.chown,
        keep: r.keep == null ? 5 : Number(r.keep),
        settleSeconds: r.settleSeconds == null ? 3 : Number(r.settleSeconds),
        socketPort: r.socketPort == null ? null : Number(r.socketPort),
    };
    if (!REL_ID_FORMATS.includes(out.id)) throw new InventoryError(`${w}.id must be one of ${REL_ID_FORMATS.join(', ')}`);
    if (!out.releasesDir.startsWith(`${base}/`) || !out.current.startsWith(`${base}/`)) throw new InventoryError(`${w}: releases and current must be inside ${base}`);
    if (typeof out.links !== 'object' || Array.isArray(out.links)) throw new InventoryError(`${w}.links must map a name inside each release to a link target`);
    for (const [name, target] of Object.entries(out.links)) {
        if (!FILE_NAME_RE.test(name)) throw new InventoryError(`${w}.links: "${name}" must be a plain name`);
        const resolved = typeof target === 'string' && target && !target.includes('\0') ? path.resolve(out.releasesDir, 'x', target) : '';
        if (!resolved.startsWith(`${base}/`)) throw new InventoryError(`${w}.links.${name} must point inside ${base}`);
    }
    if (out.chown != null && !/^[a-z_][a-z0-9_-]*(:[a-z_][a-z0-9_-]*)?$/.test(out.chown)) throw new InventoryError(`${w}.chown must be user or user:group`);
    if (!(Number.isInteger(out.keep) && out.keep >= 2 && out.keep <= 50)) throw new InventoryError(`${w}.keep must be a whole number from 2 to 50`);
    if (!(out.settleSeconds >= 0 && out.settleSeconds <= 60)) throw new InventoryError(`${w}.settleSeconds must be 0 to 60`);
    if (out.socketPort != null && !(Number.isInteger(out.socketPort) && out.socketPort > 0 && out.socketPort < 65536)) throw new InventoryError(`${w}.socketPort must be a TCP port`);
    return out;
}

/** `preflight`: checks that must pass before anything restarts (every strategy). */
function normalisePreflight(raw, where) {
    const p = raw || {};
    const w = `${where}.preflight`;
    const out = { syntaxCheck: p.syntaxCheck === true, dirs: p.dirs || [], checks: [] };
    if (!Array.isArray(out.dirs)) throw new InventoryError(`${w}.dirs must be a list of directories made in each package`);
    for (const d of out.dirs) rel(d, `${w}.dirs`);
    for (const [i, c] of (p.checks || []).entries()) {
        const at = `${w}.checks[${i}]`;
        if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((a) => typeof a !== 'string')) throw new InventoryError(`${at}.argv must be an argv array`);
        const pk = c.packages == null ? '*' : c.packages;
        if (pk !== '*' && (!Array.isArray(pk) || !pk.length)) throw new InventoryError(`${at}.packages must be "*" or a list of package directories`);
        if (Array.isArray(pk)) for (const d of pk) if (d !== '.') rel(d, `${at}.packages`);
        out.checks.push({ label: String(c.label || c.argv.join(' ')).slice(0, 80), packages: pk, argv: c.argv, timeoutSeconds: Number(c.timeoutSeconds || 120) });
    }
    return out;
}

function normaliseService(id, raw, defaults) {
    if (!ID_RE.test(id)) throw new InventoryError(`service id "${id}" must match ${ID_RE}`);
    const where = `services.${id}`;
    const strategy = raw.strategy == null ? (raw.layout === 'release' ? null : 'git-checkout') : raw.strategy;
    if (strategy !== null && !STRATEGIES.includes(strategy)) throw new InventoryError(`${where}.strategy must be one of ${STRATEGIES.join(', ')}`);
    if (strategy && strategy !== 'release-layout' && raw.layout === 'release') throw new InventoryError(`${where}: layout "release" needs strategy "release-layout"`);
    const s = withPreset({ ...defaults, ...raw }, strategy);
    const releaseLayout = strategy === 'release-layout' || s.layout === 'release';
    let repo = abs(s.repo, `${where}.repo`);
    // A release-layout entry may name the `current` link itself as its repo (what the service runs):
    // the release root is then its parent.
    if (releaseLayout && path.basename(repo) === 'current' && !(s.release && s.release.current)) repo = path.dirname(repo);
    const release = strategy === 'release-layout' ? normaliseRelease(s.release, repo, where) : null;
    const out = {
        id,
        manifest: s.manifest || id,
        description: s.description || null,
        repo,
        // Where the running code is: the checkout, or <repo>/current for the release layout.
        codeDir: releaseLayout ? (release ? release.current : path.join(repo, 'current')) : repo,
        owner: s.owner,
        runAs: s.runAs || s.owner,
        remote: s.remote || 'origin',
        branch: s.branch || 'main',
        strategy,
        release,
        // 'git' (a checkout ovhost can move) or 'release' (releases/<id> behind a `current` symlink).
        // A release-layout entry without strategy "release-layout" is deployed by its own script.
        layout: releaseLayout ? 'release' : 'git',
        managed: strategy === null ? false : s.managed !== false,
        unmanagedReason: s.unmanagedReason || (strategy === null ? 'release layout without strategy "release-layout": deployed by its own deploy script' : null),
        skipPackages: s.skipPackages || [],
        removeUntrackedLockfiles: s.removeUntrackedLockfiles === true,
        generated: s.generated || [],
        preflight: normalisePreflight(s.preflight, where),
        installUnits: s.installUnits === true,
        unitsMatch: s.unitsMatch || null,
        announce: { releaseFiles: (s.announce && s.announce.releaseFiles) || null },
        units: s.units || [],
        // Units that belong to the service but that ovhost never starts, stops or restarts: e.g.
        // OpenRe's transport workers (openre-rtmp-ingest@.service, one instance per release), which
        // drain on their own. status/validate list their instances read-only.
        workerUnits: s.workerUnits || [],
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
            lockfile: (s.install && s.install.lockfile) || 'package-lock.json',
            // One install at the checkout root for the whole workspace (pnpm), not one per package.
            workspace: !!(s.install && s.install.workspace),
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
        // The public origin release notifications name (lib/announce.js); default: the manifest's publicOrigin.
        origin: s.origin == null ? null : httpsOrigin(s.origin, `${where}.origin`),
        // Lifecycle (WS-P task 1): normally the service manifest's `lifecycle` block; an inventory
        // `lifecycle` replaces it for this host (lib/lifecycle.js resolve(), checked by validate).
        lifecycle: s.lifecycle == null ? null : s.lifecycle,
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
    if (!Array.isArray(out.workerUnits)) throw new InventoryError(`${where}.workerUnits must be an array`);
    for (const w of out.workerUnits) {
        if (typeof w !== 'string' || !WORKER_UNIT_RE.test(w)) throw new InventoryError(`${where}.workerUnits: "${w}" is not a .service unit or template`);
        for (const u of out.units) {
            if (u === w || (w.endsWith('@.service') && u.startsWith(w.slice(0, -'.service'.length)))) {
                throw new InventoryError(`${where}.units: "${u}" is a worker unit (${w}); ovhost restarts every unit in units, and never a worker unit`);
            }
        }
    }
    for (const [unit, src] of Object.entries(out.unitSources)) {
        if (!UNIT_RE.test(unit) && !/^[A-Za-z0-9@._-]+\.(service|socket)\.d\/[A-Za-z0-9._-]+\.conf$/.test(unit)) throw new InventoryError(`${where}.unitSources: "${unit}" is not a unit or drop-in name`);
        rel(src, `${where}.unitSources.${unit}`);
    }
    if (out.port !== null && !(Number.isInteger(out.port) && out.port > 0 && out.port < 65536)) throw new InventoryError(`${where}.port must be a TCP port`);
    if (out.ready) {
        if (typeof out.ready.url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(out.ready.url)) throw new InventoryError(`${where}.ready.url must be a loopback http:// URL`);
        // release: after a restart, <ready origin>/release.json must name the release just deployed.
        // allUnits: every unit must be active, not only the one behind the ready URL.
        out.ready = { timeoutSeconds: 90, headers: {}, release: false, allUnits: false, ...out.ready };
    }
    for (const p of out.packages) if (p !== '.') rel(p.replace(/\/\*$/, ''), `${where}.packages`);
    for (const p of out.skipPackages) if (typeof p !== 'string' || !p || path.isAbsolute(p) || p.includes('..')) throw new InventoryError(`${where}.skipPackages must be package directories or prefixes such as apps/_*`);
    for (const p of out.generated) rel(p, `${where}.generated`);
    if (!FILE_NAME_RE.test(out.install.lockfile)) throw new InventoryError(`${where}.install.lockfile must be a file name`);
    if (out.unitsMatch != null && !/^[A-Za-z0-9@._-]*\*[A-Za-z0-9@._*-]*\.service$/.test(out.unitsMatch)) throw new InventoryError(`${where}.unitsMatch must be a unit-file glob such as openvibe-tools*.service`);
    if (out.announce.releaseFiles != null && !/^[A-Za-z0-9._-]+\/\*\/release\.json$/.test(out.announce.releaseFiles)) throw new InventoryError(`${where}.announce.releaseFiles must look like dist/*/release.json`);
    if (out.strategy === 'release-layout') {
        for (const src of Object.values(out.unitSources)) rel(src, `${where}.unitSources`);
        if (out.generated.length) throw new InventoryError(`${where}.generated: a release-layout service builds each release in its own directory`);
    }
    if (!Array.isArray(out.install.command) || !out.install.command.length) throw new InventoryError(`${where}.install.command must be an argv array`);
    for (const b of out.build) if (!Array.isArray(b) || !b.length) throw new InventoryError(`${where}.build entries must be argv arrays`);
    if (!DRAIN_POLICIES.includes(out.drain.policy)) throw new InventoryError(`${where}.drain.policy must be one of ${DRAIN_POLICIES.join(', ')}`);
    if (out.protected) {
        const checkProbe = (p, at, nested) => {
            const kinds = nested ? PROBE_KINDS.filter((k) => k !== 'sum') : PROBE_KINDS;
            if (!kinds.includes(p.kind)) throw new InventoryError(`${at}.kind must be one of ${kinds.join(', ')}`);
            if (p.kind === 'http-json-count' && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(p.url || '')) throw new InventoryError(`${at}.url must be a loopback http:// URL`);
            if (p.kind === 'sqlite-count') {
                abs(p.db, `${at}.db`);
                if (!/^\s*select\b/i.test(p.sql || '')) throw new InventoryError(`${at}.sql must be a SELECT`);
            }
            if (p.kind === 'sum') {
                if (!Array.isArray(p.probes) || !p.probes.length) throw new InventoryError(`${at}.probes must be a non-empty array`);
                p.probes.forEach((q, i) => checkProbe(q || {}, `${at}.probes[${i}]`, true));
            }
        };
        checkProbe(out.protected, `${where}.protected`, false);
    }
    if (out.nginx) {
        const n = out.nginx;
        if (n.vhost && !FILE_NAME_RE.test(n.vhost)) throw new InventoryError(`${where}.nginx.vhost must be a file name, not a path`);
        if (n.repoVhost) rel(n.repoVhost, `${where}.nginx.repoVhost`);
        if (n.repoVhosts) rel(n.repoVhosts.replace(/\*\.conf$/, 'x.conf'), `${where}.nginx.repoVhosts`);
        if (n.variant && !['http', 'sse', 'websocket'].includes(n.variant)) throw new InventoryError(`${where}.nginx.variant must be http, sse or websocket`);
        if (n.certName && !FILE_NAME_RE.test(n.certName)) throw new InventoryError(`${where}.nginx.certName must be a name`);
    }
    if (out.lifecycle !== null && (typeof out.lifecycle !== 'object' || Array.isArray(out.lifecycle))) throw new InventoryError(`${where}.lifecycle must be an object (the manifest's lifecycle block)`);
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
 *   databases   { <database name>: <ENV VAR that points the service at that file> }, or
 *               { <database name>: { "env": "DATA_DIR", "dir": true } } when the service takes a data
 *               DIRECTORY: the copy lands in {tmp}/data/ (or "dir": "{tmp}/<name>") under its
 *               production file name and the env var (optional) points at that directory. Without
 *               "env", pair the directory with `bind`.
 *   env         { NAME: value } overrides that turn side effects off; values may use {tmp}, {port}
 *               and {db:<name>}
 *   dirs        directories to create (owned by the service user) inside {tmp} before the start
 *   command     argv to start the service; default: the production unit's ExecStart
 *   unit        which of the service's units to start (its ExecStart, WorkingDirectory and
 *               Environment=); required with several units unless `command` is set
 *   productionPort  the production port the compare paths are fetched from (default: the service's
 *               port); set it when `unit` is not the one listening on that port
 *   bind        [{ from: "{tmp}/…", to: "<absolute path inside the checkout>" }] bind mounts in the
 *               drill instance's own mount namespace, for paths the service opens relative to its
 *               checkout with no env override (production never sees them)
 *   requires    [{ file: "<path in the checkout>", contains: "<text>" }] the drill refuses to start
 *               unless the deployed checkout has each switch it relies on (an older release would
 *               ignore the override and run its side effects)
 *   ready       readiness path; default: the path of the service's ready URL
 *   compare     [{ path, ignore: [volatile keys], headers }] read-only GETs compared with production
 *   counts      [{ db, table }] row counts compared between production and the restored copy
 *   acceptance  [{ path, status: 200, keys: [top-level JSON keys] }] GETs the restored instance alone must
 *               answer (roadmap WS-S task 2): the acceptance subset for services whose answers differ from
 *               production by nature (queues, clocks) or that have no public read to compare
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
    const rawDatabases = raw.databases || {};
    if (typeof rawDatabases !== 'object' || Array.isArray(rawDatabases) || !Object.keys(rawDatabases).length) throw new InventoryError(`${w}.databases must map at least one database name to an env var name`);
    const databases = {};
    const inDataDir = new Map();
    for (const [name, target] of Object.entries(rawDatabases)) {
        if (!dbNames.includes(name)) throw new InventoryError(`${w}.databases: "${name}" is not one of ${svc.id}'s databases (${dbNames.join(', ')})`);
        if (typeof target === 'string') {
            if (!ENV_NAME_RE.test(target)) throw new InventoryError(`${w}.databases.${name} must be an env var name`);
            databases[name] = { env: target, dir: false };
            continue;
        }
        const dir = target && target.dir === true ? '{tmp}/data' : target && target.dir;
        if (!target || typeof target !== 'object' || typeof dir !== 'string') throw new InventoryError(`${w}.databases.${name} must be an env var name or { "env": "<NAME>", "dir": true }`);
        if (!/^\{tmp\}\/[A-Za-z0-9._-]+$/.test(dir)) throw new InventoryError(`${w}.databases.${name}.dir must be true or "{tmp}/<name>"`);
        if (target.env != null && !ENV_NAME_RE.test(target.env)) throw new InventoryError(`${w}.databases.${name}.env must be an env var name`);
        const dest = `${dir}/${path.basename(svc.databases.find((d) => d.name === name).path)}`;
        if (inDataDir.has(dest)) throw new InventoryError(`${w}.databases: ${name} and ${inDataDir.get(dest)} would both be ${dest}`);
        inDataDir.set(dest, name);
        databases[name] = { env: target.env || null, dir };
    }
    const dirEnvs = new Map();
    for (const t of Object.values(databases)) {
        if (!t.env) continue;
        const key = t.dir || `file:${t.env}`;
        if (dirEnvs.has(t.env) && dirEnvs.get(t.env) !== key) throw new InventoryError(`${w}.databases: ${t.env} would point at two different places`);
        dirEnvs.set(t.env, key);
    }
    const env = raw.env || {};
    for (const [k, v] of Object.entries(env)) {
        if (!ENV_NAME_RE.test(k)) throw new InventoryError(`${w}.env: "${k}" is not an env var name`);
        if (typeof v !== 'string' || /[\n\r\0]/.test(v)) throw new InventoryError(`${w}.env.${k} must be a one-line string`);
        for (const m of v.matchAll(PLACEHOLDER_RE)) {
            if (m[1].startsWith('db:') && !Object.keys(rawDatabases).includes(m[1].slice(3))) throw new InventoryError(`${w}.env.${k}: {${m[1]}} is not a restored database`);
        }
    }
    if (!Object.values(env).some((v) => v.includes('{port}')) && !(raw.command || []).some((a) => String(a).includes('{port}'))) throw new InventoryError(`${w}.env must point the instance at its port with {port} (e.g. "PORT": "{port}")`);
    for (const t of Object.values(databases)) if (t.env && t.env in env) throw new InventoryError(`${w}.env.${t.env} is already set by drill.databases`);
    const dirs = raw.dirs || [];
    for (const d of dirs) if (typeof d !== 'string' || !/^\{tmp\}\/[A-Za-z0-9._/-]+$/.test(d) || d.includes('..')) throw new InventoryError(`${w}.dirs entries must be paths under {tmp}`);
    if (raw.command != null && (!Array.isArray(raw.command) || !raw.command.length || raw.command.some((a) => typeof a !== 'string'))) throw new InventoryError(`${w}.command must be an argv array`);
    if (raw.command && !path.isAbsolute(raw.command[0])) throw new InventoryError(`${w}.command[0] must be an absolute path`);
    let unit = null;
    if (raw.unit != null) {
        if (!svc.units.includes(raw.unit)) throw new InventoryError(`${w}.unit must be one of ${svc.id}'s units (${svc.units.join(', ') || 'none'})`);
        unit = raw.unit;
    }
    let productionPort = svc.port || null;
    if (raw.productionPort != null) {
        productionPort = Number(raw.productionPort);
        if (!(Number.isInteger(productionPort) && productionPort >= 1 && productionPort < 65536)) throw new InventoryError(`${w}.productionPort must be a TCP port`);
        if (productionPort === port) throw new InventoryError(`${w}.productionPort must differ from the drill port`);
    }
    const bind = (raw.bind || []).map((b, i) => {
        const from = b && b.from;
        const to = b && b.to;
        if (typeof from !== 'string' || !/^\{tmp\}\/[A-Za-z0-9._/-]+$/.test(from) || from.includes('..')) throw new InventoryError(`${w}.bind[${i}].from must be a path under {tmp}`);
        if (typeof to !== 'string' || !path.isAbsolute(to) || to.includes('..') || !/^\/[A-Za-z0-9._/-]+$/.test(to)) throw new InventoryError(`${w}.bind[${i}].to must be a plain absolute path`);
        if (!svc.repo || !(to === svc.repo || to.startsWith(`${svc.repo}/`))) throw new InventoryError(`${w}.bind[${i}].to must be inside the checkout (${svc.repo}): a drill only redirects paths the service opens relative to it`);
        return { from, to };
    });
    const requires = (raw.requires || []).map((r, i) => {
        if (!r || typeof r.file !== 'string' || path.isAbsolute(r.file) || r.file.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(r.file)) throw new InventoryError(`${w}.requires[${i}].file must be a path inside the checkout`);
        if (typeof r.contains !== 'string' || !r.contains.trim()) throw new InventoryError(`${w}.requires[${i}].contains must be the text the file must contain`);
        return { file: r.file, contains: r.contains };
    });
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
    const acceptance = (raw.acceptance || []).map((a, i) => {
        const aa = typeof a === 'string' ? { path: a } : a;
        if (!aa || typeof aa.path !== 'string' || !/^\/[^/]/.test(aa.path) || /\s/.test(aa.path)) throw new InventoryError(`${w}.acceptance[${i}].path must be a path such as /api/health`);
        const status = aa.status == null ? 200 : Number(aa.status);
        if (!Number.isInteger(status) || status < 100 || status > 599) throw new InventoryError(`${w}.acceptance[${i}].status must be an HTTP status`);
        const keys = aa.keys || [];
        if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k)) throw new InventoryError(`${w}.acceptance[${i}].keys must be a list of key names`);
        return { path: aa.path, status, keys, headers: aa.headers || {} };
    });
    if (!compare.length && !counts.length && !acceptance.length) throw new InventoryError(`${w} needs at least one compare path, row count or acceptance check`);
    const readyTimeoutSeconds = Number(raw.readyTimeoutSeconds || (svc.ready && svc.ready.timeoutSeconds) || 90);
    return {
        supported: true,
        port,
        databases,
        env,
        dirs,
        command: raw.command || null,
        unit,
        productionPort,
        bind,
        requires,
        ready,
        readyTimeoutSeconds,
        compare,
        counts,
        acceptance,
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
        // Where the service user's backup worker writes before root takes the copy over (see
        // commands/backup.js). The same filesystem as backupDir, so the final move is a rename.
        backupStagingDir: abs(raw.backupStagingDir || `${path.normalize(raw.backupDir || '/var/backups/openvibe').replace(/\/+$/, '')}.staging`, 'backupStagingDir'),
        drillDir: abs(raw.drillDir || '/var/lib/openvibe-drills', 'drillDir'),
        nginx: {
            sitesAvailable: abs((raw.nginx && raw.nginx.sitesAvailable) || '/etc/nginx/sites-available', 'nginx.sitesAvailable'),
            sitesEnabled: abs((raw.nginx && raw.nginx.sitesEnabled) || '/etc/nginx/sites-enabled', 'nginx.sitesEnabled'),
            bin: (raw.nginx && raw.nginx.bin) || 'nginx',
        },
        // Release notifications (lib/announce.js): the env file with Host's service credentials.
        events: { envFile: raw.events && raw.events.envFile ? abs(raw.events.envFile, 'events.envFile') : null },
        // The DNS adapter (lib/dns.js): names never proxied by Cloudflare (non-HTTP traffic, the CNAME target).
        dns: { dnsOnly: Array.isArray(raw.dns && raw.dns.dnsOnly) ? raw.dns.dnsOnly.map(String) : require('./dns').DEFAULT_DNS_ONLY },
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

module.exports = { load, normalise, service, InventoryError, STRATEGIES };
