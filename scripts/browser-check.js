#!/usr/bin/env node
'use strict';
/**
 * Browser and no-JS check of every public OpenVibe product (roadmap WS-Q task 3; WS-T tasks 3 and 4), with
 * openvibe-shared/browser-harness: per route × width (390, 768, 1280) status, console errors, horizontal
 * overflow and duplicate scripts; per route without JavaScript visible text, canonical and JSON-LD against the
 * visible text; axe-core (serious/critical fail); per site a repeated-navigation growth check and idle activity.
 *
 *   node scripts/browser-check.js [--sites live,https://openvibe.wiki] [--routes-file routes.json] [--max-routes 7]
 *        [--widths 390,768,1280] [--no-axe] [--no-nav] [--laps 5] [--strict-errors]
 *        [--json] [--out docs/browser-check.md] [--remote <ssh-host>] [--harness <browser-harness.js>]
 *
 * Sites: --sites takes registry ids or origins; without it, every service in OpenVibe.Network's registry with a
 * public origin whose home page answers HTML (API roots that answer text/plain are left out). Routes per site:
 * the known routes below, then one same-origin URL per section of the site's sitemap.xml (a sitemap index is
 * followed one level), up to --max-routes, then /__ovcheck-404, which must answer 404. --routes-file is JSON,
 * { "<id or origin>": ["/", "/p/x", { "path": "/gone", "status": 410 }] }, and replaces the derived list.
 *
 * Only GETs, one page at a time, one Chrome for the run (a fresh browser context per route, cache in memory).
 * Known noise (KNOWN_ERRORS) is counted per label, not failed; --strict-errors fails it too.
 * Output: a summary per site (stderr: progress); --json prints the reports; --out appends a dated run (a table
 * and the details) to a Markdown file. Exit 0 when every site passes, 1 when one fails, 2 when the run broke.
 *
 * --remote <ssh-host> runs the same script on another machine (roadmap hazard H7: workstation disk). The
 * script and the harness are streamed over ssh into a temporary directory there, run with --json, and removed;
 * the report is written here. The remote needs Node 22+ and Chrome (CHROME_BIN or /usr/bin/google-chrome),
 * and reaches the sites itself. OVHOST_SSH overrides the ssh command (e.g. "ssh -p 2222").
 *
 * --network-down (ADR-024, WS-E task 1): instead, each site's home page loads with openvibe.network unreachable
 * (the harness's checkUnreachable: every request to it fails), at 390 and 1280 px, and must still paint: status
 * 200, settled, 120+ characters of text (a blank page has none; a short sign-in page has ~190), a --accent
 * theme token and a background. openvibe.network itself is left out. Needs
 * a harness with checkUnreachable (Shared 1.21.0 and later, or --harness a checkout).
 *
 * The harness comes from --harness, else openvibe-shared/browser-harness (Shared 1.16.0 and later), else a
 * sibling OpenVibe.Shared checkout. Needs Chrome and Node 22. (--routes-json '<json>' is --routes-file inline;
 * --remote uses it to carry the routes file.)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NETWORK = process.env.OV_NETWORK_ORIGIN || 'https://openvibe.network';
const NOT_FOUND_PROBE = '/__ovcheck-404';
// Routes worth checking on every run, beyond what the sitemap samples (paths that answered 200 on 2026-09-25).
const KNOWN_ROUTES = {
    live: ['/', '/content', '/chat', '/search?q=minecraft'],
    network: ['/', '/updates', '/login'],
    tools: ['/', '/developers', '/updates'],
    community: ['/', '/pastes', '/pulse'],
    media: ['/', '/updates'],
    chat: ['/', '/rooms', '/updates'],
    wiki: ['/', '/updates'],
    blog: ['/', '/updates'],
    // Billing's only public page (its root is the API).
    billing: { only: ['/policy'] },
};
const KNOWN_ERRORS = [
    // Cloudflare's Web Analytics automatic setup injects its beacon into HTML at the edge; the sites' CSP blocks it.
    { label: 'Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP', text: /static\.cloudflareinsights\.com/ },
    { label: 'Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP', url: /static\.cloudflareinsights\.com/ },
    // A signed-out visitor's page asks who is signed in and gets 401.
    { label: 'signed-out session probe answered 401', text: /status of 401\b/, url: /\/(api\/)?(auth\/(me|refresh|session|status|whoami)|me|session)(\?|$)/ },
];

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const errLog = (s) => process.stderr.write(`${s}\n`);

/** The harness module and its file (the file is what --remote ships). */
function loadHarness() {
    const tries = arg('harness') ? [path.resolve(arg('harness'))] : ['openvibe-shared/browser-harness', path.join(__dirname, '..', '..', 'OpenVibe.Shared', 'browser-harness.js')];
    for (const t of tries) {
        let file;
        try { file = require.resolve(t); } catch { continue; }
        return { h: require(file), file };
    }
    throw new Error(`browser harness not found (tried ${tries.join(', ')}); pass --harness <path to openvibe-shared/browser-harness.js>`);
}

