'use strict';
/**
 * Content-addressed object store for deploy files, one directory per project:
 *
 *   <root>/projects/<prj_…>/<aa>/<sha256>      the bytes (read-only files, 0644)
 *   <root>/tmp/                                 writes land here, then rename() into place
 *
 * Every path is built from a validated project id and a validated lowercase sha256 hex string, never
 * from a URL or an archive entry name, so no request can name a file outside its project's
 * directory. The same bytes uploaded by two projects are stored twice: storage is accounted and
 * deleted per project (ADR-014: tenancy keyed by project id).
 *
 * Stage B keeps objects on local disk. The roadmap prefers OpenVibe.Media "where practical"; that
 * adapter does not exist yet (see README).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isId } = require('./ids');

const SHA_RE = /^[0-9a-f]{64}$/;

function createBlobStore(root) {
    const base = path.resolve(root);
    const projectsDir = path.join(base, 'projects');
    const tmpDir = path.join(base, 'tmp');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    function projectDir(projectId) {
        if (!isId('project', projectId)) throw new TypeError('invalid project id');
        return path.join(projectsDir, projectId);
    }

    function pathFor(projectId, sha256) {
        if (!SHA_RE.test(String(sha256))) throw new TypeError('invalid sha256');
        return path.join(projectDir(projectId), sha256.slice(0, 2), sha256);
    }

    /** Store bytes whose sha256 the caller computed; verified again here. Idempotent. */
    function put(projectId, sha256, data) {
        const dest = pathFor(projectId, sha256);
        const actual = crypto.createHash('sha256').update(data).digest('hex');
        if (actual !== sha256) throw new Error('blob digest mismatch');
        try {
            const st = fs.statSync(dest);
            if (st.isFile() && st.size === data.length) return false;
        } catch { /* not there yet */ }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = path.join(tmpDir, `${crypto.randomBytes(12).toString('hex')}.part`);
        const fd = fs.openSync(tmp, 'wx', 0o644);
        try {
            fs.writeSync(fd, data);
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, dest);
        return true;
    }

    function exists(projectId, sha256) {
        try { return fs.statSync(pathFor(projectId, sha256)).isFile(); } catch { return false; }
    }

    function remove(projectId, sha256) {
        try { fs.unlinkSync(pathFor(projectId, sha256)); return true; } catch { return false; }
    }

    function removeProject(projectId) {
        fs.rmSync(projectDir(projectId), { recursive: true, force: true });
    }

    /** Every (project, sha) on disk: for the orphan sweep. */
    function* list() {
        let projects = [];
        try { projects = fs.readdirSync(projectsDir); } catch { return; }
        for (const p of projects) {
            if (!isId('project', p)) continue;
            let shards = [];
            try { shards = fs.readdirSync(path.join(projectsDir, p)); } catch { continue; }
            for (const s of shards) {
                let files = [];
                try { files = fs.readdirSync(path.join(projectsDir, p, s)); } catch { continue; }
                for (const f of files) if (SHA_RE.test(f)) yield { projectId: p, sha256: f, file: path.join(projectsDir, p, s, f) };
            }
        }
    }

    /** Remove leftovers of interrupted writes. */
    function sweepTmp(olderThanMs = 3600 * 1000) {
        let n = 0;
        for (const f of fs.readdirSync(tmpDir)) {
            const p = path.join(tmpDir, f);
            try { if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) { fs.unlinkSync(p); n++; } } catch { /* gone */ }
        }
        return n;
    }

    function writable() {
        fs.accessSync(tmpDir, fs.constants.W_OK);
        fs.accessSync(projectsDir, fs.constants.W_OK);
        return true;
    }

    return { root: base, pathFor, put, exists, remove, removeProject, list, sweepTmp, writable };
}

module.exports = { createBlobStore, SHA_RE };
