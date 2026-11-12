'use strict';
// Every page of openvibe.host gives the shared navbar the catalogue's own page list (the owner, 2026-11-12).
// Shared's legal template used to fall back to Home / My Account / Themes on /terms, /privacy and /dmca.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { NAV_LINKS } = require('../server/render/layout');

/** The links inside a page's OpenVibeNavbar.init({...}) call. */
function initLinks(html) {
    const at = html.indexOf('OpenVibeNavbar.init');
    if (at < 0) return null;
    const start = html.indexOf('links', at);
    const open = html.indexOf('[', start);
    let depth = 0, q = null, esc = false;
    for (let i = open; i < html.length; i += 1) {
        const c = html[i];
        if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '[') depth += 1; else if (c === ']') { depth -= 1; if (!depth) return JSON.parse(html.slice(open, i + 1)); }
    }
    return null;
}

(async () => {
    const t = await boot();
    try {
        const nav = NAV_LINKS().map(({ label, href }) => ({ label, href }));
        await check('every public page sends Host\'s own list, not the shared fallback', async () => {
            for (const path of ['/', ...nav.map((l) => l.href), '/terms', '/privacy', '/dmca']) {
                const r = await t.api('GET', path);
                assert.ok([200, 302, 303].includes(r.status), `${path} answered ${r.status}`);
                if (r.status !== 200) continue;
                const own = r.text.includes('window.__OV_PAGE')
                    ? JSON.parse(r.text.match(/window\.__OV_PAGE = (.+);/)[1]).navbar.links.map(({ label, href }) => ({ label, href }))
                    : (initLinks(r.text) || []).map(({ label, href }) => ({ label, href }));
                assert.deepStrictEqual(own, nav, `${path} sends Host's list`);
            }
        });
        await check('every row is a route of this server', async () => {
            for (const { href } of nav) {
                const r = await t.api('GET', href);
                assert.notStrictEqual(r.status, 404, `${href} is a route`);
                assert.ok(r.status < 500, `${href} does not fail (${r.status})`);
            }
        });
        await check('the home row is not called "Home"', async () => {
            assert.ok(!nav.some((l) => l.label === 'Home'), 'Host\'s list has no "Home" row');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
