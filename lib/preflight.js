'use strict';
/**
 * Preflight: what must hold before anything restarts (every deploy strategy; inventory `preflight`).
 * Each rule comes from a per-repository deploy script:
 *
 *   syntaxCheck  every changed .js file passes `node --check` and every changed .json file parses
 *                (Live's syntax_check), in the tree that is about to run
 *   dirs         directories each package needs, made as the service user before the restart (Tools:
 *                apps/<app>/data, which every unit's ReadWritePaths names; systemd refuses to start a
 *                unit whose ReadWritePaths is missing)
 *   checks       an argv run in each named package directory as the service user; non-zero stops the
 *                deploy (Tools: the jobs runtime loads in img/audio/docs and the guard in every app, so
 *                a native-module ABI mismatch shows up here, not in a crash loop; Games: better-sqlite3
 *                loads under this Node)
 *
 * run() never restarts or changes a unit. -> { syntaxChecked, dirsMade, checksRun, problems: [text] }
 */
const path = require('path');

async function syntaxCheck(ctx, svc, root, changed) {
    const problems = [];
    let checked = 0;
    for (const f of changed) {
        const file = path.join(root, f);
        if (f.endsWith('.js') || f.endsWith('.cjs')) {
            const st = await ctx.exec.stat(file);
            if (!st || !st.isFile) continue;
            const r = await ctx.exec.run('node', ['--check', file], { as: svc.owner, cwd: root, timeoutMs: 60 * 1000 });
            checked += 1;
            if (r.code !== 0) problems.push(`syntax error in ${f}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' / ')}`);
        } else if (f.endsWith('.json')) {
            const text = await ctx.exec.readFile(file);
            if (text == null) continue;
            try { JSON.parse(text); } catch (err) { problems.push(`invalid JSON in ${f}: ${err.message}`); }
        }
    }
    return { checked, problems };
}

async function run(ctx, svc, { root = svc.repo, changed = [], pkgDirs = [] } = {}) {
    const p = svc.preflight || { syntaxCheck: false, dirs: [], checks: [] };
    const out = { syntaxChecked: 0, dirsMade: [], checksRun: 0, problems: [] };
    if (p.syntaxCheck && changed.length) {
        const s = await syntaxCheck(ctx, svc, root, changed);
        out.syntaxChecked = s.checked;
        out.problems.push(...s.problems);
        if (!s.problems.length) ctx.log(`syntax-checked ${s.checked} changed JS file(s)`);
        if (out.problems.length) return out;
    }
    for (const pkg of pkgDirs) {
        for (const d of p.dirs) {
            const dir = path.join(root, pkg, d);
            if (await ctx.exec.stat(dir)) continue;
            await ctx.exec.mkdir(dir, { owner: svc.runAs, mode: 0o755 });
            out.dirsMade.push(path.join(pkg, d));
        }
    }
    if (out.dirsMade.length) ctx.log(`made ${out.dirsMade.join(', ')} (as ${svc.runAs})`);
    for (const c of p.checks) {
        const dirs = c.packages === '*' ? pkgDirs : c.packages;
        for (const pkg of dirs) {
            const cwd = path.join(root, pkg);
            if (!(await ctx.exec.stat(cwd))) { out.problems.push(`${c.label}: ${pkg} does not exist`); continue; }
            const r = await ctx.exec.run(c.argv[0], c.argv.slice(1), { as: svc.runAs, cwd, timeoutMs: c.timeoutSeconds * 1000 });
            out.checksRun += 1;
            if (r.code !== 0) out.problems.push(`${c.label} failed in ${pkg}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-3).join(' / ')}`);
        }
    }
    if (p.checks.length && !out.problems.length) ctx.log(`preflight: ${out.checksRun} check(s) passed (${p.checks.map((c) => c.label).join('; ')})`);
    return out;
}

/** What a plan says about the preflight, without running it. */
function describe(svc) {
    const p = svc.preflight || { syntaxCheck: false, dirs: [], checks: [] };
    const parts = [];
    if (p.syntaxCheck) parts.push('syntax check of changed .js/.json');
    if (p.dirs.length) parts.push(`make ${p.dirs.join(', ')} in each package`);
    for (const c of p.checks) parts.push(`${c.label} (${c.packages === '*' ? 'every package' : c.packages.join(', ')})`);
    return parts;
}

module.exports = { run, describe, syntaxCheck };
