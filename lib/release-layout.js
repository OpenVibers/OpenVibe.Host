'use strict';
/**
 * The release-layout strategy (roadmap WS-N task 11): Live's deploy/scripts/deploy.sh (release layout)
 * and OpenRestream's deploy.sh `release` + `api`, as one engine.
 *
 *   <repo>/repo            the git clone releases are made from (release.git), owned by `owner`
 *   <repo>/releases/<id>   a detached worktree per release with its own node_modules
 *                          (id: <UTC yyyymmdd-HHMMSS>-<sha8> for Live, <sha12> for OpenRestream)
 *   <repo>/current         -> releases/<id>, switched by an atomic rename (ln -s + mv -T)
 *   release.links          links made in every release (Live: data -> ../../shared/data)
 *
 * deploy
 *   1. fetch; the target is origin/<branch> (or --to); nothing new and no --restart: done.
 *   2. prepare the new release while the current one serves: worktree, links, `npm ci` when the
 *      lockfile or dependency fields changed (else the current node_modules hard-linked: cp -al), every
 *      dependency resolves, preflight (Live: syntax check of the changed files), release.chown (OpenRestream).
 *      Any failure removes the new release: the current one is untouched and nothing restarted (exit 2).
 *   3. static-only change (everything outside noRestartPaths unchanged, unit files unchanged): switch
 *      `current`, wait release.settleSeconds, the ready URL must answer, else switch back (exit 3).
 *   4. otherwise: protected sessions (refuse, --wait-idle, --force; drain policy), a backup when a
 *      backupOnChange file changed, switch `current`, install the release's unit files (unitSources are
 *      paths inside the release), restart the units, wait for readiness (and /release.json naming the
 *      new sha when ready.release). Not ready: switch back, put the previous release's unit files back,
 *      restart, exit 3; if that is not ready either, exit 4 (MANUAL INTERVENTION).
 *   5. prune to release.keep, never the current release, the one just left, or one a worker unit
 *      instance (OpenRestream's openre-rtmp-ingest@<id>) still runs from.
 *
 * The socket rule (Live): pid 1 must hold the socket unit's listener. When the socket unit file changed
 * in this deploy, or systemd does not hold the listener, the service is stopped, the socket restarted
 * and the service started on it (systemd.rebindSocket: the only socket restart ovhost makes). Otherwise
 * only the service restarts and new connections queue on the socket. A listener still not systemd's
 * after readiness is reported loudly and recorded (socketHeld: false).
 *
 * --prepare-only (OpenRestream's `deploy.sh release`): step 2 and stop; a later `deploy --to <sha>` of the
 * same commit switches to it (sha12 ids name one release per commit, so it is reused).
 *
 * rollback: back to the release the release log says the current one replaced (or --to <id|sha>, or
 * the newest other release), with its own node_modules; a restart only when code or units differ.
 * Rollbacks are never frozen.
 */
const path = require('path');
const { git } = require('./git');
const deps = require('./deps');
const systemd = require('./systemd');
const probes = require('./probes');
const readiness = require('./readiness');
const releases = require('./releases');
const lock = require('./lock');
const preflight = require('./preflight');
const ops = require('./release-ops');

const { OpError, EXIT } = ops;

const pad = (n) => String(n).padStart(2, '0');

