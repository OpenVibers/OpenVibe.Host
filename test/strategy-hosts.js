'use strict';
/**
 * Fake hosts for the deploy strategies (docs/deploy-strategies.md), each shaped like the service on
 * the real host and driven through the CLI:
 *   live    release-layout: /opt/openvibe.live/{repo, releases/<time>-<sha8>, current, shared/data},
 *           the socket unit held by pid 1 on :3000, /api/streams, /release.json from the running release
 *   openre  release-layout: releases/<sha12>, npm ci into every release, chown to ubuntu, two units,
 *           worker instances that run from a release
 *   tools   multi-app: apps/gateway, img, maps and the apps/_shared package, several units
 *   sites   static-build: tracked dist/ rebuilt by node build.js, repo vhosts, no units
 *   games   pnpm-build: a pnpm workspace with tracked dist-types/, one unit, players online (report)
 *   network git-checkout with installUnits
 * Nothing touches the real machine (test/fake-host.js).
 */
const path = require('path');
const { createFakeHost } = require('./fake-host');
const { main } = require('../lib/cli');
const { normalise } = require('../lib/inventory');
const { pkgJson, lifecycleDoc } = require('./helpers');

const SECRET = 'sk_live_THIS_VALUE_MUST_NEVER_APPEAR_4f9a2c';

function base(services) {
    return { host: 'fake-host', stateDir: '/var/lib/openvibe-host', backupDir: '/var/backups/openvibe', defaults: { owner: 'ubuntu', branch: 'main' }, services };
}

/** CLI, logs and helpers every strategy host shares. */
function finish(host, doc) {
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    host.ensureDir('/etc/nginx/sites-available');
    host.ensureDir('/etc/nginx/sites-enabled');
    host.badShas = new Set();
    host.cli = async (...argv) => {
        const lines = [];
        const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {} });
        return { code, out: lines.join('\n') };
    };
    host.ctx = () => ({ exec: host.exec, inv: host.inv, log: () => {} });
    host.freeze = (id) => host.put(`/var/lib/openvibe-host/freeze/${id}.json`, JSON.stringify({ service: id, reason: 'incident drill', at: '2026-09-22T11:00:00.000Z' }), { mode: 0o640 });
    host.nodeChecks = () => host.calls.filter((c) => c.cmd === 'node');
    return host;
}

// ── Live: release layout ─────────────────────────────────────────────────────

const LIVE_UNIT = '[Service]\nWorkingDirectory=/opt/openvibe.live/current\nExecStart=/usr/bin/env node /opt/openvibe.live/current/server/index.js\n';
const LIVE_SOCKET = '[Socket]\nListenStream=127.0.0.1:3000\nBacklog=511\n';
const LIVE_DROPIN = '[Unit]\nRequires=openvibe-live.socket\n[Service]\nNonBlocking=true\n';

function liveEntry(overrides = {}) {
    return {
        repo: '/opt/openvibe.live',
        owner: 'root',
        runAs: 'ubuntu',
        strategy: 'release-layout',
        release: { links: { data: '../../shared/data' }, keep: 3, settleSeconds: 3 },
        units: ['openvibe-live.service'],
        socketUnit: 'openvibe-live.socket',
        unitSources: {
            'openvibe-live.service': 'deploy/systemd/release/openvibe-live.service',
            'openvibe-live.socket': 'deploy/systemd/release/openvibe-live.socket',
            'openvibe-live.service.d/socket.conf': 'deploy/systemd/release/openvibe-live.service.d/socket.conf',
        },
        envFile: '/etc/openvibe/live.env',
        env: { required: ['JWT_SECRET'] },
        port: 3000,
        ready: { url: 'http://127.0.0.1:3000/api/ready', timeoutSeconds: 30, release: true },
        noRestartPaths: ['public/', 'docs/', '**/*.md'],
        protected: { kind: 'http-json-count', url: 'http://127.0.0.1:3000/api/streams', array: 'streams', where: { is_live: true }, label: 'live streams' },
        drain: { policy: 'refuse', waitMaxSeconds: 600, pollSeconds: 60, quietChecks: 2 },
        databases: [{ name: 'live', path: '/opt/openvibe.live/shared/data/live.db' }],
        backupOnChange: ['server/db/schema.sql'],
        preflight: { syntaxCheck: true },
        nginx: { vhost: 'openvibe.live.conf', repoVhost: 'deploy/nginx/openvibe.live.conf', variant: 'websocket' },
        lifecycle: lifecycleDoc(),
        ...overrides,
    };
}

