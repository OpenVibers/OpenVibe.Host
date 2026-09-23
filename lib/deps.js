'use strict';
/**
 * Dependencies: when to install, how, and proof that every dependency resolves before anything
 * restarts.
 *
 * The verification rule comes from a Tools outage: a dependency that used to be a `file:` link left
 * an empty directory that npm treated as installed, and every unit crash-looped on the missing
 * module. So a package counts as resolved only when node_modules/<dep>/package.json exists, parses,
 * and names that package. A broken one is removed and reinstalled once; if it still does not
 * resolve, the deploy aborts with nothing restarted.
 */
const path = require('path');

/** package dirs (relative) from patterns like ".", "apps/*" — only dirs that have a package.json. */
async function expandPackages(exec, svc) {
    const out = [];
    for (const pattern of svc.packages) {
        if (pattern.endsWith('/*')) {
            const base = pattern.slice(0, -2);
            const entries = (await exec.readdir(path.join(svc.repo, base))) || [];
            for (const e of entries.filter((x) => x.isDir).sort((a, b) => a.name.localeCompare(b.name))) {
                const dir = path.join(base, e.name);
                if (await exec.stat(path.join(svc.repo, dir, 'package.json'))) out.push(dir);
            }
        } else if (await exec.stat(path.join(svc.repo, pattern, 'package.json'))) {
            out.push(path.normalize(pattern));
        }
    }
    return out;
}

function depFields(text) {
    try {
        const j = JSON.parse(text);
        return JSON.stringify([j.dependencies || {}, j.optionalDependencies || {}, j.engines || {}]);
    } catch { return null; }
}

/** Whether a package dir needs an install between two revisions (lockfile or dependency fields changed). */
async function needsInstall(g, from, to, pkgDir) {
    const lock = path.join(pkgDir, 'package-lock.json');
    const pkg = path.join(pkgDir, 'package.json');
    const [lockA, lockB, pkgA, pkgB] = await Promise.all([g.show(from, lock), g.show(to, lock), g.show(from, pkg), g.show(to, pkg)]);
    const lockfileChanged = lockA !== lockB;
    const depsChanged = depFields(pkgA) !== depFields(pkgB);
    return { lockfileChanged, depsChanged, needed: lockfileChanged || depsChanged };
}

/**
 * npm install as the checkout owner. Afterwards the lockfile is restored from git: npm rewrites it
 * on the host (different npm version), and a dirty lockfile blocks the next fast-forward pull.
 */
async function install(exec, svc, g, pkgDir) {
    const [cmd, ...args] = svc.install.command;
    const r = await exec.run(cmd, args, { as: svc.owner, cwd: path.join(svc.repo, pkgDir), timeoutMs: 20 * 60 * 1000 });
    if (r.code !== 0) throw new Error(`${svc.install.command.join(' ')} failed in ${pkgDir}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
    if (svc.install.restoreLockfile) {
        const lock = path.join(pkgDir, 'package-lock.json');
        const dirty = await g.dirty();
        if (dirty.includes(lock)) await g.checkoutFile(lock);
    }
}

/** Returns [{ pkg, dep, reason }] for every declared dependency that does not resolve. */
async function verify(exec, svc, pkgDirs) {
    const problems = [];
    for (const pkgDir of pkgDirs) {
        const root = path.join(svc.repo, pkgDir);
        const text = await exec.readFile(path.join(root, 'package.json'));
        let pkg;
        try { pkg = JSON.parse(text); } catch { problems.push({ pkg: pkgDir, dep: null, reason: 'package.json does not parse' }); continue; }
        for (const dep of Object.keys(pkg.dependencies || {})) {
            const depJson = await exec.readFile(path.join(root, 'node_modules', dep, 'package.json'));
            if (depJson == null) { problems.push({ pkg: pkgDir, dep, reason: 'node_modules/' + dep + '/package.json is missing' }); continue; }
            let meta;
            try { meta = JSON.parse(depJson); } catch { problems.push({ pkg: pkgDir, dep, reason: 'its package.json does not parse' }); continue; }
            if (meta.name !== dep) problems.push({ pkg: pkgDir, dep, reason: `installed package is named "${meta.name}"` });
        }
    }
    return problems;
}

/** verify; remove and reinstall anything broken once; verify again. Returns the remaining problems. */
async function verifyAndRepair(exec, svc, g, pkgDirs, log = () => {}) {
    let problems = await verify(exec, svc, pkgDirs);
    if (!problems.length) return { problems, repaired: [] };
    const repaired = [];
    const byPkg = new Map();
    for (const p of problems) (byPkg.get(p.pkg) || byPkg.set(p.pkg, []).get(p.pkg)).push(p);
    for (const [pkgDir, list] of byPkg) {
        for (const p of list) {
            log(`dependency ${p.dep || '(package.json)'} in ${pkgDir} does not resolve (${p.reason}) — reinstalling`);
            if (p.dep) await exec.run('rm', ['-rf', '--', path.join(svc.repo, pkgDir, 'node_modules', p.dep)], { as: svc.owner });
        }
        await install(exec, svc, g, pkgDir);
        repaired.push(pkgDir);
    }
    problems = await verify(exec, svc, pkgDirs);
    return { problems, repaired };
}

module.exports = { expandPackages, needsInstall, install, verify, verifyAndRepair };
