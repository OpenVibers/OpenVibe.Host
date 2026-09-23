'use strict';
/**
 * git adapter. Every command runs AS THE CHECKOUT OWNER (ubuntu on the host): root running git in
 * an ubuntu-owned checkout either trips "dubious ownership" or leaves root-owned objects behind
 * that break the next pull.
 */
function git(exec, svc) {
    const run = async (args, { allowFail = false } = {}) => {
        const r = await exec.run('git', ['-C', svc.repo, ...args], { as: svc.owner });
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
        fetch: async () => { await run(['fetch', '--quiet', svc.remote, svc.branch]); },
        changedFiles: async (from, to) => (await run(['diff', '--name-only', from, to])).stdout.split('\n').filter(Boolean),
        log: async (from, to) => (await run(['log', '--oneline', '--no-decorate', `${from}..${to}`], { allowFail: true })).stdout.split('\n').filter(Boolean),
        show: async (sha, file) => { const r = await run(['show', `${sha}:${file}`], { allowFail: true }); return r.code === 0 ? r.stdout : null; },
        ffMerge: async (sha) => { await run(['merge', '--ff-only', '--quiet', sha]); },
        resetHard: async (sha) => { await run(['reset', '--hard', '--quiet', sha]); },
        checkoutFile: async (file) => { await run(['checkout', '--', file]); },
        remoteUrl: async () => redactUrl((await run(['config', '--get', `remote.${svc.remote}.url`], { allowFail: true })).stdout.trim()),
    };
}

/** https://user:token@github.com/... -> https://github.com/... */
function redactUrl(url) {
    return String(url || '').replace(/^(\w+:\/\/)[^@/]+@/, '$1');
}

module.exports = { git, redactUrl };