async function releaseLayoutHost({ id, entry, files, initialId, unitFiles = {}, owner = 'root', modules = true }) {
    const host = createFakeHost();
    const doc = base({ [id]: entry });
    finish(host, doc);
    const svc = host.inv.services[id];
    const clone = host.createRepo(svc.release.git, { owner, worktree: false });
    const sha = clone.commit(files, { message: 'initial' });
    clone.publish(sha);
    host.clone = clone;
    const first = path.join(svc.release.releasesDir, initialId(sha));
    const r = await host.exec.run('git', ['-C', svc.release.git, 'worktree', 'add', '--detach', '--quiet', first, sha], { as: owner });
    if (r.code !== 0) throw new Error(r.stderr);
    if (modules) {
        const pkg = JSON.parse(files['package.json']);
        for (const dep of Object.keys(pkg.dependencies || {})) host.put(path.join(first, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep, lock: files['package-lock.json'] }), { owner });
    }
    for (const [name, target] of Object.entries(svc.release.links)) await host.exec.symlink(target, path.join(first, name));
    await host.exec.symlink(first, svc.release.current);
    for (const [unit, src] of Object.entries(svc.unitSources)) if (files[src] != null) host.put(path.join('/etc/systemd/system', unit), files[src]);
    for (const [unit, text] of Object.entries(unitFiles)) host.put(path.join('/etc/systemd/system', unit), text);
    for (const u of svc.units) host.addUnit(u, { runningSha: sha });
    host.firstRelease = path.basename(first);
    host.releaseDir = (rid) => path.join(svc.release.releasesDir, rid);
    host.current = () => path.basename(host.resolve(svc.release.current));
    host.currentSha = () => host.repos.get(host.resolve(svc.release.current)).head;
    host.releaseIds = async () => ((await host.exec.readdir(svc.release.releasesDir)) || []).map((e) => e.name).sort();
    host.push = (changes, message = 'change') => { const s = clone.commit(changes, { message }); clone.publish(s); return s; };
    host.npmRewritesLockfile = false; // npm ci never rewrites the lockfile
    // A restarted (or started) unit runs whatever `current` points at at that moment.
    host.onRestart = (unit, u) => {
        if (unit.endsWith('.socket')) { if (host.onSocketRestart) host.onSocketRestart(unit); return; }
        const wt = host.repos.get(host.resolve(svc.release.current));
        u.runningSha = wt ? wt.head : null;
    };
    host.readyFor = (unit) => () => {
        const u = host.units.get(unit);
        if (!u || u.active !== 'active') return { status: 502 };
        return host.badShas.has(u.runningSha) ? { status: 503, body: { status: 'not_ready' } } : { status: 200, body: { status: 'ready' } };
    };
    return host;
}

const LIVE_FILES = {
    'package.json': pkgJson('openvibe-live', ['express', 'better-sqlite3']),
    'package-lock.json': '{"lockfileVersion":3,"v":1}',
    'server/index.js': 'console.log(1);',
    'server/db/schema.sql': 'CREATE TABLE a(x);',
    'public/app.js': 'app();',
    'deploy/systemd/release/openvibe-live.service': LIVE_UNIT,
    'deploy/systemd/release/openvibe-live.socket': LIVE_SOCKET,
    'deploy/systemd/release/openvibe-live.service.d/socket.conf': LIVE_DROPIN,
    'deploy/nginx/openvibe.live.conf': 'server { listen 443; }\n',
    '.env.example': 'JWT_SECRET=\n',
};

