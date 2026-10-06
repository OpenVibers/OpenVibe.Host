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
 * Two modes, selected by config (HOST_OBJECT_STORE):
 *
 *   local (default, and what an unset HOST_OBJECT_STORE gets) — the layout above, exactly as before.
 *   media — the same local layout is the READ cache, and every put is written through to
 *           OpenVibe.Media's Object API v2 (openvibe-sdk/media createObjectsClient) as a private
 *           object in Host's own namespace, keyed per project with the file's sha256 as content_hash.
 *           A deploy is not reported as stored until Media acknowledged the write; a Media failure
 *           rejects the put and the deploy fails, never a silent local-only success. ensure() serves
 *           the local cache and, on a miss, fetches the object back from Media, verifies its sha256
 *           and only then caches and serves it. Media objects are deleted only where the local store
 *           would delete the blob today (deploy GC, project removal, the worker's orphan sweep), so a
 *           Media object a remaining deploy still references is never deleted.
 *
 * Nothing in this module reaches the network on load: the Media client is built inside
 * createMediaStore(), only when the Media store is selected, and it fetches a token lazily.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isId } = require('./ids');

const SHA_RE = /^[0-9a-f]{64}$/;
// What Host's Network service principal must be granted for audience openvibe.media, in Host's own
// namespace (`host` / `host.*`). Media's v2 object API checks a verb per namespace: upload, read,
// list, delete. Media's older ids keep granting the newer verbs, but asking for each verb is exact.
const MEDIA_SCOPE = 'media.object.upload media.object.read media.object.list media.object.delete';
const MEDIA_AUDIENCE = 'openvibe.media';

const sha256Of = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A put/ensure/delete failure against Media, with a stable code. Never carries a secret. */
function mediaFailure(action, err) {
    const e = new Error(err && err.message ? `${action}: ${err.message}` : action);
    e.code = 'storage.media';
    if (err) e.cause = err;
    return e;
}

/** The local, content-addressed store. `ensure` is the synchronous read path (a cache hit is the file). */
function createLocalStore(root) {
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
        const actual = sha256Of(data);
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

    /** Free bytes on the filesystem that holds the objects (shared with every other service on the host). */
    function freeBytes() {
        const s = fs.statfsSync(base);
        return Number(s.bavail) * Number(s.bsize);
    }

    function writable() {
        fs.accessSync(tmpDir, fs.constants.W_OK);
        fs.accessSync(projectsDir, fs.constants.W_OK);
        return true;
    }

    /** The path to serve: a local cache hit is already the file. */
    function ensure(projectId, sha256) {
        return pathFor(projectId, sha256);
    }

    return { root: base, pathFor, put, exists, remove, removeProject, list, sweepTmp, writable, freeBytes, ensure };
}

/**
 * The Media-backed store: local disk is the read cache, Media is the source of truth. It exposes the
 * same interface as the local store; put/ensure/remove/removeProject become async (they talk to
 * Media), and the rest delegate to the cache.
 */
