'use strict';
// Size budgets for openvibe.host's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above the
// 2026-09-29 measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 26,   // measured 23.8 (fresh database; 15.9 before the showcase front page, 2026-10-07)
    htmlBrotliKB: 7,   // 6.3 (4.3 before the showcase)
    jsFiles: 5,   // 5 (openvibe-shared 2.10's shell adds web-runtime.js)
    jsRawKB: 250,   // 239.1 (openvibe-shared 2.6.0 served scripts; was 212.2 on 2.2.0)
    jsBrotliKB: 60,   // 56.3 (was 49.9)
    cssFiles: 2,   // 2 (host.css, openvibe-shared showcase.css)
    cssRawKB: 16,   // 14.8 (3.1 before showcase.css)
    cssBrotliKB: 4.2,   // 3.6 (0.9 before showcase.css)
    externalFiles: 1,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-host-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            BASE_URL: 'https://openvibe.host', HOST_SITES_DOMAIN: 'openvibe.host', COOKIE_SECURE: 'false',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', HOST_PGLITE_DIR: pgliteDir,
            HOST_STORAGE_DIR: path.join(dir, 'objects'), HOST_WORKER: 'off', HOST_MIN_FREE_BYTES: '0',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (HOST_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
