'use strict';
/**
 * The readiness check (deploy/scripts/ready-health.sh, docs/ready-health.md): every service in the host
 * inventory with a ready.url gets one GET with its ready.headers — 1 for a 2xx, 0 for any other answer or
 * no answer at all, no line without a ready URL — plus the last-run timestamp. The textfile collector's
 * file is replaced in one rename, and an inventory it cannot read leaves the previous file alone, so a
 * broken list is never green. The script runs for real here; the services are local HTTP servers.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');
const { test, runTests } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'scripts', 'ready-health.sh');
const PROM = 'openvibe_service_ready.prom';

function service(status, { location } = {}) {
    const s = http.createServer((req, res) => {
        s.hits.push({ url: req.url, headers: req.headers });
        res.statusCode = status;
        if (location) res.setHeader('location', location);
        res.end(status >= 500 ? 'not ready' : 'ok');
    });
    s.hits = [];
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
}

const originOf = (s) => `http://127.0.0.1:${s.address().port}`;

/** A port nothing listens on: the check is asked to meet a service that does not answer. */
function closedPort() {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
    });
}

function base() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ready-health-'));
}

function textfileDir(dirPath) {
    const d = path.join(dirPath, 'textfile');
    fs.mkdirSync(d);
    return d;
}

function inventoryFile(dirPath, services) {
    const file = path.join(dirPath, 'host.json');
    fs.writeFileSync(file, JSON.stringify({ host: 'test-host', services }));
    return file;
}

function inventoryRaw(dirPath, body) {
    const file = path.join(dirPath, 'host.json');
    fs.writeFileSync(file, body);
    return file;
}

// execFile, not spawnSync: the services are servers in this process, and a blocked event loop could not
// answer them (every service would meet a timeout instead).
function run(inventory, textfile) {
    return new Promise((resolve) => {
        execFile('bash', [SCRIPT], {
            timeout: 120000,
            env: { ...process.env, OVHOST_INVENTORY: inventory, TEXTFILE_DIR: textfile },
        }, (err, stdout, stderr) => resolve({ status: err ? (err.code == null ? null : err.code) : 0, stdout, stderr }));
    });
}

const prom = (textfile) => {
    try { return fs.readFileSync(path.join(textfile, PROM), 'utf8'); } catch { return null; }
};

