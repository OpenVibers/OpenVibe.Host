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
 *   preview   a deploy uploaded as a preview (source 'preview'): it becomes the site's ONE live
 *             preview (host_sites.preview_deploy_id + preview_expires_at) instead of going active,
 *             and is served only by the dashboard, to a member, at /preview/<deploy-id>/… (see
 *             server/http/tenant.js). Any pointer switch clears it (so a deploy or rollback makes it
 *             vanish), it expires on its own, and it is never announced to search engines.
 *   git       ingestGit: the output a project's OWN CI built from the site's connected repository
 *             (domain/site-sources.js), posted with the ref and the commit it built. The ref must be
 *             the connected one and the commit a full SHA; the files go through create() like any
 *             upload, are stored with source 'git' plus an immutable host_deploy_git row in the same
 *             transaction, and always land as the site's preview: approving it is the ordinary
 *             activate. A git deploy never moves active_deploy_id by itself.
 *
 * Host never builds: it serves the uploaded files (or the CI's build output) as they are, never
 * clones or fetches a repository, holds no credential for one, and never executes anything.
 */
const { newId, isId } = require('../ids');
const { ApiError } = require('../http/errors');
const { buildManifest } = require('../artifacts/validate');
const { principalOf, actorRef } = require('./access');

const DAY = 24 * 3600 * 1000;
// How long a preview stays served. Bounded so a draft cannot linger on the dashboard forever; the
// uploader can always upload another one.
const PREVIEW_TTL_MS = 60 * 60 * 1000;
// A full commit id: SHA-1 (40) or SHA-256 (64) object names, lowercase hex.
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_COLS = 'g.provider AS git_provider, g.repo_url AS git_repo_url, g.ref AS git_ref, g.commit_sha AS git_commit_sha';
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

function createDeploys({ store, config = null, access, projects, sites, blobs, outbox, takedowns, log = console, indexnow = null }) {
    const { db } = store;
    // IndexNow: a site's public page appeared, changed or left the index (never a sandbox site, whose
    // responses carry X-Robots-Tag noindex). `indexnow(hostname, paths)` queues one debounced batch.
    const announce = typeof indexnow === 'function' ? indexnow : () => {};
    const announceSite = (site, project, paths = ['/', '/sitemap.xml']) => {
        if (!project || project.environment !== 'sandbox') announce(sites.defaultHostname(site.name), paths);
    };
    const q = {
        // A git deploy's provenance comes along as git_* columns (NULL for any other deploy).
        byId: db.prepare(`SELECT d.*, ${GIT_COLS} FROM host_deploys d LEFT JOIN host_deploy_git g ON g.deploy_id = d.id WHERE d.id = ?`),
        forSite: db.prepare(`SELECT d.*, ${GIT_COLS} FROM host_deploys d LEFT JOIN host_deploy_git g ON g.deploy_id = d.id
                             WHERE d.site_id = ? AND d.state <> 'deleted' ORDER BY d.created_at DESC, d.seq DESC LIMIT ?`),
        insert: db.prepare(`INSERT INTO host_deploys (id, project_id, site_id, state, source, manifest, manifest_sha256, file_count, total_bytes, new_bytes, failure_code, created_by, created_at)
                            VALUES (@id, @project_id, @site_id, @state, @source, @manifest, @manifest_sha256, @file_count, @total_bytes, @new_bytes, @failure_code, @created_by, @created_at)`),
        insertFile: db.prepare('INSERT INTO host_deploy_files (deploy_id, path, sha256, size, content_type) VALUES (?, ?, ?, ?, ?)'),
        insertBlob: db.prepare('INSERT INTO host_blobs (project_id, sha256, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
        hasBlob: db.prepare('SELECT 1 FROM host_blobs WHERE project_id = ? AND sha256 = ?'),
        storageUsed: db.prepare('SELECT COALESCE(SUM(size), 0)::bigint AS n FROM host_blobs WHERE project_id = ?'),
        deploysSince: db.prepare('SELECT COUNT(*) AS n FROM host_deploys WHERE project_id = ? AND created_at > ?'),
        logLine: db.prepare('INSERT INTO host_deploy_logs (deploy_id, level, message, created_at) VALUES (?, ?, ?, ?)'),
        logFor: db.prepare('SELECT level, message, created_at FROM host_deploy_logs WHERE deploy_id = ? ORDER BY id'),
        files: db.prepare('SELECT path, sha256, size, content_type FROM host_deploy_files WHERE deploy_id = ? ORDER BY path'),
        setPointer: db.prepare('UPDATE host_sites SET active_deploy_id = ?, updated_at = ? WHERE id = ? AND status = \'active\' AND active_deploy_id IS NOT DISTINCT FROM ?'),
        setPreview: db.prepare('UPDATE host_sites SET preview_deploy_id = ?, preview_expires_at = ? WHERE id = ?'),
        clearPreview: db.prepare('UPDATE host_sites SET preview_deploy_id = NULL, preview_expires_at = NULL WHERE id = ?'),
        clearPreviewIf: db.prepare('UPDATE host_sites SET preview_deploy_id = NULL, preview_expires_at = NULL WHERE id = ? AND preview_deploy_id = ?'),
        activation: db.prepare('INSERT INTO host_activations (site_id, deploy_id, previous_deploy_id, kind, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
        activations: db.prepare('SELECT deploy_id, previous_deploy_id, kind, actor, created_at FROM host_activations WHERE site_id = ? ORDER BY id DESC LIMIT ?'),
        markDeleted: db.prepare("UPDATE host_deploys SET state = 'deleted', deleted_at = ? WHERE id = ?"),
        dropFiles: db.prepare('DELETE FROM host_deploy_files WHERE deploy_id = ?'),
        orphans: db.prepare(`SELECT sha256 FROM host_blobs b WHERE b.project_id = ? AND NOT EXISTS (
                               SELECT 1 FROM host_deploy_files f JOIN host_deploys d ON d.id = f.deploy_id
                               WHERE d.project_id = b.project_id AND f.sha256 = b.sha256)`),
        dropBlob: db.prepare('DELETE FROM host_blobs WHERE project_id = ? AND sha256 = ?'),
        sourceOf: db.prepare('SELECT provider, repo_url, ref FROM host_site_sources WHERE site_id = ?'),
        insertGit: db.prepare('INSERT INTO host_deploy_git (deploy_id, provider, repo_url, ref, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    };

    async function get(id) {
        return isId('deploy', id) ? await q.byId.get(id) || null : null;
    }

    /** The deploy, its site and project, authorized at `need`; 404 for anyone without access. */
    async function load(viewer, id, need) {
        const deploy = await get(id);
        const notFound = new ApiError(404, 'deploy.not_found', 'no such deploy');
        if (!deploy || deploy.state === 'deleted') throw notFound;
        const site = await sites.get(deploy.site_id);
        if (!site || site.status !== 'active') throw notFound;
        const project = await projects.get(deploy.project_id);
        await access.authorize(project, viewer, need, notFound);
        return { deploy, site, project };
    }

    /** Limits for an upload into this project (the archive reader and the validator share them). */
    async function limitsFor(project) {
        const quota = await projects.quotaOf(project);
        return { maxFiles: quota.maxFiles, maxFileBytes: quota.maxFileBytes, maxTotalBytes: quota.storageBytes, quota };
    }

    /** Before any byte is read: may this caller deploy to this site right now? */
    async function precheck(viewer, siteId) {
        const { site, project } = await sites.load(viewer, siteId, 'deploy');
        await takedowns.assertOpen(site);
        const minFree = config ? config.uploads.minFreeBytes : 0;
        if (minFree > 0) {
            let free = Infinity;
            try { free = blobs.freeBytes(); } catch (err) { log.warn('[Host] could not read free disk space:', err.message); }
            if (free < minFree) {
                log.warn(`[Host] uploads refused: ${free} bytes free, HOST_MIN_FREE_BYTES is ${minFree}`);
                throw new ApiError(507, 'storage.host_full', 'Host is short of disk space and is not accepting deploys right now; try again later');
            }
        }
        const limits = await limitsFor(project);
        const recent = (await q.deploysSince.get(project.id, store.now() - DAY)).n;
        if (recent >= limits.quota.deploysPerDay) {
            throw new ApiError(429, 'quota.deploys_per_day', `this project has made ${recent} deploys in the last 24 hours; the limit is ${limits.quota.deploysPerDay}`);
        }
        return { site, project, limits };
    }

    async function writeLog(deployId, lines, now) {
        for (const l of lines) await q.logLine.run(deployId, l.level, String(l.message).slice(0, 2000), now);
    }

    /** A refused upload becomes a failed deploy (with its log) and host.deploy.failed. */
    async function recordFailure(viewer, { site, project }, { source, code, problems = [], notes = [], traceparent }) {
        const id = newId('deploy', store.now());
        const now = store.now();
        const lines = [
            ...notes.map((m) => ({ level: 'info', message: m })),
            ...problems.map((p) => ({ level: 'error', message: `${p.code}: ${p.message}` })),
            { level: 'error', message: `deploy refused (${code}); nothing was stored and the active deploy is unchanged` },
        ];
        await store.tx(async () => {
            await q.insert.run({ id, project_id: project.id, site_id: site.id, state: 'failed', source, manifest: null, manifest_sha256: null, file_count: 0, total_bytes: 0, new_bytes: 0, failure_code: code, created_by: principalOf(viewer), created_at: now });
            await writeLog(id, lines, now);
            await outbox.emit({
                event_type: 'host.deploy.failed', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
                subject: { type: 'deploy', id },
                payload: { project_id: project.id, site_id: site.id, site: site.name, code, problems: problems.slice(0, 10).map((p) => p.code) },
            }, { traceparent });
        });
        outbox.kick();
        return { deploy: await get(id), log: await q.logFor.all(id) };
    }

    /**
     * entries: [{ path, data }] already normalised by the reader. -> { deploy, log, activated }
     * Throws ApiError (with extra.deploy_id and extra.log) when the upload is refused.
     */
    async function create(viewer, ctx, entries, { source, activate = false, preview = false, notes = [], traceparent, git = null } = {}) {
        const { site, project, limits } = ctx;
        // A preview is never activated: it is the site's live preview (its pointer), not its active
        // deploy, and it is stored with source 'preview' so the two can never be confused. A git
        // deploy is always a preview and keeps source 'git'; its provenance row says what it is.
        const isGit = source === 'git';
        if (isGit && (!git || preview !== true)) throw new Error('a git deploy is created by ingestGit, as a preview');
        const isPreview = preview === true;
        const storedSource = isPreview && !isGit ? 'preview' : source;
        if (isPreview) activate = false;
        const fail = async (status, code, problems) => {
            const r = await recordFailure(viewer, ctx, { source: storedSource, code, problems, notes, traceparent });
            throw new ApiError(status, code, problems[0] ? problems[0].message : code, { deploy_id: r.deploy.id, log: r.log.map((l) => `${l.level}: ${l.message}`) });
        };

        const built = buildManifest(entries, limits);
        if (!built.ok) await fail(/^quota\.|deploy\.too_large/.test(built.code) ? 413 : 422, built.code, built.problems);

        // Storage quota: only bytes this project does not store yet count.
        const fresh = new Map();
        for (const f of built.files) if (!await q.hasBlob.get(project.id, f.sha256) && !fresh.has(f.sha256)) fresh.set(f.sha256, f);
        const newBytes = [...fresh.values()].reduce((n, f) => n + f.size, 0);
        const used = (await q.storageUsed.get(project.id)).n;
        if (used + newBytes > limits.quota.storageBytes) {
            await fail(413, 'quota.storage', [{ code: 'quota.storage', message: `this deploy adds ${fmtBytes(newBytes)}; the project stores ${fmtBytes(used)} of ${fmtBytes(limits.quota.storageBytes)}` }]);
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
            { level: 'info', message: isGit ? 'built outside Host by the project\'s CI; Host stored the files as they are and executed nothing' : 'no build step: Stage B serves the uploaded files as they are; nothing was executed' },
        ];
        let activated = null;
        const previewExpiresAt = isPreview ? now + PREVIEW_TTL_MS : null;
        await store.tx(async () => {
            await q.insert.run({ id, project_id: project.id, site_id: site.id, state: 'ready', source: storedSource, manifest: built.manifestJson, manifest_sha256: built.manifestSha256, file_count: built.manifest.file_count, total_bytes: built.manifest.total_bytes, new_bytes: newBytes, failure_code: null, created_by: who, created_at: now });
            for (const f of built.files) await q.insertFile.run(id, f.path, f.sha256, f.size, f.content_type);
            for (const f of fresh.values()) await q.insertBlob.run(project.id, f.sha256, f.size, now);
            if (isGit) await q.insertGit.run(id, git.provider, git.repo_url, git.ref, git.commit_sha, now);
            await outbox.emit({
                event_type: 'host.deploy.created', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
                subject: { type: 'deploy', id },
                payload: { project_id: project.id, site_id: site.id, site: site.name, source: storedSource, file_count: built.manifest.file_count, total_bytes: built.manifest.total_bytes, manifest_sha256: built.manifestSha256 },
            }, { traceparent });
            if (isPreview) {
                await q.setPreview.run(id, previewExpiresAt, site.id);
                lines.push({ level: 'info', message: `preview: served only at /preview/${id}/ to a project member until it expires; the public site still serves its active deploy` });
            } else if (activate) {
                activated = await switchPointer(viewer, site, await get(id), 'activate', { traceparent });
                lines.push({ level: 'info', message: 'activated: the site now serves this deploy' });
            } else {
                lines.push({ level: 'info', message: 'ready; not active until you activate it' });
            }
            await writeLog(id, lines, now);
        });
        outbox.kick();
        if (activated && activated.changed) announceSite(site, project);
        return { deploy: await get(id), log: await q.logFor.all(id), activated, preview: isPreview ? { deploy_id: id, expires_at: previewExpiresAt } : null };
    }

    /**
     * May the site take a git deploy of `ref` at `commit_sha`? -> the provenance to record.
     * 409 source.not_connected, 409 source.ref_mismatch, 422 source.commit_sha / source.ref. Either
     * value may be left out (undefined) to check only the connection, before the body is read.
     */
    async function gitTarget(site, { ref, commit_sha: sha } = {}) {
        const src = await q.sourceOf.get(site.id);
        if (!src) throw new ApiError(409, 'source.not_connected', 'this site has no Git source: connect a repository and branch first (PUT /api/v1/sites/:id/source)');
        if (ref !== undefined) {
            if (typeof ref !== 'string' || !ref) throw new ApiError(422, 'source.ref', 'ref is required: the branch this commit was built from');
            if (ref !== src.ref) throw new ApiError(409, 'source.ref_mismatch', `this site deploys from ${src.ref}, not ${ref.slice(0, 200)}`);
        }
        if (sha !== undefined && (typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha))) {
            throw new ApiError(422, 'source.commit_sha', 'commit_sha must be the full commit id: 40 or 64 lowercase hex characters');
        }
        return { provider: src.provider, repo_url: src.repo_url, ref: src.ref, commit_sha: sha };
    }

    /**
     * A git deploy: the build output the project's CI posts for the connected ref at commit_sha.
     * ctx is precheck()'s result for siteId. It lands as the site's preview and never activates;
     * a refused file is a failed deploy (recordFailure, through create) and host.deploy.failed.
     */
    async function ingestGit(viewer, ctx, siteId, entries, { ref, commit_sha, notes = [], traceparent } = {}) {
        if (!ctx || !ctx.site || ctx.site.id !== siteId) throw new ApiError(404, 'site.not_found', 'no such site');
        const git = await gitTarget(ctx.site, { ref: ref == null ? '' : ref, commit_sha: commit_sha == null ? '' : commit_sha });
        const why = [...notes, `git: ${git.repo_url} ${git.ref} at ${git.commit_sha}`];
        return await create(viewer, ctx, entries, { source: 'git', preview: true, activate: false, notes: why, traceparent, git });
    }

    /** Inside a transaction. Compare-and-set on the pointer read in the same transaction. */
    async function switchPointer(viewer, site, deploy, kind, { expectedActive, traceparent } = {}) {
        const current = await db.prepare('SELECT active_deploy_id, status FROM host_sites WHERE id = ?').get(site.id);
        if (!current || current.status !== 'active') throw new ApiError(404, 'site.not_found', 'no such site');
        if (deploy.state !== 'ready' || deploy.site_id !== site.id) throw new ApiError(409, 'deploy.not_ready', 'only a ready deploy of this site can be activated');
        if (expectedActive !== undefined && (expectedActive || null) !== current.active_deploy_id) {
            throw new ApiError(409, 'site.active_changed', 'the active deploy changed since you looked', { active_deploy_id: current.active_deploy_id });
        }
        if (current.active_deploy_id === deploy.id) return { changed: false, deploy_id: deploy.id, previous_deploy_id: deploy.id };
        const now = store.now();
        const r = await q.setPointer.run(deploy.id, now, site.id, current.active_deploy_id);
        if (r.changes !== 1) throw new ApiError(409, 'site.active_changed', 'the active deploy changed during the switch');
        await q.activation.run(site.id, deploy.id, current.active_deploy_id, kind, principalOf(viewer) || 'host', now);
        // A real deploy or rollback supersedes any pending preview: it stops being served at once.
        await q.clearPreview.run(site.id);
        await outbox.emit({
            event_type: 'host.deploy.activated', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
            subject: { type: 'deploy', id: deploy.id },
            payload: { project_id: site.project_id, site_id: site.id, site: site.name, deploy_id: deploy.id, previous_deploy_id: current.active_deploy_id, rollback: kind === 'rollback' },
        }, { traceparent });
        return { changed: true, deploy_id: deploy.id, previous_deploy_id: current.active_deploy_id };
    }

    async function activate(viewer, id, { expectedActive, traceparent } = {}) {
        const { deploy, site, project } = await load(viewer, id, 'deploy');
        await takedowns.assertOpen(site);
        const out = await store.tx(async () => await switchPointer(viewer, site, deploy, 'activate', { expectedActive, traceparent }));
        outbox.kick();
        if (out.changed) announceSite(site, project);
        return out;
    }

    /** To `deployId`, or else to the most recent previously active deploy that still exists. */
    async function rollback(viewer, siteId, { deployId, expectedActive, traceparent } = {}) {
        const { site, project } = await sites.load(viewer, siteId, 'deploy');
        await takedowns.assertOpen(site);
        const out = await store.tx(async () => {
            const current = (await db.prepare('SELECT active_deploy_id FROM host_sites WHERE id = ?').get(site.id)).active_deploy_id;
            let target = null;
            if (deployId) {
                target = await get(deployId);
                if (!target || target.site_id !== site.id || target.state === 'deleted') throw new ApiError(404, 'deploy.not_found', 'no such deploy on this site');
            } else {
                for (const a of await q.activations.all(site.id, 200)) {
                    for (const cand of [a.previous_deploy_id, a.deploy_id]) {
                        if (!cand || cand === current) continue;
                        const d = await get(cand);
                        if (d && d.state === 'ready' && d.site_id === site.id) { target = d; break; }
                    }
                    if (target) break;
                }
                if (!target) throw new ApiError(409, 'deploy.no_previous', 'there is no previous deploy to roll back to');
            }
            return await switchPointer(viewer, site, target, 'rollback', { expectedActive, traceparent });
        });
        outbox.kick();
        if (out.changed) announceSite(site, project);
        return out;
    }

    /** Inside a transaction: drop blob rows no deploy of the project references. -> freed shas */
    async function collectGarbage(projectId) {
        const freed = (await q.orphans.all(projectId)).map((r) => r.sha256);
        for (const sha of freed) await q.dropBlob.run(projectId, sha);
        return freed;
    }

    function unlinkBlobs(projectId, shas) {
        for (const sha of shas) {
            try { blobs.remove(projectId, sha); } catch (err) { log.warn('[Host] could not remove object:', err.message); }
        }
    }

    async function remove(viewer, id) {
        const { deploy, site, project } = await load(viewer, id, 'maintain');
        await takedowns.assertDeletable(viewer, { site });
        let freed = [];
        await store.tx(async () => {
            const active = (await db.prepare('SELECT active_deploy_id FROM host_sites WHERE id = ?').get(site.id)).active_deploy_id;
            if (active === deploy.id) throw new ApiError(409, 'deploy.active', 'this deploy is being served: activate another one first');
            await q.markDeleted.run(store.now(), deploy.id);
            await q.dropFiles.run(deploy.id);
            // A deleted preview must stop being served even if it was the site's live one.
            await q.clearPreviewIf.run(site.id, deploy.id);
            freed = await collectGarbage(project.id);
        });
        unlinkBlobs(project.id, freed);
        return { deleted: true, objects_removed: freed.length };
    }

    return {
        get, load, precheck, create, ingestGit, gitTarget, recordFailure, activate, rollback, remove, collectGarbage, unlinkBlobs, limitsFor,
        list: async (siteId, limit = 100) => await q.forSite.all(siteId, Math.min(Math.max(limit, 1), 200)),
        logOf: async (id) => await q.logFor.all(id),
        filesOf: async (id) => await q.files.all(id),
        activationsOf: async (siteId, limit = 50) => await q.activations.all(siteId, limit),
    };
}

module.exports = { createDeploys, PREVIEW_TTL_MS };
