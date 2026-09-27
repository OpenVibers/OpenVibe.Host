'use strict';
/**
 * plan, deploy and rollback. A service's `strategy` (lib/inventory.js, docs/deploy-strategies.md)
 * picks the engine: release-layout services (Live, OpenRe) go to lib/release-layout.js; every other
 * strategy (git-checkout, multi-app, static-build, pnpm-build) is an in-place git checkout driven
 * here, with the strategy's defaults. The rules this encodes come from the per-repository deploy
 * scripts it replaces:
 *
 *   - git and npm run as the checkout owner; nothing root-owned is left under the checkout.
 *   - a tracked local change blocks the deploy (untracked files do not).
 *   - dependencies install only when package.json dependency fields or the lockfile changed
 *     (Network), the lockfile is restored from git afterwards, and EVERY dependency must resolve
 *     before anything restarts (Tools).
 *   - protected sessions are checked before the checkout moves and again right before the restart
 *     (Live: /api/streams; Media: recordings in progress). With sessions active the deploy refuses,
 *     or waits with --wait-idle; --force drops them and says so loudly. A probe that cannot answer is
 *     treated as "sessions may be active", never as zero.
 *   - only .service units are restarted; a socket unit is started if it is down, never stopped.
 *   - readiness is polled after the restart; if it fails the checkout goes back to the previous sha,
 *     dependencies are reinstalled if they differed, and the service is restarted again.
 *   - every attempt (including refusals) is appended to the release log.
 *   - multi-app (Tools): apps/_* are packages, not apps (skipPackages); an untracked lockfile the
 *     incoming release tracks is removed before the merge (it would block it); preflight checks run
 *     in each app before anything restarts; every unit file matching unitsMatch is restarted.
 *   - static-build (Sites) and pnpm-build (Games): tracked build output (`generated`) is put back
 *     from git before the checkout moves, so a previous build never blocks a deploy; when anything
 *     fails the checkout is restored AND rebuilt, since a build writes what is being served.
 *
 * Exit codes: 0 ok · 1 usage/precondition · 2 validation failed, nothing restarted ·
 *             3 not ready, rolled back and serving · 4 rollback failed — MANUAL INTERVENTION ·
 *             5 protected sessions active (refused, or --wait-idle gave up) · 6 frozen (ovhost freeze)
 */
const path = require('path');
const { git } = require('./git');
const deps = require('./deps');
const systemd = require('./systemd');
const probes = require('./probes');
const readiness = require('./readiness');
const releases = require('./releases');
const lock = require('./lock');
const nginx = require('./nginx');
const preflight = require('./preflight');

const EXIT = { OK: 0, USAGE: 1, VALIDATION: 2, ROLLED_BACK: 3, ROLLBACK_FAILED: 4, PROTECTED: 5, FROZEN: 6 };

class OpError extends Error {
    constructor(message, exitCode, extra = {}) {
        super(message);
        this.exitCode = exitCode;
        Object.assign(this, extra);
    }
}

function matchesPath(file, patterns) {
    return patterns.some((p) => {
        if (p.endsWith('/')) return file.startsWith(p);
        if (p.startsWith('*.')) return !file.includes('/') && file.endsWith(p.slice(1));
        if (p.startsWith('**/*.')) return file.endsWith(p.slice(4));
        return file === p;
    });
}

async function operatorName(exec) {
    return process.env.SUDO_USER || (await exec.userName());
}

// ── plan ─────────────────────────────────────────────────────────────────────

/**
 * What a deploy (or rollback) to `to` would do. Fetches the remote unless fetch === false; changes
 * nothing else.
 */
