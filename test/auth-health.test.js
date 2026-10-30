'use strict';
/**
 * The sign-in canary (deploy/scripts/auth-health.sh, docs/auth-health.md): every public origin in Network's
 * registry gets one GET /auth/health — 1 for 200, 0 for 503, another answer or no answer at all, and no
 * line for 404 (a site not on the SDK's sign-in yet) — and the textfile collector's file is replaced in
 * one rename. A registry it cannot read leaves the previous file alone, so a broken list is never green.
 * The script runs for real here; the sites and the registry are local HTTP servers.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { test, runTests } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'scripts', 'auth-health.sh');
const PROM = 'openvibe_auth_health.prom';

function site(status) {
    const s = http.createServer((req, res) => {
        s.hits.push(req.url);
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: status === 200, client: status === 200 ? 'ok' : 'invalid' }));
    });
    s.hits = [];
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
}

const originOf = (s) => `http://127.0.0.1:${s.address().port}`;

/** A port nothing listens on: the canary is asked to meet a site that does not answer. */
function closedPort() {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
    });
}

function dir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'auth-health-'));
}

function registryFile(dirPath, body) {
    const file = path.join(dirPath, 'registry.json');
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
}

// execFile, not spawnSync: the sites and the registry are servers in this process, and a blocked event
// loop could not answer them (the canary would meet four timeouts instead).
function run(textfileDir, registry, args = []) {
    return new Promise((resolve) => {
        execFile('bash', [SCRIPT, '--registry', registry, ...args], {
            timeout: 120000,
            env: { ...process.env, TEXTFILE_DIR: textfileDir, AUTH_HEALTH_REGISTRY_TRIES: '1', AUTH_HEALTH_REGISTRY_WAIT: '0' },
        }, (err, stdout, stderr) => resolve({ status: err ? (err.code == null ? null : err.code) : 0, stdout, stderr }));
    });
}

const prom = (textfileDir) => {
    try { return fs.readFileSync(path.join(textfileDir, PROM), 'utf8'); } catch { return null; }
};

