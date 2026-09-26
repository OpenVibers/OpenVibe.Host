'use strict';
/**
 * A standard fake host with the shapes of the real estate: Live (socket-activated, /api/streams),
 * Media (recordings counted in SQLite), Tools (several packages and units), Sites (static build +
 * nginx vhosts, no units) and Events (SSE, drain policy "report").
 */
const path = require('path');
const { createFakeHost } = require('./fake-host');
const { main } = require('../lib/cli');
const { normalise } = require('../lib/inventory');

const SECRET = 'sk_live_THIS_VALUE_MUST_NEVER_APPEAR_4f9a2c';

function pkgJson(name, deps) {
    return JSON.stringify({ name, version: '1.0.0', dependencies: Object.fromEntries(deps.map((d) => [d, '^1.0.0'])) }, null, 2);
}

// A complete lifecycle declaration (the manifest block, WS-P task 1), carried inline because the
// openvibe-contracts this repository pins predates it.
function lifecycleDoc(overrides = {}) {
    return {
        liveness: { endpoint: '/api/health', means: 'the process answers HTTP; nothing else is checked' },
        shutdown: { signal: 'SIGTERM', deadlineSeconds: 5, drains: ['HTTP server closed', 'database closed'] },
        startupRecovery: { resumes: [{ kind: 'outbox', what: 'unsent events go to OpenVibe.Events' }] },
        rollback: { conditions: ['automatic: not ready within ready.timeoutSeconds'], window: 'while ovhost waits for readiness', blockers: { none: 'the schema only adds' } },
        contracts: { range: '>=0.2.0 <1.0.0' },
        leases: { none: 'one process owns its database' },
        ...overrides,
    };
}

