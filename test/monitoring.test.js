'use strict';
// A deployed service is scraped (lib/monitoring.js; 2026-11-16: the scrape config had not been regenerated since 10-15
// and 22 services were never collected): a service with a job is left alone; one without a job whose metrics answer is
// added (the other scraped jobs kept, a job that does not answer left out so it cannot page TargetDown), checked with
// promtool, installed with the old one kept, and Prometheus reloaded; metrics that do not answer, or a config promtool
// refuses, leave the old config in place and say why.
const assert = require('assert');
const { ensureScraped, keepJobs, jobsIn } = require('../lib/monitoring');
const { render } = require('../scripts/prometheus-config');

const INV = {
    services: {
        live: { port: 3000 }, report: { port: 5080 }, mail: { port: 5250 }, quiet: { port: 5300, metrics: false },
    },
    exporters: [{ name: 'postgres', port: 9187 }],
};
// Today's config: node, postgres and live only (report and mail were added to the inventory later).
const TODAY = keepJobs(render(INV), (j) => ['node', 'postgres', 'live'].includes(j));

function fakeExec({ answers = {}, promtool = 0 } = {}) {
    const files = new Map([['/etc/prometheus/prometheus.yml', TODAY], ['/etc/openvibe/host.json', JSON.stringify(INV)]]);
    const runs = [];
    return {
        files, runs,
        readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
        writeFile: async (p, c) => { files.set(p, c); },
        removeFile: async (p) => { files.delete(p); },
        http: async (url) => ({ status: answers[new URL(url).port] || 404 }),
        run: async (cmd, args) => { runs.push([cmd, ...args].join(' ')); return { code: cmd === 'promtool' ? promtool : 0, stdout: '', stderr: cmd === 'promtool' && promtool ? 'bad config' : '' }; },
    };
}
const ctxOf = (exec) => ({ exec, inv: { file: '/etc/openvibe/host.json' } });

(async () => {
    assert.deepStrictEqual([...jobsIn(TODAY)].sort(), ['live', 'node', 'postgres']);

    // Already scraped: nothing happens.
    let exec = fakeExec({ answers: { 3000: 200 } });
    assert.strictEqual((await ensureScraped(ctxOf(exec), 'live')).state, 'scraped');
    assert.strictEqual(exec.runs.length, 0);

    // Report answers: added, mail (not answering) left out, the old config kept, promtool and a reload.
    exec = fakeExec({ answers: { 5080: 200 } });
    const r = await ensureScraped(ctxOf(exec), 'report');
    assert.strictEqual(r.state, 'added', JSON.stringify(r));
    const now = exec.files.get('/etc/prometheus/prometheus.yml');
    assert.deepStrictEqual([...jobsIn(now)].sort(), ['live', 'node', 'postgres', 'report'], 'report added, mail not');
    assert.ok(/127\.0\.0\.1:5080/.test(now) && /service: report/.test(now));
    assert.strictEqual(exec.files.get('/etc/prometheus/prometheus.yml.bak'), TODAY, 'the old config kept');
    assert.ok(!exec.files.has('/etc/prometheus/prometheus.yml.next'));
    assert.deepStrictEqual(exec.runs, ['promtool check config /etc/prometheus/prometheus.yml.next', 'systemctl reload prometheus']);

    // Mail's metrics do not answer: not added, the reason said.
    exec = fakeExec({ answers: {} });
    const m = await ensureScraped(ctxOf(exec), 'mail');
    assert.strictEqual(m.state, 'no-metrics');
    assert.ok(/answers 404/.test(m.line));
    assert.strictEqual(exec.files.get('/etc/prometheus/prometheus.yml'), TODAY, 'unchanged');

    // metrics: false and an unknown service: nothing to scrape.
    assert.strictEqual((await ensureScraped(ctxOf(fakeExec()), 'quiet')).state, 'nothing');
    assert.strictEqual((await ensureScraped(ctxOf(fakeExec()), 'nope')).state, 'nothing');

    // promtool refuses: the old config stays, no reload.
    exec = fakeExec({ answers: { 5080: 200 }, promtool: 1 });
    const bad = await ensureScraped(ctxOf(exec), 'report');
    assert.strictEqual(bad.state, 'invalid');
    assert.strictEqual(exec.files.get('/etc/prometheus/prometheus.yml'), TODAY);
    assert.ok(!exec.runs.some((x) => x.startsWith('systemctl')));

    // No Prometheus on this host: nothing, no error.
    exec = fakeExec(); exec.files.delete('/etc/prometheus/prometheus.yml');
    assert.strictEqual((await ensureScraped(ctxOf(exec), 'report')).state, 'no-prometheus');
    console.log('monitoring: a deployed service with answering metrics is scraped (others kept, silent ones left out), promtool and reload; otherwise the old config stays and says why');
})().catch((e) => { console.error(e); process.exit(1); });
