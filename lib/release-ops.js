'use strict';
/**
 * plan, deploy and rollback for a service that runs from a git checkout (every service on the host
 * today). The rules this encodes come from the per-repository deploy scripts it replaces:
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
    const dirty = await g.dirty();
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
        if (inPatterns && !pkgDirs.includes(dir)) pkgDirs.push(dir);
    }
    const installs = [];
    for (const pkg of pkgDirs) {
        const need = from === target ? { lockfileChanged: false, depsChanged: false, needed: false } : await deps.needsInstall(g, from, target, pkg);
        const hasModules = !!(await exec.stat(path.join(svc.repo, pkg, 'node_modules')));
        installs.push({ pkg, ...need, missingNodeModules: !hasModules, install: need.needed || svc.install.always || !hasModules });
    }

    const codeChanged = changed.filter((f) => !matchesPath(f, svc.noRestartPaths));
    const restartNeeded = svc.units.length > 0 && (restart || codeChanged.length > 0);

    const unitDrift = [];
    for (const [unit, src] of Object.entries(svc.unitSources)) {
        const want = await g.show(target, src);
        if (want == null) continue;
        const have = await exec.readFile(path.join('/etc/systemd/system', unit), { privileged: true });
        if (have !== want) unitDrift.push({ unit, source: src, installed: have != null });
    }

    const backupNeeded = svc.databases.length > 0 && changed.some((f) => svc.backupOnChange.includes(f));
    const sessions = restartNeeded ? await probes.countProtected(exec, svc) : null;

    return {
        service: svc.id,
        mode,
        repo: svc.repo,
        branch,
        expectedBranch: svc.branch,
        from,
        to: target,
        upToDate: from === target,
        dirty,
        commits,
        changedFiles: changed.length,
        codeChanged: codeChanged.length,
        lockfileChanged: installs.some((i) => i.lockfileChanged),
        installs,
        restartNeeded,
        units: svc.units,
        socketUnit: svc.socketUnit,
        unitDrift,
        backupNeeded,
        protectedSessions: sessions,
        drainPolicy: svc.drain.policy,
        managed: svc.managed,
        installVhosts: !!(svc.nginx && svc.nginx.installOnDeploy),
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
    if (svc.drain.policy === 'report' && first.count != null) {
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

async function runBuild(ctx, svc) {
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
    for (const u of svc.units) {
        ctx.log(`restarting ${u}`);
        await systemd.restart(ctx.exec, u);
    }
    const r = await readiness.waitReady(ctx.exec, svc, { timeoutSeconds: opts.readyTimeout, log: ctx.log });
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
}

// ── deploy / rollback ────────────────────────────────────────────────────────

/**
 * mode 'deploy': fast-forward to origin/<branch> (or opts.to). mode 'rollback': reset to opts.to.
 * -> { exitCode, record }
 */
async function apply(ctx, svc, mode, opts = {}) {
    const { exec, inv, log } = ctx;
    if (!svc.managed) throw new OpError(`${svc.id} is not managed by ovhost${svc.unmanagedReason ? `: ${svc.unmanagedReason}` : ''}`, EXIT.USAGE);
    // Live's deploy.sh can also run a releases/ + current symlink layout. Stage A only drives the
    // in-place checkout every service runs today; it will not guess its way through the other one.
    if (await exec.readlink(path.join(svc.repo, 'current'))) {
        throw new OpError(`${svc.repo} uses the releases/current layout, which Stage A does not drive yet; use the repository's own deploy script`, EXIT.USAGE);
    }
    const held = await lock.acquire(exec, inv, svc.id);
    if (held.recoveredStale) log(`removed a stale lock (${held.file})`);
    const g = git(exec, svc);
    const record = {
        id: releases.newId(exec.now()),
        service: svc.id,
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
        if (plan.unitDrift.length && !opts.installUnits) log(`note: unit files differ from the repo (${plan.unitDrift.map((u) => u.unit).join(', ')}); pass --install-units to install them`);

        // Sessions first: in place, the running process would otherwise see its files change under it.
        if (plan.restartNeeded) await guardSessions(ctx, svc, opts, record, 'before the checkout moves');

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
            await runBuild(ctx, svc);
            if (plan.installVhosts) await installRepoVhosts(ctx, svc);
            if (opts.installUnits) await installUnits(ctx, svc, record);
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

        if (!plan.restartNeeded) {
            record.result = mode === 'deploy' ? 'deployed' : 'rolled-back';
            log(`${plan.units.length ? `only ${svc.noRestartPaths.join(' ')} changed — no restart needed` : 'no units to restart'}`);
            if (svc.ready) {
                const p = await readiness.probe(exec, svc);
                record.ready = p.ok;
                if (!p.ok) log(`warning: ${svc.ready.url} answers ${p.status || p.error}`);
            }
            return { exitCode: EXIT.OK, record, plan };
        }

        const r = await restartAndWait(ctx, svc, opts);
        record.restarted = true;
        record.ready = r.ok;
        if (r.ok) {
            record.result = mode === 'deploy' ? 'deployed' : 'rolled-back';
            log(`${svc.id}: ${plan.from.slice(0, 12)} → ${plan.to.slice(0, 12)} ${mode === 'deploy' ? 'deployed' : 'rolled back'}`);
            if (svc.socketUnit || svc.protected) log('note: established WebSocket/WHIP/RTMP/WebRTC/SSE sessions were reconnected, not preserved.');
            return { exitCode: EXIT.OK, record, plan };
        }

        // Not ready: back to where we were.
        log(`automatic rollback to ${plan.from.slice(0, 12)}`);
        record.autoRollback = { to: plan.from };
        try {
            await restoreCheckout(ctx, svc, g, plan.from, record);
            const back = await restartAndWait(ctx, svc, opts);
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
    return computePlan(ctx, svc, { mode: 'deploy', to: opts.to, fetch: opts.fetch !== false, restart: opts.restart });
}

module.exports = { plan, deploy, rollback, computePlan, guardSessions, matchesPath, OpError, EXIT };
