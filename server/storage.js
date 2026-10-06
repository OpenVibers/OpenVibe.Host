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
 *           the local cache and, on a miss, streams the object back from Media while hashing it,
 *           verifies the sha256 and only then renames it into the cache and serves it. Media objects
 *           are deleted only where the local store would delete the blob today (deploy GC, project
 *           removal, the worker's orphan sweep), and the delete re-checks host_blobs just before it
 *           runs, so a Media object a deploy has since re-referenced is not deleted. The worker's
 *           sweep walks only locally cached blobs, so a Media-only orphan is left to project
 *           removal. A zero-byte file is cache-only (Media's upload refuses empty objects) and is
 *           never fetched. A put is serialised per (project, sha256) and remove deletes every
 *           matching object, so two deploys sharing a new sha cannot leave a duplicate behind.
 *
 * Nothing in this module reaches the network on load: the Media client is built inside
 * createMediaStore(), only when the Media store is selected, and it fetches a token lazily.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { isId } = require('./ids');

const SHA_RE = /^[0-9a-f]{64}$/;
// What Host's Network service principal must be granted for audience openvibe.media, in Host's own
// namespace (`host` / `host.*`). Media's v2 object API checks a verb per namespace: upload, read,
// list, delete. Media's older ids keep granting the newer verbs, but asking for each verb is exact.
const MEDIA_SCOPE = 'media.object.upload media.object.read media.object.list media.object.delete';
const MEDIA_AUDIENCE = 'openvibe.media';
// A Media download that has not answered within this long is abandoned and the read fails with a
// clean 500 instead of hanging. The SDK client has its own timeouts; this raw fetch does not.
const MEDIA_FETCH_TIMEOUT_MS = 30 * 1000;

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

    return { root: base, tmpDir, pathFor, put, exists, remove, removeProject, list, sweepTmp, writable, freeBytes, ensure };
}

/**
 * The Media-backed store: local disk is the read cache, Media is the source of truth. It exposes the
 * same interface as the local store; put/ensure/remove/removeProject become async (they talk to
 * Media), and the rest delegate to the cache.
 *
 * opts.isReferenced(projectId, sha256) -> whether host_blobs still has a row, i.e. whether a deploy
 * still references the blob. remove() re-checks it just before deleting, so a blob a concurrent
 * deploy re-used after the caller found it unreferenced keeps its Media copy.
 */
function createMediaStore(local, media, { isReferenced } = {}) {
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
    const fetchTimeoutMs = Number(media.fetchTimeoutMs) > 0 ? Number(media.fetchTimeoutMs) : MEDIA_FETCH_TIMEOUT_MS;
    // (project, sha256) -> Media object id, so a deploy does not list Host's namespace once per file.
    // A restart simply repopulates it; deleting an object drops its entry. Only an optimisation: an
    // empty map still finds every object by its content_hash.
    const known = new Map();
    const keyOf = (projectId, sha256) => `${projectId}\n${sha256}`;
    // In-flight tasks by key: a concurrent put of the same new blob waits for the first upload
    // instead of racing it into a duplicate object, and a burst of cache misses for one blob shares
    // a single download. Keys are prefixed so a put and an ensure never block each other.
    const inflight = new Map();

    const isOurs = (o, projectId, sha256) => Boolean(o)
        && o.content_hash === sha256
        && o.metadata && o.metadata.project_id === projectId;

    /** Run fn after every earlier task with the same key, whichever way it settled. */
    function serialise(map, key, fn) {
        const prev = map.get(key) || Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.then(() => {}, () => {});   // the queue's tail never rejects
        map.set(key, tail);
        tail.then(() => { if (map.get(key) === tail) map.delete(key); });
        return run;
    }

    /** Every Media object id for this (project, sha256): there can be duplicates from before puts were serialised. */
    async function findAllIds(projectId, sha256) {
        const ids = [];
        for await (const o of objects.iterate({})) if (isOurs(o, projectId, sha256)) ids.push(o.id);
        return ids;
    }

    async function findId(projectId, sha256) {
        const key = keyOf(projectId, sha256);
        const hit = known.get(key);
        if (hit) return hit;
        const ids = await findAllIds(projectId, sha256);
        if (!ids.length) return null;
        known.set(key, ids[0]);
        return ids[0];
    }

    /** Stream a Media object into a temp file while hashing it; rename into the cache only on a match. */
    async function downloadToCache(projectId, sha256, url) {
        const dest = local.pathFor(projectId, sha256);
        const tmp = path.join(local.tmpDir, `${crypto.randomBytes(12).toString('hex')}.part`);
        const hash = crypto.createHash('sha256');
        try {
            const res = await fetchBytes(url, { signal: AbortSignal.timeout(fetchTimeoutMs) });
            if (!res.ok) throw new Error(`download answered ${res.status}`);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (res.body) {
                const meter = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
                await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
            } else {
                const buf = Buffer.from(await res.arrayBuffer());
                hash.update(buf);
                fs.writeFileSync(tmp, buf);
            }
            const actual = hash.digest('hex');
            if (actual !== sha256) {
                const e = new Error(`object ${sha256}: Media returned bytes whose sha256 is ${actual}; refused`);
                e.code = 'storage.corrupt';
                throw e;
            }
            fs.renameSync(tmp, dest);
        } catch (err) {
            fs.rmSync(tmp, { force: true });
            if (err && err.code === 'storage.corrupt') throw err;
            throw mediaFailure(`could not fetch object ${sha256} from Media`, err);
        }
    }

    async function doPut(projectId, sha256, data) {
        if (!SHA_RE.test(String(sha256))) throw new TypeError('invalid sha256');
        // Media's upload refuses zero bytes ("nothing to upload"); an empty file is a valid manifest
        // entry, so it lives in the local cache only. ensure() serves it from there and, since the
        // serving path short-circuits size 0, never asks Media (which has no object for it).
        if (data.length === 0) return local.put(projectId, sha256, data);
        const changed = local.put(projectId, sha256, data);   // the cache first; verifies the digest
        // A blob this process just wrote is new here: upload it directly. Listing Host's whole
        // namespace once per file would be quadratic on a 300-file deploy, and Media's v2 list API has
        // no content_hash or metadata filter. Only a blob that was already cached (a previous deploy
        // in this process, or an earlier run) is looked up, so a restart does not upload a second copy.
        if (!changed) {
            if (await findId(projectId, sha256)) return changed;
        }
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

    /** Cache the bytes locally (as today), then write through to Media. Rejects if Media refuses. */
    function put(projectId, sha256, data) {
        return serialise(inflight, `put:${keyOf(projectId, sha256)}`, () => doPut(projectId, sha256, data));
    }

    async function doEnsure(projectId, sha256) {
        if (local.exists(projectId, sha256)) return local.pathFor(projectId, sha256);   // a peer cached it while we waited
        const id = await findId(projectId, sha256);
        if (!id) throw mediaFailure(`object ${sha256} is not in Media`, null);
        let url;
        try {
            ({ url } = await objects.signedUrl(id, { ttl: 300 }));
        } catch (err) {
            throw mediaFailure(`could not fetch object ${sha256} from Media`, err);
        }
        await downloadToCache(projectId, sha256, url);
        return local.pathFor(projectId, sha256);
    }

    /**
     * Serve the cache; on a miss fetch from Media, verify the sha256, cache it, then serve. Concurrent
     * misses for one blob share a single download.
     */
    function ensure(projectId, sha256) {
        if (local.exists(projectId, sha256)) return Promise.resolve(local.pathFor(projectId, sha256));
        return serialise(inflight, `ensure:${keyOf(projectId, sha256)}`, () => doEnsure(projectId, sha256));
    }

    /** Delete the Media object(s) and the cache file. Callers pass only blobs no deploy references. */
    async function remove(projectId, sha256) {
        if (!SHA_RE.test(String(sha256))) throw new TypeError('invalid sha256');
        let ids;
        try {
            ids = await findAllIds(projectId, sha256);
        } catch (err) {
            throw mediaFailure(`Media could not delete object ${sha256}`, err);
        }
        // Between the caller's "unreferenced" decision and this delete a concurrent deploy may have
        // re-used the sha. host_blobs is the authority: if a row now exists, keep Media's durable copy
        // and the cache file. The check is after the (slow) namespace scan, right before the delete.
        if (isReferenced && await isReferenced(projectId, sha256)) return false;
        if (ids.length) {
            try {
                for (const id of ids) await objects.delete(id);
            } catch (err) {
                throw mediaFailure(`Media could not delete object ${sha256}`, err);
            }
            known.delete(keyOf(projectId, sha256));
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
 * behaves exactly as before. opts.isReferenced is the Media store's host_blobs re-check on delete.
 */
function createBlobStore(root, opts = {}) {
    const local = createLocalStore(root);
    if (!opts.media) return local;
    return createMediaStore(local, opts.media, { isReferenced: opts.isReferenced });
}

module.exports = { createBlobStore, SHA_RE, MEDIA_SCOPE, MEDIA_AUDIENCE };
