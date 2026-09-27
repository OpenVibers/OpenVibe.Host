'use strict';
/**
 * The release-lifecycle acceptance runner (lib/acceptance.js, scripts/release-acceptance.js; roadmap WS-P task 16)
 * without the other repositories: the scenario table is complete, budgets compare, every parser reads what the
 * real tests print, and a gate is judged pass, fail, skipped or open for the right reason. Fixture "repositories"
 * are temporary directories holding tiny test scripts.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, runTests } = require('./helpers');
const a = require('../lib/acceptance');

const D46 = [
    'Home styles deployed during a broadcast', 'A shared navbar update', 'An article or paste edit', 'A feed update while reading',
    'A tool upgrade during a job', 'An API restart during streams or calls', 'A media-worker rollout', 'Duplicate or older notifications',
    'An account switch during an update', 'A partial asset group', 'Repeated navigation leaks', 'JS-disabled routes',
    'Rollback with new writes', 'Resuming an offline tab',
];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ov-acceptance-'));
/** A fixture repository: files { 'test/x.test.js': source }. */
function repo(files) {
    const dir = tmp();
    for (const [f, src] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), src); }
    return dir;
}
/** A ctx whose runner answers from `outputs` (file → { code, out }) and counts the runs. */
function fakeCtx(dirs, outputs, extra = {}) {
    const runs = [];
    return {
        runs,
        ctx: {
            dirs, base: null, hostDir: extra.hostDir || tmp(), timeoutMs: 1000,
            readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
            fetchManifest: extra.fetchManifest || (async () => { throw new Error('no site'); }),
            run: async (spec) => { runs.push(spec); const o = outputs[spec.file] || { code: 0, out: '' }; return { code: o.code, signal: null, out: o.out, stdout: o.stdout || o.out, ms: 1, timedOut: !!o.timedOut }; },
            ...extra.ctx,
        },
    };
}
const gate = (o) => ({ id: 'x1', what: 'w', repo: 'shared', files: ['test/t.test.js'], budget: { name: 'n', max: 0 }, measure: { asserted: true }, category: 'affected sessions', ...o });