function newReleaseId(now, sha, format) {
    if (format === 'sha12') return sha.slice(0, 12);
    const d = new Date(now);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${sha.slice(0, 8)}`;
}

const gitClone = (exec, svc) => git(exec, svc, { dir: svc.release.git });
const gitRelease = (exec, svc, dir) => git(exec, svc, { dir, safeDirectory: true });

/** The sha a release directory holds: its worktree HEAD, else the sha its id names. */
async function releaseSha(ctx, svc, dir) {
    try {
        const h = await gitRelease(ctx.exec, svc, dir).head();
        if (/^[0-9a-f]{40}$/.test(h)) return h;
    } catch { /* fall back to the id */ }
    const m = /([0-9a-f]{8,40})$/.exec(path.basename(dir));
    if (!m) return null;
    try { return await gitClone(ctx.exec, svc).revParse(m[1]); } catch { return null; }
}

/** Where `current` points now. -> { link, dir, id, sha } (dir null when current is not a release) */
async function currentRelease(ctx, svc) {
    const link = svc.release.current;
    const target = await ctx.exec.readlink(link);
    if (!target) return { link, dir: null, id: null, sha: null };
    const dir = path.resolve(path.dirname(link), target);
    const inside = dir.startsWith(`${svc.release.releasesDir}/`) && path.dirname(dir) === svc.release.releasesDir;
    const st = await ctx.exec.stat(dir);
    if (!inside || !st || !st.isDir) return { link, dir: null, id: null, sha: null, target };
    return { link, dir, id: path.basename(dir), sha: await releaseSha(ctx, svc, dir) };
}

/** Every release directory, newest first (time ids sort by name; others by mtime, then name). */
async function listReleases(ctx, svc) {
    const entries = ((await ctx.exec.readdir(svc.release.releasesDir)) || []).filter((e) => e.isDir && !e.name.startsWith('.'));
    const out = [];
    for (const e of entries) {
        const dir = path.join(svc.release.releasesDir, e.name);
        const st = await ctx.exec.stat(dir);
        out.push({ id: e.name, dir, mtime: (st && st.mtime) || 0 });
    }
    const timeIds = svc.release.id === 'time-sha8';
    out.sort((a, b) => (timeIds ? b.id.localeCompare(a.id) : (b.mtime - a.mtime) || b.id.localeCompare(a.id)));
    return out;
}

/** Release ids a worker unit instance still runs from (openre-rtmp-ingest@<id>.service). */
async function releasesInUse(ctx, svc) {
    const used = new Set();
    for (const w of svc.workerUnits) {
        if (!w.endsWith('@.service')) continue;
        let list = [];
        try { list = await systemd.instances(ctx.exec, w); } catch { continue; }
        for (const i of list) {
            if (['inactive', 'dead'].includes(i.active) && i.sub === 'dead') continue;
            const m = /@([^@]+)\.service$/.exec(i.unit);
            if (m) used.add(m[1]);
        }
    }
    return used;
}

/** The release a rollback returns to. -> { id, dir, sha } */
async function rollbackTarget(ctx, svc, cur, to) {
    const list = await listReleases(ctx, svc);
    if (to != null) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(to))) throw new OpError(`"${to}" is not a release id or sha`, EXIT.USAGE);
        let hit = list.find((r) => r.id === to);
        if (!hit && /^[0-9a-f]{7,40}$/.test(to)) {
            for (const r of list) {
                const sha = await releaseSha(ctx, svc, r.dir);
                if (sha && sha.startsWith(to)) { hit = { ...r, sha }; break; }
            }
        }
        if (!hit) throw new OpError(`no release ${to} in ${svc.release.releasesDir}`, EXIT.USAGE);
        return { ...hit, sha: hit.sha || await releaseSha(ctx, svc, hit.dir) };
    }
    const records = await releases.list(ctx.exec, ctx.inv, svc.id);
    for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r.result === 'deployed' && r.toRelease === cur.id && r.fromRelease && r.fromRelease !== cur.id) {
            const hit = list.find((x) => x.id === r.fromRelease);
            if (hit) {
                ctx.log(`rolling back to ${hit.id} (the release ${cur.id} replaced, from the release log)`);
                return { ...hit, sha: await releaseSha(ctx, svc, hit.dir) };
            }
        }
    }
    const other = list.find((r) => r.id !== cur.id);
    if (!other) throw new OpError(`no previous release to roll back to in ${svc.release.releasesDir}`, EXIT.USAGE);
    ctx.log(`rolling back to ${other.id} (the newest other release; the release log names none)`);
    return { ...other, sha: await releaseSha(ctx, svc, other.dir) };
}

// ── plan ─────────────────────────────────────────────────────────────────────

async function computePlan(ctx, svc, { mode = 'deploy', to = null, fetch = true, restart = false, rollbackTo = null } = {}) {
    const { exec } = ctx;
    const rel = svc.release;
    if (mode === 'deploy' && to != null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(String(to))) throw new OpError(`"${to}" is not a sha or ref name`, EXIT.USAGE);
    const cur = await currentRelease(ctx, svc);
    if (!cur.dir) throw new OpError(`${rel.current} is not a link to a release in ${rel.releasesDir}${cur.target ? ` (it points at ${cur.target})` : ''}; set up the release layout first (Live: deploy/scripts/migrate-to-releases.sh)`, EXIT.USAGE);
    if (!cur.sha) throw new OpError(`cannot tell which commit ${cur.dir} holds`, EXIT.USAGE);
    if (!(await exec.stat(rel.git))) throw new OpError(`${rel.git} (release.git) does not exist`, EXIT.USAGE);
    const g = gitClone(exec, svc);
    let target;
    let targetDir = null;
    let targetId;
    let reuse = false;
    if (mode === 'deploy') {
        if (fetch) await g.fetch();
        target = await g.revParse(to || `${svc.remote}/${svc.branch}`);
        targetId = newReleaseId(exec.now(), target, rel.id);
        const existing = path.join(rel.releasesDir, targetId);
        if (rel.id === 'sha12' && targetId !== cur.id && await exec.stat(existing)) { reuse = true; targetDir = existing; } else targetDir = existing;
    } else {
        const t = rollbackTo || await rollbackTarget(ctx, svc, cur, to);
        target = t.sha;
        targetDir = t.dir;
        targetId = t.id;
        if (!target) throw new OpError(`cannot tell which commit ${t.dir} holds`, EXIT.USAGE);
    }
    const upToDate = mode === 'deploy' ? target === cur.sha : targetId === cur.id;
    const changed = target === cur.sha ? [] : await g.changedFiles(cur.sha, target);
    const commits = target === cur.sha ? [] : mode === 'deploy' ? await g.log(cur.sha, target) : await g.log(target, cur.sha);
    const codeChanged = changed.filter((f) => !ops.matchesPath(f, svc.noRestartPaths));

    const unitDrift = [];
    let socketChanged = false;
    for (const [unit, src] of Object.entries(svc.unitSources)) {
        const want = await g.show(target, src);
        if (want == null) continue;
        const have = await exec.readFile(path.join('/etc/systemd/system', unit), { privileged: true });
        if (have !== want) {
            unitDrift.push({ unit, source: src, installed: have != null });
            if (unit === svc.socketUnit && have != null) socketChanged = true;
        }
    }
    const restartNeeded = svc.units.length > 0 && (restart || codeChanged.length > 0 || unitDrift.length > 0);

    const pkgDirs = await deps.expandPackages(exec, { ...svc, repo: cur.dir });
    if (!pkgDirs.length) pkgDirs.push('.');
    const installs = [];
    for (const pkg of pkgDirs) {
        if (mode === 'rollback' || reuse) { installs.push({ pkg, install: false, reuse: 'its own', lockfileChanged: false, depsChanged: false }); continue; }
        const need = target === cur.sha ? { lockfileChanged: false, depsChanged: false, needed: false } : await deps.needsInstall(g, cur.sha, target, pkg, svc.install.lockfile);
        const curModules = !!(await exec.stat(path.join(cur.dir, pkg, 'node_modules')));
        const install = need.needed || !rel.reuseModules || !curModules;
        installs.push({ pkg, ...need, install, reuse: install ? null : cur.id, missingNodeModules: !curModules });
    }
    const backupNeeded = svc.databases.length > 0 && changed.some((f) => svc.backupOnChange.includes(f));
    const sessions = restartNeeded ? await probes.countProtected(exec, svc) : null;
    let socket = null;
    if (svc.socketUnit) {
        const port = rel.socketPort || svc.port;
        const held = port ? await systemd.socketHeld(exec, port) : { held: null, holders: [] };
        socket = { unit: svc.socketUnit, port, held: held.held, holders: held.holders, changed: socketChanged };
    }
    return {
        service: svc.id,
        strategy: svc.strategy,
        layout: 'release',
        mode,
        repo: svc.repo,
        branch: mode === 'deploy' ? svc.branch : 'release',
        expectedBranch: mode === 'deploy' ? svc.branch : 'release',
        from: cur.sha,
        to: target,
        fromRelease: cur.id,
        toRelease: targetId,
        currentDir: cur.dir,
        targetDir,
        reuse,
        upToDate,
        dirty: [],
        generatedDirty: [],
        commits,
        changedFiles: changed.length,
        changed,
        codeChanged: codeChanged.length,
        lockfileChanged: installs.some((i) => i.lockfileChanged),
        installs,
        untrackedLockfiles: [],
        untrackedGenerated: [],
        untrackedDeleted: [],
        build: [],
        preflight: preflight.describe(svc),
        restartNeeded,
        units: svc.units,
        extraUnits: [],
        socketUnit: svc.socketUnit,
        socket,
        unitDrift,
        installUnits: true,
        backupNeeded,
        protectedSessions: sessions,
        drainPolicy: svc.drain.policy,
        managed: svc.managed,
        installVhosts: false,
        vhostsRemoved: [],
        nginxNotInstalled: !!(svc.nginx && svc.nginx.repoVhost && changed.includes(svc.nginx.repoVhost)),
        keep: rel.keep,
    };
}

// ── steps ────────────────────────────────────────────────────────────────────

/** Point `current` at dir: a new link beside the old one, renamed over it (atomic). */
async function switchCurrent(ctx, svc, dir) {
    const link = svc.release.current;
    const tmp = path.join(path.dirname(link), `.${path.basename(link)}.tmp`);
    await ctx.exec.removeFile(tmp, { privileged: true });
    await ctx.exec.symlink(dir, tmp, { privileged: true });
    const r = await ctx.exec.run('mv', ['-T', '-f', tmp, link], { privileged: true });
    if (r.code !== 0) throw new Error(`could not switch ${link} to ${dir}: ${(r.stderr || '').trim()}`);
    ctx.log(`current -> ${path.basename(dir)}`);
}

/** Install the unit files a release carries (unitSources are paths inside the release). */
async function installReleaseUnits(ctx, svc, dir) {
    const changed = [];
    let socketChanged = false;
    for (const [unit, src] of Object.entries(svc.unitSources)) {
        const file = path.join(dir, src);
        const want = await ctx.exec.readFile(file);
        if (want == null) continue;
        const dest = path.join('/etc/systemd/system', unit);
        const have = await ctx.exec.readFile(dest, { privileged: true });
        if (have === want) continue;
        const r = await ctx.exec.run('install', ['-m', '0644', '-D', file, dest], { privileged: true });
        if (r.code !== 0) throw new Error(`could not install ${dest}: ${(r.stderr || '').trim()}`);
        if (unit === svc.socketUnit && have != null) socketChanged = true;
        changed.push(unit);
    }
    if (changed.length) {
        await systemd.daemonReload(ctx.exec);
        if (svc.socketUnit) await systemd.enable(ctx.exec, svc.socketUnit);
        for (const u of svc.units) await systemd.enable(ctx.exec, u);
        ctx.log(`installed unit files from ${path.basename(dir)}: ${changed.join(', ')}; daemon-reload`);
    }
    return { changed, socketChanged };
}

/** Restart the units (rebinding the socket only when it must) and wait for readiness. */
async function restartRelease(ctx, svc, { socketChanged = false, expectSha = null, readyTimeout } = {}) {
    const { exec, log } = ctx;
    let rebind = null;
    const port = svc.release.socketPort || svc.port;
    if (svc.socketUnit) {
        const s = await systemd.ensureSocketActive(exec, svc.socketUnit);
        if (s.started) log(`${svc.socketUnit} was ${s.state.active}; started it`);
        const held = port ? await systemd.socketHeld(exec, port) : { held: true, holders: [] };
        if (socketChanged) rebind = 'socket-changed';
        else if (held.held === false) rebind = 'socket-not-held';
    }
    let units = svc.units;
    if (rebind) {
        log(`${svc.socketUnit} ${rebind === 'socket-changed' ? 'changed' : 'is not holding its listener (pid 1 does not hold :' + port + ')'} — stopping ${svc.units[0]}, restarting the socket, starting ${svc.units[0]} on it (HTTP is refused for that moment, once)`);
        await systemd.rebindSocket(exec, svc.units[0], svc.socketUnit, rebind);
        units = svc.units.slice(1);
    } else if (svc.socketUnit) log(`${svc.socketUnit} holds the listener — new HTTP connections queue through the restart`);
    for (const u of units) {
        log(`restarting ${u}`);
        await systemd.restart(exec, u);
    }
    const r = await readiness.waitReady(exec, svc, { timeoutSeconds: readyTimeout, log, expectSha });
    if (r.ok) log(r.skipped ? 'no ready URL declared; restart issued' : `ready after ${r.seconds}s`);
    else log(`NOT READY after ${r.seconds}s (${r.reason}); see: journalctl -u ${svc.units[0]} -n 50`);
    let socketHeld = null;
    if (r.ok && svc.socketUnit && port) {
        socketHeld = (await systemd.socketHeld(exec, port)).held;
        if (!socketHeld) log(`✗ socket activation is not in effect: systemd does not hold :${port}, so restarts refuse connections (journalctl -u ${svc.socketUnit})`);
    }
    return { ...r, rebind, socketHeld };
}

/** Remove releases beyond keep: never current, the one just left, or one a worker still runs from. */
async function prune(ctx, svc, { keepIds = [] } = {}) {
    const list = await listReleases(ctx, svc);
    const cur = await currentRelease(ctx, svc);
    const inUse = await releasesInUse(ctx, svc);
    const g = gitClone(ctx.exec, svc);
    const removed = [];
    for (const r of list.slice(svc.release.keep)) {
        if (r.id === cur.id || keepIds.includes(r.id) || inUse.has(r.id)) continue;
        ctx.log(`pruning ${r.id}`);
        if (!(await g.worktreeRemove(r.dir))) await ctx.exec.run('rm', ['-rf', '--', r.dir], { privileged: true });
        removed.push(r.id);
    }
    await g.worktreePrune();
    return removed;
}

/** Make the new release: worktree, links, node_modules, dependencies, preflight, owner. */
async function prepare(ctx, svc, plan, record) {
    const { exec, log } = ctx;
    const g = gitClone(exec, svc);
    const dir = plan.targetDir;
    const rsvc = { ...svc, repo: dir, install: { ...svc.install, restoreLockfile: false } };
    if (plan.reuse) {
        // sha12 ids: a release prepared earlier (--prepare-only) is used as it is, checked again.
        log(`release ${plan.toRelease} already exists; checking it again`);
    } else {
        log(`preparing release ${plan.toRelease} while ${plan.fromRelease} keeps serving…`);
        await exec.mkdir(svc.release.releasesDir, { mode: 0o755 });
        await g.worktreeAdd(dir, plan.to);
        record.prepared = plan.toRelease;
        for (const [name, target] of Object.entries(svc.release.links)) {
            const at = path.join(dir, name);
            if (await exec.readlink(at)) continue;
            if (await exec.stat(at)) await exec.run('rm', ['-rf', '--', at], { privileged: true });
            await exec.symlink(target, at, { privileged: true });
        }
        for (const i of plan.installs) {
            if (i.install) {
                log(`installing dependencies in the new release${i.pkg === '.' ? '' : ` (${i.pkg})`} (${[i.lockfileChanged && 'lockfile changed', i.depsChanged && 'package.json dependencies changed', i.missingNodeModules && `no node_modules in ${plan.fromRelease}`, !svc.release.reuseModules && 'always'].filter(Boolean).join(', ') || 'install'}) — nothing interrupted yet`);
                await deps.install(exec, rsvc, gitRelease(exec, svc, dir), i.pkg);
                record.installed.push(i.pkg);
            } else {
                log(`dependencies unchanged — hard-linking node_modules from ${plan.fromRelease}${i.pkg === '.' ? '' : ` (${i.pkg})`}`);
                const r = await exec.run('cp', ['-al', path.join(plan.currentDir, i.pkg, 'node_modules'), path.join(dir, i.pkg, 'node_modules')], { as: svc.owner });
                if (r.code !== 0) throw new Error(`cp -al node_modules failed: ${(r.stderr || '').trim()}`);
            }
        }
    }
    const pkgDirs = await deps.expandPackages(exec, rsvc);
    const v = await deps.verifyAndRepair(exec, rsvc, gitRelease(exec, svc, dir), pkgDirs, log);
    record.depsVerified = v.problems.length === 0;
    if (v.repaired.length) record.depsRepaired = v.repaired;
    if (v.problems.length) throw new OpError(`dependencies do not resolve: ${v.problems.map((p) => `${p.pkg}: ${p.dep} (${p.reason})`).join('; ')}`, EXIT.VALIDATION);
    log(`every dependency resolves (${pkgDirs.join(', ') || 'no packages'})`);
    const pf = await preflight.run(ctx, rsvc, { root: dir, changed: plan.changed, pkgDirs });
    if (pf.problems.length) {
        record.preflight = { ok: false, problems: pf.problems };
        throw new OpError(`preflight failed: ${pf.problems.join('; ')}`, EXIT.VALIDATION);
    }
    if (svc.preflight.checks.length || svc.preflight.syntaxCheck) record.preflight = { ok: true, checks: pf.checksRun, syntaxChecked: pf.syntaxChecked };
    if (svc.release.chown) {
        const r = await exec.run('chown', ['-R', svc.release.chown, dir], { privileged: true });
        if (r.code !== 0) throw new Error(`chown -R ${svc.release.chown} ${dir} failed: ${(r.stderr || '').trim()}`);
    }
}

// ── deploy / rollback ────────────────────────────────────────────────────────

async function apply(ctx, svc, mode, opts = {}) {
    const { exec, inv, log } = ctx;
    if (!svc.managed) throw new OpError(`${svc.id} is not managed by ovhost${svc.unmanagedReason ? `: ${svc.unmanagedReason}` : ''}`, EXIT.USAGE);
    const held = await lock.acquire(exec, inv, svc.id);
    if (held.recoveredStale) log(`removed a stale lock (${held.file})`);
    const record = {
        id: releases.newId(exec.now()),
        service: svc.id,
        strategy: svc.strategy,
        layout: 'release',
        action: mode,
        startedAt: new Date(exec.now()).toISOString(),
        operator: await ops.operatorName(exec),
        host: await exec.hostname(),
        from: null,
        to: null,
        fromRelease: null,
        toRelease: null,
        commits: 0,
        lockfileChanged: false,
        installed: [],
        depsVerified: null,
        restartNeeded: null,
        switched: false,
        restarted: false,
        ready: null,
        forced: false,
        result: null,
    };
    let writeRecord = true;
    try {
        const plan = await computePlan(ctx, svc, { mode, to: opts.to, fetch: opts.fetch !== false, restart: opts.restart });
        Object.assign(record, { from: plan.from, to: plan.to, fromRelease: plan.fromRelease, toRelease: plan.toRelease, commits: plan.commits.length, lockfileChanged: plan.lockfileChanged, restartNeeded: plan.restartNeeded });
        log(`${svc.id}: ${mode} ${plan.fromRelease} (${plan.from.slice(0, 12)}) → ${mode === 'deploy' && !plan.reuse ? `new release ${plan.toRelease}` : plan.toRelease} (${plan.to.slice(0, 12)}; ${plan.commits.length} commit(s), ${plan.changedFiles} file(s) changed)`);
        if (plan.upToDate && !opts.restart) {
            log(mode === 'deploy' ? `already at ${plan.to.slice(0, 12)}; nothing to deploy` : `${plan.toRelease} is already current; nothing to do`);
            record.result = 'unchanged';
            writeRecord = false;
            return { exitCode: EXIT.OK, record, plan };
        }
        for (const c of plan.commits.slice(0, 20)) log(`    ${c}`);
        if (plan.nginxNotInstalled) log(`note: ${svc.nginx.repoVhost} changed and is NOT installed by a deploy — review it, copy it to ${inv.nginx.sitesAvailable}, nginx -t, reload`);

        let dir = plan.targetDir;
        const leaving = plan.currentDir;
        if (mode === 'deploy' && !plan.upToDate) {
            try {
                await prepare(ctx, svc, plan, record);
            } catch (err) {
                if (record.prepared) {
                    await gitClone(exec, svc).worktreeRemove(dir);
                    record.removedPrepared = true;
                }
                const msg = `${err.message} (release ${plan.toRelease} ${record.prepared ? 'removed' : 'not made'}; ${plan.fromRelease} untouched; nothing restarted)`;
                throw new OpError(msg, err.exitCode === EXIT.VALIDATION || !(err instanceof OpError) ? EXIT.VALIDATION : err.exitCode);
            }
        } else if (plan.upToDate) {
            dir = leaving;
        }
        if (opts.prepareOnly) {
            record.result = 'prepared';
            log(`release ${plan.toRelease} ${plan.reuse ? 'already exists' : 'is prepared'}; ${plan.fromRelease} keeps serving (--prepare-only: nothing switched or restarted)`);
            return { exitCode: EXIT.OK, record, plan };
        }

        const done = (result) => {
            record.result = result;
            return result;
        };

        if (!plan.restartNeeded) {
            if (dir !== leaving) {
                await switchCurrent(ctx, svc, dir);
                record.switched = true;
            }
            if (svc.ready) {
                await exec.sleep(svc.release.settleSeconds * 1000);
                const p = await readiness.probe(exec, svc);
                record.ready = p.ok;
                if (!p.ok) {
                    log(`${svc.ready.url} answers ${p.status || p.error} after the switch — switching back to ${plan.fromRelease}`);
                    await switchCurrent(ctx, svc, leaving);
                    record.autoRollback = { to: plan.fromRelease, ready: (await readiness.probe(exec, svc)).ok };
                    done('failed-rolled-back');
                    return { exitCode: EXIT.ROLLED_BACK, record, plan };
                }
            }
            done(mode === 'deploy' ? 'deployed' : 'rolled-back');
            log(`switched to ${plan.toRelease} without a restart (only ${svc.noRestartPaths.join(' ')} changed)`);
            if (mode === 'deploy') record.pruned = await prune(ctx, svc, { keepIds: [plan.fromRelease] });
            return { exitCode: EXIT.OK, record, plan };
        }

        // A restart: sessions first, then the backup, then the switch. Refused or given up: the new
        // release is removed again and the current one never stopped serving.
        try {
            await ops.guardSessions(ctx, svc, opts, record, 'before the switch');
            if (plan.backupNeeded) {
                await ops.backupBeforeRestart(ctx, svc, record);
                await ops.guardSessions(ctx, svc, opts, record, 'immediately before the restart');
            }
        } catch (err) {
            if (record.prepared) {
                await gitClone(exec, svc).worktreeRemove(dir);
                record.removedPrepared = true;
                if (err instanceof OpError) err.message += ` (release ${plan.toRelease} removed; ${plan.fromRelease} keeps serving)`;
            }
            throw err;
        }
        if (dir !== leaving) {
            await switchCurrent(ctx, svc, dir);
            record.switched = true;
        }
        const u = await installReleaseUnits(ctx, svc, dir);
        record.unitsInstalled = u.changed;
        const r = await restartRelease(ctx, svc, { socketChanged: u.socketChanged, expectSha: plan.to, readyTimeout: opts.readyTimeout });
        record.restarted = true;
        record.ready = r.ok;
        if (r.rebind) record.socketRebind = r.rebind;
        if (r.socketHeld != null) record.socketHeld = r.socketHeld;
        if (r.ok) {
            done(mode === 'deploy' ? 'deployed' : 'rolled-back');
            log(`${svc.id}: ${plan.fromRelease} → ${plan.toRelease} ${mode === 'deploy' ? 'deployed' : 'rolled back'}`);
            if (svc.socketUnit || svc.protected) log('note: established WebSocket/WHIP/RTMP/WebRTC/SSE sessions were reconnected, not preserved.');
            if (mode === 'deploy') record.pruned = await prune(ctx, svc, { keepIds: [plan.fromRelease] });
            return { exitCode: EXIT.OK, record, plan };
        }

        // Not ready: back to the release we left.
        log(`automatic rollback to ${plan.fromRelease}`);
        record.autoRollback = { to: plan.fromRelease };
        let exitCode;
        try {
            if (record.switched) await switchCurrent(ctx, svc, leaving);
            const back = await installReleaseUnits(ctx, svc, leaving);
            const b = await restartRelease(ctx, svc, { socketChanged: back.socketChanged, expectSha: plan.from, readyTimeout: opts.readyTimeout });
            record.autoRollback.ready = b.ok;
            if (b.ok) {
                done('failed-rolled-back');
                exitCode = EXIT.ROLLED_BACK;
                log(`${svc.id} is back on ${plan.fromRelease} and serving; ${plan.toRelease} was not deployed (it is kept for inspection)`);
            } else {
                done('rollback-failed');
                exitCode = EXIT.ROLLBACK_FAILED;
                log(`ROLLBACK FAILED: ${plan.fromRelease} is not ready either — MANUAL INTERVENTION REQUIRED`);
            }
        } catch (err) {
            done('rollback-failed');
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

module.exports = { apply, computePlan, currentRelease, listReleases, rollbackTarget, newReleaseId, prune, switchCurrent };
