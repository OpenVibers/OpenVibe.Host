'use strict';
/**
 * scripts/d41-proof.sh against the fake host. The real script runs in bash; `ovhost`, `systemctl`
 * and `runuser` are small stubs that call back into this process, where the real ovhost CLI
 * (lib/cli.js) runs against test/fake-host.js and systemctl/git answer from the fake host's units and
 * repositories. Nothing touches the machine except the evidence directory in a temp dir.
 *
 *   - PASS: deploy (restart in place), rollback one release, deploy forward; only the target's unit
 *     restarts (three new InvocationIDs), every other unit and the Live socket are untouched, the
 *     service ends on the commit it started on, the release log has the three records.
 *   - Another unit changing (collateral restart) is detected: FAIL, exit 2, named in the summary.
 *   - A rollback target that is not ready: ovhost rolls back by itself (exit 3), the proof says so.
 *   - Refusals change nothing: refuse-listed and protected services, dependency changes, dry runs.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { scenario, test, runTests } = require('./helpers');
const { main } = require('../lib/cli');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'd41-proof.sh');
const REPO = '/opt/openvibe.sources';
const UNIT = 'openvibe-sources.service';

function sourcesHost({ lockfileChange = false } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.sources = { repo: REPO, units: [UNIT], port: 4720, ready: { url: 'http://127.0.0.1:4720/api/ready', timeoutSeconds: 30 }, noRestartPaths: ['docs/', '**/*.md'] };
    doc.services.chat = { repo: '/opt/openvibe.chat', units: ['openvibe-chat.service'], port: 4400, ready: { url: 'http://127.0.0.1:4400/ready', timeoutSeconds: 30 } };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });

    const repo = host.createRepo(REPO, { owner: 'ubuntu' });
    const pkg = JSON.stringify({ name: 'openvibe-sources', version: '1.0.0', dependencies: { express: '^4' } });
    const prev = repo.commit({ 'package.json': pkg, 'package-lock.json': '{"v":1}', 'server/index.js': 'sources(1);' }, { message: 'fetch schedule' });
    repo.publish(prev);
    const s0 = repo.commit({ 'server/index.js': 'sources(2);', ...(lockfileChange ? { 'package-lock.json': '{"v":2}' } : {}) }, { message: 'parse feeds' });
    repo.publish(s0);
    repo.checkout(s0);
    host.put(`${REPO}/node_modules/express/package.json`, JSON.stringify({ name: 'express' }), { owner: 'ubuntu' });
    host.addUnit(UNIT, { runningSha: s0 });
    host.unitRepo[UNIT] = repo;
    host.listeners.set(4720, [{ pid: host.units.get(UNIT).mainPid, process: 'node' }]);
    const chat = host.createRepo('/opt/openvibe.chat', { owner: 'ubuntu' });
    const c = chat.commit({ 'package.json': '{"name":"chat"}', 'server/index.js': 'chat();' });
    chat.publish(c);
    chat.checkout(c);
    host.addUnit('openvibe-chat.service', { runningSha: c });
    host.addUnit('nginx.service');

    // systemd bookkeeping the proof reads: a restart is a new process and a new invocation.
    for (const [name, u] of host.units) { u.invocationId = crypto.randomBytes(16).toString('hex'); u.activeEnter = `Tue 2026-09-22 12:00:${String(host.units.size).padStart(2, '0')} UTC`; u.name = name; }
    const base = host.onRestart;
    host.onRestart = (unit, u) => {
        base(unit, u);
        u.mainPid = host.nextPid++;
        u.invocationId = crypto.randomBytes(16).toString('hex');
        u.activeEnter = new Date(host.exec.now()).toUTCString();
        if (host.collateral && host.collateral[unit]) {
            const other = host.units.get(host.collateral[unit]);
            other.mainPid = host.nextPid++;
            other.invocationId = crypto.randomBytes(16).toString('hex');
        }
    };
    const ready = (unit) => () => {
        const u = host.units.get(unit);
        if (!u || u.active !== 'active') return { status: 502 };
        return host.badShas.has(u.runningSha) ? { status: 503, body: { status: 'not_ready' } } : { status: 200, body: { status: 'ready' } };
    };
    host.http.set('http://127.0.0.1:4720/api/ready', ready(UNIT));
    host.http.set('http://127.0.0.1:4400/ready', ready('openvibe-chat.service'));
    host.prev = prev;
    host.s0 = s0;
    return host;
}

