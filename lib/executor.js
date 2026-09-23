'use strict';
/**
 * The system executor: the ONLY module in ovhost that touches the machine (processes, files, HTTP,
 * SQLite). Every command and library function takes an executor, so the tests swap this for the
 * fake host in test/fake-host.js and nothing in the suite ever runs systemctl, git, npm or curl.
 *
 * Interface (all async):
 *   run(cmd, args, { as, privileged, cwd, timeoutMs, input }) -> { code, stdout, stderr }
 *       as          run as this user (git/npm as the checkout owner, sqlite as the service user);
 *                   root uses runuser with the user's HOME, the same user runs directly, anyone else
 *                   goes through `sudo -n -H -u`.
 *       privileged  run as root (systemctl, nginx -t, reading 0600 env files); `sudo -n` unless root.
 *   readFile(path, { privileged }) -> string | null
 *   writeFile(path, content, { privileged, mode }) ; appendFile(path, text) ; removeFile(path, { privileged })
 *   symlink(target, path, { privileged }) ; readlink(path) -> string | null
 *   stat(path) -> { mode, uid, gid, owner, isFile, isDir, isSymlink, size } | null
 *   readdir(path) -> [{ name, isDir }] | null
 *   mkdir(path, { owner, mode }) ; createExclusive(path, content) -> bool ; pidAlive(pid) -> bool
 *   http(url, { timeoutMs, headers }) -> { status, body } | { status: 0, error }
 *   sqlite(db, sql, { as }) -> rows ; sqliteBackup(db, dest, { as })
 *   listeners(port) -> [{ pid, process }]
 *   sleep(ms) ; now() -> ms ; isRoot() ; userName() ; hostname()
 */
const { spawn } = require('child_process');
const fs = require('fs');
const httpLib = require('http');
const os = require('os');
const path = require('path');

const WORKER = path.join(__dirname, 'sqlite-worker.js');

function passwdEntry(user) {
    try {
        for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
            const f = line.split(':');
            if (f[0] === user) return { name: f[0], uid: Number(f[2]), gid: Number(f[3]), home: f[5] };
        }
    } catch { /* no passwd file: callers fall back */ }
    return null;
}

function userById(uid) {
    try {
        for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
            const f = line.split(':');
            if (Number(f[2]) === uid) return f[0];
        }
    } catch { /* ignore */ }
    return String(uid);
}

