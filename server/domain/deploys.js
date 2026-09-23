'use strict';
/**
 * Deploys: immutable artifacts, the upload/validation log, activation and rollback.
 *
 *   upload    entries → validate (paths, types, sizes, quotas) → objects written to the project's
 *             content-addressed store → ONE transaction: deploy row + file rows + blob rows + log +
 *             host.deploy.created (+ activation when asked). A refused upload is recorded as a
 *             failed deploy with its log and host.deploy.failed, so the owner can see why.
 *   activate  the site's active_deploy_id pointer changes in one transaction together with the
 *             activation record and host.deploy.activated. A request reads the pointer once and then
 *             only immutable rows, so it sees the old deploy or the new one, never a mix.
 *   rollback  the same switch, to a named deploy or to the one that was active before.
 *   delete    only a deploy that is not active; its objects are removed when no other deploy of
 *             the project uses them.
 *
 * There is no build: Stage B serves the uploaded files as they are, and nothing is ever executed.
 */
const { newId, isId } = require('../ids');
const { ApiError } = require('../http/errors');
const { buildManifest } = require('../artifacts/validate');
const { principalOf, actorRef } = require('./access');

const DAY = 24 * 3600 * 1000;
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

function createDeploys({ store, access, projects, sites, blobs, outbox, log = console }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM host_deploys WHERE id = ?'),
        forSite: db.prepare("SELECT * FROM host_deploys WHERE site_id = ? AND state <> 'deleted' ORDER BY created_at DESC, rowid DESC LIMIT ?"),
        insert: db.prepare(`INSERT INTO host_deploys (id, project_id, site_id, state, source, manifest, manifest_sha256, file_count, total_bytes, new_bytes, failure_code, created_by, created_at)
                            VALUES (@id, @project_id, @site_id, @state, @source, @manifest, @manifest_sha256, @file_count, @total_bytes, @new_bytes, @failure_code, @created_by, @created_at)`),
        insertFile: db.prepare('INSERT INTO host_deploy_files (deploy_id, path, sha256, size, content_type) VALUES (?, ?, ?, ?, ?)'),
        insertBlob: db.prepare('INSERT OR IGNORE INTO host_blobs (project_id, sha256, size, created_at) VALUES (?, ?, ?, ?)'),
        hasBlob: db.prepare('SELECT 1 FROM host_blobs WHERE project_id = ? AND sha256 = ?'),
        storageUsed: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM host_blobs WHERE project_id = ?'),
        deploysSince: db.prepare('SELECT COUNT(*) AS n FROM host_deploys WHERE project_id = ? AND created_at > ?'),
        logLine: db.prepare('INSERT INTO host_deploy_logs (deploy_id, level, message, created_at) VALUES (?, ?, ?, ?)'),
        logFor: db.prepare('SELECT level, message, created_at FROM host_deploy_logs WHERE deploy_id = ? ORDER BY id'),
        files: db.prepare('SELECT path, sha256, size, content_type FROM host_deploy_files WHERE deploy_id = ? ORDER BY path'),
        setPointer: db.prepare('UPDATE host_sites SET active_deploy_id = ?, updated_at = ? WHERE id = ? AND status = \'active\' AND active_deploy_id IS ?'),
        activation: db.prepare('INSERT INTO host_activations (site_id, deploy_id, previous_deploy_id, kind, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
        activations: db.prepare('SELECT deploy_id, previous_deploy_id, kind, actor, created_at FROM host_activations WHERE site_id = ? ORDER BY id DESC LIMIT ?'),
        markDeleted: db.prepare("UPDATE host_deploys SET state = 'deleted', deleted_at = ? WHERE id = ?"),
        dropFiles: db.prepare('DELETE FROM host_deploy_files WHERE deploy_id = ?'),
        orphans: db.prepare(`SELECT sha256 FROM host_blobs b WHERE b.project_id = ? AND NOT EXISTS (
                               SELECT 1 FROM host_deploy_files f JOIN host_deploys d ON d.id = f.deploy_id
                               WHERE d.project_id = b.project_id AND f.sha256 = b.sha256)`),
        dropBlob: db.prepare('DELETE FROM host_blobs WHERE project_id = ? AND sha256 = ?'),
    };

    function get(id) {
        return isId('deploy', id) ? q.byId.get(id) || null : null;
    }

    /** The deploy, its site and project, authorized at `need`; 404 for anyone without access. */
    function load(viewer, id, need) {
        const deploy = get(id);
        const notFound = new ApiError(404, 'deploy.not_found', 'no such deploy');
        if (!deploy || deploy.state === 'deleted') throw notFound;
        const site = sites.get(deploy.site_id);
        if (!site || site.status !== 'active') throw notFound;
        const project = projects.get(deploy.project_id);
        access.authorize(project, viewer, need, notFound);
        return { deploy, site, project };
    }

    /** Limits for an upload into this project (the archive reader and the validator share them). */
    function limitsFor(project) {
        const quota = projects.quotaOf(project);
        return { maxFiles: quota.maxFiles, maxFileBytes: quota.maxFileBytes, maxTotalBytes: quota.storageBytes, quota };
    }

    /** Before any byte is read: may this caller deploy to this site right now? */
    function precheck(viewer, siteId) {
        const { site, project } = sites.load(viewer, siteId, 'deploy');
        const limits = limitsFor(project);
        const recent = q.deploysSince.get(project.id, store.now() - DAY).n;
        if (recent >= limits.quota.deploysPerDay) {
            throw new ApiError(429, 'quota.deploys_per_day', `this project has made ${recent} deploys in the last 24 hours; the limit is ${limits.quota.deploysPerDay}`);
        }
        return { site, project, limits };
    }

    function writeLog(deployId, lines, now) {
        for (const l of lines) q.logLine.run(deployId, l.level, String(l.message).slice(0, 2000), now);
    }

    /** A refused upload becomes a failed deploy (with its log) and host.deploy.failed. */
    function recordFailure(viewer, { site, project }, { source, code, problems = [], notes = [], traceparent }) {
        const id = newId('deploy', store.now());
        const now = store.now();
        const lines = [
            ...notes.map((m) => ({ level: 'info', message: m })),
            ...problems.map((p) => ({ level: 'error', message: `${p.code}: ${p.message}` })),
            { level: 'error', message: `deploy refused (${code}); nothing was stored and the active deploy is unchanged` },
        ];
        store.tx(() => {
            q.insert.run({ id, project_id: project.id, site_id: site.id, state: 'failed', source, manifest: null, manifest_sha256: null, file_count: 0, total_bytes: 0, new_bytes: 0, failure_code: code, created_by: principalOf(viewer), created_at: now });
            writeLog(id, lines, now);
            outbox.emit({
                event_type: 'host.deploy.failed', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
                subject: { type: 'deploy', id },
                payload: { project_id: project.id, site_id: site.id, site: site.name, code, problems: problems.slice(0, 10).map((p) => p.code) },
            }, { traceparent });
        });
        outbox.kick();
        return { deploy: get(id), log: q.logFor.all(id) };
    }

    /**
     * entries: [{ path, data }] already normalised by the reader. -> { deploy, log, activated }
     * Throws ApiError (with extra.deploy_id and extra.log) when the upload is refused.
     */
    function create(viewer, ctx, entries, { source, activate = false, notes = [], traceparent } = {}) {
        const { site, project, limits } = ctx;
        const fail = (status, code, problems) => {
            const r = recordFailure(viewer, ctx, { source, code, problems, notes, traceparent });
            throw new ApiError(status, code, problems[0] ? problems[0].message : code, { deploy_id: r.deploy.id, log: r.log.map((l) => `${l.level}: ${l.message}`) });
        };

        const built = buildManifest(entries, limits);
        if (!built.ok) fail(/^quota\.|deploy\.too_large/.test(built.code) ? 413 : 422, built.code, built.problems);

        // Storage quota: only bytes this project does not store yet count.
        const fresh = new Map();
        for (const f of built.files) if (!q.hasBlob.get(project.id, f.sha256) && !fresh.has(f.sha256)) fresh.set(f.sha256, f);
        const newBytes = [...fresh.values()].reduce((n, f) => n + f.size, 0);
        const used = q.storageUsed.get(project.id).n;
        if (used + newBytes > limits.quota.storageBytes) {
            fail(413, 'quota.storage', [{ code: 'quota.storage', message: `this deploy adds ${fmtBytes(newBytes)}; the project stores ${fmtBytes(used)} of ${fmtBytes(limits.quota.storageBytes)}` }]);
        }

        // Objects first (idempotent, content-addressed); rows only after they are durable.
        for (const f of fresh.values()) blobs.put(project.id, f.sha256, f.data);

        const id = newId('deploy', store.now());
        const now = store.now();
        const who = principalOf(viewer);
        const lines = [
            ...notes.map((m) => ({ level: 'info', message: m })),
            { level: 'info', message: `validated ${built.manifest.file_count} files, ${fmtBytes(built.manifest.total_bytes)} (paths, file types, sizes)` },
            ...built.warnings.map((m) => ({ level: 'warn', message: m })),
            { level: 'info', message: `stored ${fresh.size} new objects (${fmtBytes(newBytes)}); ${built.files.length - fresh.size} already stored for this project` },
            { level: 'info', message: `manifest sha256 ${built.manifestSha256}` },
            { level: 'info', message: 'no build step: Stage B serves the uploaded files as they are; nothing was executed' },
        ];
        let activated = null;
        store.tx(() => {
            q.insert.run({ id, project_id: project.id, site_id: site.id, state: 'ready', source, manifest: built.manifestJson, manifest_sha256: built.manifestSha256, file_count: built.manifest.file_count, total_bytes: built.manifest.total_bytes, new_bytes: newBytes, failure_code: null, created_by: who, created_at: now });
            for (const f of built.files) q.insertFile.run(id, f.path, f.sha256, f.size, f.content_type);
            for (const f of fresh.values()) q.insertBlob.run(project.id, f.sha256, f.size, now);
            outbox.emit({
                event_type: 'host.deploy.created', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
                subject: { type: 'deploy', id },
                payload: { project_id: project.id, site_id: site.id, site: site.name, source, file_count: built.manifest.file_count, total_bytes: built.manifest.total_bytes, manifest_sha256: built.manifestSha256 },
            }, { traceparent });
            if (activate) {
                activated = switchPointer(viewer, site, get(id), 'activate', { traceparent });
                lines.push({ level: 'info', message: 'activated: the site now serves this deploy' });
            } else {
                lines.push({ level: 'info', message: 'ready; not active until you activate it' });
            }
            writeLog(id, lines, now);
        });
        outbox.kick();
        return { deploy: get(id), log: q.logFor.all(id), activated };
    }

    /** Inside a transaction. Compare-and-set on the pointer read in the same transaction. */
    function switchPointer(viewer, site, deploy, kind, { expectedActive, traceparent } = {}) {
        const current = db.prepare('SELECT active_deploy_id, status FROM host_sites WHERE id = ?').get(site.id);
        if (!current || current.status !== 'active') throw new ApiError(404, 'site.not_found', 'no such site');
        if (deploy.state !== 'ready' || deploy.site_id !== site.id) throw new ApiError(409, 'deploy.not_ready', 'only a ready deploy of this site can be activated');
        if (expectedActive !== undefined && (expectedActive || null) !== current.active_deploy_id) {
            throw new ApiError(409, 'site.active_changed', 'the active deploy changed since you looked', { active_deploy_id: current.active_deploy_id });
        }
        if (current.active_deploy_id === deploy.id) return { changed: false, deploy_id: deploy.id, previous_deploy_id: deploy.id };
        const now = store.now();
        const r = q.setPointer.run(deploy.id, now, site.id, current.active_deploy_id);
        if (r.changes !== 1) throw new ApiError(409, 'site.active_changed', 'the active deploy changed during the switch');
        q.activation.run(site.id, deploy.id, current.active_deploy_id, kind, principalOf(viewer) || 'host', now);
        outbox.emit({
            event_type: 'host.deploy.activated', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
            subject: { type: 'deploy', id: deploy.id },
            payload: { project_id: site.project_id, site_id: site.id, site: site.name, deploy_id: deploy.id, previous_deploy_id: current.active_deploy_id, rollback: kind === 'rollback' },
        }, { traceparent });
        return { changed: true, deploy_id: deploy.id, previous_deploy_id: current.active_deploy_id };
    }

    function activate(viewer, id, { expectedActive, traceparent } = {}) {
        const { deploy, site } = load(viewer, id, 'deploy');
        const out = store.tx(() => switchPointer(viewer, site, deploy, 'activate', { expectedActive, traceparent }));
        outbox.kick();
        return out;
    }

    /** To `deployId`, or else to the most recent previously active deploy that still exists. */
    function rollback(viewer, siteId, { deployId, expectedActive, traceparent } = {}) {
        const { site } = sites.load(viewer, siteId, 'deploy');
        const out = store.tx(() => {
            const current = db.prepare('SELECT active_deploy_id FROM host_sites WHERE id = ?').get(site.id).active_deploy_id;
            let target = null;
            if (deployId) {
                target = get(deployId);
                if (!target || target.site_id !== site.id || target.state === 'deleted') throw new ApiError(404, 'deploy.not_found', 'no such deploy on this site');
            } else {
                for (const a of q.activations.all(site.id, 200)) {
                    for (const cand of [a.previous_deploy_id, a.deploy_id]) {
                        if (!cand || cand === current) continue;
                        const d = get(cand);
                        if (d && d.state === 'ready' && d.site_id === site.id) { target = d; break; }
                    }
                    if (target) break;
                }
                if (!target) throw new ApiError(409, 'deploy.no_previous', 'there is no previous deploy to roll back to');
            }
            return switchPointer(viewer, site, target, 'rollback', { expectedActive, traceparent });
        });
        outbox.kick();
        return out;
    }

    /** Inside a transaction: drop blob rows no deploy of the project references. -> freed shas */
    function collectGarbage(projectId) {
        const freed = q.orphans.all(projectId).map((r) => r.sha256);
        for (const sha of freed) q.dropBlob.run(projectId, sha);
        return freed;
    }

    function unlinkBlobs(projectId, shas) {
        for (const sha of shas) {
            try { blobs.remove(projectId, sha); } catch (err) { log.warn('[Host] could not remove object:', err.message); }
        }
    }

    function remove(viewer, id) {
        const { deploy, site, project } = load(viewer, id, 'maintain');
        let freed = [];
        store.tx(() => {
            const active = db.prepare('SELECT active_deploy_id FROM host_sites WHERE id = ?').get(site.id).active_deploy_id;
            if (active === deploy.id) throw new ApiError(409, 'deploy.active', 'this deploy is being served: activate another one first');
            q.markDeleted.run(store.now(), deploy.id);
            q.dropFiles.run(deploy.id);
            freed = collectGarbage(project.id);
        });
        unlinkBlobs(project.id, freed);
        return { deleted: true, objects_removed: freed.length };
    }

    return {
        get, load, precheck, create, recordFailure, activate, rollback, remove, collectGarbage, unlinkBlobs, limitsFor,
        list: (siteId, limit = 100) => q.forSite.all(siteId, Math.min(Math.max(limit, 1), 200)),
        logOf: (id) => q.logFor.all(id),
        filesOf: (id) => q.files.all(id),
        activationsOf: (siteId, limit = 50) => q.activations.all(siteId, limit),
    };
}

module.exports = { createDeploys };
