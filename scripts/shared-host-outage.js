#!/usr/bin/env node
'use strict';
/**
 * Shared-host outage test (roadmap WS-P task 5): every OpenVibe site still renders its content, its
 * navigation and its theme when openvibe.network (and every *.openvibe.network host) does not answer. The
 * Frame, the theme loader and the "shipped" widget load from there; a site must degrade, never go blank.
 *
 *   node scripts/shared-host-outage.js [--sites https://openvibe.live,https://openvibe.tools] [--out report.md] [--json]
 *
 * Without --sites the public sites come from OpenVibe.Network's registry (asked once, before the block):
 * every service with a public origin outside openvibe.network. Each home page is loaded in headless Chrome
 * with the Network domain blocked (Network.setBlockedURLs) and checked after it settles:
 *   content   at least 200 characters of visible text
 *   nav       a navigation (nav, [role=navigation] or a header) with at least 3 visible links
 *   theme     a styled page, not the browser default: a background on html or body, and either the
 *             theme tokens resolve (--bg-primary or --accent on :root) or the text colour is the page's own
 *   blocked   at least one request to openvibe.network was blocked (else the page never depended on it,
 *             which is reported, not failed)
 * Exit 0 when every site passes, 1 otherwise. Needs Chrome (CHROME_BIN or the usual paths) and Node 22.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const NETWORK = 'https://openvibe.network';
const BLOCK = ['*://openvibe.network/*', '*://*.openvibe.network/*'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sitesFromRegistry() {
    const r = await fetch(`${NETWORK}/api/v1/registry/services`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    const body = await r.json();
    const list = Array.isArray(body) ? body : body.services || [];
    const origins = new Set();
    for (const s of list) {
        const o = s.publicOrigin || s.public_origin || s.origin;
        if (!o || !/^https:\/\//.test(o)) continue;
        const host = new URL(o).hostname;
        if (host === 'openvibe.network' || host.endsWith('.openvibe.network')) continue;
        origins.add(new URL(o).origin);
    }
    return [...origins].sort();
}

async function launchChrome() {
    const bin = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
    if (!bin) throw new Error('Chrome not found (set CHROME_BIN)');
    const port = 9800 + Math.floor(Math.random() * 5000);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-outage-'));
    const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
    let targets = null;
    for (let i = 0; i < 120 && !targets; i++) {
        try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); }
    }
    if (!targets) { proc.kill('SIGKILL'); throw new Error('Chrome did not start'); }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map(), listeners = new Map();
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    };
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const close = () => { try { ws.close(); } catch { /* closed */ } proc.kill('SIGKILL'); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500).unref(); };
    return { send, on, evaluate, close };
}

const CHECK = `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
    const navs = [...document.querySelectorAll('nav, [role=navigation], header')];
    const links = Math.max(0, ...navs.map((n) => [...n.querySelectorAll('a[href]')].filter(visible).length));
    const root = getComputedStyle(document.documentElement);
    const token = (root.getPropertyValue('--bg-primary') || root.getPropertyValue('--accent') || '').trim();
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const htmlBg = root.backgroundColor;
    const styledBg = [bodyBg, htmlBg].some((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent');
    const ownText = getComputedStyle(document.body).color !== 'rgb(0, 0, 0)';
    return { chars: text.length, navLinks: links, token, styledBg, ownText, title: document.title.slice(0, 80) };
})()`;

async function checkSite(cdp, origin) {
    const blocked = [];
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: BLOCK });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const onFail = (p) => { if (p.blockedReason) blocked.push(p.requestId); };
    cdp.on('Network.loadingFailed', onFail);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${origin}/` });
    await sleep(6000);
    const r = await cdp.evaluate(CHECK);
    const out = {
        site: origin, title: r.title, chars: r.chars, navLinks: r.navLinks, token: r.token || null, styled: r.styledBg, blocked: new Set(blocked).size,
        content: r.chars >= 200, nav: r.navLinks >= 3, theme: r.styledBg && (Boolean(r.token) || r.ownText),
    };
    out.ok = out.content && out.nav && out.theme;
    return out;
}

(async () => {
    const sites = arg('sites') ? arg('sites').split(',').map((s) => new URL(s.trim()).origin) : await sitesFromRegistry();
    const results = [];
    for (const site of sites) {
        const cdp = await launchChrome();
        try { results.push(await checkSite(cdp, site)); }
        catch (err) { results.push({ site, ok: false, error: err.message }); }
        finally { cdp.close(); }
    }
    if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
    else for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.site}  ${r.error || `content ${r.chars} chars, nav ${r.navLinks} links, theme ${r.theme ? 'yes' : 'no'}, ${r.blocked} request(s) to openvibe.network blocked`}`);
    if (arg('out')) {
        const at = new Date().toISOString();
        const rows = results.map((r) => `| ${r.site} | ${r.ok ? 'pass' : 'FAIL'} | ${r.chars ?? '-'} | ${r.navLinks ?? '-'} | ${r.theme ? 'yes' : 'no'} | ${r.blocked ?? '-'} |${r.error ? ` ${r.error}` : ''}`);
        fs.appendFileSync(arg('out'), `\n### Run ${at}\n\n| Site | Result | Text (chars) | Nav links | Theme | Blocked requests |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
    }
    process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(2); });