async function computePlan(ctx, svc, { mode = 'deploy', to = null, fetch = true, restart = false } = {}) {
    const { exec } = ctx;
    if (to != null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(String(to))) throw new OpError(`"${to}" is not a sha or ref name`, EXIT.USAGE);
    const g = git(exec, svc);
    const from = await g.head();
    const branch = await g.branch();
    const dirtyAll = await g.dirty();
    // Tracked output a previous build rewrote (Sites' dist/, Games' dist-types/) is not a local change.
    const generatedDirty = dirtyAll.filter((f) => matchesPath(f, svc.generated));
    const dirty = dirtyAll.filter((f) => !matchesPath(f, svc.generated));
    let target;
    if (mode === 'deploy') {
        if (fetch) await g.fetch();
        target = await g.revParse(to || `${svc.remote}/${svc.branch}`);
    } else {
        if (!to) throw new OpError('rollback needs a target sha', EXIT.USAGE);
        if (!(await g.hasCommit(to))) throw new OpError(`commit ${to} is not in ${svc.repo}`, EXIT.USAGE);
        target = await g.revParse(to);
    }
    const changed = from === target ? [] : await g.changedFiles(from, target);
    const commits = from === target ? [] : mode === 'deploy' ? await g.log(from, target) : await g.log(target, from);

    const pkgDirs = await deps.expandPackages(exec, svc);
    for (const f of changed) {
        if (path.basename(f) !== 'package.json') continue;
        const dir = path.dirname(f) || '.';
        const inPatterns = svc.packages.some((p) => p === dir || (p.endsWith('/*') && path.dirname(dir) === p.slice(0, -2)));
        if (inPatterns && !pkgDirs.includes(dir) && !deps.skipped(dir, svc.skipPackages)) pkgDirs.push(dir);
    }
    // npm leaves an untracked lockfile in an app that did not track one; once the release tracks it,
    // the merge refuses to overwrite it. Those files are generated: they are removed before the merge.
    const untrackedLockfiles = [];
    if (svc.removeUntrackedLockfiles) {
        for (const f of changed) {
            if (path.basename(f) !== svc.install.lockfile || deps.skipped(path.dirname(f), svc.skipPackages)) continue;
            if (!(await exec.stat(path.join(svc.repo, f)))) continue;
            if ((await g.show(from, f)) == null) untrackedLockfiles.push(f);
        }
    }
    const installs = [];
    if (svc.install.workspace) {
        // A workspace (pnpm): one install at the root, needed when its lockfile or any package's
        // dependency fields changed; every package is still verified afterwards.
        let need = { lockfileChanged: false, depsChanged: false, needed: false };
        if (from !== target) {
            for (const pkg of ['.', ...pkgDirs]) {
                const n = await deps.needsInstall(g, from, target, pkg, svc.install.lockfile);
                if (pkg === '.') need.lockfileChanged = n.lockfileChanged;
                need.depsChanged = need.depsChanged || n.depsChanged;
            }
            need.needed = need.lockfileChanged || need.depsChanged;
        }
        const hasModules = !!(await exec.stat(path.join(svc.repo, 'node_modules')));
        installs.push({ pkg: '.', ...need, missingNodeModules: !hasModules, install: need.needed || svc.install.always || !hasModules });
    } else {
        for (const pkg of pkgDirs) {
            const need = from === target ? { lockfileChanged: false, depsChanged: false, needed: false } : await deps.needsInstall(g, from, target, pkg, svc.install.lockfile);
            const hasModules = !!(await exec.stat(path.join(svc.repo, pkg, 'node_modules')));
            installs.push({ pkg, ...need, missingNodeModules: !hasModules, install: need.needed || svc.install.always || !hasModules });
        }
    }

    const codeChanged = changed.filter((f) => !matchesPath(f, svc.noRestartPaths));
    // unitsMatch (Tools: openvibe-tools*.service): a unit file on the host that the inventory does not
    // list is restarted too, as the script did, and named so the inventory can be corrected. A oneshot
    // unit the glob catches is a job, not a service (openvibe-toolsjob.service, the job proof a timer runs;
    // 2026-09-27 it was restarted and then waited on as if it should stay active, so the deploy and its
    // rollback both read "not ready"): it is named and left alone.
    let extraUnits = [];
    const skippedJobs = [];
    if (svc.unitsMatch) {
        let found = [];
        try { found = (await systemd.listUnitFiles(exec, svc.unitsMatch)).filter((u) => !svc.units.includes(u) && !svc.workerUnits.includes(u)); } catch { found = []; }
        for (const u of found) {
            let type = '';
            try { type = (await systemd.show(exec, u)).type; } catch { /* unknown: treat as a service */ }
            if (type === 'oneshot') skippedJobs.push(u); else extraUnits.push(u);
        }
    }
    const units = [...svc.units, ...extraUnits];
    const restartNeeded = units.length > 0 && (restart || codeChanged.length > 0);

    const unitDrift = [];
    for (const [unit, src] of Object.entries(svc.unitSources)) {
        const want = await g.show(target, src);
        if (want == null) continue;
        const have = await exec.readFile(path.join('/etc/systemd/system', unit), { privileged: true });
        if (have !== want) unitDrift.push({ unit, source: src, installed: have != null });
    }

    const backupNeeded = svc.databases.length > 0 && changed.some((f) => svc.backupOnChange.includes(f));
    const sessions = restartNeeded ? await probes.countProtected(exec, svc) : null;

    // A vhost the release no longer has stays installed: removing it could take down the real service
    // that now owns the domain (its vhost may even have the same name). It is named, never removed.
    const vhostsRemoved = [];
    if (svc.nginx && svc.nginx.installOnDeploy && svc.nginx.repoVhosts) {
        const vdir = path.dirname(svc.nginx.repoVhosts);
        for (const f of changed) if (f.endsWith('.conf') && path.dirname(f) === vdir && (await g.show(target, f)) == null) vhostsRemoved.push(path.basename(f));
    }

    return {
        service: svc.id,
        strategy: svc.strategy,
        layout: 'git',
        mode,
        repo: svc.repo,
        branch,
        expectedBranch: svc.branch,
        from,
        to: target,
        upToDate: from === target,
        dirty,
        generatedDirty,
        commits,
        changedFiles: changed.length,
        changed,
        codeChanged: codeChanged.length,
        lockfileChanged: installs.some((i) => i.lockfileChanged),
        installs,
        untrackedLockfiles,
        build: svc.build.map((b) => b.join(' ')),
        preflight: preflight.describe(svc),
        restartNeeded,
        units,
        extraUnits,
        skippedJobs,
        socketUnit: svc.socketUnit,
        unitDrift,
        installUnits: svc.installUnits,
        backupNeeded,
        protectedSessions: sessions,
        drainPolicy: svc.drain.policy,
        managed: svc.managed,
        installVhosts: !!(svc.nginx && svc.nginx.installOnDeploy),
        vhostsRemoved,
        nginxNotInstalled: !!(svc.nginx && svc.nginx.repoVhost && !svc.nginx.installOnDeploy && changed.includes(svc.nginx.repoVhost)),
        announceFrom: svc.announce.releaseFiles,
    };
}