async function liveHost(overrides = {}) {
    const host = await releaseLayoutHost({ id: 'live', entry: liveEntry(overrides), files: LIVE_FILES, initialId: (sha) => `20260922-110000-${sha.slice(0, 8)}` });
    host.addUnit('openvibe-live.socket', { sub: 'listening', mainPid: 0 });
    host.listeners.set(3000, [{ pid: 1, process: 'systemd' }]);
    host.put('/etc/openvibe/live.env', `JWT_SECRET=${SECRET}\n`, { mode: 0o600 });
    host.put('/opt/openvibe.live/shared/data/live.db', 'sqlite', { owner: 'ubuntu' });
    host.liveStreams = [];
    host.http.set('http://127.0.0.1:3000/api/ready', host.readyFor('openvibe-live.service'));
    host.http.set('http://127.0.0.1:3000/api/streams', () => ({ status: 200, body: { streams: host.liveStreams } }));
    // Live names its release after the directory it runs from: <time>-<sha8>.
    host.http.set('http://127.0.0.1:3000/release.json', () => {
        const u = host.units.get('openvibe-live.service');
        return { status: 200, body: { service: 'live', release: String(u.runningSha).slice(0, 8) } };
    });
    host.calls.length = 0;
    return host;
}

// ── OpenRe: release layout, sha12 ids, workers ───────────────────────────────

function openreEntry(overrides = {}) {
    return {
        repo: '/opt/openre.stream',
        owner: 'root',
        runAs: 'ubuntu',
        strategy: 'release-layout',
        release: { id: 'sha12', reuseModules: false, chown: 'ubuntu:ubuntu', keep: 2 },
        units: ['openre-api.service', 'openre-session-coordinator.service'],
        workerUnits: ['openre-rtmp-ingest@.service', 'openre-restream-worker@.service', 'openre-jsmpeg@.service'],
        envFile: '/etc/openvibe/openre.env',
        port: 4500,
        ready: { url: 'http://127.0.0.1:4500/api/ready', timeoutSeconds: 60 },
        noRestartPaths: ['docs/', 'test/', '**/*.md'],
        databases: [{ name: 'openre', path: '/var/lib/openre/openre.db' }],
        protected: { kind: 'sqlite-count', db: '/var/lib/openre/openre.db', sql: "SELECT count(*) AS n FROM ingest_sessions WHERE state IN ('starting', 'live', 'ending')", label: 'ingest sessions' },
        drain: { policy: 'refuse' },
        lifecycle: lifecycleDoc(),
        ...overrides,
    };
}

const OPENRE_FILES = {
    'package.json': pkgJson('openre-stream', ['express', 'better-sqlite3']),
    'package-lock.json': '{"lockfileVersion":3,"v":1}',
    'server/index.js': 'api();',
    'docs/README.md': '# OpenRe',
};

async function openreHost(overrides = {}) {
    const host = await releaseLayoutHost({ id: 'openre', entry: openreEntry(overrides), files: OPENRE_FILES, initialId: (sha) => sha.slice(0, 12) });
    host.put('/etc/openvibe/openre.env', `OV_OAUTH_CLIENT_SECRET=${SECRET}\n`, { mode: 0o600 });
    host.put('/var/lib/openre/openre.db', 'sqlite', { owner: 'ubuntu' });
    host.addUnit(`openre-rtmp-ingest@${host.firstRelease}.service`, { mainPid: 3102 });
    host.addUnit(`openre-restream-worker@${host.firstRelease}.service`, { mainPid: 3103 });
    host.addUnit(`openre-jsmpeg@${host.firstRelease}.service`, { mainPid: 3105 });
    host.sessions = 0;
    host.sqliteHandler = () => [{ n: host.sessions }];
    host.http.set('http://127.0.0.1:4500/api/ready', host.readyFor('openre-api.service'));
    host.calls.length = 0;
    return host;
}