function createMediaStore(local, media) {
    const { createObjectsClient } = require('openvibe-sdk/media');           // v2 object API
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    if (!media || !media.url) throw new Error('HOST_OBJECT_STORE=media needs OV_MEDIA_URL (the internal OpenVibe.Media base URL)');
    if (!media.clientSecret) throw new Error('HOST_OBJECT_STORE=media needs OV_OAUTH_CLIENT_SECRET: Host stores objects as its own Media tenant through a Network service token');
    const tokenClient = createServiceTokenClient({
        tokenUrl: media.tokenUrl,
        clientId: media.clientId,
        clientSecret: media.clientSecret,
        audience: MEDIA_AUDIENCE,
        scope: media.scope || MEDIA_SCOPE,
        ...(media.fetchImpl ? { fetch: media.fetchImpl } : {}),
    });
    const objects = createObjectsClient({
        app: media.namespace || 'host',
        baseUrl: String(media.url).replace(/\/+$/, ''),
        tokenClient,
        ...(media.fetchImpl ? { fetch: media.fetchImpl } : {}),
    });
    const fetchBytes = media.fetchImpl || globalThis.fetch;
    // (project, sha256) -> Media object id, so a deploy does not list Host's namespace once per file.
    // A restart simply repopulates it; deleting an object drops its entry. Only an optimisation: an
    // empty map still finds every object by its content_hash.
    const known = new Map();
    const keyOf = (projectId, sha256) => `${projectId}\n${sha256}`;

    const isOurs = (o, projectId, sha256) => Boolean(o)
        && o.content_hash === sha256
        && o.metadata && o.metadata.project_id === projectId;

    async function findId(projectId, sha256) {
        const hit = known.get(keyOf(projectId, sha256));
        if (hit) return hit;
        for await (const o of objects.iterate({})) {
            if (isOurs(o, projectId, sha256)) { known.set(keyOf(projectId, sha256), o.id); return o.id; }
        }
        return null;
    }

    /** Cache the bytes locally (as today), then write through to Media. Rejects if Media refuses. */
    async function put(projectId, sha256, data) {
        if (!SHA_RE.test(String(sha256))) throw new TypeError('invalid sha256');
        const changed = local.put(projectId, sha256, data);   // the cache first; verifies the digest
        if (await findId(projectId, sha256)) return changed;  // Media holds it already (idempotent)
        let obj;
        try {
            obj = await objects.upload(data, {
                kind: 'file', visibility: 'private', mimeType: 'application/octet-stream',
                filename: sha256, contentHash: sha256,
                metadata: { project_id: projectId, sha256 },
            });
        } catch (err) {
            throw mediaFailure(`Media refused to store object ${sha256}`, err);
        }
        known.set(keyOf(projectId, sha256), obj.id);
        return changed;
    }

    /** Serve the cache; on a miss fetch from Media, verify the sha256, cache it, then serve. */
    async function ensure(projectId, sha256) {
        if (local.exists(projectId, sha256)) return local.pathFor(projectId, sha256);
        const id = await findId(projectId, sha256);
        if (!id) throw mediaFailure(`object ${sha256} is not in Media`, null);
        let bytes;
        try {
            const { url } = await objects.signedUrl(id, { ttl: 300 });
            const res = await fetchBytes(url);
            if (!res.ok) throw new Error(`download answered ${res.status}`);
            bytes = Buffer.from(await res.arrayBuffer());
        } catch (err) {
            throw mediaFailure(`could not fetch object ${sha256} from Media`, err);
        }
        const actual = sha256Of(bytes);
        if (actual !== sha256) throw new Error(`object ${sha256}: Media returned bytes whose sha256 is ${actual}; refused`);
        local.put(projectId, sha256, bytes);   // verifies again and caches
        return local.pathFor(projectId, sha256);
    }

    /** Delete the Media object and the cache file. Callers pass only blobs no deploy references. */
    async function remove(projectId, sha256) {
        if (!SHA_RE.test(String(sha256))) throw new TypeError('invalid sha256');
        try {
            const id = await findId(projectId, sha256);
            if (id) { await objects.delete(id); known.delete(keyOf(projectId, sha256)); }
        } catch (err) {
            throw mediaFailure(`Media could not delete object ${sha256}`, err);
        }
        return local.remove(projectId, sha256);
    }

    /** Delete every Media object of the project and the project's cache directory. */
    async function removeProject(projectId) {
        if (!isId('project', projectId)) throw new TypeError('invalid project id');
        let failure = null;
        try {
            for await (const o of objects.iterate({})) {
                if (o && o.metadata && o.metadata.project_id === projectId) {
                    try {
                        await objects.delete(o.id);
                        if (o.content_hash) known.delete(keyOf(projectId, o.content_hash));
                    } catch (err) { failure = failure || err; }
                }
            }
        } catch (err) { failure = failure || err; }
        local.removeProject(projectId);
        if (failure) throw mediaFailure(`Media could not delete the objects of ${projectId}`, failure);
    }

    return { ...local, put, ensure, remove, removeProject };
}

/**
 * root: the local object directory. opts.media, when set, selects the Media-backed store (its
 * presence, built from config, is the `HOST_OBJECT_STORE=media` switch); without it the local store
 * behaves exactly as before.
 */
function createBlobStore(root, opts = {}) {
    const local = createLocalStore(root);
    if (!opts.media) return local;
    return createMediaStore(local, opts.media);
}

module.exports = { createBlobStore, SHA_RE, MEDIA_SCOPE, MEDIA_AUDIENCE };