runTests([
    test('the table: 14 scenarios in D46 order, each with gates that can run locally, every gate complete', () => {
        assert.deepStrictEqual(a.SCENARIOS.map((s) => s.n), D46.map((_, i) => i + 1));
        assert.deepStrictEqual(a.SCENARIOS.map((s) => s.name), D46);
        const ids = new Set();
        for (const s of a.SCENARIOS) {
            assert.ok(s.gates.length >= 1, `scenario ${s.n} has a gate`);
            assert.ok(s.gates.some((g) => !g.base && ['test', 'record', undefined].includes(g.kind)), `scenario ${s.n} has evidence a local run judges`);
            assert.ok(s.gates.some((g) => !g.kind && !g.base), `scenario ${s.n} has at least one test gate without a running site`);
            for (const g of s.gates) {
                assert.ok(!ids.has(g.id), `gate ${g.id} is unique`); ids.add(g.id);
                assert.match(g.id, new RegExp(`^${s.n}[a-z]$`), `${g.id} is named after its scenario`);
                assert.ok(g.what && g.budget && g.budget.name, `${g.id}: what and a named budget`);
                assert.ok(['max', 'min', 'equals'].some((k) => typeof g.budget[k] === 'number'), `${g.id}: a numeric bound`);
                assert.ok(a.CATEGORIES.includes(g.category), `${g.id}: a D46 category (${g.category})`);
                const kind = g.kind || 'test';
                if (kind === 'test') {
                    assert.ok(a.REPOS[g.repo], `${g.id}: a known repository`);
                    assert.ok(g.files.length && g.files.every((f) => /^[\w./-]+\.js$/.test(f) && !path.isAbsolute(f)), `${g.id}: relative .js files`);
                    assert.ok(g.measure && (g.measure.asserted || typeof g.measure === 'function'), `${g.id}: a measure`);
                    assert.ok((g.expect || []).length, `${g.id}: at least one line it expects`);
                    for (const p of g.pins || []) assert.ok(g.files.includes(p.file) && p.text, `${g.id}: pins name a file it runs`);
                    assert.ok(g.source, `${g.id}: where the number comes from`);
                } else if (kind === 'record') assert.ok(g.row, `${g.id}: a proof row`);
                else if (kind === 'manifest') assert.ok(g.base && typeof g.check === 'function', `${g.id}: a manifest check needs --base`);
                else { assert.strictEqual(kind, 'open'); assert.ok(g.reason, `${g.id}: why it is open`); }
            }
        }
        // Host's own gates name files that exist here.
        for (const s of a.SCENARIOS) for (const g of s.gates.filter((x) => x.repo === 'host')) for (const f of g.files) assert.ok(fs.existsSync(path.join(a.HOST_DIR, f)), f);
        // Every record names a row of docs/deploy-proofs.md.
        const rows = a.proofRows(fs.readFileSync(path.join(a.HOST_DIR, 'docs', 'deploy-proofs.md'), 'utf8'));
        for (const s of a.SCENARIOS) for (const g of s.gates.filter((x) => x.kind === 'record')) assert.ok(rows[g.row], `deploy-proofs.md: ${g.row}`);
    }),

    test('budgets: max, min and equals compare; the text shows the bound and unit', () => {
        assert.strictEqual(a.withinBudget(0, { max: 0 }), true);
        assert.strictEqual(a.withinBudget(1, { max: 0 }), false);
        assert.strictEqual(a.withinBudget(660, { max: 5000 }), true);
        assert.strictEqual(a.withinBudget(100, { min: 100 }), true);
        assert.strictEqual(a.withinBudget(99.9, { min: 100 }), false);
        assert.strictEqual(a.withinBudget(1, { equals: 1 }), true);
        assert.strictEqual(a.withinBudget(NaN, { max: 1 }), false);
        assert.strictEqual(a.withinBudget(undefined, { max: 1 }), false);
        assert.strictEqual(a.formatBudget({ max: 5000, unit: 'ms' }), '≤ 5000 ms');
        assert.strictEqual(a.formatBudget({ min: 100, unit: '%' }), '≥ 100 %');
        assert.strictEqual(a.formatBudget({ equals: 1 }), '= 1');
        assert.strictEqual(a.boundOf({ min: 100 }), 100);
    }),

    test('parsers read what the real tests print', () => {
        assert.deepStrictEqual(a.parseMetrics('[metric] a.b=0\nnoise\n[metric] c-d=12.5\n[metric] a.b=3\n[metric] bad=x\n'), { 'a.b': 3, 'c-d': 12.5 });
        assert.deepStrictEqual(a.metric('c-d')('[metric] c-d=7'), { value: 7, text: undefined });
        assert.strictEqual(a.metric('missing')('[metric] c-d=7'), null);
        // Tools' graceful.test.js summary line.
        const g = a.gracefulStop('graceful stop: helper ok; SIGTERM → exit 0 with the request in flight answered: gateway 365 ms, img 431 ms, food 661 ms');
        assert.deepStrictEqual([g.value, g.text], [661, '661 ms (food; 3 processes)']);
        assert.strictEqual(a.gracefulStop('graceful stop: helper ok'), null);
        // Live's smoke lap probes.
        const laps = '  ✓ x\n    lap probes: {"intervals":14,"sockets":0,"windowListeners":58,"domNodes":6363}\n                {"intervals":14,"sockets":1,"windowListeners":58,"domNodes":6370}\n                {"intervals":15,"sockets":1,"windowListeners":61,"domNodes":6300}\n  ✓ repeated navigation';
        assert.deepStrictEqual(a.lapProbes(laps), { intervals: 1, sockets: 0, windowListeners: 3, domNodes: -70 });
        assert.deepStrictEqual(a.lapGrowth(['intervals', 'windowListeners'])(laps), { value: 3, text: 'intervals +1, windowListeners +3 (laps 2→3)' });
        assert.strictEqual(a.lapGrowth(['domNodes'])(laps).value, -70);
        assert.strictEqual(a.lapProbes('lap probes: {"a":1}'), null, 'three laps or nothing');
        assert.deepStrictEqual(a.duplicateScripts('  ✓ no script requested twice (48 scripts)'), { value: 0, text: '0 of 48 scripts' });
        assert.strictEqual(a.duplicateScripts('  ✗ scripts requested more than once: app.js×2, chat.js×2').value, 2);
        // Host's browser-check --json (stdout), with progress on stderr.
        const report = [{ id: 'live', navigation: { growth: { measured: true, laps: 5, from: 2, deltas: { heapKB: 61, nodes: 5, listeners: 1, documents: 0, intervals: 0, timeouts: 0, sockets: 0 }, over: [] } },
            routes: [{ nojs: { textChars: 2058 } }, { nojs: { textChars: 1529 } }, { nojs: null }], summary: { checks: { nojs: { pass: 2, warn: 0, fail: 0, skip: 1 } } } }];
        const io = { stdout: JSON.stringify(report, null, 2) };
        assert.deepStrictEqual(a.navigationGrowth('progress', io), { value: 0, text: '0 over; heap +61 KB, nodes +5, listeners +1, intervals 0, timeouts 0, sockets 0 (laps 2→5)' });
        assert.deepStrictEqual(a.noJsRoutes('progress', io), { value: 0, text: '0 of 2 routes unreadable (least text 1529 chars)' });
        assert.strictEqual(a.navigationGrowth('not json', { stdout: 'not json' }), null);
        // docs/deploy-proofs.md's table.
        const rows = a.proofRows('| Proof | State | Record |\n|---|---|---|\n| Web drain (Live) | passed 2026-09-26 | [below](#x) |\n| Recorder (Media) | open | needs a live ingest |\n');
        assert.deepStrictEqual(rows, { 'Web drain (Live)': { state: 'passed 2026-09-26', record: '[below](#x)' }, 'Recorder (Media)': { state: 'open', record: 'needs a live ingest' } });
    }),

    test('skipped: no --base, a repository not there, or a test that says it skipped; never a pass', async () => {
        const dir = repo({ 'test/t.test.js': '' });
        const { ctx, runs } = fakeCtx({ shared: dir }, { 'test/t.test.js': { code: 0, out: 'notification-live-chrome: skipped (no Chrome; set CHROME_BIN)\n' } });
        const base = await a.judgeGate(gate({ base: true }), ctx);
        assert.deepStrictEqual([base.result, base.reason], ['skipped', 'needs a running site: --base <url>']);
        const missing = await a.judgeGate(gate({ repo: 'media' }), fakeCtx({ media: path.join(dir, 'nope') }, {}).ctx);
        assert.strictEqual(missing.result, 'skipped');
        assert.match(missing.reason, /OpenVibe\.Media not found at .*nope/);
        const said = await a.judgeGate(gate({ expect: [/all checks passed/] }), ctx);
        assert.deepStrictEqual([said.result, said.reason], ['skipped', 'test/t.test.js: no Chrome; set CHROME_BIN']);
        assert.strictEqual(runs.length, 1, 'nothing ran for the first two');
        assert.deepStrictEqual(a.summarize([base, missing, said]), { gates: 3, pass: 0, fail: 0, skipped: 3, open: 0, ok: true, scenarios: 1 });
    }),

    test('fail: exit code, a missing expected line, a missing pin, over budget, unmeasurable, a timeout', async () => {
        const dir = repo({ 'test/t.test.js': "assert.strictEqual(x, 0, 'never while typing');\n" });
        const run = (out, code = 0, extra = {}) => fakeCtx({ shared: dir }, { 'test/t.test.js': { code, out, ...extra } });
        const exit = await a.judgeGate(gate({ measure: a.metric('x.n'), expect: [/ok/] }), run('[metric] x.n=1\nAssertionError', 1).ctx);
        assert.deepStrictEqual([exit.result, exit.reason, exit.measured, exit.measuredText], ['fail', 'test/t.test.js failed (exit 1)', 1, '1'], 'a failing test still shows what it measured');
        assert.match(exit.tail, /AssertionError/);
        const line = await a.judgeGate(gate({ expect: [/x: all checks passed/] }), run('x: something else').ctx);
        assert.deepStrictEqual([line.result, line.reason], ['fail', 'expected output missing: x: all checks passed']);
        const { ctx, runs } = run('x: all checks passed');
        const pin = await a.judgeGate(gate({ expect: [/passed/], pins: [{ file: 'test/t.test.js', text: 'never while the camera is live' }] }), ctx);
        assert.strictEqual(pin.result, 'fail');
        assert.match(pin.reason, /the assertion this gate rests on is gone from test\/t\.test\.js: never while the camera is live/);
        assert.strictEqual(runs.length, 0, 'a gate whose assertion is gone does not even run');
        const over = await a.judgeGate(gate({ expect: [/ok/], measure: a.metric('delay'), budget: { name: 'delay', max: 0, unit: 'ms' } }), run('[metric] delay=30000\nok').ctx);
        assert.deepStrictEqual([over.result, over.reason, over.measuredText], ['fail', 'outside the budget', '30000 ms']);
        const none = await a.judgeGate(gate({ expect: [/ok/], measure: a.metric('delay') }), run('ok').ctx);
        assert.deepStrictEqual([none.result, none.reason], ['fail', 'the measured value is not in the output']);
        const slow = await a.judgeGate(gate({ timeoutMs: 1000 }), run('', null, { timedOut: true }).ctx);
        assert.deepStrictEqual([slow.result, slow.reason], ['fail', 'test/t.test.js timed out after 1 s']);
        const gone = await a.judgeGate(gate({ files: ['test/gone.test.js'] }), run('').ctx);
        assert.deepStrictEqual([gone.result, gone.reason], ['fail', 'test/gone.test.js is missing in OpenVibe.Shared']);
        assert.strictEqual(a.summarize([exit, line, pin, over]).ok, false);
    }),

    test('pass: an asserted bound, a measured value, a smoke whose other checks failed (ignoreExit)', async () => {
        const dir = repo({ 'test/t.test.js': "'never while typing'" });
        const ok = await a.judgeGate(gate({ expect: [/all checks passed/], pins: [{ file: 'test/t.test.js', text: 'never while typing' }], measure: { asserted: true, note: 'deferred: typing' } }), fakeCtx({ shared: dir }, { 'test/t.test.js': { code: 0, out: 't: all checks passed' } }).ctx);
        assert.deepStrictEqual([ok.result, ok.measured, ok.measuredText, ok.budgetText], ['pass', 0, '0 (asserted; deferred: typing)', '≤ 0']);
        const min = await a.judgeGate(gate({ expect: [/works/], budget: { name: 'rows', min: 100, unit: '%' }, measure: { asserted: true } }), fakeCtx({ shared: dir }, { 'test/t.test.js': { code: 0, out: 'it works' } }).ctx);
        assert.deepStrictEqual([min.result, min.measuredText], ['pass', '100 % (asserted)']);
        const smoke = '    lap probes: {"intervals":14}\n {"intervals":14}\n {"intervals":14}\n  ✗ 1440px /@admin: active=page-home\n\n6 browser check(s) failed\n';
        const { ctx } = fakeCtx({ live: dir }, { 'test/t.test.js': { code: 1, out: smoke } });
        ctx.base = 'https://site.test';
        const leak = await a.judgeGate(gate({ repo: 'live', base: true, ignoreExit: true, expect: [/lap probes:/], budget: { name: 'growth', max: 2 }, measure: a.lapGrowth(['intervals']) }), ctx);
        assert.deepStrictEqual([leak.result, leak.measured, leak.reason, leak.note], ['pass', 0, null, "the smoke's other checks: 6 failed (not this gate's)"]);
    }),

    test('records, manifests and open gates', async () => {
        const hostDir = repo({ 'docs/deploy-proofs.md': '| Proof | State | Record |\n|---|---|---|\n| Web drain (Live) | passed 2026-09-26 | [below](#w) |\n| Recorder (Media) | open | needs a live ingest during a Media deploy |\n\n57 requests, all 200.\n' });
        const { ctx } = fakeCtx({}, {}, { hostDir });
        const rec = (o) => ({ id: 'r1', kind: 'record', what: 'w', budget: { name: 'failed', max: 0 }, category: 'affected sessions', ...o });
        const passed = await a.judgeGate(rec({ row: 'Web drain (Live)', quote: '57 requests, all 200', value: 0, text: '0 of 57' }), ctx);
        assert.deepStrictEqual([passed.result, passed.measuredText, passed.note], ['pass', '0 of 57', 'recorded: passed 2026-09-26']);
        const open = await a.judgeGate(rec({ row: 'Recorder (Media)' }), ctx);
        assert.deepStrictEqual([open.result, open.reason], ['open', 'open: needs a live ingest during a Media deploy']);
        const changed = await a.judgeGate(rec({ row: 'Web drain (Live)', quote: '99 requests', value: 0 }), ctx);
        assert.deepStrictEqual([changed.result, changed.reason], ['fail', 'the record no longer says "99 requests"']);
        const noRow = await a.judgeGate(rec({ row: 'Nope' }), ctx);
        assert.strictEqual(noRow.result, 'fail');
        const over = await a.judgeGate(rec({ row: 'Web drain (Live)', value: 4 }), ctx);
        assert.strictEqual(over.result, 'fail');

        const styles = a.SCENARIOS[0].gates.find((g) => g.kind === 'manifest');
        const site = (m) => fakeCtx({}, {}, { fetchManifest: async () => m, ctx: { base: 'https://site.test' } }).ctx;
        const without = await a.judgeGate(styles, site({ components: { shell: { kind: 'script', version: 'a' }, server: { kind: 'server', version: 'a' } } }));
        assert.deepStrictEqual([without.result, without.measured, without.measuredText], ['open', 0, '0 (components: shell:script, server:server)']);
        const withStyles = await a.judgeGate(styles, site({ components: { styles: { kind: 'style', version: 'b' } } }));
        assert.strictEqual(withStyles.result, 'pass');
        const down = await a.judgeGate(styles, fakeCtx({}, {}, { ctx: { base: 'https://site.test' } }).ctx);
        assert.deepStrictEqual([down.result, down.reason], ['fail', 'GET https://site.test/release.json: no site']);
        const known = await a.judgeGate({ id: 'o1', kind: 'open', what: 'w', budget: { name: 'n', max: 0 }, reason: 'no proof yet' }, site({}));
        assert.deepStrictEqual([known.result, known.reason], ['open', 'no proof yet']);
        assert.deepStrictEqual(a.summarize([passed, open, known]), { gates: 3, pass: 1, fail: 0, skipped: 0, open: 2, ok: true, scenarios: 1 });
    }),

    test('runAcceptance runs real processes: node <file> from the repository, once per file, with a timeout; versions recorded', async () => {
        const counter = path.join(tmp(), 'runs.log');
        const dir = repo({
            'test/good.test.js': `require('fs').appendFileSync(${JSON.stringify(counter)}, 'good\\n'); console.log('[metric] x.delay=0'); console.log('cwd ' + process.cwd()); console.log('good: all checks passed');`,
            'test/bad.test.js': "console.log('[metric] x.left=2'); console.error('AssertionError: left 2'); process.exit(1);",
            'test/slow.test.js': 'setTimeout(() => {}, 60000);',
            'test/env.test.js': "console.log('env ' + process.env.NODE_ENV + ' ' + (process.env.BASE || '-'));",
        });
        const scenarios = [
            { n: 1, name: 'One', gates: [
                gate({ id: '1a', files: ['test/good.test.js'], expect: [/good: all checks passed/], measure: a.metric('x.delay'), budget: { name: 'delay', max: 0 } }),
                gate({ id: '1b', files: ['test/good.test.js'], expect: [new RegExp(`cwd ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')] }),
                gate({ id: '1c', files: ['test/env.test.js'], expect: [/env test -/] }),
            ] },
            { n: 2, name: 'Two', gates: [
                gate({ id: '2a', files: ['test/bad.test.js'], expect: [/never/], measure: a.metric('x.left') }),
                gate({ id: '2b', files: ['test/slow.test.js'], timeoutMs: 500 }),
                gate({ id: '2c', repo: 'live', files: ['test/good.test.js'], base: true }),
            ] },
        ];
        const seen = [];
        const report = await a.runAcceptance({ scenarios, dirs: { shared: dir, live: dir, host: a.HOST_DIR }, onGate: (r) => seen.push(r.id) });
        const by = Object.fromEntries(report.gates.map((r) => [r.id, r]));
        assert.deepStrictEqual(seen, ['1a', '1b', '1c', '2a', '2b', '2c']);
        assert.deepStrictEqual(['1a', '1b', '1c', '2a', '2b', '2c'].map((id) => by[id].result), ['pass', 'pass', 'pass', 'fail', 'fail', 'skipped']);
        assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'good\n', 'a file two gates share runs once');
        assert.deepStrictEqual([by['2a'].measured, by['2a'].reason], [2, 'test/bad.test.js failed (exit 1)']);
        assert.match(by['2b'].reason, /timed out after 1 s/);
        assert.deepStrictEqual(report.summary, { gates: 6, pass: 3, fail: 2, skipped: 1, open: 0, ok: false, scenarios: 2 });
        assert.strictEqual(report.versions.shared.dir, dir);
        assert.strictEqual(report.versions.shared.commit, null, 'not a git checkout: no commit');
        assert.ok(report.versions.host.commit, 'the Host checkout records its commit');
        // The reports.
        const table = a.formatTable(report);
        assert.match(table, /── 1\. One/);
        assert.match(table, /3 passed, 2 failed, 1 skipped, 0 open \(6 gates, 2 scenarios\) — FAILED/);
        assert.match(table, /── 2a \(test\/bad\.test\.js failed \(exit 1\)\) ──\n[\s\S]*AssertionError: left 2/);
        const mdown = a.formatMarkdown({ ...report, gates: [...report.gates, { ...by['1a'], what: 'a | b' }] });
        assert.match(mdown, /\| 1 \| 1a \| pass \| 0 \| ≤ 0 \|/);
        assert.match(mdown, /\| 2 \| 2c \| \*\*skipped\*\*: needs a running site: --base <url> \|/);
        assert.match(mdown, /a \\\| b/, 'pipes are escaped');
    }),

    test('a repository that moves while its tests run is named in the report', async () => {
        const dir = repo({ 'test/commit.test.js': "const { execFileSync } = require('child_process'); require('fs').writeFileSync('new.txt', 'x'); execFileSync('git', ['add', 'new.txt']); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'during']); console.log('ok');" });
        const g = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
        g('init', '-q'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
        const before = g('rev-parse', '--short=12', 'HEAD').stdout.trim();
        const logs = tmp();
        const report = await a.runAcceptance({ scenarios: [{ n: 1, name: 'One', gates: [gate({ id: '1a', files: ['test/commit.test.js'], expect: [/ok/] })] }], dirs: { shared: dir, host: a.HOST_DIR }, logs });
        const v = report.versions.shared;
        assert.strictEqual(v.commit, before, 'the commit the run started from');
        assert.strictEqual(v.changedDuringRun, g('rev-parse', '--short=12', 'HEAD').stdout.trim());
        assert.match(a.formatTable(report), /CHANGED DURING THE RUN/);
        assert.deepStrictEqual(fs.readdirSync(logs), ['shared__test_commit.test.js.log'], '--logs keeps each run\'s output');
    }),

    test('scripts/release-acceptance.js: bad arguments exit 2; without the repositories every gate is skipped and the run exits 0 with 0 passes', () => {
        const script = path.join(a.HOST_DIR, 'scripts', 'release-acceptance.js');
        const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });
        assert.strictEqual(run('--only', '99').status, 2);
        assert.strictEqual(run('--bogus').status, 2);
        assert.strictEqual(run('--base', 'openvibe.live').status, 2);
        const list = run('--list');
        assert.strictEqual(list.status, 0);
        assert.strictEqual((list.stdout.match(/^ ?\d+ \d+[a-z] /gm) || []).length, a.SCENARIOS.reduce((n, s) => n + s.gates.length, 0));
        const empty = tmp();
        const r = run('--repos', empty, '--live', path.join(empty, 'live'), '--only', '9,14', '--json');
        assert.strictEqual(r.status, 0, r.stderr);
        const report = JSON.parse(r.stdout);
        assert.strictEqual(report.summary.pass, 0, 'skipped gates are never passes');
        assert.strictEqual(report.summary.skipped, report.summary.gates);
        assert.ok(report.gates.every((g) => /OpenVibe\.Shared not found/.test(g.reason)));
        const strict = run('--repos', empty, '--live', path.join(empty, 'live'), '--only', '9a', '--strict');
        assert.strictEqual(strict.status, 1, '--strict: a skipped gate fails the run');
    }),
]);