// ── in-place strategies ──────────────────────────────────────────────────────

function inPlace(host, id, files, packages = ['.']) {
    const svc = host.inv.services[id];
    const repo = host.createRepo(svc.repo, { owner: svc.owner });
    const sha = repo.commit(files, { message: 'initial' });
    repo.publish(sha);
    repo.checkout(sha);
    for (const dir of packages) {
        const pkg = JSON.parse(files[path.join(dir, 'package.json')]);
        for (const dep of Object.keys(pkg.dependencies || {})) host.put(path.join(svc.repo, dir, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep }), { owner: 'ubuntu' });
    }
    for (const u of svc.units) host.addUnit(u, { runningSha: sha });
    host.repo = repo;
    host.push = (changes, message = 'change') => { const s = repo.commit(changes, { message }); repo.publish(s); return s; };
    host.onRestart = (unit, u) => { u.runningSha = repo.head; };
    host.readyFor = (unit) => () => {
        const u = host.units.get(unit);
        if (!u || u.active !== 'active') return { status: 502 };
        return host.badShas.has(u.runningSha) ? { status: 503, body: { status: 'not_ready' } } : { status: 200, body: { status: 'ready' } };
    };
    return repo;
}

// Tools: multi-app.
const TOOLS_UNITS = ['openvibe-tools.service', 'openvibe-tools-img.service', 'openvibe-tools-maps.service'];
function toolsEntry(overrides = {}) {
    return {
        repo: '/opt/openvibe.tools',
        strategy: 'multi-app',
        units: TOOLS_UNITS,
        unitsMatch: 'openvibe-tools*.service',
        port: 4001,
        ready: { url: 'http://127.0.0.1:4001/api/ready', headers: { Host: 'openvibe.tools' }, timeoutSeconds: 60, release: true, allUnits: true },
        noRestartPaths: ['**/*.md'],
        preflight: {
            dirs: ['data'],
            checks: [
                { label: 'jobs runtime loads', packages: ['apps/img'], argv: ['node', '-e', "const D=require('better-sqlite3'); new D(':memory:').close(); require('openvibe-contracts'); require('openvibe-sdk'); require('../_shared/jobs')"] },
                { label: 'guard loads', packages: '*', argv: ['node', '-e', "const D=require('better-sqlite3'); new D(':memory:').close(); require('../_shared/guard')"] },
            ],
        },
        protected: { kind: 'sum', label: 'running tool jobs', probes: [{ kind: 'sqlite-count', db: '/opt/openvibe.tools/apps/img/data/jobs.db', sql: "SELECT count(*) AS n FROM tool_jobs WHERE state = 'running'" }] },
        drain: { policy: 'report', waitMaxSeconds: 900, pollSeconds: 60, quietChecks: 2 },
        lifecycle: lifecycleDoc(),
        ...overrides,
    };
}

const TOOLS_FILES = {
    'apps/gateway/package.json': pkgJson('tools-gateway', ['express', 'better-sqlite3']),
    'apps/gateway/package-lock.json': '{"v":1}',
    'apps/gateway/server/index.js': 'gw();',
    'apps/img/package.json': pkgJson('tools-img', ['express', 'better-sqlite3', 'openvibe-contracts', 'openvibe-sdk']),
    'apps/img/package-lock.json': '{"v":1}',
    'apps/img/server/index.js': 'img();',
    'apps/maps/package.json': pkgJson('tools-maps', ['express', 'better-sqlite3']),
    'apps/maps/server/index.js': 'maps();',
    'apps/_shared/package.json': JSON.stringify({ name: 'openvibe-tools-shared', version: '1.1.0', private: true }),
    'apps/_shared/guard/index.js': 'guard();',
    'apps/_shared/jobs/index.js': 'jobs();',
    'README.md': '# Tools',
};

