'use strict';
/**
 * An in-process stand-in for OpenVibe.Media's Object API v2, wide enough for Host's Media object
 * store: init (POST /objects), the content PUT, complete, metadata GET, list, the signed download
 * link, and delete — the routes OpenVibe.Media serves from server/objects/routes.js, served here
 * from memory. It follows test/stageb/mocks.js (an HTTP server on a random port) and test/s3-mock.js
 * (a recorded command log plus injectable failures).
 *
 *   const media = await startMedia();
 *   media.url                     the base URL to give Host (OV_MEDIA_URL)
 *   media.objects                 Map id -> object (bytes, content_hash, metadata, lifecycle_status)
 *   media.calls                   every request { method, url, bytes, auth }
 *   media.failUpload = true       every init answers 403 (a deploy must then fail)
 *   media.failDelete = true       every delete answers 500
 *   media.tamper.add(id)          the signed content GET answers other bytes
 *   media.countInits()            init requests so far
 *   media.readyFor(projectId)     ready objects whose metadata.project_id is that project
 *   media.byHash(projectId, sha)  the ready object for that project and content hash
 *   await media.close()
 */
const http = require('http');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function startMedia({ app = 'host' } = {}) {
    const objects = new Map();
    const calls = [];
    const media = { objects, calls, app, failUpload: false, failDelete: false, tamper: new Set() };
    const basePath = `/api/v2/${encodeURIComponent(app)}/objects`;
    const base = () => `http://127.0.0.1:${server.address().port}`;
    const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const publicShape = (o) => ({
        id: o.id, app_id: app, namespace: o.namespace, kind: o.kind, visibility: o.visibility,
        lifecycle_status: o.lifecycle_status, mime_type: o.mime_type, size_bytes: o.size_bytes,
        content_hash: o.content_hash || null, metadata: o.metadata, public_url: null,
    });

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            calls.push({ method: req.method, url: req.url, bytes: raw.length, auth: req.headers.authorization || null });
            const p = new URL(req.url, 'http://localhost').pathname;
            const rel = p === basePath ? '' : p.startsWith(`${basePath}/`) ? p.slice(basePath.length + 1) : null;
            if (rel === null) return json(res, 404, { code: 'media.not_found' });

            if (rel === '' && req.method === 'POST') {
                if (media.failUpload) return json(res, 403, { code: 'media.object.denied', detail: 'the fake refuses every upload' });
                let body = {};
                try { body = JSON.parse(raw.toString('utf8')); } catch { /* malformed: treat as empty */ }
                const id = `med_${ids.ulid()}`;
                const o = {
                    id, namespace: body.namespace || app, kind: body.kind || 'file', visibility: body.visibility || 'private',
                    lifecycle_status: 'uploading', mime_type: body.mime_type || null, size_bytes: Number(body.size_bytes) || 0,
                    content_hash: null, metadata: { ...(body.metadata || {}) }, bytes: null,
                };
                objects.set(id, o);
                return json(res, 201, {
                    id, object: publicShape(o),
                    upload: { method: 'PUT', url: `${base()}${basePath}/${id}/content?token=tok`, token: 'tok', expires_at: new Date(Date.now() + 3600e3).toISOString(), max_bytes: o.size_bytes, content_type: o.mime_type },
                });
            }
            if (rel === '' && req.method === 'GET') {
                const all = [...objects.values()].filter((o) => o.lifecycle_status !== 'deleted');
                return json(res, 200, { objects: all.map(publicShape), next_cursor: null, limit: 50 });
            }

            const m = /^([^/]+)(?:\/(.*))?$/.exec(rel);
            const obj = m && objects.get(m[1]);
            if (!obj) return json(res, 404, { code: 'media.object.not_found' });
            const sub = m[2] || '';
            if (sub === 'content' && req.method === 'PUT') {
                obj.bytes = Buffer.from(raw);
                obj.content_hash = sha256(obj.bytes);
                obj.size_bytes = obj.bytes.length;
                return json(res, 200, {});
            }
            if (sub === 'content' && req.method === 'GET') {
                if (media.tamper.has(obj.id)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.from('TAMPERED BYTES')); }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                return res.end(obj.bytes || Buffer.alloc(0));
            }
            if (sub === 'complete' && req.method === 'POST') {
                let body = {};
                try { body = JSON.parse(raw.toString('utf8')); } catch { /* */ }
                const expected = String(body.content_hash || '').toLowerCase();
                if (expected && expected !== obj.content_hash) return json(res, 422, { code: 'media.object.hash_mismatch', detail: 'content hash mismatch' });
                obj.lifecycle_status = 'ready';
                return json(res, 200, publicShape(obj));
            }
            if (sub === 'download' && req.method === 'GET') {
                if (obj.lifecycle_status !== 'ready') return json(res, 409, { code: 'media.object.not_ready' });
                return json(res, 200, { url: `${base()}${basePath}/${obj.id}/content?token=signed`, expires_at: new Date(Date.now() + 300e3).toISOString(), public: false });
            }
            if (sub === '' && req.method === 'GET') return json(res, 200, publicShape(obj));
            if (sub === '' && req.method === 'DELETE') {
                if (media.failDelete) return json(res, 500, { code: 'media.object.delete_failed' });
                obj.lifecycle_status = 'deleted';
                return json(res, 200, publicShape(obj));
            }
            return json(res, 404, { code: 'media.not_found' });
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            media.url = base();
            media.close = () => new Promise((r) => server.close(r));
            media.countInits = () => calls.filter((c) => c.method === 'POST' && new URL(c.url, 'http://x').pathname === basePath).length;
            media.ready = () => [...objects.values()].filter((o) => o.lifecycle_status === 'ready');
            media.readyFor = (projectId) => media.ready().filter((o) => o.metadata && o.metadata.project_id === projectId);
            media.byHash = (projectId, sha) => media.ready().find((o) => o.metadata && o.metadata.project_id === projectId && o.content_hash === sha) || null;
            resolve(media);
        });
    });
}

module.exports = { startMedia };