runTests([
    test('every service with a ready URL is probed once; 2xx is 1, everything else 0, headers are sent', async () => {
        const ok = await service(200);
        const created = await service(201);
        const refused = await service(503);
        const broken = await service(500);
        const redirect = await service(302, { location: '/sign-in' });
        const gate = await service(401);
        const tools = await service(200);
        const dead = await closedPort();
        const dir = base();
        const textfile = textfileDir(dir);
        const inventory = inventoryFile(dir, {
            live: { ready: { url: `${originOf(ok)}/api/ready` } },
            codes: { ready: { url: `${originOf(created)}/api/ready` } },
            cam: { ready: { url: `${originOf(refused)}/api/ready` } },
            chat: { ready: { url: `${originOf(broken)}/api/ready` } },
            blog: { ready: { url: `${originOf(redirect)}/api/ready` } },
            ai: { ready: { url: `${originOf(gate)}/api/ready` } },
            work: { ready: { url: `http://127.0.0.1:${dead}/api/ready` } },
            tools: {
                ready: {
                    url: `${originOf(tools)}/api/ready`,
                    headers: { Host: 'openvibe.tools', Authorization: 'Bearer test-secret' },
                },
            },
            sites: { repo: '/opt/openvibe.sites' },
        });
        const r = await run(inventory, textfile);
        for (const s of [ok, created, refused, broken, redirect, gate, tools]) s.close();
        assert.strictEqual(r.status, 1, r.stderr);
        for (const s of [ok, created, refused, broken, redirect, gate, tools]) {
            assert.deepStrictEqual(s.hits.map((h) => h.url), ['/api/ready'], 'exactly one probe per service');
        }
        assert.strictEqual(tools.hits[0].headers.host, 'openvibe.tools', 'the inventory ready.headers are sent');
        assert.strictEqual(tools.hits[0].headers.authorization, 'Bearer test-secret');
        const file = prom(textfile);
        assert.match(file, /^# TYPE openvibe_service_ready gauge$/m);
        for (const id of ['live', 'codes', 'tools']) assert.match(file, new RegExp(`^openvibe_service_ready\\{service="${id}"\\} 1$`, 'm'));
        for (const id of ['cam', 'chat', 'blog', 'ai', 'work']) assert.match(file, new RegExp(`^openvibe_service_ready\\{service="${id}"\\} 0$`, 'm'), id);
        assert.ok(!/service="sites"/.test(file), 'a service with no ready URL gets no line');
        assert.match(file, /^openvibe_service_ready_last_run_timestamp \d+$/m);
        const lines = r.stdout.trim().split('\n');
        assert.deepStrictEqual(lines.slice(0, 8), [
            'openvibe_service_ready{service="ai"} 0',
            'openvibe_service_ready{service="blog"} 0',
            'openvibe_service_ready{service="cam"} 0',
            'openvibe_service_ready{service="chat"} 0',
            'openvibe_service_ready{service="codes"} 1',
            'openvibe_service_ready{service="live"} 1',
            'openvibe_service_ready{service="tools"} 1',
            'openvibe_service_ready{service="work"} 0',
        ]);
        assert.match(lines[8], /^openvibe_service_ready_last_run_timestamp \d+$/);
        assert.ok(Math.abs(Date.now() / 1000 - Number(lines[8].split(' ')[1])) < 60, 'the run timestamp is now');
        assert.ok(!/test-secret/.test(r.stdout) && !/test-secret/.test(r.stderr), 'a header secret is never printed');
        assert.deepStrictEqual(fs.readdirSync(textfile), [PROM], 'no temp file is left behind');
    }),
    test('all 2xx exits 0, a service without a ready URL is skipped, and the file is replaced in one rename', async () => {
        const live = await service(200);
        const blog = await service(204);
        const dir = base();
        const textfile = textfileDir(dir);
        const inventory = inventoryFile(dir, {
            live: { ready: { url: originOf(live) } },
            blog: { ready: { url: `${originOf(blog)}/api/ready` } },
            sites: { repo: '/opt/openvibe.sites' },
        });
        let r = await run(inventory, textfile);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(prom(textfile), /^openvibe_service_ready\{service="live"\} 1$/m);
        assert.match(prom(textfile), /^openvibe_service_ready\{service="blog"\} 1$/m);
        assert.ok(!/service="sites"/.test(prom(textfile)));
        const first = fs.statSync(path.join(textfile, PROM)).ino;
        const firstTs = Number(prom(textfile).match(/last_run_timestamp (\d+)/)[1]);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        r = await run(inventory, textfile);
        assert.strictEqual(r.status, 0, r.stderr);
        const second = fs.statSync(path.join(textfile, PROM)).ino;
        const secondTs = Number(prom(textfile).match(/last_run_timestamp (\d+)/)[1]);
        assert.notStrictEqual(second, first, 'a rename, not a rewrite in place');
        assert.ok(secondTs > firstTs, 'the run timestamp moves');
        assert.deepStrictEqual([live.hits.length, blog.hits.length], [2, 2]);
        live.close();
        blog.close();
    }),
    test('an inventory it cannot read, is not JSON, or names no ready URL keeps the previous file', async () => {
        const dir = base();
        const textfile = textfileDir(dir);
        fs.writeFileSync(path.join(textfile, PROM), 'openvibe_service_ready{service="live"} 1\n');
        const before = prom(textfile);
        let r = await run(path.join(dir, 'absent.json'), textfile);
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /cannot read the inventory file/);
        r = await run(inventoryRaw(dir, '<html>502</html>'), textfile);
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /is not JSON/);
        r = await run(inventoryFile(dir, { live: { repo: '/opt/openvibe.live' } }), textfile);
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /names no service with a ready URL/);
        r = await run(inventoryFile(dir, {}), textfile);
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /names no service with a ready URL/);
        assert.strictEqual(prom(textfile), before, 'an inventory that cannot be checked is not green');
    }),
    test('without the collector directory nothing is written, and the lines are still printed', async () => {
        const ok = await service(200);
        const dir = base();
        const inventory = inventoryFile(dir, { live: { ready: { url: originOf(ok) } } });
        const absent = path.join(dir, 'no-collector-here');
        const r = await run(inventory, absent);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /^openvibe_service_ready\{service="live"\} 1$/m);
        assert.match(r.stdout, /^openvibe_service_ready_last_run_timestamp \d+$/m);
        assert.ok(!fs.existsSync(path.join(absent, PROM)), 'nothing to write to, nothing written');
        ok.close();
    }),
    test('the timer is every 5 minutes, the rules page on a service that stays not ready or a check that stops', () => {
        const root = path.join(__dirname, '..');
        const timer = fs.readFileSync(path.join(root, 'deploy', 'systemd', 'openvibe-readyhealth.timer'), 'utf8');
        assert.match(timer, /^OnBootSec=5min$/m);
        assert.match(timer, /^OnUnitActiveSec=5min$/m);
        assert.match(timer, /^WantedBy=timers\.target$/m);
        const unit = fs.readFileSync(path.join(root, 'deploy', 'systemd', 'openvibe-readyhealth.service'), 'utf8');
        assert.match(unit, /^ExecStart=\/usr\/local\/lib\/openvibe-host\/deploy\/scripts\/ready-health\.sh$/m);
        assert.match(unit, /^Environment=OVHOST_INVENTORY=\/etc\/openvibe\/host\.json$/m);
        assert.match(unit, /^User=root$/m);
        const rules = fs.readFileSync(path.join(root, 'deploy', 'prometheus', 'openvibe-rules.yml'), 'utf8');
        assert.match(rules, /- alert: OpenVibeServiceNotReady\n\s+expr: openvibe_service_ready == 0\n\s+for: 15m\n\s+labels: \{ severity: page \}/);
        const notReady = rules.slice(rules.indexOf('alert: OpenVibeServiceNotReady'), rules.indexOf('alert: OpenVibeServiceReadyMissed'));
        assert.match(notReady, /summary: ".*\$labels\.service.*\/api\/ready/);
        assert.match(rules, /- alert: OpenVibeServiceReadyMissed\n\s+expr: time\(\) - openvibe_service_ready_last_run_timestamp > 20 \* 60 or absent\(openvibe_service_ready_last_run_timestamp\)\n\s+for: 5m\n\s+labels: \{ severity: page \}/);
        const doc = fs.readFileSync(path.join(root, 'docs', 'ready-health.md'), 'utf8');
        assert.match(doc, /openvibe_service_ready_last_run_timestamp/);
        assert.match(doc, /openvibe-readyhealth\.timer/);
        const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
    }),
]);