runTests([
    test('every public origin is probed once; 200 is 1, 503 and no answer are 0, 404 is no line', async () => {
        const ok = await site(200);
        const refused = await site(503);
        const missing = await site(404);
        const broken = await site(500);
        const gate = await site(401);
        const dead = await closedPort();
        const textfile = dir();
        const registry = registryFile(textfile, {
            services: [
                { id: 'live', publicOrigin: originOf(ok) },
                { id: 'cam', public_origin: `${originOf(refused)}/` },
                { id: 'blog', publicOrigin: originOf(missing) },
                { id: 'chat', publicOrigin: originOf(broken) },
                { id: 'tools', publicOrigin: `http://127.0.0.1:${dead}` },
                { id: 'ai', publicOrigin: originOf(gate) },
                { id: 'contracts' },
                { id: 'Bad Id', publicOrigin: 'https://openvibe.example' },
                { id: 'noscheme', publicOrigin: 'openvibe.example' },
                { id: 'live', publicOrigin: originOf(ok) },
            ],
        });
        const r = await run(textfile, registry);
        for (const s of [ok, refused, missing, broken, gate]) s.close();
        assert.strictEqual(r.status, 1, r.stderr);
        assert.deepStrictEqual(ok.hits, ['/auth/health'], 'exactly one probe per site');
        const file = prom(textfile);
        assert.match(file, /^# TYPE openvibe_auth_health gauge$/m);
        assert.match(file, /^openvibe_auth_health\{site="live"\} 1$/m);
        assert.match(file, /^openvibe_auth_health\{site="cam"\} 0$/m, '503: the Network refuses its client');
        assert.ok(!/site="blog"/.test(file), '404: not on the SDK sign-in, no line');
        assert.ok(!/site="ai"/.test(file), '401: the site\'s own sign-in gate answered, no line');
        assert.match(file, /^openvibe_auth_health\{site="chat"\} 0$/m, 'another status is not a pass');
        assert.match(file, /^openvibe_auth_health\{site="tools"\} 0$/m, 'no answer is 0');
        assert.ok(!/site="Bad Id"/.test(file) && !/site="noscheme"/.test(file) && !/site="contracts"/.test(file));
        assert.strictEqual(file.match(/site="live"/g).length, 1, 'a repeated id keeps one line');
        assert.deepStrictEqual(r.stdout.trim().split('\n'), [
            'openvibe_auth_health{site="live"} 1',
            'openvibe_auth_health{site="cam"} 0',
            'openvibe_auth_health{site="chat"} 0',
            'openvibe_auth_health{site="tools"} 0',
        ]);
        assert.deepStrictEqual(fs.readdirSync(textfile).filter((f) => f !== 'registry.json'), [PROM], 'no temp file is left behind');
    }),
    test('a bare array is read too, --sites narrows a run, and an all-good list exits 0', async () => {
        const ok = await site(200);
        const other = await site(200);
        const textfile = dir();
        const registry = registryFile(textfile, [{ id: 'live', publicOrigin: originOf(ok) }, { id: 'blog', publicOrigin: originOf(other) }]);
        let r = await run(textfile, registry);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(prom(textfile), /^openvibe_auth_health\{site="live"\} 1$/m);
        assert.match(prom(textfile), /^openvibe_auth_health\{site="blog"\} 1$/m);
        r = await run(textfile, registry, ['--sites', 'live']);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual([ok.hits.length, other.hits.length], [2, 1], 'the filtered run leaves the other site alone');
        assert.ok(!/site="blog"/.test(prom(textfile)));
        ok.close();
        other.close();
    }),
    test('the registry is taken from a URL, and one that does not answer keeps the previous file', async () => {
        const ok = await site(200);
        const registryServer = await site(200);
        const registryBody = JSON.stringify({ services: [{ id: 'live', publicOrigin: originOf(ok) }] });
        registryServer.removeAllListeners('request');
        registryServer.on('request', (req, res) => { res.statusCode = 200; res.end(registryBody); });
        const textfile = dir();
        let r = await run(textfile, originOf(registryServer));
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(prom(textfile), /^openvibe_auth_health\{site="live"\} 1$/m);
        const before = prom(textfile);
        r = await run(textfile, 'http://127.0.0.1:1/api/v1/registry/services');
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /the registry did not answer/);
        assert.strictEqual(prom(textfile), before, 'a registry that cannot be read is not a green canary');
        const deadServer = http.createServer((req, res) => { res.statusCode = 500; res.end('no'); });
        await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
        r = await run(textfile, `http://127.0.0.1:${deadServer.address().port}/api/v1/registry/services`);
        assert.strictEqual(r.status, 2);
        assert.strictEqual(prom(textfile), before, 'a 500 from the registry changes nothing');
        ok.close();
        registryServer.close();
        deadServer.close();
    }),
    test('a registry that is not JSON or names no site keeps the previous file', async () => {
        const ok = await site(200);
        const textfile = dir();
        fs.writeFileSync(path.join(textfile, PROM), 'openvibe_auth_health{site="live"} 1\n');
        let r = await run(textfile, path.join(textfile, 'absent.json'));
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /cannot read the registry file/);
        r = await run(textfile, registryFile(textfile, '<html>502</html>'));
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /not JSON/);
        r = await run(textfile, registryFile(textfile, { services: [{ id: 'live' }] }));
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /no site with a public origin/);
        assert.strictEqual(prom(textfile), 'openvibe_auth_health{site="live"} 1\n');
        ok.close();
    }),
    test('the file is replaced in one rename; without the collector directory nothing is written', async () => {
        const ok = await site(200);
        const textfile = dir();
        const registry = registryFile(textfile, [{ id: 'live', publicOrigin: originOf(ok) }]);
        assert.strictEqual((await run(textfile, registry)).status, 0);
        const first = fs.statSync(path.join(textfile, PROM)).ino;
        assert.strictEqual((await run(textfile, registry)).status, 0);
        const second = fs.statSync(path.join(textfile, PROM)).ino;
        assert.notStrictEqual(second, first, 'a rename, not a rewrite in place');
        assert.ok(!fs.readdirSync(textfile).some((f) => f.endsWith('.tmp.' + process.pid) || f.startsWith(PROM + '.tmp')), 'no temp file');
        const absent = path.join(textfile, 'no-collector-here');
        const r = await run(absent, registry);
        assert.strictEqual(r.status, 0);
        assert.ok(!fs.existsSync(path.join(absent, PROM)), 'nothing to write to, nothing written');
        ok.close();
    }),
]);
