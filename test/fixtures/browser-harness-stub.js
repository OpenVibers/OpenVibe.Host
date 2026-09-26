'use strict';
// Stand-in for openvibe-shared/browser-harness in test/browser-check.test.js: no Chrome. run() records what it
// was asked (to $STUB_CALLS, one JSON line per call) and answers a canned report; a base whose host starts with
// "bad" fails its overflow check.
const fs = require('fs');

const CHECKS = ['status', 'errors', 'overflow', 'scripts', 'nojs', 'canonical', 'jsonld', 'axe'];
const tally = (v) => ({ pass: v === 'pass' ? 1 : 0, warn: v === 'warn' ? 1 : 0, fail: v === 'fail' ? 1 : 0, skip: v === 'skip' ? 1 : 0 });

module.exports = {
    WIDTHS: [390, 768, 1280],
    AXE: { version: '0.0.0-stub' },
    sitemapPaths: (xml, base, cap) => [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]))
        .filter((u) => u.origin === new URL(base).origin && u.pathname !== '/').map((u) => u.pathname).slice(0, cap),
    launch: async () => ({ closed: false, close() { this.closed = true; } }),
    format: (r) => `${r.base}: ${r.ok ? 'pass' : 'FAIL'}`,
    run: async (o) => {
        if (process.env.STUB_CALLS) {
            fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify({ base: o.base, routes: o.routes, widths: o.widths, checks: o.checks, laps: o.navigation.laps, ignore: (o.ignoreErrors || []).map((x) => x.label) })}\n`);
        }
        const bad = new URL(o.base).hostname.startsWith('bad');
        const checks = Object.fromEntries(CHECKS.map((c) => [c, c === 'overflow' && bad ? 'fail' : 'pass']));
        const routes = o.routes.map((r) => ({ path: typeof r === 'string' ? r : r.path, checks, ok: !bad, ...(bad ? {} : { ignored: { 'signed-out session probe answered 401': 2 } }) }));
        const summary = { routes: routes.length, checks: Object.fromEntries(CHECKS.map((c) => [c, tally(checks[c])])), axe: { critical: 0, serious: bad ? 2 : 0, moderate: 1, minor: 0 }, ok: !bad };
        summary.checks.navigation = tally('pass');
        return { base: o.base, chrome: 'Chrome/0-stub', routes, navigation: { ok: true, growth: { deltas: { heapKB: 12, nodes: 0, listeners: 1 }, over: [] }, idle: { cpuPct: 0.5, requests: 1 } }, summary, ok: !bad };
    },
};
