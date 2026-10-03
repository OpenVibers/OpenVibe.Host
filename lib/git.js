'use strict';
/**
 * git adapter. Every command runs AS THE CHECKOUT OWNER (ubuntu on the host): root running git in
 * an ubuntu-owned checkout either trips "dubious ownership" or leaves root-owned objects behind
 * that break the next pull.
 */
function git(exec, svc, { dir = svc.repo, safeDirectory = false } = {}) {
    // A release directory may belong to the service user while git runs as the clone's owner (OpenRe
    // chowns each release): -c safe.directory names that one directory, nothing wider.
    const pre = ['-C', dir, ...(safeDirectory ? ['-c', `safe.directory=${dir}`] : [])];
    const run = async (args, { allowFail = false } = {}) => {
        const r = await exec.run('git', [...pre, ...args], { as: svc.owner });
        if (r.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
        return r;
    };
    return {
        head: async () => (await run(['rev-parse', 'HEAD'])).stdout.trim(),
        branch: async () => (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(),
        revParse: async (ref) => (await run(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim(),
        hasCommit: async (sha) => (await run(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0,
        /** Tracked changes only; untracked files (data/, local notes) never block a deploy. */
        dirty: async () => (await run(['status', '--porcelain', '--untracked-files=no'])).stdout.split('\n').filter(Boolean).map((l) => l.slice(3)),
        /** Paths the index marks skip-worktree (ls-files -v prints 'S'); git status hides them. */
        skipWorktree: async () => (await run(['ls-files', '-v'])).stdout.split('\n').filter((l) => l.startsWith('S ')).map((l) => l.slice(2)),
        /** Drop the skip-worktree bit so the path can leave the index; a no-op when it was not set. */
        noSkipWorktree: async (file) => { await run(['update-index', '--no-skip-worktree', '--', file], { allowFail: true }); },
        /** Remove a path from the INDEX only: the working-tree files (node_modules) stay on disk. */
        rmCached: async (file) => { await run(['rm', '--cached', '-q', '-r', '--', file]); },
        fetch: async () => { await run(['fetch', '--quiet', svc.remote, svc.branch]); },
        changedFiles: async (from, to) => (await run(['diff', '--name-only', from, to])).stdout.split('\n').filter(Boolean),
        /** Paths <to> has and <from> does not (in either direction: a rollback's target can be the older commit). */
        addedFiles: async (from, to) => (await run(['diff', '--name-only', '--diff-filter=A', from, to])).stdout.split('\n').filter(Boolean),
        log: async (from, to) => (await run(['log', '--oneline', '--no-decorate', `${from}..${to}`], { allowFail: true })).stdout.split('\n').filter(Boolean),
        show: async (sha, file) => { const r = await run(['show', `${sha}:${file}`], { allowFail: true }); return r.code === 0 ? r.stdout : null; },
        ffMerge: async (sha) => { await run(['merge', '--ff-only', '--quiet', sha]); },
        resetHard: async (sha) => { await run(['reset', '--hard', '--quiet', sha]); },
        checkoutFile: async (file) => { await run(['checkout', '--', file]); },
        /** Restore tracked files from HEAD (generated output a build rewrote). */
        checkoutPaths: async (files) => { for (let i = 0; i < files.length; i += 200) await run(['checkout', '--', ...files.slice(i, i + 200)]); },
        /** A detached worktree of <sha> at <dir> (a new release). */
        worktreeAdd: async (wt, sha) => { await run(['worktree', 'add', '--detach', '--quiet', wt, sha]); },
        worktreeRemove: async (wt) => (await run(['worktree', 'remove', '--force', wt], { allowFail: true })).code === 0,
        worktreePrune: async () => { await run(['worktree', 'prune'], { allowFail: true }); },
        remoteUrl: async () => redactUrl((await run(['config', '--get', `remote.${svc.remote}.url`], { allowFail: true })).stdout.trim()),
    };
}

/** https://user:token@github.com/... -> https://github.com/... */
function redactUrl(url) {
    return String(url || '').replace(/^(\w+:\/\/)[^@/]+@/, '$1');
}

module.exports = { git, redactUrl };
