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
    htmlRawKB: 32,   // 28.8 on 2026-10-22 (fresh database: the curated front page's counts, sizes, value, providers and questions); 23.8 before; 15.9 before the showcase front page, 2026-10-07
    htmlBrotliKB: 8,   // 7.1 on 2026-10-22; 6.3 (4.3 before the showcase)
    jsFiles: 5,   // 5 (openvibe-shared 2.10's shell adds web-runtime.js)
    jsRawKB: 268,   // 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 239.1 (openvibe-shared 2.6.0 served scripts; was 212.2 on 2.2.0)
    jsBrotliKB: 63,   // 61.7 with shared 4.11.0's seasonal navbar; 56.3 (was 49.9)
    cssFiles: 3,   // 3 (host.css, openvibe-shared showcase.css, catalog.css: the front page is the hosting catalog since Host#69)
    cssRawKB: 38,   // 34.8 on 2026-10-22 (the front page's cards and questions); 31.9 (2026-10-16 the domain comparison's and benchmarks' styles; 27.2 with showcase.css 4.1.5, 14.8 before catalog.css)
    cssBrotliKB: 7.5,   // 6.9 (5.7 before the domain and benchmark styles, 3.6 before catalog.css)
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