function inventoryDoc() {
    return {
        host: 'fake-host',
        stateDir: '/var/lib/openvibe-host',
        backupDir: '/var/backups/openvibe',
        defaults: { owner: 'ubuntu', branch: 'main' },
        services: {
            live: {
                repo: '/opt/openvibe.live',
                units: ['openvibe-live.service'],
                socketUnit: 'openvibe-live.socket',
                unitSources: { 'openvibe-live.service': 'deploy/systemd/openvibe-live.service' },
                envFile: '/etc/openvibe/live.env',
                env: { required: ['JWT_SECRET', 'OV_OAUTH_CLIENT_SECRET', 'BASE_URL', 'PAYPAL_CLIENT_SECRET'] },
                port: 3000,
                ready: { url: 'http://127.0.0.1:3000/api/ready', timeoutSeconds: 30 },
                noRestartPaths: ['public/', 'docs/', '*.md'],
                protected: { kind: 'http-json-count', url: 'http://127.0.0.1:3000/api/streams', array: 'streams', where: { is_live: true }, label: 'live streams' },
                drain: { policy: 'refuse', waitMaxSeconds: 600, pollSeconds: 60, quietChecks: 2 },
                databases: [{ name: 'live', path: '/opt/openvibe.live/data/live.db' }],
                backupOnChange: ['server/db/schema.sql'],
                nginx: { vhost: 'openvibe.live.conf', variant: 'websocket', wsPaths: ['/ws/'] },
                lifecycle: lifecycleDoc(),
            },
            media: {
                repo: '/opt/openvibe.media',
                units: ['openvibe-media.service'],
                envFile: '/etc/openvibe/media.env',
                env: { required: 'from-example' },
                port: 4100,
                ready: { url: 'http://127.0.0.1:4100/healthz', timeoutSeconds: 30 },
                protected: { kind: 'sqlite-count', db: '/opt/openvibe.media/data/media.db', sql: 'SELECT count(*) AS n FROM vods WHERE is_recording = 1', label: 'recordings in progress' },
                databases: [{ name: 'media', path: '/opt/openvibe.media/data/media.db' }],
                lifecycle: lifecycleDoc({ liveness: { endpoint: '/healthz', means: 'the process answers HTTP and reads its database' }, shutdown: { signal: 'SIGTERM', deadlineSeconds: 70, drains: ['recordings stopped', 'HTTP server closed'] } }),
            },
            tools: {
                repo: '/opt/openvibe.tools',
                packages: ['apps/*'],
                units: ['openvibe-tools.service', 'openvibe-tools-maps.service'],
                port: 4001,
                ready: { url: 'http://127.0.0.1:4001/api/health', headers: { Host: 'openvibe.tools' }, timeoutSeconds: 30 },
                lifecycle: lifecycleDoc(),
            },
            sites: {
                repo: '/opt/openvibe.sites',
                units: [],
                install: { command: ['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], always: true },
                build: [['node', 'build.js']],
                nginx: { repoVhosts: 'deploy/nginx/*.conf', installOnDeploy: true },
                lifecycle: lifecycleDoc({ liveness: { none: 'static files served by nginx' }, shutdown: { none: 'no process of its own' }, startupRecovery: { none: 'nothing in flight' } }),
            },
            events: {
                repo: '/opt/openvibe.events',
                units: ['openvibe-events.service'],
                port: 4300,
                ready: { url: 'http://127.0.0.1:4300/api/ready', timeoutSeconds: 30 },
                protected: { kind: 'http-json-count', url: 'http://127.0.0.1:4300/api/ready', field: 'realtime_connections', label: 'SSE connections' },
                drain: { policy: 'report' },
                nginx: { variant: 'sse', ssePaths: ['/realtime/stream'] },
                lifecycle: lifecycleDoc({ shutdown: { signal: 'SIGTERM', deadlineSeconds: 10, drains: ['SSE streams stopped', 'deliveries in flight awaited'] } }),
            },
        },
    };
}

function scenario() {
    const host = createFakeHost();
    const doc = inventoryDoc();
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    const inv = normalise(doc);
    host.inv = inv;
    host.badShas = new Set();
    host.liveStreams = [];
    host.recording = 0;
    host.sseConnections = 0;
    host.unitRepo = {};

    const repoFor = {};
    function service(id, initialFiles, packages) {
        const svc = inv.services[id];
        const repo = host.createRepo(svc.repo, { owner: 'ubuntu' });
        const sha = repo.commit(initialFiles, { message: 'initial' });
        repo.publish(sha);
        repo.checkout(sha);
        for (const pkgDir of packages) {
            const pkg = JSON.parse(initialFiles[path.join(pkgDir, 'package.json')]);
            for (const dep of Object.keys(pkg.dependencies || {})) host.put(path.join(svc.repo, pkgDir, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep }), { owner: 'ubuntu' });
        }
        for (const u of svc.units) {
            host.addUnit(u, { runningSha: sha });
            host.unitRepo[u] = repo;
        }
        repoFor[id] = repo;
        return repo;
    }

    service('live', {
        'package.json': pkgJson('openvibe-live', ['express', 'better-sqlite3', 'openvibe-shared']),
        'package-lock.json': '{"lockfileVersion":3,"v":1}',
        'server/index.js': 'console.log(1);',
        'server/db/schema.sql': 'CREATE TABLE a(x);',
        'public/app.js': 'app();',
        'deploy/systemd/openvibe-live.service': '[Service]\nExecStart=node server/index.js\n',
        '.env.example': 'JWT_SECRET=\nBASE_URL=https://openvibe.live\nPAYPAL_CLIENT_SECRET=\nOV_OAUTH_CLIENT_SECRET=\n# OPTIONAL_THING=\nTURN_URL=\n',
    }, ['.']);
    host.addUnit('openvibe-live.socket', { sub: 'listening', partOf: ['openvibe-live.service'], mainPid: 0 });
    host.put('/etc/systemd/system/openvibe-live.service', '[Service]\nExecStart=node server/index.js\nEnvironment=NODE_ENV=production\n');
    host.put('/etc/openvibe/live.env', `JWT_SECRET=${SECRET}\nBASE_URL=https://openvibe.live\nPAYPAL_CLIENT_SECRET="${SECRET}-paypal"\nOV_OAUTH_CLIENT_SECRET=${SECRET}-oauth\n`, { mode: 0o600 });
    host.put('/opt/openvibe.live/data/live.db', 'sqlite', { owner: 'ubuntu' });

    service('media', {
        'package.json': pkgJson('openvibe-media', ['express', 'better-sqlite3']),
        'package-lock.json': '{"lockfileVersion":3,"v":1}',
        'server/index.js': 'media();',
        '.env.example': 'PORT=4100\nMEDIA_B2_APP_KEY=\nMEDIA_R2_SECRET_ACCESS_KEY=\n',
    }, ['.']);
    host.put('/etc/openvibe/media.env', `PORT=4100\nMEDIA_B2_APP_KEY=${SECRET}-b2\nMEDIA_R2_SECRET_ACCESS_KEY=${SECRET}-r2\n`, { mode: 0o600 });
    host.put('/opt/openvibe.media/data/media.db', 'sqlite', { owner: 'ubuntu' });

    service('tools', {
        'apps/gateway/package.json': pkgJson('tools-gateway', ['express', 'openvibe-shared']),
        'apps/gateway/package-lock.json': '{"v":1}',
        'apps/gateway/server.js': 'gw();',
        'apps/maps/package.json': pkgJson('tools-maps', ['express']),
        'apps/maps/package-lock.json': '{"v":1}',
        'apps/maps/server.js': 'maps();',
    }, ['apps/gateway', 'apps/maps']);

    service('sites', {
        'package.json': pkgJson('openvibe-sites', ['openvibe-shared']),
        'package-lock.json': '{"v":1}',
        'build.js': 'build();',
        'deploy/nginx/openvibe.chat.conf': 'server { listen 443; server_name openvibe.chat; }\n',
    }, ['.']);

    service('events', {
        'package.json': pkgJson('openvibe-events', ['express']),
        'package-lock.json': '{"v":1}',
        'server/index.js': 'events();',
    }, ['.']);

    host.ensureDir('/etc/nginx/sites-available');
    host.ensureDir('/etc/nginx/sites-enabled');

    // A restarted unit runs whatever its checkout holds at that moment.
    host.onRestart = (unit, u) => { if (host.unitRepo[unit]) u.runningSha = host.unitRepo[unit].head; };
    const readyFor = (unit) => () => {
        const u = host.units.get(unit);
        if (!u || u.active !== 'active') return { status: 502 };
        return host.badShas.has(u.runningSha) ? { status: 503, body: { status: 'not_ready' } } : { status: 200, body: { status: 'ready', realtime_connections: host.sseConnections } };
    };
    host.http.set('http://127.0.0.1:3000/api/ready', readyFor('openvibe-live.service'));
    host.http.set('http://127.0.0.1:3000/api/streams', () => ({ status: 200, body: { streams: host.liveStreams } }));
    host.http.set('http://127.0.0.1:4100/healthz', readyFor('openvibe-media.service'));
    host.http.set('http://127.0.0.1:4001/api/health', readyFor('openvibe-tools.service'));
    host.http.set('http://127.0.0.1:4300/api/ready', readyFor('openvibe-events.service'));
    host.sqliteHandler = (db, sql) => (/is_recording/.test(sql) ? [{ n: host.recording }] : [{ n: 0 }]);

    host.repo = (id) => repoFor[id];
    host.ctx = () => ({ exec: host.exec, inv, log: (s) => host.logs.push(s) });
    host.logs = [];
    host.cli = async (...argv) => {
        const lines = [];
        const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {} });
        return { code, out: lines.join('\n') };
    };
    return host;
}

/** Publish a new commit on origin/main for a service. */
function push(host, id, changes, message = 'change') {
    const repo = host.repo(id);
    const sha = repo.commit(changes, { message });
    repo.publish(sha);
    return sha;
}

function test(name, fn) {
    return { name, fn };
}

async function runTests(tests) {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed += 1;
            console.log(`  ✗ ${t.name}\n${err.stack}`);
        }
    }
    if (failed) { console.log(`${failed} failed`); process.exit(1); }
}

module.exports = { scenario, push, test, runTests, SECRET, pkgJson, lifecycleDoc };
