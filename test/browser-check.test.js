'use strict';
// scripts/browser-check.js (WS-Q task 3) with a stub harness (no Chrome) against a local registry and local
// "sites": which sites and routes it picks, the JSON and Markdown reports, exit codes, --remote through a
// stand-in ssh, and `ovhost deploy --browser-check`, which reports and never changes the deploy's result.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { scenario, push, test, runTests } = require('./helpers');
const { main } = require('../lib/cli');
const { runBrowserCheck } = require('../lib/browser-check-hook');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'browser-check.js');
const STUB = path.join(__dirname, 'fixtures', 'browser-harness-stub.js');

// One local server answers for every "site" (<name>.localhost, which resolves to loopback) and the registry.
function serve() {
    const server = http.createServer((req, res) => {
        const port = server.address().port;
        const o = `http://127.0.0.1:${port}`;
        const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
        if (req.url === '/api/v1/registry/services') {
            return send('application/json', JSON.stringify({ services: [
                { id: 'good', publicOrigin: `http://good.localhost:${port}` },
                { id: 'bad', publicOrigin: `http://bad.localhost:${port}` },
                { id: 'api', publicOrigin: `http://api.localhost:${port}` },
                { id: 'billing', publicOrigin: `http://billing.localhost:${port}` },
                { id: 'contracts' },
            ] }));
        }
        const host = String(req.headers.host).split('.')[0];
        if (host === 'api') return send('text/plain', 'ok');
        if (req.url === '/sitemap.xml' && host === 'good') {
            return send('application/xml', `<sitemapindex><sitemap><loc>http://good.localhost:${port}/sm-1.xml</loc></sitemap></sitemapindex>`);
        }
        if (req.url === '/sm-1.xml') {
            return send('application/xml', `<urlset><url><loc>http://good.localhost:${port}/</loc></url><url><loc>http://good.localhost:${port}/p/one</loc></url>
                <url><loc>http://good.localhost:${port}/p/three</loc></url><url><loc>http://good.localhost:${port}/list</loc></url><url><loc>http://good.localhost:${port}/s/two</loc></url><url><loc>${o}/elsewhere</loc></url></urlset>`);
        }
        if (req.url === '/sitemap.xml') return send('text/html', 'no', 404);
        return send('text/html', '<!doctype html><title>x</title>');
    });
    return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function runScript(args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('close', (code) => resolve({ code, out, err }));
    });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovhost-bc-'));
const calls = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

