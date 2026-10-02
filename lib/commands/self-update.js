'use strict';
/**
 * ovhost self-update [--dry-run]: update the ovhost CLI install itself —
 * /usr/local/lib/openvibe-host, the root-owned checkout /usr/local/bin/ovhost links to
 * (README "Installing on the host"). Deploying the Host service updates /opt/openvibe.host only,
 * so without this the installed CLI silently runs behind main (it was 16 commits behind on
 * 2026-10-02: no `env-names --set`, no `logs`, no Bot vhost).
 *
 * The install directory comes from ovhost's own real path, so it works whatever the symlink is:
 *   /usr/local/bin/ovhost -> /usr/local/lib/openvibe-host/bin/ovhost  =>  /usr/local/lib/openvibe-host
 *
 * It fetches origin/main, refuses a dirty tree, a branch other than main, or a divergence, merges
 * --ff-only and runs `npm ci --omit=dev --no-audit --no-fund` in the install directory. npm
 * rewriting the (checked-in) lockfile is undone: the install must stay exactly at the merged sha.
 * Nothing is restarted: ovhost is a CLI, and the next invocation runs the new code.
 */
const fs = require('fs');
const path = require('path');
const { git } = require('../git');
const { OpError, EXIT } = require('../release-ops');

const REMOTE = 'origin';
const BRANCH = 'main';
const NPM_CI = ['ci', '--omit=dev', '--no-audit', '--no-fund'];

/** <install>/bin/ovhost from a path to the invoked script, following the /usr/local/bin symlink. */
function installDirFor(selfPath) {
    let real = selfPath;
    try { real = fs.realpathSync(selfPath); } catch { /* not on disk here (tests): use the path as given */ }
    return { self: real, dir: path.dirname(path.dirname(real)) };
}

async function selfUpdate(ctx, { selfPath, dryRun = false } = {}) {
    const { exec, log } = ctx;
    const { self, dir } = installDirFor(selfPath || '');
    if (path.basename(self) !== 'ovhost' || path.basename(path.dirname(self)) !== 'bin') {
        throw new OpError(`${self || "ovhost's own path"} is not <install>/bin/ovhost — self-update only updates the installed CLI (README "Installing on the host")`, EXIT.USAGE);
    }
    // The install is root-owned and npm ci rewrites node_modules in it: without root both git and npm
    // trip over permissions (or leave root-owned objects behind), exactly what lib/git.js warns about.
    if (!(await exec.isRoot())) throw new OpError('self-update must run as root (sudo ovhost self-update): the install is root-owned and it replaces node_modules', EXIT.USAGE);
    const st = await exec.stat(dir);
    if (!st || !st.isDir) throw new OpError(`${dir} is not a directory — cannot self-update`, EXIT.USAGE);

    const svc = { owner: st.owner || 'root', repo: dir, remote: REMOTE, branch: BRANCH };
    const g = git(exec, svc);
    let oldSha;
    try { oldSha = await g.head(); } catch (err) { throw new OpError(`${dir} is not a git checkout: ${err.message.split('\n')[0]}`, EXIT.USAGE); }

    const branch = await g.branch();
    if (branch !== BRANCH) throw new OpError(`${dir} is on branch "${branch}", not "${BRANCH}" — refusing to self-update (put it back on ${BRANCH} by hand)`, EXIT.USAGE);
    const dirty = await g.dirty();
    if (dirty.length) {
        const shown = dirty.slice(0, 5).join(', ');
        throw new OpError(`${dir} has local changes (${shown}${dirty.length > 5 ? `, +${dirty.length - 5} more` : ''}) — refusing to self-update; nothing was fetched or changed`, EXIT.USAGE);
    }

    log(`fetching ${REMOTE} ${BRANCH} in ${dir}`);
    try { await g.fetch(); } catch (err) { throw new OpError(`git fetch ${REMOTE} ${BRANCH} failed in ${dir}: ${err.message}`, EXIT.USAGE); }
    const newSha = await g.revParse(`${REMOTE}/${BRANCH}`);
    if (!newSha) throw new OpError(`${REMOTE}/${BRANCH} not found in ${dir}`, EXIT.USAGE);

    const commits = newSha === oldSha ? [] : await g.log(oldSha, newSha);
    const result = { installDir: dir, branch, remote: REMOTE, oldSha, newSha, commits: commits.length, upToDate: newSha === oldSha, dryRun, updated: false, lockfileRestored: false, npm: null };

    if (result.upToDate) {
        if (!dryRun) log(`${dir} is already at ${REMOTE}/${BRANCH}`);
        return result;
    }

    const ff = await exec.run('git', ['-C', dir, 'merge-base', '--is-ancestor', oldSha, newSha], { as: svc.owner });
    if (ff.code !== 0) throw new OpError(`${dir} has diverged from ${REMOTE}/${BRANCH} (${oldSha.slice(0, 12)} is not an ancestor of ${newSha.slice(0, 12)}) — refusing, not a fast-forward; fix it by hand`, EXIT.USAGE);

    if (dryRun) return result;

    try { await g.ffMerge(newSha); } catch (err) { throw new OpError(`git merge --ff-only ${newSha.slice(0, 12)} failed in ${dir}: ${err.message}`, EXIT.USAGE); }
    result.updated = true;

    log(`installing dependencies (npm ${NPM_CI.join(' ')})`);
    const npm = await exec.run('npm', NPM_CI, { as: svc.owner, cwd: dir, timeoutMs: 20 * 60 * 1000 });
    result.npm = { code: npm.code };
    if (npm.code !== 0) {
        const why = String(npm.stderr || npm.stdout).trim().split('\n').slice(-3).join(' / ');
        throw new OpError(`the code is now at ${newSha.slice(0, 12)}, but "npm ci --omit=dev --no-audit --no-fund" failed (exit ${npm.code}) in ${dir}: ${why} — re-run it there by hand`, EXIT.VALIDATION);
    }

    // npm ci normally does not touch the lockfile, but if it did the install would no longer be the
    // merged tree (and the next self-update would refuse it as dirty).
    if ((await g.dirty()).includes('package-lock.json')) {
        await g.checkoutFile('package-lock.json');
        result.lockfileRestored = true;
        log('package-lock.json was rewritten by npm; restored to the merged version');
    }
    return result;
}

module.exports = { selfUpdate, NPM_CI, REMOTE, BRANCH };
