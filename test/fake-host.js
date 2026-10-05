'use strict';
/**
 * A fake host implementing the executor interface (lib/executor.js) in memory: a filesystem, git
 * repositories, systemd units, npm, nginx, ss, HTTP endpoints, SQLite and PostgreSQL. Nothing here
 * touches the real machine. Every run() call is recorded in `calls` so tests can assert what would
 * have been executed (and as whom).
 *
 * PostgreSQL is modelled the way lib/dbengine.js uses it: `exec.psql(database, sql)` answers rows
 * (queries only), and the cluster's own tools — pg_dump, pg_restore, createdb, dropdb, pgbackrest —
 * go through run() as the postgres OS user, which is also how the role password reaches psql
 * (on stdin, so it never appears in an argv this fake records).
 */
const crypto = require('crypto');
const path = require('path');
const { Readable, Writable } = require('stream');
const { createTarGz, readTarGz } = require('../lib/tar');

function createFakeHost({ root = true, user = 'root', hostname = 'fake-host', start = Date.parse('2026-09-22T12:00:00Z') } = {}) {
    const files = new Map(); // path -> { type: 'file'|'dir'|'symlink', content, mode, owner, target }
    const calls = [];
    const repos = new Map(); // repoPath -> repo
    const remoteRepos = new Map(); // URL -> files for a new clone
    const units = new Map(); // unit -> state
    const http = new Map(); // url -> fn({ headers, method, body }) -> { status, body } (request() also passes method and body)
    const alivePids = new Set();
    const listeners = new Map(); // port -> [{ pid, process }]
    let clock = start;
    let seq = 0;
    const host = {
        files, calls, repos, remoteRepos, units, http, alivePids, listeners,
        nginxTest: () => ({ code: 0, stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' }),
        npm: null, // (cwd, argv, as) -> undefined | { code, stderr } ; default installs package.json deps
        npmRewritesLockfile: true,
        sqliteHandler: () => [{ n: 0 }],
        sqliteCalls: [],
        // ── PostgreSQL ──
        // The cluster's databases and roles, the archiver's failed WAL count, the stanza's backups
        // and its status. A test drives them directly (host.pgDatabases.add('ov_trade')) or through
        // the tools below, exactly as production would.
        pgDatabases: new Set(),
        pgRoles: new Map(), // role -> { password }
        pgArchiver: { failed_count: 0 },
        pgBackups: [], // [{ type, timestamp: { stop } }] (epoch seconds)
        pgStanzaStatus: { code: 0, message: 'ok' },
        pgbackrestCode: 0,
        pgbackrestStderr: '',
        psqlHandler: null, // (database, sql, as) -> rows | undefined (undefined: the engine defaults)
        psqlCalls: [],
        adminSql: [], // SQL sent to psql on stdin (role creation, where the password must not be argv)
        dumps: [], // { database, dest, as }
        restores: [], // { database, role, file, as }
        createdDatabases: [], // { name, owner, as }
        droppedDatabases: [], // { name, as }
        statfsFree: 100 * 1024 ** 3,
        statfsSize: 500 * 1024 ** 3,
        reads: [],
        onTar: null, // (args, opts, real) -> undefined | { code, stdout, stderr } ; override a tar result
        tarMembers: [], // [{ type, name, target }] extra (non-)members a `tar -tvzf` listing reports
        certbot: null, // (args, opts) -> { code, stdout, stderr } | Error ; default: nothing to do
        certbotCalls: [], // { args, as, privileged }
        journalctl: null, // (args, opts) -> { code, stdout, stderr } ; default: no entries
        journalctlCalls: [], // { args, as, privileged }
        onRestart: null, // (unit) -> void
        onSystemdRun: null, // (spec) -> undefined | { code, stderr } ; spec = { unit, uid, cwd, props, argv, pid }
        onKill: null, // (pid, signal) -> false to ignore the signal
        onNode: null, // (args, opts) -> undefined | { code, stdout, stderr } ; `node` otherwise exits 0
        pnpm: null, // (cwd, argv, as) -> undefined | { code, stderr } ; default installs every workspace package's deps
        onBuild: null, // (cwd, argv, as) -> undefined | { code, stderr } ; `pnpm build`
        systemdRuns: [],
        nextPid: 40000,
        streamPiece: 4096, // readStream() yields files in pieces of this size
    };

    // ── filesystem ──
    // Every path component that is a symlink is followed (like the kernel does), so a file read or
    // written through /opt/x/current/… lands in the release `current` points at.
    function resolveLinks(p) {
        const parts = path.resolve(p).split('/').filter(Boolean);
        let cur = '/';
        for (const part of parts) {
            let next = path.join(cur, part);
            let e = files.get(next);
            let hops = 0;
            while (e && e.type === 'symlink' && hops++ < 10) { next = path.resolve(path.dirname(next), e.target); e = files.get(next); }
            cur = next;
        }
        return cur;
    }
    /** The path of an entry itself (lstat): the parent resolved, the last component not followed. */
    function lpath(p) { const abs = path.resolve(p); return abs === '/' ? abs : path.join(resolveLinks(path.dirname(abs)), path.basename(abs)); }
    function ensureDir(p, owner = 'root', mode = 0o755) {
        const parts = resolveLinks(p).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur += `/${part}`;
            if (!files.has(cur)) files.set(cur, { type: 'dir', mode, owner, mtime: clock });
        }
    }
    function put(p, content, { mode = 0o644, owner = 'root' } = {}) {
        ensureDir(path.dirname(p), owner);
        files.set(lpath(p), { type: 'file', content, mode, owner, mtime: clock });
    }
    function get(p) {
        return files.get(resolveLinks(p)) || null;
    }
    function rmTree(p) {
        const abs = lpath(p);
        for (const k of [...files.keys()]) if (k === abs || k.startsWith(`${abs}/`)) files.delete(k);
    }
    function copyTree(src, dest, owner) {
        const from = resolveLinks(src);
        const to = lpath(dest);
        const e = files.get(from);
        if (!e) return false;
        for (const [k, v] of [...files.entries()]) {
            if (k !== from && !k.startsWith(`${from}/`)) continue;
            files.set(to + k.slice(from.length), { ...v, owner: owner || v.owner, mtime: clock });
        }
        ensureDir(path.dirname(to));
        return true;
    }
    host.put = put;
    host.read = (p) => { const e = get(p); return e && e.type === 'file' ? String(e.content) : null; };
    host.ensureDir = ensureDir;
    host.resolve = resolveLinks;

    // ── git ──
    function newSha(seed) { seq += 1; return crypto.createHash('sha1').update(`${seq}:${seed}`).digest('hex'); }
    host.createRepo = (repoPath, { owner = 'ubuntu', branch = 'main', remote = 'origin', worktree = true } = {}) => {
        const repo = { path: repoPath, owner, branch, remote, commits: new Map(), head: null, remoteRefs: {}, worktrees: new Set(), skipWorktree: new Set(), indexRemoved: new Set() };
        repos.set(repoPath, repo);
        ensureDir(repoPath, owner);
        files.get(path.resolve(repoPath)).owner = owner;
        if (!worktree) repo.bare = true;
        repo.commit = (changes, { parent = repo.remoteRefs[`${remote}/${branch}`] || repo.head, message = 'change' } = {}) => {
            const base = parent ? { ...repo.commits.get(parent).files } : {};
            for (const [k, v] of Object.entries(changes)) { if (v === null) delete base[k]; else base[k] = v; }
            const sha = newSha(JSON.stringify(base) + message);
            repo.commits.set(sha, { sha, parent, message, files: base });
            return sha;
        };
        repo.publish = (sha) => { repo.remoteRefs[`${remote}/${branch}`] = sha; };
        repo.checkout = (sha) => {
            const old = repo.head ? repo.commits.get(repo.head).files : {};
            const next = repo.commits.get(sha).files;
            for (const f of Object.keys(old)) if (!(f in next)) files.delete(path.join(repoPath, f));
            for (const [f, c] of Object.entries(next)) put(path.join(repoPath, f), c, { owner });
            repo.head = sha;
        };
        return repo;
    };
    /** `git worktree add --detach <dir> <sha>`: a checkout sharing the clone's commits. */
    function addWorktree(parent, dir, sha, owner) {
        const wt = { path: dir, owner, branch: 'HEAD', remote: parent.remote, commits: parent.commits, head: null, remoteRefs: parent.remoteRefs, worktreeOf: parent.path, skipWorktree: new Set(), indexRemoved: new Set() };
        wt.checkout = (s2) => {
            const old = wt.head ? wt.commits.get(wt.head).files : {};
            const next = wt.commits.get(s2).files;
            for (const f of Object.keys(old)) if (!(f in next)) files.delete(path.join(dir, f));
            for (const [f, c] of Object.entries(next)) put(path.join(dir, f), c, { owner });
            wt.head = s2;
        };
        ensureDir(dir, owner);
        wt.checkout(sha);
        repos.set(path.resolve(dir), wt);
        parent.worktrees.add(path.resolve(dir));
        return wt;
    }
    function isAncestor(repo, anc, sha) {
        let cur = sha;
        while (cur) { if (cur === anc) return true; cur = repo.commits.get(cur).parent; }
        return false;
    }
    function resolveRef(repo, ref) {
        const r0 = ref.replace(/\^\{commit\}$/, '');
        // <ref>^ and <ref>~<n>: first parents.
        const up = /^(.*?)(\^+|~(\d+))$/.exec(r0);
        if (up && up[1]) {
            let sha = resolveRef(repo, up[1]);
            for (let n = up[3] ? Number(up[3]) : up[2].length; sha && n > 0; n--) sha = repo.commits.get(sha).parent || null;
            return sha;
        }
        const r = r0;
        if (r === 'HEAD') return repo.head;
        if (repo.remoteRefs[r]) return repo.remoteRefs[r];
        if (repo.commits.has(r)) return r;
        const matches = [...repo.commits.keys()].filter((k) => k.startsWith(r));
        return matches.length === 1 ? matches[0] : null;
    }
    function gitCmd(args, opts) {
        if (args[0] === 'clone') {
            const url = args[args.length - 2];
            const dest = args[args.length - 1];
            const source = remoteRepos.get(url);
            if (!source || (files.has(path.resolve(dest)) && (files.get(path.resolve(dest)).type !== 'dir' || [...files.keys()].some((p) => p.startsWith(`${path.resolve(dest)}/`))))) return { code: 128, stdout: '', stderr: 'clone source missing or destination occupied' };
            const branch = args[args.indexOf('--branch') + 1];
            const repo = host.createRepo(dest, { owner: opts.as || 'root', branch });
            const sha = repo.commit(source);
            repo.publish(sha);
            repo.checkout(sha);
            return { code: 0, stdout: '', stderr: '' };
        }
        const repo = repos.get(args[1]) || repos.get(resolveLinks(args[1]));
        if (!repo) return { code: 128, stdout: '', stderr: 'not a git repository' };
        let i = 2;
        const config = {};
        while (args[i] === '-c') { const [k, v] = String(args[i + 1]).split('='); config[k] = v; i += 2; }
        const dirEntry = files.get(resolveLinks(repo.path));
        const dirOwner = dirEntry ? dirEntry.owner : repo.owner;
        const safe = config['safe.directory'] === repo.path || config['safe.directory'] === args[1] || config['safe.directory'] === '*';
        if (opts.as !== repo.owner && !(safe && (opts.as || 'root') === 'root')) return { code: 128, stdout: '', stderr: `fatal: detected dubious ownership in repository at '${repo.path}' (ran as ${opts.as || 'root'})` };
        if (dirOwner !== repo.owner && (opts.as || 'root') !== dirOwner && !safe) return { code: 128, stdout: '', stderr: `fatal: detected dubious ownership in repository at '${repo.path}' (owned by ${dirOwner})` };
        const [sub, ...rest] = args.slice(i);
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        const fail = (stderr) => ({ code: 1, stdout: '', stderr });
        switch (sub) {
        case 'rev-parse':
            if (rest[0] === '--abbrev-ref') return ok(`${repo.branch}\n`);
            if (rest[0] === '--verify') { const s = resolveRef(repo, rest[1]); return s ? ok(`${s}\n`) : fail(`fatal: Needed a single revision (${rest[1]})`); }
            return ok(`${resolveRef(repo, rest[0])}\n`);
        case 'cat-file': return resolveRef(repo, rest[1]) ? ok() : fail('bad object');
        case 'merge-base': {
            if (rest[0] !== '--is-ancestor') return fail('fake git: merge-base --is-ancestor only');
            const a = resolveRef(repo, rest[1]);
            const b = resolveRef(repo, rest[2]);
            return a && b && isAncestor(repo, a, b) ? ok() : fail('');
        }
        case 'status': {
            const head = repo.commits.get(repo.head).files;
            const dirty = Object.entries(head)
                .filter(([f, c]) => !repo.skipWorktree.has(f) && !repo.indexRemoved.has(f) && host.read(path.join(repo.path, f)) !== c)
                .map(([f]) => ` M ${f}`);
            return ok(dirty.length ? `${dirty.join('\n')}\n` : '');
        }
        case 'ls-files': {
            // `-v`: the skip-worktree bit is the uppercase 'S' tag (others are lowercase).
            const head = repo.commits.get(repo.head).files;
            const lines = Object.keys(head).filter((f) => !repo.indexRemoved.has(f)).map((f) => `${repo.skipWorktree.has(f) ? 'S' : 'H'} ${f}`);
            return ok(lines.length ? `${lines.join('\n')}\n` : '');
        }
        case 'update-index': {
            const skip = rest.includes('--skip-worktree') ? true : rest.includes('--no-skip-worktree') ? false : null;
            if (skip == null) return fail('fake git: update-index supports --skip-worktree/--no-skip-worktree');
            for (const f of rest.slice(rest.indexOf('--') + 1)) { if (skip) repo.skipWorktree.add(f); else repo.skipWorktree.delete(f); }
            return ok();
        }
        case 'fetch': return ok();
        case 'diff': {
            const refs = rest.filter((x) => !x.startsWith('--'));
            const a = repo.commits.get(resolveRef(repo, refs[0])).files;
            const b = repo.commits.get(resolveRef(repo, refs[1])).files;
            const added = rest.includes('--diff-filter=A');
            const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => (added ? !(f in a) && f in b : a[f] !== b[f])).sort();
            return ok(names.length ? `${names.join('\n')}\n` : '');
        }
        case 'log': {
            const [from, to] = rest[rest.length - 1].split('..');
            const out = [];
            let cur = resolveRef(repo, to);
            while (cur && cur !== resolveRef(repo, from)) { out.push(`${cur.slice(0, 7)} ${repo.commits.get(cur).message}`); cur = repo.commits.get(cur).parent; }
            return ok(out.length ? `${out.join('\n')}\n` : '');
        }
        case 'show': {
            const [ref, file] = rest[0].split(':');
            const c = repo.commits.get(resolveRef(repo, ref));
            return c && file in c.files ? ok(c.files[file]) : fail(`fatal: path '${file}' does not exist`);
        }
        case 'rm': {
            // `git rm --cached -q -r -- <path>`: the index only, the working tree is untouched.
            if (!rest.includes('--cached')) return fail('fake git: rm without --cached would remove the working tree');
            for (const f of rest.slice(rest.indexOf('--') + 1)) { repo.indexRemoved.add(f); repo.skipWorktree.delete(f); }
            return ok();
        }
        case 'merge': {
            const sha = resolveRef(repo, rest[rest.length - 1]);
            if (!isAncestor(repo, repo.head, sha)) return fail('fatal: Not possible to fast-forward, aborting.');
            // A local change to a path the incoming tree DELETES blocks the merge — the real git
            // behavior behind the tracked node_modules symlink npm replaced with a directory — unless
            // the path has left the index (`git rm --cached`). skip-worktree does not help.
            const headFiles = repo.commits.get(repo.head).files;
            const nextFiles = repo.commits.get(sha).files;
            for (const f of Object.keys(nextFiles)) {
                if (f in headFiles || !files.has(path.join(repo.path, f))) continue;
                return fail(`error: The following untracked working tree files would be overwritten by merge:\n\t${f}\nPlease move or remove them before you merge.`);
            }
            for (const f of Object.keys(headFiles)) {
                if (f in nextFiles || repo.indexRemoved.has(f)) continue;
                if (host.read(path.join(repo.path, f)) === headFiles[f]) continue;
                return fail(`error: Your local changes to the following files would be overwritten by merge:\n\t${f}\nPlease commit your changes or stash them before you merge.`);
            }
            // An untracked file where the incoming tree adds one blocks it too, even byte for byte the same
            // (real git: Sites' deploy/nginx/openvibe.work.conf, 2026-10-03).
            for (const f of Object.keys(nextFiles)) {
                if (f in headFiles || host.read(path.join(repo.path, f)) == null) continue;
                return fail(`error: The following untracked working tree files would be overwritten by merge:\n\t${f}\nPlease move or remove them before you merge.\nAborting`);
            }
            repo.checkout(sha);
            repo.indexRemoved.clear();
            repo.skipWorktree.clear();
            return ok();
        }
        case 'reset': repo.checkout(resolveRef(repo, rest[rest.length - 1])); return ok();
        case 'checkout': {
            const list = rest[0] === '--' ? rest.slice(1) : [rest[rest.length - 1]];
            for (const f of list) put(path.join(repo.path, f), repo.commits.get(repo.head).files[f], { owner: repo.owner });
            return ok();
        }
        case 'worktree': {
            const [op, ...wargs] = rest;
            if (op === 'add') {
                const pos = wargs.filter((a) => !a.startsWith('-'));
                const [dir, ref] = pos;
                if (files.has(lpath(dir))) return fail(`fatal: '${dir}' already exists`);
                const sha = resolveRef(repo, ref);
                if (!sha) return fail(`fatal: invalid reference: ${ref}`);
                addWorktree(repo, dir, sha, opts.as || 'root');
                return ok();
            }
            if (op === 'remove') {
                const dir = path.resolve(wargs[wargs.length - 1]);
                if (!repo.worktrees || !repo.worktrees.has(dir)) return fail(`fatal: '${dir}' is not a working tree`);
                rmTree(dir);
                repos.delete(dir);
                repo.worktrees.delete(dir);
                return ok();
            }
            if (op === 'prune') return ok();
            return fail(`fake git: worktree ${op}`);
        }
        case 'config': return ok(`https://x-access-token:ghp_FAKE_TOKEN_VALUE@github.com/OpenVibers/${path.basename(repo.path)}.git\n`);
        default: return fail(`fake git: unsupported ${sub}`);
        }
    }

    // ── npm ──
    function npmCmd(argv, opts) {
        if (host.npm) {
            const r = host.npm(opts.cwd, argv, opts.as);
            if (r) return { stdout: '', stderr: '', ...r };
        }
        const pkg = JSON.parse(host.read(path.join(opts.cwd, 'package.json')));
        for (const dep of Object.keys(pkg.dependencies || {})) put(path.join(opts.cwd, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep, version: '1.0.0' }), { owner: opts.as });
        const lock = path.join(opts.cwd, 'package-lock.json');
        if (host.npmRewritesLockfile && host.read(lock) != null) put(lock, `${host.read(lock)}\n// rewritten by npm on the host`, { owner: opts.as });
        return { code: 0, stdout: 'added packages', stderr: '' };
    }

    // ── pnpm (Games: a workspace) ──
    function pnpmCmd(argv, opts) {
        if (argv[0] === 'build' || (argv[0] === 'run' && argv[1] === 'build')) {
            const r = host.onBuild ? host.onBuild(opts.cwd, argv, opts.as) : undefined;
            return r ? { stdout: '', stderr: '', ...r } : { code: 0, stdout: 'built', stderr: '' };
        }
        if (host.pnpm) {
            const r = host.pnpm(opts.cwd, argv, opts.as);
            if (r) return { stdout: '', stderr: '', ...r };
        }
        const pkgs = ['.'];
        for (const base of ['apps', 'packages']) {
            const abs = resolveLinks(path.join(opts.cwd, base));
            for (const k of files.keys()) if (k.startsWith(`${abs}/`) && k.slice(abs.length + 1).split('/').length === 2 && k.endsWith('/package.json')) pkgs.push(path.join(base, k.slice(abs.length + 1).split('/')[0]));
        }
        for (const dir of pkgs) {
            const text = host.read(path.join(opts.cwd, dir, 'package.json'));
            if (text == null) continue;
            const pkg = JSON.parse(text);
            for (const dep of Object.keys(pkg.dependencies || {})) put(path.join(opts.cwd, dir, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep, version: '1.0.0' }), { owner: opts.as });
        }
        return { code: 0, stdout: 'Done', stderr: '' };
    }

    // ── tar (backup/drill of a content-addressed object directory) ──
    // The forms the backup and drill use: `tar -czf <dest> -C <dir> .`, `tar -tvzf <archive>` (the
    // drill's member pre-check) and `tar -xzf <archive> -C <dir>`. The archive is a real gzipped tar
    // (lib/tar.js), so it survives the off-host encrypt/decrypt pipeline byte for byte.
    function tarCmd(args, opts) {
        const result = tarCmdReal(args, opts);
        // A test can override the result (to simulate a warning or a failure) after the real archive
        // was made, so --exclude and the archive's contents stay realistic.
        if (host.onTar) { const r = host.onTar(args, opts, result); if (r) return { stdout: '', stderr: '', ...r }; }
        return result;
    }
    function tarCmdReal(args, opts) {
        const mode = String(args[0] || '');
        const archive = args[1];
        const ci = args.indexOf('-C');
        const dir = ci >= 0 ? args[ci + 1] : '.';
        // `--exclude=PAT` (used for Host's transient <root>/tmp scratch): skip a member whose relative
        // name is the pattern or sits under it.
        const excludes = args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice(10).replace(/^\.\//, ''));
        const excluded = (name) => excludes.some((ex) => name === ex || name.startsWith(`${ex}/`));
        if (mode.includes('c')) {
            const target = args[args.length - 1];
            const base = resolveLinks(dir);
            const root = resolveLinks(path.join(dir, target));
            const entries = [];
            for (const [k, v] of files) {
                if (v.type !== 'file') continue;
                if (k !== root && !k.startsWith(`${root}/`)) continue;
                const name = path.relative(base, k);
                if (excluded(name)) continue;
                entries.push({ name, content: v.content });
            }
            put(archive, createTarGz(entries, clock), { owner: opts.as || user, mode: 0o600 });
            return { code: 0, stdout: '', stderr: '' };
        }
        if (mode.includes('t')) {
            const e = get(archive);
            if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: `tar: ${archive}: No such file or directory` };
            let parsed;
            try { parsed = readTarGz(Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content))); } catch (err) { return { code: 1, stdout: '', stderr: `tar: ${err.message}` }; }
            const lines = parsed.map((f) => `-rw-r--r-- ubuntu/ubuntu ${Buffer.byteLength(f.content)} 2026-09-22 12:00 ${f.name}`);
            for (const m of host.tarMembers) lines.push(`${m.type}rw-r--r-- root/root 0 2026-09-22 12:00 ${m.name}${m.target ? ` -> ${m.target}` : ''}`);
            return { code: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' };
        }
        if (mode.includes('x')) {
            const e = get(archive);
            if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: `tar: ${archive}: No such file or directory` };
            const destdir = resolveLinks(dir);
            let parsed;
            try { parsed = readTarGz(Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content))); } catch (err) { return { code: 1, stdout: '', stderr: `tar: ${err.message}` }; }
            for (const f of parsed) {
                const name = f.name.replace(/^\.\//, '');
                if (!name || name.split('/').includes('..')) continue;
                put(path.join(destdir, name), f.content, { owner: opts.as || 'root', mode: 0o644 });
            }
            return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `fake tar: unsupported ${args.join(' ')}` };
    }

    // ── systemd ──
    host.addUnit = (unit, state = {}) => {
        units.set(unit, { load: 'loaded', active: 'active', sub: 'running', mainPid: 1000 + units.size, fragmentPath: `/etc/systemd/system/${unit}`, dropIns: [], partOf: [], restarts: 0, runningSha: null, ...state });
        return units.get(unit);
    };
    function systemctlCmd(args) {
        const [action, unit] = args;
        const u = units.get(unit);
        switch (action) {
        case 'show': {
            if (!u) return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nFragmentPath=\n', stderr: '' };
            return { code: 0, stdout: [`LoadState=${u.load}`, `ActiveState=${u.active}`, `SubState=${u.sub}`, `MainPID=${u.active === 'active' ? u.mainPid : 0}`, `FragmentPath=${u.fragmentPath}`, `UnitFileState=enabled`, `DropInPaths=${u.dropIns.join(' ')}`, `PartOf=${u.partOf.join(' ')}`, `NRestarts=${u.restarts}`, `TimeoutStopUSec=${u.timeoutStop || '1min 30s'}`, `KillSignal=${u.killSignal || 15}`, `Type=${u.type || 'simple'}`].join('\n'), stderr: '' };
        }
        case 'restart':
            if (!u) return { code: 5, stdout: '', stderr: `Unit ${unit} not found.` };
            u.active = 'active'; u.sub = 'running'; u.restarts += 1;
            if (host.onRestart) host.onRestart(unit, u);
            return { code: 0, stdout: '', stderr: '' };
        case 'start':
            if (u) {
                const was = u.active;
                u.active = 'active'; u.sub = unit.endsWith('.socket') ? 'listening' : 'running';
                // A service that starts runs whatever its checkout holds now (like a restart).
                if (was !== 'active' && !unit.endsWith('.socket') && host.onRestart) host.onRestart(unit, u);
            }
            return { code: 0, stdout: '', stderr: '' };
        case 'stop': if (u) { u.active = 'inactive'; u.sub = 'dead'; } return { code: 0, stdout: '', stderr: '' };
        case 'reload': case 'daemon-reload': case 'enable': return { code: 0, stdout: '', stderr: '' };
        case 'list-unit-files': {
            const glob = args[args.length - 1];
            const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
            const rows = [...units.entries()].filter(([name, x]) => re.test(name) && !x.transient).map(([name]) => `${name} enabled enabled`);
            return { code: rows.length ? 0 : 1, stdout: rows.length ? `${rows.join('\n')}\n` : '', stderr: '' };
        }
        case 'is-active': return { code: u && u.active === 'active' ? 0 : 3, stdout: '', stderr: '' };
        case 'list-units': {
            // systemctl list-units --all --plain --no-legend --no-pager <glob>
            const glob = args[args.length - 1];
            const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
            const rows = [...units.entries()].filter(([name]) => re.test(name)).map(([name, x]) => `${name} ${x.load} ${x.active} ${x.sub} ${name}`);
            return { code: 0, stdout: rows.length ? `${rows.join('\n')}\n` : '', stderr: '' };
        }
        default: return { code: 1, stdout: '', stderr: `fake systemctl: ${action}` };
        }
    }

    // ── systemd-run (transient units: restore drills) ──
    function systemdRunCmd(args) {
        const spec = { unit: null, uid: null, cwd: null, props: [], argv: [], pid: null };
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '--') { spec.argv = args.slice(i + 1); break; }
            if (a === '--unit') spec.unit = args[++i];
            else if (a === '--description') i += 1;
            else if (a === '-p') spec.props.push(args[++i]);
            else if (a.startsWith('--uid=')) spec.uid = a.slice(6);
            else if (a.startsWith('--working-directory=')) spec.cwd = a.slice(20);
        }
        spec.envFiles = spec.props.filter((p) => p.startsWith('EnvironmentFile=')).map((p) => p.slice(16));
        spec.pid = host.nextPid++;
        host.systemdRuns.push(spec);
        const r = host.onSystemdRun ? host.onSystemdRun(spec) : undefined;
        if (r && r.code) return { stdout: '', stderr: '', ...r };
        if (!(r && r.exitedAtStart)) alivePids.add(spec.pid);
        host.addUnit(spec.unit, { mainPid: spec.pid, active: r && r.exitedAtStart ? 'failed' : 'active', transient: true });
        return { code: 0, stdout: '', stderr: '' };
    }

    host.socketViolations = () => calls.filter((c) => c.cmd === 'systemctl' && ['stop', 'restart', 'kill', 'try-restart', 'reload-or-restart', 'disable', 'mask'].includes(c.args[0]) && String(c.args[1]).endsWith('.socket'));
    host.restarts = () => calls.filter((c) => c.cmd === 'systemctl' && c.args[0] === 'restart').map((c) => c.args[1]);

    const exec = {
        kind: 'fake',
        async run(cmd, args = [], opts = {}) {
            calls.push({ cmd, args, as: opts.as || null, privileged: !!opts.privileged, cwd: opts.cwd || null });
            switch (cmd) {
            case 'git': return gitCmd(args, opts);
            case 'npm': return npmCmd(args, opts);
            case 'pnpm': return pnpmCmd(args, opts);
            case 'systemctl': return systemctlCmd(args);
            case 'nginx': return { stdout: '', ...host.nginxTest() };
            case 'rm': rmTree(args[args.length - 1]); return { code: 0, stdout: '', stderr: '' };
            case 'cat': {
                // Reads as opts.as: another user's file needs the world-read bit.
                const e = get(args[args.length - 1]);
                if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: 'cat: No such file or directory' };
                if (opts.as && opts.as !== 'root' && e.owner !== opts.as && !(e.mode & 0o004)) return { code: 1, stdout: '', stderr: 'cat: Permission denied' };
                return { code: 0, stdout: String(e.content), stderr: '' };
            }
            case 'install': {
                const src = args[args.length - 2];
                const dest = args[args.length - 1];
                const o = args.indexOf('-o');
                const m = args.indexOf('-m');
                const e = get(src);
                if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: `install: cannot stat '${src}': No such file or directory` };
                put(dest, e.content, { owner: o >= 0 ? args[o + 1] : 'root', mode: m >= 0 ? parseInt(args[m + 1], 8) : 0o755 });
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'chown': {
                const target = resolveLinks(args[args.length - 1]);
                const e = files.get(target);
                if (!e) return { code: 1, stdout: '', stderr: 'chown: no such file' };
                const whoRaw = args.filter((a) => !a.startsWith('-'))[0].split(':')[0];
                const who = whoRaw === '0' ? 'root' : whoRaw;
                if (args.includes('-R')) { for (const [k, v] of files) if (k === target || k.startsWith(`${target}/`)) v.owner = who; } else e.owner = who;
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'chmod': {
                const e = files.get(path.resolve(args[args.length - 1]));
                if (!e) return { code: 1, stdout: '', stderr: 'chmod: no such file' };
                e.mode = parseInt(args.filter((a) => !a.startsWith('-'))[0], 8);
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'mv': {
                const src = lpath(args[args.length - 2]);
                const dest = lpath(args[args.length - 1]);
                const force = args.slice(0, -2).some((a) => /^-[A-Za-z]*f/.test(a));
                if (!files.has(src)) return { code: 1, stdout: '', stderr: `mv: cannot stat '${src}'` };
                // mv -T -f over a symlink (or a file) replaces it in one rename: an atomic switch.
                if (files.has(dest) && force && files.get(dest).type !== 'dir') files.delete(dest);
                if (files.has(dest)) return { code: 1, stdout: '', stderr: `mv: '${dest}' exists` };
                ensureDir(path.dirname(dest));
                for (const k of [...files.keys()]) {
                    if (k !== src && !k.startsWith(`${src}/`)) continue;
                    files.set(dest + k.slice(src.length), files.get(k));
                    files.delete(k);
                }
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'node': {
                const r = host.onNode ? host.onNode(args, opts) : undefined;
                return r ? { stdout: '', stderr: '', ...r } : { code: 0, stdout: '', stderr: '' };
            }
            case 'du': {
                const target = args[args.length - 1];
                const root = resolveLinks(target);
                if (!files.has(root)) return { code: 1, stdout: '', stderr: `du: cannot access '${target}': No such file or directory` };
                let total = 0;
                for (const [k, v] of files) {
                    if (k !== root && !k.startsWith(`${root}/`)) continue;
                    total += v.type === 'file' ? Buffer.byteLength(Buffer.isBuffer(v.content) ? v.content : String(v.content)) : 4096;
                }
                return { code: 0, stdout: `${total}\t${target}\n`, stderr: '' };
            }
            case 'certbot': {
                host.certbotCalls.push({ args, as: opts.as || null, privileged: !!opts.privileged });
                const r = host.certbot ? host.certbot(args, opts) : undefined;
                if (r instanceof Error) return { code: 1, stdout: '', stderr: r.message };
                return { code: 0, stdout: 'Certificate not yet due for renewal; no action taken.', stderr: '', ...(r || {}) };
            }
            case 'journalctl': {
                host.journalctlCalls.push({ args, as: opts.as || null, privileged: !!opts.privileged });
                const r = host.journalctl ? host.journalctl(args, opts) : undefined;
                return { code: 0, stdout: '', stderr: '', ...(r || {}) };
            }
            case 'fuser': return { code: (host.openFiles || new Set()).has(path.resolve(args[args.length - 1])) ? 0 : 1, stdout: '', stderr: '' };
            // ── PostgreSQL tools (lib/dbengine.js runs each of these as the postgres OS user) ──
            case 'psql': {
                // Admin SQL on stdin (CREATE ROLE … LOGIN PASSWORD …, DROP ROLE …). Queries never come
                // this way: they go through exec.psql(). The password stays out of argv, as in life.
                const sql = String(opts.input || '');
                host.adminSql.push(sql);
                const create = /CREATE ROLE "([^"]+)" LOGIN PASSWORD '([^']*)'/.exec(sql);
                if (create) host.pgRoles.set(create[1], { password: create[2] });
                const drop = /DROP ROLE IF EXISTS "([^"]+)"/.exec(sql);
                if (drop) host.pgRoles.delete(drop[1]);
                if (host.onAdminSql) { const r = host.onAdminSql(sql, opts); if (r) return { stdout: '', stderr: '', ...r }; }
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'createdb': {
                const name = args[args.length - 1];
                const owner = (args.find((a) => a.startsWith('--owner=')) || '').slice(8) || null;
                if (host.pgDatabases.has(name)) return { code: 1, stdout: '', stderr: `createdb: error: database creation failed: ERROR:  database "${name}" already exists` };
                host.pgDatabases.add(name);
                host.createdDatabases.push({ name, owner, as: opts.as || null });
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'dropdb': {
                const name = args[args.length - 1];
                host.pgDatabases.delete(name);
                host.droppedDatabases.push({ name, as: opts.as || null });
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'pg_dump': {
                const dest = args[args.indexOf('-f') + 1];
                const database = args[args.indexOf('-d') + 1];
                if (!host.pgDatabases.has(database)) return { code: 1, stdout: '', stderr: `pg_dump: error: connection to server failed: FATAL:  database "${database}" does not exist` };
                const parent = files.get(path.dirname(path.resolve(dest)));
                if ((opts.as || 'root') !== 'root' && parent && parent.owner !== (opts.as || 'root')) return { code: 1, stdout: '', stderr: `pg_dump: error: could not open output file "${dest}": Permission denied` };
                host.dumps.push({ database, dest, as: opts.as || null });
                put(dest, host.dumpContent ? host.dumpContent(database) : `pg_dump -Fc of ${database}`, { owner: opts.as || 'root', mode: 0o600 });
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'pg_restore': {
                if (args.includes('--list')) {
                    const e = get(args[args.length - 1]);
                    if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: `pg_restore: error: could not open input file "${args[args.length - 1]}"` };
                    // A text dump is what pg_restore refuses; the fake's archives all start with its marker.
                    if (!String(e.content).startsWith('pg_dump -Fc')) return { code: 1, stdout: '', stderr: 'pg_restore: error: input file appears to be a text format dump. Please use psql.' };
                    return { code: 0, stdout: ';\n; Archive created at 2026-09-28 03:30:00 UTC\n', stderr: '' };
                }
                const database = args[args.indexOf('-d') + 1];
                const file = args[args.length - 1];
                const role = (args.find((a) => a.startsWith('--role=')) || '').slice(7) || null;
                if (!host.pgDatabases.has(database)) return { code: 1, stdout: '', stderr: `pg_restore: error: connection to server failed: database "${database}" does not exist` };
                if (!get(file)) return { code: 1, stdout: '', stderr: `pg_restore: error: could not open input file "${file}"` };
                if (role && !host.pgRoles.has(role)) return { code: 1, stdout: '', stderr: `pg_restore: error: role "${role}" does not exist` };
                host.restores.push({ database, role, file, as: opts.as || null });
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'pgbackrest': {
                if (!args.includes('info')) return { code: 1, stdout: '', stderr: `fake pgbackrest: ${args.join(' ')}` };
                if (host.pgbackrestCode !== 0) return { code: host.pgbackrestCode, stdout: '', stderr: host.pgbackrestStderr || 'pgbackrest: error' };
                const stanzas = host.pgbackrestStanzas ? host.pgbackrestStanzas() : [{ name: 'openvibe', status: host.pgStanzaStatus, backup: host.pgBackups }];
                return { code: 0, stdout: `${JSON.stringify(stanzas)}\n`, stderr: '' };
            }
            case 'systemd-run': return systemdRunCmd(args);
            case 'tar': return tarCmd(args, opts);
            case 'cp': {
                const src = args[args.length - 2];
                const dest = args[args.length - 1];
                if (args.some((a) => /^-[A-Za-z]*a/.test(a))) {
                    if (files.has(lpath(dest))) return { code: 1, stdout: '', stderr: `cp: '${dest}' exists` };
                    return copyTree(src, dest, opts.as || user) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: `cp: cannot stat '${src}'` };
                }
                const e = get(src);
                if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: `cp: cannot stat '${src}': No such file or directory` };
                put(dest, e.content, { owner: args.includes('-p') ? e.owner : opts.as || user, mode: args.includes('-p') ? e.mode : 0o644 });
                return { code: 0, stdout: '', stderr: '' };
            }
            default: return { code: 127, stdout: '', stderr: `fake host: no ${cmd}` };
            }
        },
        async readFile(p) { host.reads.push(path.resolve(p)); const e = get(p); return e && e.type === 'file' ? (Buffer.isBuffer(e.content) ? e.content.toString('utf8') : String(e.content)) : null; },
        async writeFile(p, content, { mode = 0o644 } = {}) { put(p, content, { mode, owner: user }); },
        readStream(p) {
            const e = get(p);
            if (!e || e.type !== 'file') {
                const r = new Readable({ read() {} });
                process.nextTick(() => r.destroy(Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' })));
                return r;
            }
            host.reads.push(path.resolve(p));
            const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content));
            // Small pieces, so chunking and part boundaries are exercised.
            const pieces = [];
            for (let i = 0; i < buf.length; i += host.streamPiece) pieces.push(buf.subarray(i, i + host.streamPiece));
            return Readable.from(pieces);
        },
        writeStream(p, { mode = 0o600 } = {}) {
            if (files.has(path.resolve(p))) throw Object.assign(new Error(`EEXIST: file already exists, open '${p}'`), { code: 'EEXIST' });
            const parts = [];
            put(p, Buffer.alloc(0), { mode, owner: user });
            return new Writable({
                write(chunk, _enc, cb) { parts.push(Buffer.from(chunk)); cb(); },
                final(cb) { put(p, Buffer.concat(parts), { mode, owner: user }); cb(); },
            });
        },
        async appendFile(p, text) { const prev = host.read(p) || ''; put(p, prev + text, { mode: 0o640, owner: user }); },
        async removeFile(p) { files.delete(lpath(p)); },
        async symlink(target, p) {
            if (files.has(lpath(p))) throw Object.assign(new Error(`EEXIST: file already exists, symlink '${target}' -> '${p}'`), { code: 'EEXIST' });
            ensureDir(path.dirname(p)); files.set(lpath(p), { type: 'symlink', target, owner: user, mode: 0o777, mtime: clock });
        },
        async readlink(p) { const e = files.get(lpath(p)); return e && e.type === 'symlink' ? e.target : null; },
        async stat(p) {
            const l = files.get(lpath(p));
            const e = get(p);
            if (!e) return null;
            const size = e.type === 'file' ? Buffer.byteLength(Buffer.isBuffer(e.content) ? e.content : String(e.content)) : 4096;
            return { mode: e.mode, uid: e.owner === 'root' ? 0 : 1000, gid: 0, owner: e.owner, isFile: e.type === 'file', isDir: e.type === 'dir', isSymlink: !!l && l.type === 'symlink', size, nlink: e.nlink || 1, mtime: e.mtime || 0 };
        },
        async readdir(p) {
            const abs = resolveLinks(p);
            const e = files.get(abs);
            if (!e || e.type !== 'dir') return null;
            const out = new Map();
            for (const [k, v] of files) {
                if (!k.startsWith(`${abs}/`)) continue;
                const name = k.slice(abs.length + 1).split('/')[0];
                if (!out.has(name)) out.set(name, { name, isDir: k === `${abs}/${name}` ? v.type === 'dir' : true });
            }
            return [...out.values()];
        },
        async mkdir(p, { owner, mode = 0o750 } = {}) { ensureDir(p, owner || user, mode); const e = files.get(resolveLinks(p)); e.owner = owner || e.owner; e.mode = mode; },
        async createExclusive(p, content) { if (files.has(lpath(p))) return false; put(p, content, { mode: 0o640, owner: user }); return true; },
        async pidAlive(pid) { return alivePids.has(pid); },
        async http(url, { headers = {} } = {}) {
            calls.push({ cmd: 'curl', args: [url], as: null, privileged: false, cwd: null });
            const h = http.get(url);
            if (!h) return { status: 0, error: 'ECONNREFUSED' };
            const r = h({ headers });
            return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {}) };
        },
        async request(url, { method = 'GET', headers = {}, body = null } = {}) {
            calls.push({ cmd: 'curl', args: ['-X', method, url], as: null, privileged: false, cwd: null });
            const h = http.get(url);
            if (!h) return { status: 0, error: 'ECONNREFUSED' };
            const r = h({ method, headers, body });
            if (r && r.error) return { status: 0, error: r.error };
            return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {}) };
        },
        /** Queries only, as the postgres OS user: the engine defaults answer `datname`/archiver asks. */
        async psql(database, sql, { as = 'postgres' } = {}) {
            host.psqlCalls.push({ database, sql, as });
            calls.push({ cmd: 'psql', args: [database, sql], as, privileged: false, cwd: null });
            if (host.psqlHandler) { const r = host.psqlHandler(database, sql, as); if (r !== undefined) return r; }
            const left = /FROM (pg_database|pg_roles) WHERE left\((?:datname|rolname), length\('([^']*)'\)\)/.exec(sql);
            if (left) return [...(left[1] === 'pg_database' ? host.pgDatabases : host.pgRoles.keys())].filter((n) => n.startsWith(left[2])).map((name) => ({ name }));
            const named = /datname = '([^']*)'/.exec(sql);
            if (/pg_database/i.test(sql) && named) return host.pgDatabases.has(named[1]) ? [{ present: '1' }] : [];
            if (/pg_stat_archiver/i.test(sql)) return [{ n: String(host.pgArchiver.failed_count) }];
            return [{ n: 0 }];
        },
        async statfs(p) {
            // The real statfs() runs on an existing path only: a missing path is an ENOENT, not a
            // free-space figure. Mirror that so a space check before the directory exists is caught.
            if (!get(p)) { const err = new Error(`ENOENT: no such file or directory, statfs '${p}'`); err.code = 'ENOENT'; throw err; }
            return { free: host.statfsFree, size: host.statfsSize };
        },
        async sqlite(db, sql, { as } = {}) {
            host.sqliteCalls.push({ op: 'query', db, sql, as });
            calls.push({ cmd: 'sqlite', args: [db, sql], as: as || null, privileged: false, cwd: null });
            return host.sqliteHandler(db, sql, as);
        },
        async sqliteBackup(db, dest, { as } = {}) {
            host.sqliteCalls.push({ op: 'backup', db, dest, as });
            calls.push({ cmd: 'sqlite-backup', args: [db, dest], as: as || null, privileged: false, cwd: null });
            if (files.has(path.resolve(dest))) throw new Error(`refusing to overwrite ${dest}`);
            const parent = files.get(path.dirname(path.resolve(dest)));
            if (as && parent && parent.owner !== as) throw new Error(`cannot open ${dest}: permission denied (directory owned by ${parent.owner}, worker runs as ${as})`);
            if (host.onSqliteBackup) { const r = host.onSqliteBackup(db, dest, as); if (r instanceof Error) throw r; }
            put(dest, host.backupContent ? host.backupContent(db) : `backup of ${db}`, { owner: as || user, mode: 0o600 });
        },
        async listeners(port) { return listeners.get(port) || []; },
        async kill(pid, signal = 'SIGTERM') {
            calls.push({ cmd: 'kill', args: [signal, pid], as: null, privileged: true, cwd: null });
            if (!alivePids.has(pid)) return false;
            if (host.onKill && host.onKill(pid, signal) === false) return true;
            alivePids.delete(pid);
            for (const u of units.values()) if (u.mainPid === pid) { u.active = 'inactive'; u.sub = 'dead'; }
            for (const [port, list] of listeners) {
                const rest = list.filter((l) => l.pid !== pid);
                if (rest.length) listeners.set(port, rest); else listeners.delete(port);
            }
            return true;
        },
        async sleep(ms) { clock += ms; },
        now: () => clock,
        async isRoot() { return root; },
        async userName() { return user; },
        async hostname() { return hostname; },
    };
    host.exec = exec;
    host.advance = (ms) => { clock += ms; };
    return host;
}

module.exports = { createFakeHost };