async function get(url, accept = '*/*') {
    const r = await fetch(url, { headers: { accept, 'user-agent': 'OpenVibe-BrowserCheck/1 (+https://openvibe.host)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
}

async function registry() {
    const r = await get(`${NETWORK}/api/v1/registry/services`, 'application/json');
    const body = JSON.parse(r.body);
    const out = [];
    for (const s of Array.isArray(body) ? body : body.services || []) {
        const o = s.publicOrigin || s.public_origin;
        if (o && /^https?:\/\//.test(o)) out.push({ id: s.id || s.name, origin: new URL(o).origin });
    }
    return out;
}

async function resolveSites(reg) {
    const list = arg('sites') ? arg('sites').split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (list) {
        return list.map((x) => {
            if (/^https?:\/\//.test(x)) { const origin = new URL(x).origin; return { id: (reg.find((s) => s.origin === origin) || {}).id || new URL(x).hostname, origin }; }
            const s = reg.find((r) => r.id === x);
            if (!s) throw new Error(`--sites: ${x} is not a registry id with a public origin (${reg.map((r) => r.id).join(', ')})`);
            return s;
        });
    }
    const out = [];
    for (const s of reg) {
        if (KNOWN_ROUTES[s.id] && KNOWN_ROUTES[s.id].only) { out.push(s); continue; }
        try {
            const r = await get(`${s.origin}/`, 'text/html');
            if (/text\/html/i.test(r.type)) out.push(s); else errLog(`skip ${s.origin}: its root answers ${r.type || r.status}, not HTML`);
        } catch (e) { out.push(s); errLog(`${s.origin}: home did not answer (${e.message}); checked anyway`); }
    }
    return out;
}

async function sitemapSample(h, origin, cap) {
    if (cap <= 0) return [];
    let xml;
    try { const r = await get(`${origin}/sitemap.xml`, 'application/xml'); if (r.status !== 200) return []; xml = r.body; } catch { return []; }
    if (/<sitemapindex/i.test(xml)) {
        const children = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } }).slice(0, 3);
        const parts = [];
        for (const u of children) { try { const r = await get(u, 'application/xml'); if (r.status === 200) parts.push(r.body); } catch { /* skip */ } }
        xml = parts.join('\n');
    }
    return h.sitemapPaths(xml, origin, cap);
}

async function routesFor(h, site, routesFile, max) {
    if (routesFile) {
        const own = routesFile[site.id] || routesFile[site.origin];
        if (own) return own;
    }
    const known = KNOWN_ROUTES[site.id];
    if (known && known.only) return known.only;
    const routes = [...(known || ['/'])];
    // One sitemap URL per section the known routes do not already cover (/@… channels count as one section).
    const section = (p) => { const s = String(p).split(/[/?#]/)[1] || ''; return s.startsWith('@') ? '@' : s; };
    const covered = new Set(routes.map(section));
    // Detail pages first (/vod/1, /@name, /p/x): list pages are usually among the known routes already.
    const detail = (p) => (section(p) === '@' || String(p).split('?')[0].split('/').filter(Boolean).length > 1 ? 0 : 1);
    const sampled = (await sitemapSample(h, site.origin, 50)).map((p, i) => [p, i]).sort((a, b) => detail(a[0]) - detail(b[0]) || a[1] - b[1]).map(([p]) => p);
    for (const p of sampled) {
        if (routes.length >= max) break;
        if (covered.has(section(p))) continue;
        covered.add(section(p));
        routes.push(p);
    }
    routes.push({ path: NOT_FOUND_PROBE, status: 404 });
    return routes;
}

// ─── Report ───────────────────────────────────────────────────────────────────────────────────────

const COLUMNS = ['status', 'errors', 'overflow', 'scripts', 'nojs', 'canonical', 'jsonld', 'axe', 'navigation'];
function cell(c) {
    if (!c) return '-';
    const used = c.pass + c.warn + c.fail;
    if (!used) return '-';
    if (c.fail) return `**${c.fail}✗**${c.warn ? ` ${c.warn}!` : ''}`;
    return c.warn ? `${c.warn}!` : '✓';
}
function growthCell(n) {
    if (!n || n.skipped) return '-';
    if (n.error) return 'error';
    const d = n.growth.deltas;
    const f = (v) => (v > 0 ? `+${v}` : String(v));
    return `${f(d.heapKB)} KB · ${f(d.nodes)} nodes · ${f(d.listeners)} lst${n.growth.over.length ? ` **(${n.growth.over.map((o) => o.name).join(', ')})**` : ''}`;
}
function idleCell(n) {
    if (!n || !n.idle) return '-';
    const a = n.idle.animations;
    return `${n.idle.cpuPct}% · ${n.idle.requests} req${a && a.infinite ? ` · ${a.infinite} anim` : ''}`;
}
function ignoredOf(rep) {
    const out = {};
    for (const src of [...rep.routes, rep.navigation || {}]) for (const [k, v] of Object.entries(src.ignored || {})) out[k] = (out[k] || 0) + v;
    return out;
}

function markdown(h, reports, meta) {
    const L = [];
    L.push(`### Run ${meta.at} (${meta.runner}; ${meta.chrome || 'Chrome'})`, '');
    L.push(`${reports.filter((r) => r.ok).length}/${reports.length} sites pass. Widths ${meta.widths.join(', ')}; axe ${meta.axe}; navigation ${meta.nav}. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.`, '');
    L.push('| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of reports) {
        const s = r.summary || { checks: {}, axe: {} };
        const host = r.base.replace(/^https?:\/\//, '');
        L.push(`| ${host} | ${r.routes.length} | ${COLUMNS.map((c) => cell(s.checks[c])).join(' | ')} | ${s.axe ? `${s.axe.serious}/${s.axe.critical} (${s.axe.moderate})` : '-'} | ${growthCell(r.navigation)} | ${idleCell(r.navigation)} |`);
    }
    const ignored = {};
    for (const r of reports) for (const [k, v] of Object.entries(ignoredOf(r))) { ignored[k] = ignored[k] || { n: 0, sites: new Set() }; ignored[k].n += v; ignored[k].sites.add(r.base.replace(/^https?:\/\//, '')); }
    if (Object.keys(ignored).length) {
        L.push('', 'Known errors, counted and not failed (`--strict-errors` fails them):');
        for (const [k, v] of Object.entries(ignored)) L.push(`- ${k}: ${v.n}× on ${[...v.sites].join(', ')}`);
    }
    L.push('', '<details><summary>Details: routes and findings per site</summary>', '');
    for (const r of reports) L.push(h.format(r, { markdown: true }), '');
    L.push('</details>', '');
    return L.join('\n');
}

// ─── Remote ───────────────────────────────────────────────────────────────────────────────────────

function runRemote(host, harnessFile) {
    return new Promise((resolve, reject) => {
        const passArgs = [];
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i];
            if (['--remote', '--out', '--harness'].includes(a)) { i++; continue; }
            if (a === '--json') continue;
            if (a === '--routes-file') { passArgs.push('--routes-json', JSON.stringify(JSON.parse(fs.readFileSync(argv[++i], 'utf8')))); continue; }
            passArgs.push(a);
        }
        const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
        const remoteCmd = `d=$(mktemp -d) && cd "$d" && tar xzf - && node browser-check.js --json --harness ./${q(path.basename(harnessFile))} ${passArgs.map(q).join(' ')}; rc=$?; cd / && rm -rf "$d"; exit $rc`;
        const ssh = (process.env.OVHOST_SSH || 'ssh -o BatchMode=yes').split(/\s+/).filter(Boolean);
        const child = spawn(ssh[0], [...ssh.slice(1), host, remoteCmd], { stdio: ['pipe', 'pipe', 'inherit'] });
        const tar = spawn('tar', ['czf', '-', '-C', path.dirname(harnessFile), path.basename(harnessFile), '-C', __dirname, path.basename(__filename)], { stdio: ['ignore', 'pipe', 'inherit'] });
        tar.stdout.pipe(child.stdin);
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.on('error', reject);
        child.on('close', (code) => {
            try { resolve({ code, reports: JSON.parse(out) }); } catch { reject(new Error(`remote run on ${host} exited ${code} without a JSON report${out ? `: ${out.slice(0, 300)}` : ''}`)); }
        });
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────────────────────────

/** --network-down: every site's home with openvibe.network unreachable (ADR-024). */
async function networkDown(h) {
    if (typeof h.checkUnreachable !== 'function') throw new Error('this harness has no checkUnreachable (Shared 1.21.0+); pass --harness <OpenVibe.Shared/browser-harness.js>');
    const netHost = new URL(NETWORK).hostname;
    const sites = (await resolveSites(await registry())).filter((s) => new URL(s.origin).hostname !== netHost);
    const block = [`*://${netHost}/*`];
    const results = [];
    const browser = await h.launch({});
    try {
        for (const site of sites) {
            let r;
            try { r = await h.checkUnreachable(`${site.origin}/`, { block, widths: [390, 1280], browser, minText: 120 }); } catch (e) { r = { url: `${site.origin}/`, ok: false, error: e.message, widths: [] }; }
            r.id = site.id;
            results.push(r);
            errLog(`${r.ok ? 'ok  ' : 'FAIL'} ${site.origin}${r.error ? ` (${r.error})` : ''}`);
        }
    } finally { await browser.close(); }
    const at = new Date().toISOString();
    const rows = results.map((r) => {
        const w = (px) => r.widths.find((x) => x.width === px) || {};
        const cell = (x) => (x.ok ? '✓' : x.status == null ? '—' : `**✗** ${x.status}${x.settled === false ? ' unsettled' : ''}${x.accent ? '' : ' no theme'}${(x.textChars || 0) < 120 ? ` ${x.textChars || 0} chars` : ''}`);
        return `| ${new URL(r.url).hostname} | ${cell(w(390))} | ${cell(w(1280))} | ${(w(1280).accent || '—')} | ${r.error ? r.error.slice(0, 80) : ''} |`;
    });
    const md = `### Network-down run ${at} (ADR-024)\n\n${results.filter((r) => r.ok).length}/${results.length} sites paint with ${netHost} unreachable (every request to it fails). Checked at 390 and 1280 px: status 200, settled, at least 120 characters of text, a \`--accent\` theme token and a background.\n\n| Site | 390 | 1280 | --accent | Note |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
    if (has('json')) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    else console.log(md);
    if (arg('out')) fs.appendFileSync(arg('out'), `\n${md}`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
}

(async () => {
    const { h, file: harnessFile } = loadHarness();
    if (has('network-down')) return networkDown(h);
    const widths = arg('widths') ? arg('widths').split(',').map(Number) : h.WIDTHS;
    const meta = { at: new Date().toISOString(), runner: 'local', widths, axe: has('no-axe') ? 'off' : `axe-core ${h.AXE.version}, WCAG 2.1 A/AA`, nav: has('no-nav') ? 'off' : `${Number(arg('laps') || 5)} laps` };
    let reports, code;
    if (arg('remote')) {
        meta.runner = `remote ${arg('remote')}`;
        ({ reports, code } = await runRemote(arg('remote'), harnessFile));
    } else {
        const routesFile = arg('routes-file') ? JSON.parse(fs.readFileSync(arg('routes-file'), 'utf8')) : arg('routes-json') ? JSON.parse(arg('routes-json')) : null;
        const max = Number(arg('max-routes') || 7);
        const reg = await registry();
        const sites = await resolveSites(reg);
        reports = [];
        let browser = null;
        try {
            for (const site of sites) {
                if (!browser || browser.closed) browser = await h.launch({});
                const routes = await routesFor(h, site, routesFile, max);
                errLog(`${site.origin}: ${routes.map((r) => (typeof r === 'string' ? r : r.path)).join(' ')}`);
                const rep = await h.run({
                    base: site.origin, routes, widths, browser, log: (s) => errLog(`  ${s}`),
                    checks: { axe: !has('no-axe'), navigation: !has('no-nav') }, navigation: { laps: Number(arg('laps') || 5) },
                    ignoreErrors: has('strict-errors') ? [] : KNOWN_ERRORS,
                });
                rep.id = site.id;
                reports.push(rep);
            }
        } finally { if (browser) await browser.close(); }
        code = reports.every((r) => r.ok) ? 0 : 1;
    }
    meta.chrome = (reports.find((r) => r.chrome) || {}).chrome;
    if (has('json')) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
    else {
        for (const r of reports) {
            const s = r.summary;
            const bad = Object.entries(s.checks).filter(([, c]) => c.fail).map(([k, c]) => `${k} ${c.fail}`);
            console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.base}  ${r.routes.length} route(s)${bad.length ? `; failing: ${bad.join(', ')}` : ''}; axe serious ${s.axe.serious}, critical ${s.axe.critical}, moderate ${s.axe.moderate}; nav ${growthCell(r.navigation).replace(/\*\*/g, '')}; idle ${idleCell(r.navigation)}`);
        }
    }
    if (arg('out')) fs.appendFileSync(arg('out'), `\n${markdown(h, reports, meta)}`);
    process.exit(code === 0 && reports.every((r) => r.ok) ? 0 : 1);
})().catch((err) => { console.error(err.stack || err.message); process.exit(2); });
