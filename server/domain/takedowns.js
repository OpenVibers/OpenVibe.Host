'use strict';
/**
 * Abuse takedowns, by OpenVibe staff only (Network role admin).
 *
 * A takedown stops a site, or every site of a project, from being served at once: its default and
 * custom domains answer 451 with no tenant content. Unlike a delete, it KEEPS the deploys, their
 * file rows, logs and objects, so a report can be reviewed and, where the law requires it, the
 * material preserved and handed over. While a takedown is active the project's members cannot
 * upload, activate, roll back or delete anything it covers; staff can still delete. Every takedown
 * and every lift stays in host_takedowns.
 *
 * Members see that their site is taken down, and why (site/project `takedown` in the API).
 */
const { ApiError } = require('../http/errors');
const { principalOf } = require('./access');

const REASON_MAX = 500;

function createTakedowns({ store }) {
    const { db } = store;
    const q = {
        forSite: db.prepare(`SELECT target_kind, reason, created_at FROM host_takedowns
                             WHERE lifted_at IS NULL AND ((target_kind = 'site' AND target_id = ?) OR (target_kind = 'project' AND target_id = ?))
                             ORDER BY target_kind = 'project' DESC, created_at LIMIT 1`),
        forProject: db.prepare("SELECT target_kind, reason, created_at FROM host_takedowns WHERE lifted_at IS NULL AND target_kind = 'project' AND target_id = ?"),
        anyInProject: db.prepare(`SELECT target_kind, reason, created_at FROM host_takedowns t
                                  WHERE lifted_at IS NULL AND ((target_kind = 'project' AND target_id = @p)
                                     OR (target_kind = 'site' AND target_id IN (SELECT id FROM host_sites WHERE project_id = @p AND status = 'active')))
                                  LIMIT 1`),
        insert: db.prepare('INSERT INTO host_takedowns (target_kind, target_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)'),
        lift: db.prepare('UPDATE host_takedowns SET lifted_by = ?, lifted_at = ?, lift_note = ? WHERE target_kind = ? AND target_id = ? AND lifted_at IS NULL'),
    };

    const shape = (row) => (row ? { scope: row.target_kind, reason: row.reason, since: row.created_at } : null);

    /** The takedown that covers a site (its own, or its project's), or null. */
    const ofSite = (site) => shape(q.forSite.get(site.id, site.project_id));
    /** The project-wide takedown, or null. */
    const ofProject = (projectId) => shape(q.forProject.get(projectId));

    /** Members may not publish into, or change, content that is taken down. */
    function assertOpen(site) {
        const t = ofSite(site);
        if (t) throw new ApiError(403, 'site.taken_down', `this ${t.scope} was taken down by OpenVibe staff (${t.reason}); nothing can be published or changed until staff lift it`);
    }

    /** Deleting taken-down content would destroy what staff are reviewing: staff only. */
    function assertDeletable(viewer, { site = null, projectId = null }) {
        if (viewer && viewer.staff) return;
        const row = site ? q.forSite.get(site.id, site.project_id) : q.anyInProject.get({ p: projectId });
        if (row) throw new ApiError(409, 'site.taken_down', `this ${row.target_kind} was taken down by OpenVibe staff and is kept for review; it cannot be deleted until staff lift the takedown`);
    }

    function requireStaff(viewer) {
        if (!viewer || !viewer.staff) throw new ApiError(403, 'auth.staff_only', 'only OpenVibe staff can take content down or lift a takedown');
    }

    /** kind: 'site' | 'project'. -> the takedown */
    function takeDown(viewer, kind, targetId, reasonRaw) {
        requireStaff(viewer);
        const reason = String(reasonRaw || '').trim();
        if (!reason || reason.length > REASON_MAX) throw new ApiError(422, 'takedown.reason_required', `a takedown needs a reason of 1–${REASON_MAX} characters (members see it)`);
        try {
            q.insert.run(kind, targetId, reason, principalOf(viewer), store.now());
        } catch (err) {
            if (/UNIQUE/.test(err.message)) throw new ApiError(409, 'takedown.exists', `this ${kind} is already taken down`);
            throw err;
        }
        return { scope: kind, reason, since: store.now() };
    }

    function lift(viewer, kind, targetId, note) {
        requireStaff(viewer);
        const r = q.lift.run(principalOf(viewer), store.now(), note == null ? null : String(note).slice(0, REASON_MAX), kind, targetId);
        if (r.changes !== 1) throw new ApiError(404, 'takedown.not_found', `this ${kind} is not taken down`);
        return { lifted: true };
    }

    return { ofSite, ofProject, assertOpen, assertDeletable, takeDown, lift };
}

module.exports = { createTakedowns };