function createSystemExecutor({ env = process.env } = {}) {
    const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
    const me = () => { try { return os.userInfo().username; } catch { return env.USER || 'unknown'; } };

    function wrap(cmd, args, { as, privileged } = {}) {
        if (as && as !== me()) {
            if (isRoot()) {
                const pw = passwdEntry(as);
                const home = pw ? pw.home : `/home/${as}`;
                return ['runuser', ['-u', as, '--', 'env', `HOME=${home}`, `PATH=${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`, cmd, ...args]];
            }
            return ['sudo', ['-n', '-H', '-u', as, '--', cmd, ...args]];
        }
        if (privileged && !isRoot()) return ['sudo', ['-n', '--', cmd, ...args]];
        return [cmd, args];
    }

    function run(cmd, args = [], opts = {}) {
        const [c, a] = wrap(cmd, args, opts);
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let child;
            try {
                // A process started as another user from root's cwd (/root) cannot read its own cwd, and
                // git refuses to start; give it / unless the caller chose a directory.
                child = spawn(c, a, { cwd: opts.cwd || (opts.as ? '/' : undefined), env: { ...env, ...(opts.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (err) {
                resolve({ code: 127, stdout: '', stderr: err.message });
                return;
            }
            const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', (err) => { stderr += err.message; });
            child.on('close', (code) => {
                if (timer) clearTimeout(timer);
                resolve({ code: code === null ? 124 : code, stdout, stderr });
            });
            if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
        });
    }

    async function readFile(p, { privileged } = {}) {
        try {
            return fs.readFileSync(p, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            if (err.code === 'EACCES' && privileged && !isRoot()) {
                const r = await run('cat', ['--', p], { privileged: true });
                return r.code === 0 ? r.stdout : null;
            }
            throw err;
        }
    }

    async function writeFile(p, content, { privileged, mode = 0o644 } = {}) {
        if (!privileged || isRoot()) {
            fs.writeFileSync(p, content, { mode });
            fs.chmodSync(p, mode);
            return;
        }
        const r = await run('install', ['-m', mode.toString(8), '/dev/stdin', p], { privileged: true, input: content });
        if (r.code !== 0) throw new Error(`could not write ${p}: ${r.stderr.trim()}`);
    }

    async function removeFile(p, { privileged } = {}) {
        if (!privileged || isRoot()) { fs.rmSync(p, { force: true }); return; }
        await run('rm', ['-f', '--', p], { privileged: true });
    }

    async function symlink(target, p, { privileged } = {}) {
        if (!privileged || isRoot()) { fs.symlinkSync(target, p); return; }
        const r = await run('ln', ['-s', target, p], { privileged: true });
        if (r.code !== 0) throw new Error(`could not link ${p}: ${r.stderr.trim()}`);
    }

    async function readlink(p) { try { return fs.readlinkSync(p); } catch { return null; } }

    async function stat(p) {
        try {
            const l = fs.lstatSync(p);
            const s = l.isSymbolicLink() ? fs.statSync(p) : l;
            return { mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, owner: userById(s.uid), isFile: s.isFile(), isDir: s.isDirectory(), isSymlink: l.isSymbolicLink(), size: s.size };
        } catch { return null; }
    }

    async function readdir(p) {
        try { return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() })); } catch { return null; }
    }

    async function mkdir(p, { owner, mode = 0o750 } = {}) {
        fs.mkdirSync(p, { recursive: true, mode });
        if (owner && isRoot()) {
            const pw = passwdEntry(owner);
            if (pw) fs.chownSync(p, pw.uid, pw.gid);
        }
    }

    async function appendFile(p, text) {
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o750 });
        fs.appendFileSync(p, text, { mode: 0o640 });
    }

    async function createExclusive(p, content) {
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o750 });
        try { fs.writeFileSync(p, content, { flag: 'wx', mode: 0o640 }); return true; } catch (err) { if (err.code === 'EEXIST') return false; throw err; }
    }

    function pidAlive(pid) {
        try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
    }

    // node:http rather than fetch: fetch silently drops a Host header, and the Tools gateway only
    // answers its health check for Host: openvibe.tools. Probes are loopback http:// only.
    function http(url, { timeoutMs = 5000, headers = {} } = {}) {
        return new Promise((resolve) => {
            let req;
            const timer = setTimeout(() => { if (req) req.destroy(); resolve({ status: 0, error: 'timeout' }); }, timeoutMs);
            try {
                req = httpLib.get(url, { headers }, (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', (c) => { if (body.length < 4 * 1024 * 1024) body += c; });
                    res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
                    res.on('error', (err) => { clearTimeout(timer); resolve({ status: 0, error: err.code || err.message }); });
                });
                req.on('error', (err) => { clearTimeout(timer); resolve({ status: 0, error: err.code || err.message }); });
            } catch (err) {
                clearTimeout(timer);
                resolve({ status: 0, error: err.message });
            }
        });
    }

    async function sqliteCall(payload, as) {
        const r = await run(process.execPath, [WORKER, JSON.stringify(payload)], { as, timeoutMs: 6 * 3600 * 1000 });
        let out;
        try { out = JSON.parse(r.stdout); } catch { throw new Error(`sqlite worker failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`); }
        if (!out.ok) throw new Error(out.error);
        return out;
    }

    async function listeners(port) {
        const r = await run('ss', ['-H', '-ltnp', `sport = :${port}`], { privileged: true });
        if (r.code !== 0) throw new Error(`ss failed: ${r.stderr.trim()}`);
        const out = [];
        for (const line of r.stdout.split('\n')) {
            if (!line.trim()) continue;
            const users = line.match(/users:\(\((.*)\)\)/);
            const procs = users ? [...users[1].matchAll(/"([^"]+)",pid=(\d+)/g)] : [];
            if (!procs.length) out.push({ pid: null, process: null });
            for (const m of procs) out.push({ pid: Number(m[2]), process: m[1] });
        }
        return out;
    }

    return {
        kind: 'system',
        run,
        readFile,
        writeFile,
        removeFile,
        symlink,
        readlink,
        stat,
        readdir,
        mkdir,
        appendFile,
        createExclusive,
        pidAlive: async (pid) => pidAlive(pid),
        http,
        sqlite: async (db, sql, { as } = {}) => (await sqliteCall({ op: 'query', db, sql }, as)).rows,
        sqliteBackup: async (db, dest, { as } = {}) => { await sqliteCall({ op: 'backup', db, dest }, as); },
        listeners,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        isRoot: async () => isRoot(),
        userName: async () => me(),
        hostname: async () => os.hostname(),
    };
}

module.exports = { createSystemExecutor };
