'use strict';
/**
 * Projects, members and quotas.
 *
 * ADR-014: projects are owned by OpenVibe.Network. Network has no projects yet, so a project is
 * created here by its owner (a usr_ subject) and gets a prj_ id; `network_project_id` records the
 * Network project once it exists, and every Host resource is keyed by the project id so one
 * revocation reaches all of it. Quotas are enforced here, by the owning service.
 */
const { ids } = require('openvibe-contracts');
const { newId, isId } = require('../ids');
const { ApiError } = require('../http/errors');
const { principalOf } = require('./access');

const NAME_MAX = 80;
const NETWORK_PROJECT_RE = /^[A-Za-z0-9_:-]{3,80}$/;
const PRINCIPAL_RE = /^(usr_[0-9A-HJKMNP-TV-Z]{26}|app:app_[0-9A-HJKMNP-TV-Z]{26}|svc:[a-z][a-z0-9-]{1,39})$/;
const QUOTA_FIELDS = { storage_bytes: 'storageBytes', deploys_per_day: 'deploysPerDay', max_files: 'maxFiles', max_file_bytes: 'maxFileBytes', sites: 'sites', custom_domains: 'customDomains' };
const DAY = 24 * 3600 * 1000;

function createProjects({ store, config, access, blobs, takedowns, log = console }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM host_projects WHERE id = ?'),
        forPrincipal: db.prepare(`SELECT p.*, m.role FROM host_projects p JOIN host_project_members m ON m.project_id = p.id
                                  WHERE m.principal = ? AND p.status = 'active' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 200`),
        all: db.prepare("SELECT p.*, NULL AS role FROM host_projects p WHERE p.status = 'active' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 200"),
        ownedCount: db.prepare("SELECT COUNT(*) AS n FROM host_projects WHERE owner_subject = ? AND status = 'active'"),
        insert: db.prepare(`INSERT INTO host_projects (id, network_project_id, owner_subject, name, environment, status, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`),
        addMember: db.prepare(`INSERT INTO host_project_members (project_id, principal, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT (project_id, principal) DO UPDATE SET role = excluded.role`),
        removeMember: db.prepare('DELETE FROM host_project_members WHERE project_id = ? AND principal = ?'),
        members: db.prepare('SELECT principal, role, added_by, created_at FROM host_project_members WHERE project_id = ? ORDER BY created_at'),
        quotaRow: db.prepare('SELECT * FROM host_quotas WHERE project_id = ?'),
        storageUsed: db.prepare('SELECT COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM host_blobs WHERE project_id = ?'),
        deploysSince: db.prepare('SELECT COUNT(*) AS n FROM host_deploys WHERE project_id = ? AND created_at > ?'),
        siteCount: db.prepare("SELECT COUNT(*) AS n FROM host_sites WHERE project_id = ? AND status = 'active'"),
        customDomainCount: db.prepare("SELECT COUNT(*) AS n FROM host_domains WHERE project_id = ? AND kind = 'custom' AND status IN ('pending','verified')"),
        markDeleted: db.prepare("UPDATE host_projects SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?"),
    };

    function get(id) {
        return isId('project', id) ? q.byId.get(id) || null : null;
    }

    /** The effective quota: the project's override where set, else the environment's default. */
    function quotaOf(project) {
        const defaults = config.quotas[project.environment] || config.quotas.production;
        const row = q.quotaRow.get(project.id) || {};
        const out = {};
        for (const [col, key] of Object.entries(QUOTA_FIELDS)) out[key] = row[col] != null ? row[col] : defaults[key];
        return out;
    }

    function usageOf(project) {
        const s = q.storageUsed.get(project.id);
        return {
            storageBytes: s.n,
            objects: s.c,
            deploysLast24h: q.deploysSince.get(project.id, store.now() - DAY).n,
            sites: q.siteCount.get(project.id).n,
            customDomains: q.customDomainCount.get(project.id).n,
        };
    }

    function create(viewer, input = {}) {
        const owner = principalOf(viewer);
        if (!owner || !ids.isSubjectId('user', owner)) {
            throw new ApiError(403, 'project.owner_must_be_user', 'a project is owned by a person (usr_…): an app or service must name the owner with X-OV-Subject');
        }
        const name = String(input.name || '').trim();
        if (!name || name.length > NAME_MAX) throw new ApiError(422, 'project.invalid_name', `a project needs a name of 1–${NAME_MAX} characters`);
        const environment = input.environment == null ? 'production' : String(input.environment);
        if (!['production', 'sandbox'].includes(environment)) throw new ApiError(422, 'project.invalid_environment', 'environment is production or sandbox');
        if (viewer.kind === 'service' && viewer.env === 'sandbox' && environment !== 'sandbox') {
            throw new ApiError(403, 'environment.sandbox_token', 'a sandbox credential can only create sandbox projects');
        }
        let networkProjectId = null;
        if (input.network_project_id != null && input.network_project_id !== '') {
            networkProjectId = String(input.network_project_id);
            if (!NETWORK_PROJECT_RE.test(networkProjectId)) throw new ApiError(422, 'project.invalid_network_project_id', 'network_project_id is not a project id');
        }
        const maxOwned = (config.projects && config.projects.maxPerOwner) || 10;
        if (q.ownedCount.get(owner).n >= maxOwned) throw new ApiError(429, 'quota.projects', `you already own ${maxOwned} projects`);
        const id = newId('project', store.now());
        const now = store.now();
        try {
            store.tx(() => {
                q.insert.run(id, networkProjectId, owner, name, environment, now, now);
                q.addMember.run(id, owner, 'owner', owner, now);
            });
        } catch (err) {
            if (/UNIQUE/.test(err.message)) throw new ApiError(409, 'project.network_project_taken', 'that Network project already has a Host project');
            throw err;
        }
        return get(id);
    }

    function listFor(viewer) {
        if (viewer.kind === 'user' && viewer.staff && viewer.allProjects) return q.all.all();
        const p = principalOf(viewer);
        return p ? q.forPrincipal.all(p) : [];
    }

    function members(project) {
        return q.members.all(project.id);
    }

    function setMember(viewer, project, principal, role) {
        access.authorize(project, viewer, 'own');
        if (!PRINCIPAL_RE.test(String(principal))) throw new ApiError(422, 'member.invalid_principal', 'a member is a usr_ subject, an app:app_ principal or a svc: principal');
        if (!['maintainer', 'deployer', 'owner'].includes(role)) throw new ApiError(422, 'member.invalid_role', 'role is owner, maintainer or deployer');
        if (role === 'owner' && !principal.startsWith('usr_')) throw new ApiError(422, 'member.invalid_role', 'only a person can be an owner');
        if (principal === project.owner_subject && role !== 'owner') throw new ApiError(409, 'member.owner_fixed', 'the project owner stays owner');
        q.addMember.run(project.id, principal, role, principalOf(viewer), store.now());
        return members(project);
    }

    function removeMember(viewer, project, principal) {
        access.authorize(project, viewer, 'own');
        if (principal === project.owner_subject) throw new ApiError(409, 'member.owner_fixed', 'the project owner cannot be removed');
        q.removeMember.run(project.id, principal);
        return members(project);
    }

    function setQuota(viewer, project, input = {}) {
        access.authorize(project, viewer, 'staff');
        const row = q.quotaRow.get(project.id) || {};
        const next = {};
        for (const col of Object.keys(QUOTA_FIELDS)) {
            if (!(col in input)) { next[col] = row[col] != null ? row[col] : null; continue; }
            const v = input[col];
            if (v === null) { next[col] = null; continue; }
            if (!Number.isSafeInteger(v) || v < 0) throw new ApiError(422, 'quota.invalid', `${col} must be a non-negative integer or null (the default)`);
            next[col] = v;
        }
        db.prepare(`INSERT INTO host_quotas (project_id, storage_bytes, deploys_per_day, max_files, max_file_bytes, sites, custom_domains, updated_by, updated_at)
                    VALUES (@project_id, @storage_bytes, @deploys_per_day, @max_files, @max_file_bytes, @sites, @custom_domains, @updated_by, @updated_at)
                    ON CONFLICT (project_id) DO UPDATE SET storage_bytes = excluded.storage_bytes, deploys_per_day = excluded.deploys_per_day,
                      max_files = excluded.max_files, max_file_bytes = excluded.max_file_bytes, sites = excluded.sites,
                      custom_domains = excluded.custom_domains, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run({ project_id: project.id, ...next, updated_by: principalOf(viewer), updated_at: store.now() });
        return quotaOf(project);
    }

    /** Owner (or staff) deletes the project: every site stops serving at once; objects are removed. */
    function remove(viewer, project, { sites }) {
        access.authorize(project, viewer, 'own');
        takedowns.assertDeletable(viewer, { projectId: project.id });
        const now = store.now();
        store.tx(() => {
            for (const s of sites.listForProject(project.id)) sites.markDeleted(s, now);
            db.prepare("UPDATE host_deploys SET state = 'deleted', deleted_at = ? WHERE project_id = ? AND state <> 'deleted'").run(now, project.id);
            db.prepare("DELETE FROM host_deploy_files WHERE deploy_id IN (SELECT id FROM host_deploys WHERE project_id = ?)").run(project.id);
            db.prepare('DELETE FROM host_blobs WHERE project_id = ?').run(project.id);
            db.prepare('DELETE FROM host_domains WHERE project_id = ?').run(project.id);
            q.markDeleted.run(now, now, project.id);
        });
        try { blobs.removeProject(project.id); } catch (err) { log.warn('[Host] could not remove project objects:', err.message); }
        return { deleted: true };
    }

    return { get, create, listFor, members, setMember, removeMember, quotaOf, usageOf, setQuota, remove, QUOTA_FIELDS };
}

module.exports = { createProjects };