function toolsHost(overrides = {}) {
    const host = finish(createFakeHost(), base({ tools: toolsEntry(overrides) }));
    inPlace(host, 'tools', TOOLS_FILES, ['apps/gateway', 'apps/img', 'apps/maps']);
    host.http.set('http://127.0.0.1:4001/api/ready', host.readyFor('openvibe-tools.service'));
    host.gatewayRelease = null; // override what the gateway's /release.json names
    host.http.set('http://127.0.0.1:4001/release.json', ({ headers }) => {
        if (headers.Host !== 'openvibe.tools') return { status: 404 };
        const u = host.units.get('openvibe-tools.service');
        return { status: 200, body: { service: 'tools', release: host.gatewayRelease || String(u.runningSha).slice(0, 12) } };
    });
    host.jobs = 0;
    host.sqliteHandler = () => [{ n: host.jobs }];
    return host;
}

// Sites: static-build.
function sitesEntry(overrides = {}) {
    return { repo: '/opt/openvibe.sites', strategy: 'static-build', units: [], lifecycle: lifecycleDoc({ liveness: { none: 'static files served by nginx' }, shutdown: { none: 'no process of its own' }, startupRecovery: { none: 'nothing in flight' } }), ...overrides };
}

const SITES_FILES = {
    'package.json': pkgJson('openvibe-sites', ['openvibe-shared']),
    'package-lock.json': '{"v":1}',
    'build.js': 'build();',
    'sites.json': '{"sites":["openvibe.news","openvibe.tips"]}',
    'dist/openvibe.news/index.html': '<h1>News</h1> 2026-09-21',
    'dist/openvibe.news/release.json': JSON.stringify({ service: 'news', release: 'aaaaaaaaaaaa' }),
    'dist/openvibe.tips/index.html': '<h1>Tips</h1> 2026-09-21',
    'dist/openvibe.tips/release.json': JSON.stringify({ service: 'tips', release: 'bbbbbbbbbbbb' }),
    'deploy/nginx/openvibe.news.conf': 'server { listen 443; server_name openvibe.news; }\n',
    'deploy/nginx/openvibe.tips.conf': 'server { listen 443; server_name openvibe.tips; }\n',
};

function sitesHost(overrides = {}) {
    const host = finish(createFakeHost(), base({ sites: sitesEntry(overrides) }));
    inPlace(host, 'sites', SITES_FILES, ['.']);
    // node build.js on the host rewrites the tracked dist/ with today's date: a build leaves it dirty.
    host.onNode = (args, opts) => {
        if (args[0] !== 'build.js') return undefined;
        host.builds = (host.builds || 0) + 1;
        if (host.buildFails && host.repo.head === host.buildFails) return { code: 1, stderr: 'build.js: sites.json is not valid' };
        for (const f of ['dist/openvibe.news/index.html', 'dist/openvibe.tips/index.html']) {
            const cur = host.read(path.join(opts.cwd, f));
            if (cur != null) host.put(path.join(opts.cwd, f), cur.replace(/\d{4}-\d{2}-\d{2}/, '2026-09-22'), { owner: opts.as });
        }
        return { code: 0 };
    };
    return host;
}

// Games: pnpm-build.
function gamesEntry(overrides = {}) {
    return {
        repo: '/opt/openvibe.games',
        strategy: 'pnpm-build',
        units: ['openvibe-games.service'],
        port: 8000,
        ready: { url: 'http://127.0.0.1:8000/api/ready', timeoutSeconds: 60 },
        generated: ['apps/client/dist-types/', 'apps/server/dist-types/'],
        preflight: { checks: [{ label: 'better-sqlite3 loads under this Node', packages: ['apps/server'], argv: ['node', '-e', "new (require('better-sqlite3'))(':memory:').close()"] }] },
        protected: { kind: 'http-json-count', url: 'http://127.0.0.1:8000/api/ready', field: 'checks.sessions.detail.online', label: 'players online' },
        drain: { policy: 'report', waitMaxSeconds: 600, pollSeconds: 60, quietChecks: 2 },
        databases: [{ name: 'world', path: '/opt/openvibe.games/data/world.db' }],
        lifecycle: lifecycleDoc(),
        ...overrides,
    };
}

