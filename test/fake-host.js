'use strict';
/**
 * A fake host implementing the executor interface (lib/executor.js) in memory: a filesystem, git
 * repositories, systemd units, npm, nginx, ss, HTTP endpoints and SQLite. Nothing here touches the
 * real machine. Every run() call is recorded in `calls` so tests can assert what would have been
 * executed (and as whom).
 */
const crypto = require('crypto');
const path = require('path');
const { Readable, Writable } = require('stream');

function createFakeHost({ root = true, user = 'root', hostname = 'fake-host', start = Date.parse('2026-09-22T12:00:00Z') } = {}) {
    const files = new Map(); // path -> { type: 'file'|'dir'|'symlink', content, mode, owner, target }
    const calls = [];
    const repos = new Map(); // repoPath -> repo
    const units = new Map(); // unit -> state
    const http = new Map(); // url -> fn({ headers }) -> { status, body }
    const alivePids = new Set();
    const listeners = new Map(); // port -> [{ pid, process }]
    let clock = start;
    let seq = 0;
    const host = {
        files, calls, repos, units, http, alivePids, listeners,
        nginxTest: () => ({ code: 0, stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' }),
        npm: null, // (cwd, argv, as) -> undefined | { code, stderr } ; default installs package.json deps
        npmRewritesLockfile: true,
        sqliteHandler: () => [{ n: 0 }],
        sqliteCalls: [],
        reads: [],
        onRestart: null, // (unit) -> void
        onSystemdRun: null, // (spec) -> undefined | { code, stderr } ; spec = { unit, uid, cwd, props, argv, pid }
        onKill: null, // (pid, signal) -> false to ignore the signal
        systemdRuns: [],
        nextPid: 40000,
        streamPiece: 4096, // readStream() yields files in pieces of this size
    };

    // ── filesystem ──
    function ensureDir(p, owner = 'root', mode = 0o755) {
        const parts = path.resolve(p).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur += `/${part}`;
            if (!files.has(cur)) files.set(cur, { type: 'dir', mode, owner });
        }
    }
    function put(p, content, { mode = 0o644, owner = 'root' } = {}) {
        ensureDir(path.dirname(p), owner);
        files.set(path.resolve(p), { type: 'file', content, mode, owner });
    }
    function get(p) {
        let e = files.get(path.resolve(p));
        let hops = 0;
        while (e && e.type === 'symlink' && hops++ < 10) e = files.get(path.resolve(path.dirname(p), e.target));
        return e || null;
    }
    function rmTree(p) {
        const abs = path.resolve(p);
        for (const k of [...files.keys()]) if (k === abs || k.startsWith(`${abs}/`)) files.delete(k);
    }
    host.put = put;
    host.read = (p) => { const e = get(p); return e && e.type === 'file' ? String(e.content) : null; };
    host.ensureDir = ensureDir;

    // ── git ──
    function newSha(seed) { seq += 1; return crypto.createHash('sha1').update(`${seq}:${seed}`).digest('hex'); }
    host.createRepo = (repoPath, { owner = 'ubuntu', branch = 'main', remote = 'origin' } = {}) => {
        const repo = { path: repoPath, owner, branch, remote, commits: new Map(), head: null, remoteRefs: {} };
        repos.set(repoPath, repo);
        ensureDir(repoPath, owner);
        files.get(path.resolve(repoPath)).owner = owner;
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
    function isAncestor(repo, anc, sha) {
        let cur = sha;
        while (cur) { if (cur === anc) return true; cur = repo.commits.get(cur).parent; }
        return false;
    }
    function resolveRef(repo, ref) {
        const r = ref.replace(/\^\{commit\}$/, '');
        if (r === 'HEAD') return repo.head;
        if (repo.remoteRefs[r]) return repo.remoteRefs[r];
        if (repo.commits.has(r)) return r;
        const matches = [...repo.commits.keys()].filter((k) => k.startsWith(r));
        return matches.length === 1 ? matches[0] : null;
    }
    function gitCmd(args, opts) {
        const repo = repos.get(args[1]);
        if (!repo) return { code: 128, stdout: '', stderr: 'not a git repository' };
        if (opts.as !== repo.owner) return { code: 128, stdout: '', stderr: `fatal: detected dubious ownership in repository at '${repo.path}' (ran as ${opts.as || 'root'})` };
        const [sub, ...rest] = args.slice(2);
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        const fail = (stderr) => ({ code: 1, stdout: '', stderr });
        switch (sub) {
        case 'rev-parse':
            if (rest[0] === '--abbrev-ref') return ok(`${repo.branch}\n`);
            if (rest[0] === '--verify') { const s = resolveRef(repo, rest[1]); return s ? ok(`${s}\n`) : fail(`fatal: Needed a single revision (${rest[1]})`); }
            return ok(`${resolveRef(repo, rest[0])}\n`);
        case 'cat-file': return resolveRef(repo, rest[1]) ? ok() : fail('bad object');
        case 'status': {
            const head = repo.commits.get(repo.head).files;
            const dirty = Object.entries(head).filter(([f, c]) => host.read(path.join(repo.path, f)) !== c).map(([f]) => ` M ${f}`);
            return ok(dirty.length ? `${dirty.join('\n')}\n` : '');
        }
        case 'fetch': return ok();
        case 'diff': {
            const a = repo.commits.get(resolveRef(repo, rest[1])).files;
            const b = repo.commits.get(resolveRef(repo, rest[2])).files;
            const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
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
        case 'merge': {
            const sha = resolveRef(repo, rest[rest.length - 1]);
            if (!isAncestor(repo, repo.head, sha)) return fail('fatal: Not possible to fast-forward, aborting.');
            repo.checkout(sha);
            return ok();
        }
        case 'reset': repo.checkout(resolveRef(repo, rest[rest.length - 1])); return ok();
        case 'checkout': {
            const f = rest[rest.length - 1];
            put(path.join(repo.path, f), repo.commits.get(repo.head).files[f], { owner: repo.owner });
            return ok();
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
            return { code: 0, stdout: [`LoadState=${u.load}`, `ActiveState=${u.active}`, `SubState=${u.sub}`, `MainPID=${u.active === 'active' ? u.mainPid : 0}`, `FragmentPath=${u.fragmentPath}`, `UnitFileState=enabled`, `DropInPaths=${u.dropIns.join(' ')}`, `PartOf=${u.partOf.join(' ')}`, `NRestarts=${u.restarts}`].join('\n'), stderr: '' };
        }
        case 'restart':
            if (!u) return { code: 5, stdout: '', stderr: `Unit ${unit} not found.` };
            u.active = 'active'; u.sub = 'running'; u.restarts += 1;
            if (host.onRestart) host.onRestart(unit, u);
            return { code: 0, stdout: '', stderr: '' };
        case 'start': if (u) { u.active = 'active'; u.sub = unit.endsWith('.socket') ? 'listening' : 'running'; } return { code: 0, stdout: '', stderr: '' };
        case 'stop': if (u) { u.active = 'inactive'; u.sub = 'dead'; } return { code: 0, stdout: '', stderr: '' };
        case 'reload': case 'daemon-reload': return { code: 0, stdout: '', stderr: '' };
        case 'is-active': return { code: u && u.active === 'active' ? 0 : 3, stdout: '', stderr: '' };
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
            case 'systemctl': return systemctlCmd(args);
            case 'nginx': return { stdout: '', ...host.nginxTest() };
            case 'rm': rmTree(args[args.length - 1]); return { code: 0, stdout: '', stderr: '' };
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
                const e = files.get(path.resolve(args[args.length - 1]));
                if (!e) return { code: 1, stdout: '', stderr: 'chown: no such file' };
                e.owner = args.filter((a) => !a.startsWith('-'))[0].split(':')[0];
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'chmod': {
                const e = files.get(path.resolve(args[args.length - 1]));
                if (!e) return { code: 1, stdout: '', stderr: 'chmod: no such file' };
                e.mode = parseInt(args.filter((a) => !a.startsWith('-'))[0], 8);
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'mv': {
                const src = path.resolve(args[args.length - 2]);
                const dest = path.resolve(args[args.length - 1]);
                if (!files.has(src)) return { code: 1, stdout: '', stderr: `mv: cannot stat '${src}'` };
                if (files.has(dest)) return { code: 1, stdout: '', stderr: `mv: '${dest}' exists` };
                ensureDir(path.dirname(dest));
                for (const k of [...files.keys()]) {
                    if (k !== src && !k.startsWith(`${src}/`)) continue;
                    files.set(dest + k.slice(src.length), files.get(k));
                    files.delete(k);
                }
                return { code: 0, stdout: '', stderr: '' };
            }
            case 'node': return { code: 0, stdout: '', stderr: '' };
            case 'systemd-run': return systemdRunCmd(args);
            case 'cp': {
                const src = args[args.length - 2];
                const dest = args[args.length - 1];
                const e = get(src);
                if (!e || e.type !== 'file') return { code: 1, stdout: '', stderr: `cp: cannot stat '${src}': No such file or directory` };
                put(dest, e.content, { owner: opts.as || user, mode: 0o644 });
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
        async removeFile(p) { files.delete(path.resolve(p)); },
        async symlink(target, p) { ensureDir(path.dirname(p)); files.set(path.resolve(p), { type: 'symlink', target, owner: user, mode: 0o777 }); },
        async readlink(p) { const e = files.get(path.resolve(p)); return e && e.type === 'symlink' ? e.target : null; },
        async stat(p) {
            const l = files.get(path.resolve(p));
            const e = get(p);
            if (!e) return null;
            const size = e.type === 'file' ? Buffer.byteLength(Buffer.isBuffer(e.content) ? e.content : String(e.content)) : 4096;
            return { mode: e.mode, uid: e.owner === 'root' ? 0 : 1000, gid: 0, owner: e.owner, isFile: e.type === 'file', isDir: e.type === 'dir', isSymlink: !!l && l.type === 'symlink', size, nlink: e.nlink || 1 };
        },
        async readdir(p) {
            const abs = path.resolve(p);
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
        async mkdir(p, { owner, mode = 0o750 } = {}) { ensureDir(p, owner || user, mode); const e = files.get(path.resolve(p)); e.owner = owner || e.owner; e.mode = mode; },
        async createExclusive(p, content) { if (files.has(path.resolve(p))) return false; put(p, content, { mode: 0o640, owner: user }); return true; },
        async pidAlive(pid) { return alivePids.has(pid); },
        async http(url, { headers = {} } = {}) {
            calls.push({ cmd: 'curl', args: [url], as: null, privileged: false, cwd: null });
            const h = http.get(url);
            if (!h) return { status: 0, error: 'ECONNREFUSED' };
            const r = h({ headers });
            return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {}) };
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
