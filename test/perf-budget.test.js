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

// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 356.6 KB raw / 85.0 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 353.9 KB raw / 84.4 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 352.9 KB raw / 84.2 KB brotli.
const BUDGETS = {
    htmlRawKB: 37,   // 32.7 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 28.8 on 2026-10-22 (fresh database: the curated front page's counts, sizes, value, providers and questions); 23.8 before; 15.9 before the showcase front page, 2026-10-07
    htmlBrotliKB: 9,   // 8.5 with openvibe-shared 4.92.0: the page starts its footer (2026-11-01); 2026-11-01: WebSite + Organization JSON-LD; 8.1 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 7.1 on 2026-10-22; 6.3 (4.3 before the showcase)
    jsFiles: 5,   // 5 (openvibe-shared 2.10's shell adds web-runtime.js)
    jsRawKB: 357.3, // 357.3 with openvibe-shared 4.153.0 (2026-11-08: signed in to the network, signed in here, on phones too; a page can turn away a carried card); 356.6 with openvibe-shared 4.152.0 (2026-11-08: the menu marks the page you are on and opens without the keyboard on a phone, floating cards follow you across OpenVibe sites (overlay.js), and the navbar preconnects to the next OpenVibe site on intent); 353.9 with openvibe-shared 4.150.0 (2026-11-08: the bell opens the Dock on Activity, the Dock's phone header is in two rows, and the menu's orb is the close button with an open/close animation); 352.9 with openvibe-shared 4.149.0 (2026-11-08: the menu has tabs at the top; the phone's menu button is the orb of 4.148.0); 350.2 with openvibe-shared 4.142.0 (2026-11-07: the menu has a close button on a phone);  349.2 with openvibe-shared 4.139.0 (2026-11-07: the menu's feed rows lead with their picture, the footer and glyphs defer 38 KB); 348.2 with openvibe-shared 4.137.0 (2026-11-07: every script by its content hash, one menu button on a phone, the menu warms at idle); 346.1 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 345.4 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 345.4 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 343 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 342 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 340.4 with openvibe-shared 4.118.0 (2026-11-06: the Locker re-auth link, the 44 px footer and TLD targets); 340.4 with openvibe-shared 4.118.0 (2026-11-06: the Locker re-auth link, the 44 px footer and TLD targets); 338.4 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 337.1 with openvibe-shared 4.112.1 (2026-11-06: theme-loader.js (4.111.1) and the footer/appbar phone CSS (4.112.1)); 335.8 with openvibe-shared 4.109.2 (2026-11-03: OpenVibe's own select, the navbar loads ov-forms); 333.1 with openvibe-shared 4.107.0 (2026-11-03: open.<tld> sites are named for their domain; the brand knows its front door); 332.5 with openvibe-shared 4.106.2 (2026-11-02: the site's name reads whole on a signed-in phone; the balances stack); 331.1 openvibe-shared 4.102.0 (2026-11-02: the puzzle glyph, the sidebar's two-line rows, boost lets parsed pages go); 328.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 324.8 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 323.2 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 239.1 (openvibe-shared 2.6.0 served scripts; was 212.2 on 2.2.0)
    jsBrotliKB: 85.1, // 85.1 with openvibe-shared 4.153.0 (2026-11-08: signed in to the network, signed in here, on phones too; a page can turn away a carried card); 85.0 with openvibe-shared 4.152.0 (2026-11-08: the menu marks the page you are on and opens without the keyboard on a phone, floating cards follow you across OpenVibe sites (overlay.js), and the navbar preconnects to the next OpenVibe site on intent); 84.4 with openvibe-shared 4.150.0 (2026-11-08: the bell opens the Dock on Activity, the Dock's phone header is in two rows, and the menu's orb is the close button with an open/close animation); 84.2 with openvibe-shared 4.149.0 (2026-11-08: the menu has tabs at the top; the phone's menu button is the orb of 4.148.0); 83.7 with openvibe-shared 4.142.0 (2026-11-07: the menu has a close button on a phone);  83.5 with openvibe-shared 4.139.0 (2026-11-07: the menu's feed rows lead with their picture, the footer and glyphs defer 38 KB); 83.1 with openvibe-shared 4.137.0 (2026-11-07: every script by its content hash, one menu button on a phone, the menu warms at idle); 82.6 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 82.5 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 82.5 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 81.9 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 81.7 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 81.5 with openvibe-shared 4.118.0 (2026-11-06: the Locker re-auth link, the 44 px footer and TLD targets); 81.5 with openvibe-shared 4.118.0 (2026-11-06: the Locker re-auth link, the 44 px footer and TLD targets); 81.1 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 80.9 with openvibe-shared 4.112.1 (2026-11-06: theme-loader.js (4.111.1) and the footer/appbar phone CSS (4.112.1)); 80.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 79.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 56.3 (was 49.9)
    cssFiles: 3,   // 3 (host.css, openvibe-shared showcase.css, catalog.css: the front page is the hosting catalog since Host#69)
    cssRawKB: 57,   // 55.8 with the price-trend chart's placement, the home's change rail and the Every change fold (2026-10-30); 53.5 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 51.3 the home's phone rows and fold (2026-10-29); 46.2 openvibe-shared 4.26.1 (hero visual); 40.7 with Shared 4.13.0 (2026-10-26: account links); 34.8 on 2026-10-22 (the front page's cards and questions); 31.9 (2026-10-16 the domain comparison's and benchmarks' styles; 27.2 with showcase.css 4.1.5, 14.8 before catalog.css)
    cssBrotliKB: 11.5,   // 11.2 with the price-trend chart's placement, the home's change rail and the Every change fold (2026-10-30); 10.9 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 10.1 with the phone rules that show four rows of each front-page list (2026-10-29); 8.3 with Shared 4.13.0 (2026-10-26: account links); 6.9 (5.7 before the domain and benchmark styles, 3.6 before catalog.css)
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
