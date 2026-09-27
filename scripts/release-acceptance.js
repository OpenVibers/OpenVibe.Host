#!/usr/bin/env node
'use strict';
/**
 * Release-lifecycle acceptance (D46, roadmap WS-P task 16): the 14 scenarios in lib/acceptance.js, each gate's
 * tests run with `node <file>` from its repository, then a table of result, measured value and budget.
 *
 *   node scripts/release-acceptance.js                         # every scenario; site gates skipped
 *   node scripts/release-acceptance.js --only 9,14,6a          # scenarios by number, gates by id
 *   node scripts/release-acceptance.js --base https://openvibe.live --channel /@JapaneseOldGuy
 *   node scripts/release-acceptance.js --json                  # the report as JSON on stdout
 *   node scripts/release-acceptance.js --out run.md            # also write the run as Markdown (overwrites)
 *
 * --repos <dir>     where the repositories are checked out (default ~/OpenVibers); this repository is always
 *                   the Host one
 * --live <dir>      OpenVibe.Live (default ~/orca/workspaces/OpenVibe.Live/seadragon, else <repos>/OpenVibe.Live)
 * --base <url>      a running site for the browser gates (Live's test/browser/smoke.js with BASE, this
 *                   repository's scripts/browser-check.js) and the manifest gate; they only read pages.
 *                   Without it they are reported as skipped, never as passing
 * --channel </@x>   the channel page the Live smoke visits (its default /@admin exists only locally)
 * --node <path>     the node that runs the tests (default: this one; the repositories test on Node 22)
 * --timeout <s>     the default per-gate timeout (180 s; the browser gates have their own)
 * --logs <dir>      keep each test's full output there (<repo>__<file>.log)
 * --strict          exit 1 unless every selected gate passed (skipped and open count against it)
 * --list            print the table of gates without running anything
 *
 * Exit 0 when no gate failed (skipped and open gates are listed with their reason, never counted as passes),
 * 1 when one failed, 2 on bad arguments.
 */
const fs = require('fs');
const path = require('path');
const acceptance = require('../lib/acceptance');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const expand = (p) => (p && p.startsWith('~/') ? path.join(require('os').homedir(), p.slice(2)) : p);

const KNOWN = new Set(['repos', 'live', 'base', 'channel', 'node', 'timeout', 'only', 'out', 'logs', 'json', 'strict', 'list', 'help']);
for (const a of argv) {
    if (a.startsWith('--') && !KNOWN.has(a.slice(2))) { console.error(`unknown option ${a} (see the header of scripts/release-acceptance.js)`); process.exit(2); }
}
if (has('help')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n'));
    process.exit(0);
}
const only = arg('only') ? arg('only').split(',').map((s) => s.trim()).filter(Boolean) : [];
const known = new Set(acceptance.SCENARIOS.flatMap((s) => [String(s.n), ...s.gates.map((g) => g.id)]));
const unknown = only.filter((o) => !known.has(o));
if (unknown.length) { console.error(`--only: no scenario or gate ${unknown.join(', ')} (scenarios 1-${acceptance.SCENARIOS.length}, gates like 6a)`); process.exit(2); }
const base = arg('base');
if (base && !/^https?:\/\/[^/]+/.test(base)) { console.error('--base takes an http(s) origin, e.g. https://openvibe.live'); process.exit(2); }
const timeout = arg('timeout') ? Number(arg('timeout')) : null;
if (timeout !== null && !(timeout > 0)) { console.error('--timeout takes seconds'); process.exit(2); }

if (has('list')) {
    for (const { scenario, gate } of acceptance.select(acceptance.SCENARIOS, only)) {
        const where = gate.kind === 'record' ? 'record: docs/deploy-proofs.md' : gate.kind === 'manifest' ? 'manifest: <base>/release.json' : gate.kind === 'open' ? 'open' : `${gate.repo}${gate.cwd ? `/${gate.cwd}` : ''}: ${gate.files.join(', ')}`;
        console.log(`${String(scenario.n).padStart(2)} ${gate.id.padEnd(4)} ${acceptance.formatBudget(gate.budget).padEnd(10)} ${gate.budget.name}${gate.base ? ' [--base]' : ''}\n          ${where}`);
    }
    process.exit(0);
}

(async () => {
    const report = await acceptance.runAcceptance({
        only, base, channel: arg('channel'), node: arg('node') || process.execPath,
        repos: expand(arg('repos')) || undefined, live: expand(arg('live')) || undefined,
        timeoutMs: timeout ? timeout * 1000 : undefined, logs: expand(arg('logs')) || undefined,
        onGate: has('json') ? null : (r) => process.stderr.write(`  ${r.id.padEnd(4)} ${r.result}${r.ms ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}\n`),
    });
    if (has('json')) console.log(JSON.stringify(report, null, 2));
    else console.log(acceptance.formatTable(report));
    if (arg('out')) fs.writeFileSync(arg('out'), `${acceptance.formatMarkdown(report)}\n`);
    const s = report.summary;
    process.exit(!s.ok || (has('strict') && s.pass !== s.gates) ? 1 : 0);
})().catch((err) => { console.error(err.stack || err.message); process.exit(2); });