/** systemctl as the proof calls it, answered from the fake host. */
function systemctl(host, argv) {
    const ok = (stdout) => ({ code: 0, stdout });
    if (argv[0] === 'list-units') {
        const glob = argv[argv.length - 1];
        const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return ok([...host.units.entries()].filter(([n]) => re.test(n)).map(([n, u]) => `${u.active === 'failed' ? '● ' : ''}${n} ${u.load} ${u.active} ${u.sub} ${n}\n`).join(''));
    }
    if (argv[0] === 'show') {
        const unit = argv[1];
        const props = (argv.find((a) => a.startsWith('--property=')) || '').slice(11).split(',');
        const u = host.units.get(unit);
        const v = u ? {
            Id: unit, LoadState: u.load, ActiveState: u.active, SubState: u.sub, MainPID: u.active === 'active' ? u.mainPid : 0,
            InvocationID: u.invocationId || '', ActiveEnterTimestamp: u.activeEnter || '', ExecMainStartTimestamp: u.activeEnter || '', NRestarts: 0,
        } : { Id: unit, LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead', MainPID: 0, InvocationID: '', ActiveEnterTimestamp: '', ExecMainStartTimestamp: '', NRestarts: 0 };
        return ok(props.map((p) => `${p}=${v[p]}\n`).join(''));
    }
    return { code: 1, stdout: '', stderr: `stub systemctl: ${argv[0]}` };
}

/** runuser -u <owner> -- git -C <repo> …, answered by the fake host's git as that owner. */
async function runuser(host, argv) {
    const [flag, owner, dashdash, cmd, ...rest] = argv;
    if (flag !== '-u' || dashdash !== '--' || cmd !== 'git') return { code: 1, stdout: '', stderr: 'stub runuser: git only' };
    const r = await host.exec.run('git', rest, { as: owner });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

async function withRpc(host, fn) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const { tool, argv } = JSON.parse(Buffer.concat(chunks).toString());
            let r;
            try {
                if (tool === 'ovhost') {
                    const lines = [];
                    const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {} });
                    host.ovhostCalls.push(argv.join(' '));
                    r = { code, stdout: lines.length ? `${lines.join('\n')}\n` : '' };
                } else if (tool === 'systemctl') r = systemctl(host, argv);
                else if (tool === 'runuser') r = await runuser(host, argv);
                else r = { code: 127, stdout: '', stderr: `no stub for ${tool}` };
            } catch (err) { r = { code: 2, stdout: '', stderr: err.stack }; }
            res.end(JSON.stringify(r));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    host.ovhostCalls = [];
    try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const STUB = `#!/usr/bin/env node
const http = require('http');
const tool = require('path').basename(process.argv[1]);
const body = JSON.stringify({ tool, argv: process.argv.slice(2) });
const req = http.request(process.env.D41_RPC, { method: 'POST' }, (res) => {
    const c = []; res.on('data', (d) => c.push(d));
    res.on('end', () => { const r = JSON.parse(Buffer.concat(c).toString()); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exitCode = r.code; });
});
req.end(body);
`;