// ── protected sessions ───────────────────────────────────────────────────────

async function guardSessions(ctx, svc, opts, record, when) {
    const { exec, log } = ctx;
    const first = await probes.countProtected(exec, svc);
    record.protectedSessions = { count: first.count, label: first.label, unknown: first.unknown || null, checkedWhen: when };
    if (first.notRunning || first.count === 0) return;
    const describe = (r) => (r.count == null ? `${r.label}: unknown (${r.unknown}) — treated as active` : `${r.count} ${r.label}`);
    if (opts.force) {
        record.forced = true;
        log('');
        log('!!! --force: restarting with protected sessions active');
        log(`!!! ${describe(first)} WILL BE DROPPED (${when})`);
        log('');
        return;
    }
    // Drain policy "report" restarts and says so, unless the operator asked to wait (--wait-idle).
    if (svc.drain.policy === 'report' && first.count != null && !opts.waitIdle) {
        log(`${describe(first)}; drain policy "report": they reconnect after the restart`);
        return;
    }
    const wait = opts.waitIdle || svc.drain.policy === 'wait';
    if (!wait) {
        throw new OpError(`${describe(first)} — refusing to restart ${svc.units.join(', ')} (${when}). Re-run with --wait-idle to hold until idle, or --force to drop them.`, EXIT.PROTECTED, { result: 'refused' });
    }
    const maxMs = svc.drain.waitMaxSeconds * 1000;
    const pollMs = svc.drain.pollSeconds * 1000;
    const start = exec.now();
    let quiet = 0;
    let last = first;
    log(`${describe(first)}; --wait-idle: holding the restart (${when}); need ${svc.drain.quietChecks} idle checks ${svc.drain.pollSeconds}s apart, max ${svc.drain.waitMaxSeconds}s`);
    while (exec.now() - start < maxMs) {
        await exec.sleep(pollMs);
        last = await probes.countProtected(exec, svc);
        if (last.notRunning || last.count === 0) quiet += 1; else quiet = 0;
        if (quiet >= svc.drain.quietChecks) {
            record.protectedSessions.waitedSeconds = Math.round((exec.now() - start) / 1000);
            record.protectedSessions.count = 0;
            log(`idle for ${quiet} checks — proceeding (waited ${record.protectedSessions.waitedSeconds}s)`);
            return;
        }
        log(`${describe(last)}; still holding (${Math.round((exec.now() - start) / 1000)}s)`);
    }
    throw new OpError(`${describe(last)} after waiting ${svc.drain.waitMaxSeconds}s — gave up; nothing was restarted`, EXIT.PROTECTED, { result: 'gave-up-waiting' });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function installAll(ctx, svc, g, installs, record) {
    for (const i of installs) {
        if (!i.install) continue;
        ctx.log(`installing dependencies in ${i.pkg} (${[i.lockfileChanged && 'lockfile changed', i.depsChanged && 'package.json dependencies changed', i.missingNodeModules && 'no node_modules', svc.install.always && 'always'].filter(Boolean).join(', ')})`);
        await deps.install(ctx.exec, svc, g, i.pkg);
        record.installed.push(i.pkg);
    }
}

async function verifyDeps(ctx, svc, g) {
    const pkgDirs = await deps.expandPackages(ctx.exec, svc);
    const { problems, repaired } = await deps.verifyAndRepair(ctx.exec, svc, g, pkgDirs, ctx.log);
    return { pkgDirs, problems, repaired };
}

async function runBuild(ctx, svc, record = null) {
    if (record && svc.build.length) record.built = true;
    for (const argv of svc.build) {
        ctx.log(`build: ${argv.join(' ')}`);
        const r = await ctx.exec.run(argv[0], argv.slice(1), { as: svc.owner, cwd: svc.repo, timeoutMs: 20 * 60 * 1000 });
        if (r.code !== 0) throw new Error(`build step "${argv.join(' ')}" failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
    }
}

async function installRepoVhosts(ctx, svc) {
    const n = svc.nginx;
    const pattern = n.repoVhosts || n.repoVhost;
    if (!pattern) return null;
    let names;
    if (pattern.endsWith('*.conf')) {
        const dir = path.dirname(pattern);
        names = ((await ctx.exec.readdir(path.join(svc.repo, dir))) || []).filter((e) => !e.isDir && e.name.endsWith('.conf')).map((e) => path.join(dir, e.name));
    } else names = [pattern];
    const files = [];
    for (const rel of names.sort()) files.push({ name: path.basename(rel), text: await ctx.exec.readFile(path.join(svc.repo, rel)) });
    return nginx.install(ctx.exec, ctx.inv, files, { log: ctx.log });
}

async function installUnits(ctx, svc, record) {
    const changed = [];
    for (const [unit, src] of Object.entries(svc.unitSources)) {
        const want = await ctx.exec.readFile(path.join(svc.repo, src));
        if (want == null) continue;
        const dest = path.join('/etc/systemd/system', unit);
        const have = await ctx.exec.readFile(dest, { privileged: true });
        if (have === want) continue;
        await ctx.exec.run('install', ['-m', '0644', '-D', path.join(svc.repo, src), dest], { privileged: true });
        changed.push(unit);
    }
    if (changed.length) {
        await systemd.daemonReload(ctx.exec);
        ctx.log(`installed unit files: ${changed.join(', ')}; daemon-reload`);
    }
    record.unitsInstalled = changed;
}

async function backupBeforeRestart(ctx, svc, record) {
    const { backup } = require('./commands/backup');
    ctx.log('schema files changed — backing up the declared databases first');
    const res = await backup(ctx, svc.id, { reason: `pre-deploy ${record.to.slice(0, 12)}` });
    record.backup = res.files.map((f) => f.dest);
}

/** Restart the service units (never the socket) and poll readiness. -> { ok, reason } */
async function restartAndWait(ctx, svc, opts = {}) {
    if (svc.socketUnit) {
        const s = await systemd.ensureSocketActive(ctx.exec, svc.socketUnit);
        ctx.log(s.started ? `${svc.socketUnit} was ${s.state.active}; started it` : `${svc.socketUnit} active — new HTTP connections queue through the restart`);
    }
    for (const u of opts.units || svc.units) {
        ctx.log(`restarting ${u}`);
        await systemd.restart(ctx.exec, u);
    }
    const r = await readiness.waitReady(ctx.exec, svc, { timeoutSeconds: opts.readyTimeout, log: ctx.log, expectSha: opts.expectSha, units: opts.units || svc.units });
    if (r.ok) ctx.log(r.skipped ? 'no ready URL declared; restart issued' : `ready after ${r.seconds}s`);
    else ctx.log(`NOT READY after ${r.seconds}s (${r.reason}); see: journalctl -u ${svc.units[0]} -n 50`);
    return r;
}

/** Put the checkout back on `sha` and make node_modules match it again. */
async function restoreCheckout(ctx, svc, g, sha, record) {
    ctx.log(`restoring the checkout to ${sha.slice(0, 12)}`);
    await g.resetHard(sha);
    if (record.installed.length) {
        for (const pkg of record.installed) {
            ctx.log(`reinstalling dependencies in ${pkg} for ${sha.slice(0, 12)}`);
            await deps.install(ctx.exec, svc, g, pkg);
        }
    }
    const v = await verifyDeps(ctx, svc, g);
    if (v.problems.length) throw new Error(`after restoring ${sha.slice(0, 12)} these dependencies still do not resolve: ${v.problems.map((p) => `${p.pkg}:${p.dep}`).join(', ')}`);
    // A build writes what is served (Sites' dist/, Games' apps/client/dist): build the old release again.
    if (record.built) {
        ctx.log(`rebuilding ${sha.slice(0, 12)}`);
        await runBuild(ctx, svc);
    }
}

/** Sites: one release notification per placeholder, from each dist/<domain>/release.json. */
async function releaseAnnouncements(ctx, svc) {
    const pattern = svc.announce.releaseFiles;
    if (!pattern) return null;
    const dir = pattern.split('/')[0];
    const out = [];
    const entries = ((await ctx.exec.readdir(path.join(svc.repo, dir))) || []).filter((e) => e.isDir).map((e) => e.name).sort();
    for (const domain of entries) {
        let m;
        try { m = JSON.parse((await ctx.exec.readFile(path.join(svc.repo, dir, domain, 'release.json'))) || 'null'); } catch { m = null; }
        if (!m || !/^[a-z][a-z0-9-]{1,39}$/.test(String(m.service)) || !/^[0-9a-f]{7,40}$/.test(String(m.release)) || !/^[a-z0-9.-]+$/.test(domain)) continue;
        out.push({ service: m.service, release: m.release, origin: `https://${domain}` });
    }
    return out;
}

// ── deploy / rollback ────────────────────────────────────────────────────────

/**
 * mode 'deploy': fast-forward to origin/<branch> (or opts.to). mode 'rollback': reset to opts.to.
 * -> { exitCode, record }
 */
async function apply(ctx, svc, mode, opts = {}) {
    const { exec, inv, log } = ctx;
    if (!svc.managed) throw new OpError(`${svc.id} is not managed by ovhost${svc.unmanagedReason ? `: ${svc.unmanagedReason}` : ''}`, EXIT.USAGE);
    if (svc.strategy === 'release-layout') return require('./release-layout').apply(ctx, svc, mode, opts);
    if (opts.prepareOnly) throw new OpError(`--prepare-only needs a release-layout service; ${svc.id} is ${svc.strategy}`, EXIT.USAGE);
    // An in-place strategy never guesses its way through a releases/ + current layout.
    if (await exec.readlink(path.join(svc.repo, 'current'))) {
        throw new OpError(`${svc.repo} uses the releases/current layout; set strategy "release-layout" for ${svc.id} (docs/deploy-strategies.md) or use the repository's own deploy script`, EXIT.USAGE);
    }
    const held = await lock.acquire(exec, inv, svc.id);
    if (held.recoveredStale) log(`removed a stale lock (${held.file})`);
    const g = git(exec, svc);
    const record = {
        id: releases.newId(exec.now()),
        service: svc.id,
        strategy: svc.strategy,
        action: mode,
        startedAt: new Date(exec.now()).toISOString(),
        operator: await operatorName(exec),
        host: await exec.hostname(),
        from: null,
        to: null,
        commits: 0,
        lockfileChanged: false,
        installed: [],
        depsVerified: null,
        restartNeeded: null,
        restarted: false,
        ready: null,
        forced: false,
        result: null,
    };
    let exitCode = EXIT.OK;
    let writeRecord = true;
    try {
        const plan = await computePlan(ctx, svc, { mode, to: opts.to, fetch: opts.fetch !== false, restart: opts.restart });
        Object.assign(record, { from: plan.from, to: plan.to, commits: plan.commits.length, lockfileChanged: plan.lockfileChanged, restartNeeded: plan.restartNeeded });
        log(`${svc.id}: ${mode} ${plan.from.slice(0, 12)} → ${plan.to.slice(0, 12)} (${plan.commits.length} commit(s), ${plan.changedFiles} file(s) changed)`);
        if (plan.branch !== svc.branch) throw new OpError(`${svc.repo} is on "${plan.branch}", expected "${svc.branch}"`, EXIT.USAGE);
        if (plan.dirty.length) throw new OpError(`${svc.repo} has tracked local changes (${plan.dirty.slice(0, 5).join(', ')}${plan.dirty.length > 5 ? ', …' : ''}); commit or discard them first`, EXIT.VALIDATION);
        if (plan.upToDate && !opts.restart) {
            log(`already at ${plan.to.slice(0, 12)}; nothing to do`);
            record.result = 'unchanged';
            writeRecord = false;
            return { exitCode: EXIT.OK, record, plan };
        }
        for (const c of plan.commits.slice(0, 20)) log(`    ${c}`);
        if (plan.unitDrift.length && !opts.installUnits && !svc.installUnits) log(`note: unit files differ from the repo (${plan.unitDrift.map((u) => u.unit).join(', ')}); pass --install-units to install them`);

        // Sessions first: in place, the running process would otherwise see its files change under it.
        if (plan.restartNeeded) await guardSessions(ctx, svc, opts, record, 'before the checkout moves');

        if (plan.generatedDirty.length && !plan.upToDate) {
            log(`restoring ${plan.generatedDirty.length} tracked build output file(s) from git (${svc.generated.join(', ')})`);
            await g.checkoutPaths(plan.generatedDirty);
        }
        for (const f of plan.untrackedLockfiles) {
            log(`removing untracked ${f} (the release tracks it)`);
            await exec.run('rm', ['-f', '--', path.join(svc.repo, f)], { as: svc.owner });
            (record.removedUntracked = record.removedUntracked || []).push(f);
        }

        if (!plan.upToDate) {
            if (mode === 'deploy') await g.ffMerge(plan.to); else await g.resetHard(plan.to);
            record.checkoutMoved = true;
        }
        try {
            await installAll(ctx, svc, g, plan.installs, record);
            const v = await verifyDeps(ctx, svc, g);
            record.depsVerified = v.problems.length === 0;
            if (v.repaired.length) record.depsRepaired = v.repaired;
            if (v.problems.length) throw new OpError(`dependencies do not resolve: ${v.problems.map((p) => `${p.pkg}: ${p.dep} (${p.reason})`).join('; ')}`, EXIT.VALIDATION);
            log(`every dependency resolves (${v.pkgDirs.join(', ') || 'no packages'})`);
            await runBuild(ctx, svc, record);
            const pf = await preflight.run(ctx, svc, { root: svc.repo, changed: plan.changed, pkgDirs: v.pkgDirs });
            if (pf.problems.length) {
                record.preflight = { ok: false, problems: pf.problems };
                throw new OpError(`preflight failed: ${pf.problems.join('; ')}`, EXIT.VALIDATION);
            }
            if (svc.preflight.checks.length || svc.preflight.syntaxCheck) record.preflight = { ok: true, checks: pf.checksRun, syntaxChecked: pf.syntaxChecked };
            if (plan.installVhosts) {
                try { await installRepoVhosts(ctx, svc); } catch (err) { throw new OpError(err.message, EXIT.VALIDATION); }
                for (const name of plan.vhostsRemoved) log(`note: ${name} is no longer in the repository and stays installed; remove it by hand once its domain is served elsewhere (nginx -t, reload)`);
            }
            if (opts.installUnits || svc.installUnits) await installUnits(ctx, svc, record);
            if (plan.backupNeeded && plan.restartNeeded) await backupBeforeRestart(ctx, svc, record);
            if (plan.restartNeeded) await guardSessions(ctx, svc, opts, record, 'immediately before the restart');
        } catch (err) {
            // Nothing has been restarted: put the files back the way the running process expects.
            if (record.checkoutMoved) {
                try { await restoreCheckout(ctx, svc, g, plan.from, record); record.checkoutRestored = true; } catch (e2) {
                    throw new OpError(`${err.message}\nAND restoring ${plan.from.slice(0, 12)} failed: ${e2.message} — MANUAL INTERVENTION REQUIRED`, EXIT.ROLLBACK_FAILED, { result: 'restore-failed' });
                }
            }
            if (err instanceof OpError) { err.message += record.checkoutRestored ? ` (checkout restored to ${plan.from.slice(0, 12)}; nothing restarted)` : ' (nothing restarted)'; throw err; }
            throw new OpError(`${err.message} (${record.checkoutRestored ? `checkout restored to ${plan.from.slice(0, 12)}; ` : ''}nothing restarted)`, EXIT.VALIDATION);
        }

        const announcements = await releaseAnnouncements(ctx, svc);
        if (!plan.restartNeeded) {
            record.result = mode === 'deploy' ? 'deployed' : 'rolled-back';
            log(`${plan.units.length ? `only ${svc.noRestartPaths.join(' ')} changed — no restart needed` : 'no units to restart'}`);
            if (svc.ready) {
                const p = await readiness.probe(exec, svc);
                record.ready = p.ok;
                if (!p.ok) log(`warning: ${svc.ready.url} answers ${p.status || p.error}`);
            }
            return { exitCode: EXIT.OK, record, plan, announcements };
        }

        if (plan.extraUnits.length) log(`warning: ${plan.extraUnits.join(', ')} match ${svc.unitsMatch} but are not in the inventory's units; restarting them too (add them to services.${svc.id}.units)`);
        const restartOpts = { ...opts, units: plan.units, expectSha: plan.to };
        const r = await restartAndWait(ctx, svc, restartOpts);
        record.restarted = true;
        record.ready = r.ok;
        if (r.ok) {
            record.result = mode === 'deploy' ? 'deployed' : 'rolled-back';
            log(`${svc.id}: ${plan.from.slice(0, 12)} → ${plan.to.slice(0, 12)} ${mode === 'deploy' ? 'deployed' : 'rolled back'}`);
            if (svc.socketUnit || svc.protected) log('note: established WebSocket/WHIP/RTMP/WebRTC/SSE sessions were reconnected, not preserved.');
            return { exitCode: EXIT.OK, record, plan, announcements };
        }

        // Not ready: back to where we were.
        log(`automatic rollback to ${plan.from.slice(0, 12)}`);
        record.autoRollback = { to: plan.from };
        try {
            await restoreCheckout(ctx, svc, g, plan.from, record);
            const back = await restartAndWait(ctx, svc, { ...restartOpts, expectSha: plan.from });
            record.autoRollback.ready = back.ok;
            if (back.ok) {
                record.result = 'failed-rolled-back';
                exitCode = EXIT.ROLLED_BACK;
                log(`${svc.id} is back on ${plan.from.slice(0, 12)} and serving; ${plan.to.slice(0, 12)} was not deployed`);
            } else {
                record.result = 'rollback-failed';
                exitCode = EXIT.ROLLBACK_FAILED;
                log(`ROLLBACK FAILED: ${plan.from.slice(0, 12)} is not ready either — MANUAL INTERVENTION REQUIRED`);
            }
        } catch (err) {
            record.result = 'rollback-failed';
            record.error = err.message;
            exitCode = EXIT.ROLLBACK_FAILED;
            log(`ROLLBACK FAILED: ${err.message} — MANUAL INTERVENTION REQUIRED`);
        }
        return { exitCode, record, plan };
    } catch (err) {
        record.result = err.result || record.result || 'failed';
        record.error = err.message;
        throw err;
    } finally {
        record.finishedAt = new Date(exec.now()).toISOString();
        if (writeRecord) {
            try { await releases.append(exec, inv, record); } catch (e) { log(`warning: could not append to the release log: ${e.message}`); }
        }
        await held.release();
    }
}

async function deploy(ctx, id, opts = {}) {
    const svc = require('./inventory').service(ctx.inv, id);
    // A freeze (ovhost freeze, or maintenance schedule --freeze; lib/incidents.js) holds deploys, never rollbacks.
    const hold = await require('./incidents').frozen(ctx, svc.id);
    if (hold) {
        if (!opts.force) throw new OpError(`${svc.id} is frozen${hold.service === 'all' ? ' (all services)' : ''} since ${hold.at}: ${hold.reason}${hold.incident ? ` (${hold.incident})` : ''}. ovhost unfreeze ${hold.service}, or --force`, EXIT.FROZEN);
        ctx.log(`!!! --force: deploying ${svc.id} through the freeze (${hold.reason})`);
    }
    return apply(ctx, svc, 'deploy', opts);
}

async function rollback(ctx, id, opts = {}) {
    const svc = require('./inventory').service(ctx.inv, id);
    if (svc.managed && svc.strategy === 'release-layout') return require('./release-layout').apply(ctx, svc, 'rollback', opts);
    let to = opts.to;
    if (!to) {
        const current = await git(ctx.exec, svc).head();
        to = releases.previousFor(await releases.list(ctx.exec, ctx.inv, id), current);
        if (!to) throw new OpError(`no deploy in the release log brought ${id} to ${current.slice(0, 12)}; pass --to <sha>`, EXIT.USAGE);
        ctx.log(`rolling back to ${to.slice(0, 12)} (the release before ${current.slice(0, 12)} in the release log)`);
    }
    return apply(ctx, svc, 'rollback', { ...opts, to });
}

async function plan(ctx, id, opts = {}) {
    const svc = require('./inventory').service(ctx.inv, id);
    if (svc.strategy === 'release-layout') return require('./release-layout').computePlan(ctx, svc, { mode: 'deploy', to: opts.to, fetch: opts.fetch !== false, restart: opts.restart });
    return computePlan(ctx, svc, { mode: 'deploy', to: opts.to, fetch: opts.fetch !== false, restart: opts.restart });
}

module.exports = { plan, deploy, rollback, computePlan, guardSessions, matchesPath, installUnits, backupBeforeRestart, OpError, EXIT, operatorName };