const GAMES_FILES = {
    'package.json': JSON.stringify({ name: 'openvibe-games', private: true, scripts: { build: 'pnpm -r build' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\nv: 1\n',
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - apps/*\n',
    'apps/server/package.json': pkgJson('@openvibe/server', ['@openvibe/shared', 'better-sqlite3', 'tsx']),
    'apps/server/src/main.ts': 'main();',
    'apps/server/dist-types/main.d.ts': 'export {};\n',
    'apps/client/package.json': pkgJson('@openvibe/client', ['@openvibe/shared']),
    'apps/client/src/main.ts': 'client();',
    'apps/client/dist-types/main.d.ts': 'export {};\n',
    'packages/shared/package.json': JSON.stringify({ name: '@openvibe/shared', version: '0.1.0' }),
    'packages/shared/src/index.ts': 'export const x = 1;',
};

function gamesHost(overrides = {}) {
    const host = finish(createFakeHost(), base({ games: gamesEntry(overrides) }));
    inPlace(host, 'games', GAMES_FILES, ['apps/server', 'apps/client']);
    host.players = 0;
    host.http.set('http://127.0.0.1:8000/api/ready', () => {
        const r = host.readyFor('openvibe-games.service')();
        return r.status === 200 ? { status: 200, body: { status: 'ready', checks: { sessions: { detail: { online: host.players } } } } } : r;
    });
    // pnpm build writes the client bundle that is served and rewrites the tracked dist-types.
    host.onBuild = (cwd, argv, as) => {
        host.builds = (host.builds || 0) + 1;
        if (host.buildFails && host.repo.head === host.buildFails) return { code: 1, stderr: 'tsc: error TS2322' };
        host.put(path.join(cwd, 'apps/client/dist/index.html'), `client built from ${host.repo.head}`, { owner: as });
        host.put(path.join(cwd, 'apps/client/dist-types/main.d.ts'), `export {}; // built ${host.repo.head.slice(0, 7)}\n`, { owner: as });
        return { code: 0 };
    };
    host.put('/opt/openvibe.games/data/world.db', 'sqlite', { owner: 'ubuntu' });
    return host;
}

// Network: git-checkout, unit files installed on every deploy.
function networkHost() {
    const entry = {
        repo: '/opt/openvibe.network',
        units: ['openvibe-network.service'],
        unitSources: { 'openvibe-network.service': 'deploy/systemd/openvibe-network.service' },
        installUnits: true,
        port: 4000,
        ready: { url: 'http://127.0.0.1:4000/api/ready', timeoutSeconds: 30 },
        noRestartPaths: ['docs/', '**/*.md'],
        lifecycle: lifecycleDoc(),
    };
    const host = finish(createFakeHost(), base({ network: entry }));
    inPlace(host, 'network', {
        'package.json': pkgJson('openvibe-network', ['express']),
        'package-lock.json': '{"v":1}',
        'server/index.js': 'net();',
        'deploy/systemd/openvibe-network.service': '[Service]\nExecStart=node server/index.js\n',
    }, ['.']);
    host.put('/etc/systemd/system/openvibe-network.service', '[Service]\nExecStart=node server/index.js\n');
    host.http.set('http://127.0.0.1:4000/api/ready', host.readyFor('openvibe-network.service'));
    return host;
}

module.exports = { liveHost, liveEntry, openreHost, toolsHost, sitesHost, gamesHost, networkHost, LIVE_SOCKET, SECRET };