async function runProof(host, args) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-d41-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const t of ['ovhost', 'systemctl', 'runuser']) { fs.writeFileSync(path.join(bin, t), STUB); fs.chmodSync(path.join(bin, t), 0o755); }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const state = path.join(dir, 'd41');
    return withRpc(host, (rpc) => new Promise((resolve) => {
        const child = spawn('bash', [SCRIPT, ...args], {
            env: {
                PATH: `${bin}:${process.env.PATH}`, HOME: dir, D41_RPC: rpc, D41_REQUIRE_ROOT: '0', D41_STATE_DIR: state,
                OVHOST: path.join(bin, 'ovhost'), SYSTEMCTL: path.join(bin, 'systemctl'), RUNUSER: path.join(bin, 'runuser'), NODE: path.join(bin, 'node'),
            },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('close', (code) => {
            const runs = fs.existsSync(state) ? fs.readdirSync(state) : [];
            const evidence = runs.length ? path.join(state, runs[0]) : null;
            const read = (f) => (evidence && fs.existsSync(path.join(evidence, f)) ? fs.readFileSync(path.join(evidence, f), 'utf8') : null);
            resolve({ code, out, evidence, read, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
        });
    }));
}

runTests([
    test('PASS: deploy in place, roll back one release, deploy forward; nothing else touched; ends where it started', async () => {
        const host = sourcesHost();
        const pids = Object.fromEntries([...host.units].map(([n, u]) => [n, [u.mainPid, u.invocationId]]));
        const r = await runProof(host, ['sources']);
        try {
            assert.strictEqual(r.code, 0, r.out);
            assert.match(r.out, /# D41 proof: sources \(.*\): PASS/);
            // Exactly three restarts, all of the target unit; the Live socket never touched.
            assert.deepStrictEqual(host.restarts(), [UNIT, UNIT, UNIT]);
            assert.deepStrictEqual(host.socketViolations(), []);
            for (const [n, [pid, inv]] of Object.entries(pids)) {
                if (n === UNIT) continue;
                assert.deepStrictEqual([host.units.get(n).mainPid, host.units.get(n).invocationId], [pid, inv], `${n} untouched`);
            }
            assert.notStrictEqual(host.units.get(UNIT).mainPid, pids[UNIT][0]);
            // The ovhost commands, in order.
            const steps = host.ovhostCalls.filter((c) => /^(deploy|rollback) /.test(c));
            assert.deepStrictEqual(steps, [
                `deploy sources --to ${host.s0} --restart --json`,
                `rollback sources --to ${host.prev} --restart --json`,
                `deploy sources --to ${host.s0} --restart --json`,
            ]);
            assert.strictEqual(host.units.get(UNIT).runningSha, host.s0, 'running S0 again');
            // Evidence.
            const summary = r.read('summary.md');
            if (process.env.D41_SHOW) console.log(r.out);
            assert.match(summary, /\| A \| `ovhost deploy sources --to [0-9a-f]{40} --restart` \| 0 \| deployed \|/);
            assert.match(summary, /\| B \| `ovhost rollback sources --to [0-9a-f]{40} --restart` \| 0 \| rolled-back \|/);
            assert.match(summary, /\| C \| `ovhost deploy sources --to [0-9a-f]{40} --restart` \| 0 \| deployed \|/);
            assert.match(summary, /openvibe-sources\.service \(MainPID \d+\)/);
            assert.match(summary, /identical before, after each step and at the end/);
            const watched = r.read('watch.units').trim().split('\n');
            for (const u of ['openvibe-live.socket', 'openvibe-live.service', 'openvibe-chat.service', 'openvibe-media.service', 'nginx.service', 'openvibe-events.service']) assert.ok(watched.includes(u), `${u} watched`);
            assert.ok(!watched.includes(UNIT));
            const releases = JSON.parse(r.read('releases.json'));
            assert.deepStrictEqual(releases.map((x) => [x.action, x.result]), [['deploy', 'deployed'], ['rollback', 'rolled-back'], ['deploy', 'deployed']]);
            assert.match(summary, /\| sources \| `[0-9a-f]{12}` → `[0-9a-f]{12}` → `[0-9a-f]{12}` \(3 restarts\) \| \d+ other units identical: yes; readiness kept: yes \|/);
        } finally { r.cleanup(); }
    }),

    test('FAIL: a unit that changes as a side effect (here Chat, restarted along with the target) is detected and named', async () => {
        const host = sourcesHost();
        host.collateral = { [UNIT]: 'openvibe-chat.service' };
        const r = await runProof(host, ['sources']);
        try {
            assert.strictEqual(r.code, 2, r.out);
            assert.match(r.out, /after A, other units changed: openvibe-chat\.service/);
            assert.match(r.read('summary.md'), /: FAIL/);
            assert.deepStrictEqual(host.restarts(), [UNIT], 'stops after the first step that touched something else');
            assert.strictEqual(host.units.get(UNIT).runningSha, host.s0);
        } finally { r.cleanup(); }
    }),

    test('a rollback target that is not ready: ovhost rolls it back by itself (exit 3) and the proof reports it', async () => {
        const host = sourcesHost();
        host.badShas.add(host.prev);
        const r = await runProof(host, ['sources', '--ready-timeout', '5']);
        try {
            assert.strictEqual(r.code, 3, r.out);
            assert.match(r.out, /step B: exit 3, result failed-rolled-back/);
            assert.strictEqual(host.units.get(UNIT).runningSha, host.s0, 'back on S0 and serving');
            assert.ok(!host.ovhostCalls.some((c) => c.startsWith(`deploy sources --to ${host.s0} --restart --json`) && host.ovhostCalls.indexOf(c) > 3), 'step C never ran');
        } finally { r.cleanup(); }
    }),

    test('refusals change nothing: refuse-listed, protected or socket services, dependency changes; --dry-run only looks', async () => {
        for (const [args, re, opts] of [
            [['live'], /live is on the refuse list/],
            [['events'], /events is on the refuse list/],
            [['sources', '--prev', 'deadbeef'], /--prev deadbeef is not a commit/],
            [['sources'], /changes dependencies \(npm install on B and C\)/, { lockfileChange: true }],
            [['nope'], /nope is not in the inventory/],
        ]) {
            const host = sourcesHost(opts);
            const r = await runProof(host, args);
            try {
                assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.out}`);
                assert.match(r.out, re);
                assert.deepStrictEqual(host.restarts(), []);
            } finally { r.cleanup(); }
        }
        const host = sourcesHost();
        const dry = await runProof(host, ['sources', '--dry-run']);
        try {
            assert.strictEqual(dry.code, 0, dry.out);
            assert.match(dry.out, /A: ovhost deploy sources --to [0-9a-f]{40} --restart/);
            assert.match(dry.out, /B: ovhost rollback sources --to [0-9a-f]{40} --restart/);
            assert.deepStrictEqual(host.restarts(), []);
            assert.ok(!host.ovhostCalls.some((c) => /^(deploy|rollback) /.test(c)));
        } finally { dry.cleanup(); }
    }),
]);
