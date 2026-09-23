'use strict';
/**
 * Who may do what on a project.
 *
 *   principal   a browser user: its usr_ subject. A first-party service token (svc:…): the person
 *               named by X-OV-Subject, else the service itself. An app token (app:app_…): the app
 *               itself — apps are principals (ADR-014) and never act as a person here.
 *   roles       owner > maintainer > deployer, per project (host_project_members).
 *                 deployer    upload deploys, list them and their logs, activate, roll back
 *                 maintainer  + sites, custom domains, delete deploys
 *                 owner       + delete the project, manage members
 *   staff       Network admins: read everything, delete sites/projects/domains, set quotas; they
 *               cannot publish into a tenant's site.
 *
 * A caller who is not a member gets 404 for the project and everything in it (existence is not
 * revealed). A sandbox token (claim env = "sandbox") is refused on production projects.
 */
const { ApiError } = require('../http/errors');

const RANK = { deployer: 1, maintainer: 2, owner: 3 };
const NEED = { read: 1, deploy: 1, maintain: 2, own: 3 };

function principalOf(viewer) {
    if (!viewer) return null;
    if (viewer.kind === 'user') return viewer.subject || null;
    if (viewer.kind === 'service') {
        if (viewer.subject && /^svc:/.test(viewer.service)) return viewer.subject;
        return viewer.service;
    }
    return null;
}

/** The person accountable for an action: a usr_ subject when there is one. */
function actorOf(viewer) {
    return principalOf(viewer) || 'anonymous';
}

function actorRef(viewer) {
    const p = principalOf(viewer);
    if (p && p.startsWith('usr_')) return { type: 'user', id: p };
    if (p && p.startsWith('app:')) return { type: 'app', id: p.slice(4) };
    if (p && p.startsWith('svc:')) return { type: 'service', id: p.slice(4) };
    return { type: 'service', id: 'host' };
}

function createAccess({ store }) {
    const { db } = store;
    const memberStmt = db.prepare('SELECT role FROM host_project_members WHERE project_id = ? AND principal = ?');

    function roleOf(project, viewer) {
        const p = principalOf(viewer);
        if (!p) return null;
        const row = memberStmt.get(project.id, p);
        return row ? row.role : null;
    }

    /**
     * Throws unless the viewer may act on the project at `need` (read|deploy|maintain|own|staff).
     * `notFound` is the problem thrown when the viewer has no business knowing the resource exists.
     */
    function authorize(project, viewer, need, notFound = new ApiError(404, 'project.not_found', 'no such project')) {
        if (!project || project.status !== 'active') throw notFound;
        if (!viewer || viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in with OpenVibe, or present a service token');
        if (viewer.kind === 'service' && viewer.env === 'sandbox' && project.environment !== 'sandbox') {
            throw new ApiError(403, 'environment.sandbox_token', 'a sandbox credential cannot act on a production project');
        }
        if (need === 'staff') {
            if (viewer.staff) return 'staff';
            throw new ApiError(403, 'auth.staff_only', 'only OpenVibe staff can change quotas');
        }
        const role = roleOf(project, viewer);
        if (!role) {
            if (viewer.staff && need !== 'deploy') return 'staff';
            throw notFound;
        }
        if (RANK[role] < NEED[need]) throw new ApiError(403, 'project.role_insufficient', `this needs the ${need === 'own' ? 'owner' : need === 'maintain' ? 'maintainer' : 'deployer'} role; you are ${role}`);
        return role;
    }

    return { authorize, roleOf };
}

module.exports = { createAccess, principalOf, actorOf, actorRef, RANK };