runTests([
    test('every public HTML site from the registry, known + sitemap routes + a 404 probe; JSON, Markdown and exit 1 on a failing site', async () => {
        const server = await serve();
        const dir = tmp();
        try {
            const env = { OV_NETWORK_ORIGIN: `http://127.0.0.1:${server.address().port}`, STUB_CALLS: path.join(dir, 'calls.jsonl') };
            const out = path.join(dir, 'report.md');
            fs.writeFileSync(out, '# Browser check\n');
            const r = await runScript(['--harness', STUB, '--json', '--out', out, '--max-routes', '3'], env);
            assert.strictEqual(r.code, 1, r.err);
            const reports = JSON.parse(r.out);
            const port = server.address().port;
            assert.deepStrictEqual(reports.map((x) => x.id), ['good', 'bad', 'billing'], 'the text/plain API root and the service without an origin are left out');
            assert.match(r.err, /skip http:\/\/api\.localhost:\d+: its root answers text\/plain/);
            const c = calls(env.STUB_CALLS);
            assert.deepStrictEqual(c[0].routes, ['/', '/p/one', '/s/two', { path: '/__ovcheck-404', status: 404 }], 'sitemap index followed, detail pages first, one per section, capped, other origins dropped');
            assert.deepStrictEqual(c[1].routes, ['/', { path: '/__ovcheck-404', status: 404 }], 'no sitemap: home and the probe');
            assert.deepStrictEqual(c[2].routes, ['/policy'], 'billing: its policy page only');
            assert.strictEqual(c[0].base, `http://good.localhost:${port}`);
            assert.deepStrictEqual(c[0].widths, [390, 768, 1280]);
            assert.deepStrictEqual(c[0].checks, { axe: true, navigation: true });
            assert.strictEqual(c[0].laps, 5);
            assert.ok(c[0].ignore.includes('signed-out session probe answered 401'));
            const md = fs.readFileSync(out, 'utf8');
            assert.ok(md.startsWith('# Browser check\n\n### Run '), 'appended under the existing heading');
            assert.match(md, /2\/3 sites pass/);
            assert.match(md, /\| bad\.localhost:\d+ \| 2 \| ✓ \| ✓ \| \*\*1✗\*\* \| ✓ \| ✓ \| ✓ \| ✓ \| ✓ \| ✓ \| 2\/0 \(1\) \| \+12 KB · 0 nodes · \+1 lst \| 0\.5% · 1 req \|/);
            assert.match(md, /signed-out session probe answered 401: 10× on good\.localhost:\d+, billing\.localhost:\d+/);
        } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    }),
    test('--sites (ids and origins), --routes-file, --widths, --no-axe, --no-nav, --laps, --strict-errors; exit 0 when all pass', async () => {
        const server = await serve();
        const dir = tmp();
        try {
            const port = server.address().port;
            const env = { OV_NETWORK_ORIGIN: `http://127.0.0.1:${port}`, STUB_CALLS: path.join(dir, 'calls.jsonl') };
            const routesFile = path.join(dir, 'routes.json');
            fs.writeFileSync(routesFile, JSON.stringify({ good: ['/a', { path: '/gone', status: 410 }] }));
            const r = await runScript(['--harness', STUB, '--sites', `good,http://billing.localhost:${port}/x`, '--routes-file', routesFile, '--widths', '320,1440', '--no-axe', '--no-nav', '--laps', '3', '--strict-errors'], env);
            assert.strictEqual(r.code, 0, r.err + r.out);
            assert.match(r.out, /^ok {3}http:\/\/good\.localhost:\d+ {2}2 route\(s\); axe serious 0, critical 0, moderate 1/m);
            const c = calls(env.STUB_CALLS);
            assert.deepStrictEqual(c.map((x) => x.routes), [['/a', { path: '/gone', status: 410 }], ['/policy']]);
            assert.deepStrictEqual(c[0].widths, [320, 1440]);
            assert.deepStrictEqual(c[0].checks, { axe: false, navigation: false });
            assert.strictEqual(c[0].laps, 3);
            assert.deepStrictEqual(c[0].ignore, []);
            const bad = await runScript(['--harness', STUB, '--sites', 'nope'], env);
            assert.strictEqual(bad.code, 2);
            assert.match(bad.err, /--sites: nope is not a registry id with a public origin/);
            const missing = await runScript(['--harness', path.join(dir, 'none.js'), '--sites', 'good'], env);
            assert.strictEqual(missing.code, 2, 'an explicit --harness that is missing is an error, not a fallback');
            assert.match(missing.err, /browser harness not found \(tried .*none\.js\)/);
        } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    }),
    test('--remote: the script and harness go over ssh into a temp dir, run with --json there, the report is written here', async () => {
        const server = await serve();
        const dir = tmp();
        try {
            const port = server.address().port;
            // A stand-in for ssh: `fake-ssh <host> <command>` runs the command here in a shell, with stdin.
            const fakeSsh = path.join(dir, 'fake-ssh');
            fs.writeFileSync(fakeSsh, `#!/bin/sh\necho "$1" > ${JSON.stringify(path.join(dir, 'host'))}\nexec sh -c "$2"\n`, { mode: 0o755 });
            const routesFile = path.join(dir, 'routes.json');
            fs.writeFileSync(routesFile, JSON.stringify({ good: ['/r'] }));
            const out = path.join(dir, 'report.md');
            const env = { OV_NETWORK_ORIGIN: `http://127.0.0.1:${port}`, STUB_CALLS: path.join(dir, 'calls.jsonl'), OVHOST_SSH: fakeSsh, TMPDIR: dir };
            const before = fs.readdirSync(dir).length;
            const r = await runScript(['--harness', STUB, '--remote', 'runner@far', '--sites', 'good', '--routes-file', routesFile, '--out', out], env);
            assert.strictEqual(r.code, 0, r.err + r.out);
            assert.strictEqual(fs.readFileSync(path.join(dir, 'host'), 'utf8').trim(), 'runner@far');
            assert.deepStrictEqual(calls(env.STUB_CALLS).map((x) => x.routes), [['/r']], 'the routes file travelled inline');
            assert.match(r.out, /^ok {3}http:\/\/good\.localhost/m);
            assert.match(fs.readFileSync(out, 'utf8'), /### Run .* \(remote runner@far; Chrome\/0-stub\)/);
            // The remote temp dir is gone: only what this test made is left (calls, host, fake-ssh, routes, report).
            assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('tmp.')).length, 0);
            assert.ok(fs.readdirSync(dir).length <= before + 3);
        } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    }),
    test('ovhost deploy --browser-check: after a deploy, the site is checked and reported; the exit code and record stand', async () => {
        const host = scenario();
        push(host, 'live', { 'server/index.js': 'console.log(3);' }, 'server change');
        const asked = [];
        const lines = [];
        const code = await main(['deploy', 'live', '--browser-check'], { exec: host.exec, out: (s) => lines.push(s), env: {},
            browserCheck: async (id) => { asked.push(id); return { code: 1, lines: ['FAIL https://openvibe.live  5 route(s); failing: overflow 1'], error: null }; } });
        assert.strictEqual(code, 0, lines.join('\n'));
        assert.deepStrictEqual(asked, ['live']);
        const text = lines.join('\n');
        assert.match(text, /result: deployed/);
        assert.match(text, /\[ovhost\] {3}FAIL https:\/\/openvibe\.live {2}5 route\(s\); failing: overflow 1/);
        assert.match(text, /browser check found problems \(see above\); the deploy stands/);
        // Not asked for, not deployed (unchanged), or --json: no check.
        for (const argv of [['deploy', 'live'], ['deploy', 'live', '--browser-check'], ['deploy', 'live', '--browser-check', '--json']]) {
            if (argv.length === 3 && !argv.includes('--json')) push(host, 'live', { 'server/index.js': `console.log(${Math.random()});` });
            asked.length = 0;
            await main(argv, { exec: host.exec, out: () => {}, env: {}, browserCheck: async (id) => { asked.push(id); return { code: 0, lines: [] }; } });
            assert.deepStrictEqual(asked, argv.length === 3 && !argv.includes('--json') ? ['live'] : [], argv.join(' '));
        }
        const unchanged = [];
        await main(['deploy', 'live', '--browser-check'], { exec: host.exec, out: (s) => unchanged.push(s), env: {}, browserCheck: async () => { throw new Error('must not run'); } });
        assert.ok(!unchanged.join('\n').includes('browser check'), 'an unchanged deploy is not checked');
        // A check that cannot run says so.
        push(host, 'live', { 'server/index.js': 'console.log(4);' });
        const broken = [];
        const c2 = await main(['deploy', 'live', '--browser-check'], { exec: host.exec, out: (s) => broken.push(s), env: {}, browserCheck: async () => ({ code: 2, lines: [], error: 'Error: Chrome not found (set CHROME_BIN)' }) });
        assert.strictEqual(c2, 0);
        assert.match(broken.join('\n'), /browser check did not run: Error: Chrome not found \(set CHROME_BIN\); the deploy stands/);
    }),
    test('runBrowserCheck spawns the script for the service and reads its outcome', async () => {
        const dir = tmp();
        try {
            const script = path.join(dir, 'check.js');
            fs.writeFileSync(script, "const a = process.argv.slice(2); if (a[1] === 'down') { console.error('Error: Chrome not found (set CHROME_BIN)'); process.exit(2); } console.log(`ok   site ${a.join(' ')}`); process.exit(a[1] === 'bad' ? 1 : 0);");
            assert.deepStrictEqual(await runBrowserCheck('wiki', { script, args: ['--no-nav'] }), { code: 0, lines: ['ok   site --sites wiki --no-nav'], error: null });
            assert.strictEqual((await runBrowserCheck('bad', { script })).code, 1);
            assert.deepStrictEqual(await runBrowserCheck('down', { script }), { code: 2, lines: [], error: 'Error: Chrome not found (set CHROME_BIN)' });
            fs.writeFileSync(script, 'setTimeout(() => {}, 60000);');
            const slow = await runBrowserCheck('x', { script, timeoutMs: 300 });
            assert.strictEqual(slow.code, 2);
            assert.match(slow.error, /timed out after 0s/);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),
]);
