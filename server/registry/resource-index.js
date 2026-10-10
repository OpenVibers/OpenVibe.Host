'use strict';
/**
 * Host's authority resource index (ADR-048 section 3; capability host.resource.read):
 *
 *   GET /api/v1/resources[?project=&kind=&owner=&cursor=&limit=]  → common.resource-list-result@1
 *   GET /api/v1/resources/:ovrn                            → common.resource-summary@1
 *
 * It pages the resources OpenVibe.Host owns — its tenant sites (sit_), the immutable deploys of those
 * sites (dpl_) and their default and custom domains (dom_), each from its own table — as
 * common.resource-summary@1, the shape OpenVibe.Services fans out over and merges
 * (openvibe-sdk/resources' createResourceIndex). It is the same shape and the same path
 * OpenVibe.Network's index answers (server/registry/resource-index.js there).
 *
 * Host lists no projects: Host mints its own prj_ ids until it adopts Network projects (ADR-014), and
 * only Network lists projects (ADR-048, step 8). Every summary still carries the project_id of the
 * project that owns it, which is the tenancy boundary.
 *
 * Tenancy: `?project=prj_…` is the caller's tenancy boundary. With it, only that project's resources
 * answer — a resource of another project is never returned. Without it the first-party caller (the
 * capability is first-party, resourceConstraints none) sees every Host-owned resource, which is what an
 * authority-wide fan-out needs.
 *
 * OVRN: a summary's ovrn is computed with openvibe-contracts' contracts.resources.nameOf, the one
 * formatter, so it is present exactly when the resource is a nameable resource. All three Host kinds
 * are: sit_, dpl_ and dom_ carry a three-letter prefix and the resource carries a project, so every
 * summary is named ovrn:host:<prj_…>:<type>/<id> — and that is also what GET /api/v1/resources/:ovrn
 * can read: only a resource whose computed ovrn equals the one asked for answers.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
// Host's JSON handler wrapper: a rejected handler reaches the app's error handler, and these handlers
// write their own response. Express 4 does not catch a rejected async handler.
const { run } = require('../http/errors');

const SERVICE = 'host';
const SITE_KIND = 'host.site';
const DEPLOY_KIND = 'host.deploy';
const DOMAIN_KIND = 'host.domain';
const KINDS = [SITE_KIND, DEPLOY_KIND, DOMAIN_KIND];
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER_ID_RE = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** A subject-ref {type:'user', id} for a stored subject, or null when it is not a usr_ id. */
const userRef = (subject) => (USER_SUBJECT_RE.test(String(subject || '')) ? { type: 'user', id: subject } : null);

/** common.resource-summary@1 for a host_sites row. A site is named by the label it is served at. */
function siteSummary(s) {
    return {
        id: s.id, kind: SITE_KIND, service: SERVICE, project_id: s.project_id,
        ...(userRef(s.created_by) ? { owner: userRef(s.created_by) } : {}),
        name: s.name, state: s.status, created_at: new Date(Number(s.created_at)).toISOString(),
    };
}

/** common.resource-summary@1 for a host_deploys row. A deploy has no name of its own. */
function deploySummary(d) {
    return {
        id: d.id, kind: DEPLOY_KIND, service: SERVICE, project_id: d.project_id,
        ...(userRef(d.created_by) ? { owner: userRef(d.created_by) } : {}),
        state: d.state, created_at: new Date(Number(d.created_at)).toISOString(),
    };
}

/** common.resource-summary@1 for a host_domains row: a domain's name is the hostname it answers on. */
function domainSummary(d) {
    return {
        id: d.id, kind: DOMAIN_KIND, service: SERVICE, project_id: d.project_id,
        ...(userRef(d.created_by) ? { owner: userRef(d.created_by) } : {}),
        name: d.hostname, state: d.status, created_at: new Date(Number(d.created_at)).toISOString(),
    };
}

/** The summary's ovrn, or null when it has none: contracts.resources.nameOf is the one formatter. */
function ovrnOf(summary) {
    return contracts.resources.nameOf(summary);
}

/** The summary with its ovrn attached when it has one. */
function named(summary) {
    const ovrn = ovrnOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** A stable (kind, id) ordering, so a cursor can be a position in it. */
const order = (x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** The summaries matching the project, kind and owner filters, sorted by (kind, id). */
// Scope: host.resource.read is first-party (resourceConstraints none), so its holder sees every project and
// ?project= only narrows. If it is ever granted to a non-first-party principal, derive the scope from that
// principal's grants here instead of trusting the query.
async function collect(db, { project = null, kind = null, owner = null } = {}) {
    // Only usr_ subjects become summary owners; an agt_ subject cannot match any Host summary.
    if (owner && !USER_SUBJECT_RE.test(owner)) return [];
    const clauses = [];
    const values = [];
    if (project) { clauses.push('project_id = ?'); values.push(project); }
    if (owner) { clauses.push('created_by = ?'); values.push(owner); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const out = [];
    if (!kind || kind === SITE_KIND) {
        const rows = await db.prepare(`SELECT * FROM host_sites${where} ORDER BY id`).all(...values);
        for (const r of rows) out.push(named(siteSummary(r)));
    }
    if (!kind || kind === DEPLOY_KIND) {
        const rows = await db.prepare(`SELECT * FROM host_deploys${where} ORDER BY id`).all(...values);
        for (const r of rows) out.push(named(deploySummary(r)));
    }
    if (!kind || kind === DOMAIN_KIND) {
        const rows = await db.prepare(`SELECT * FROM host_domains${where} ORDER BY id`).all(...values);
        for (const r of rows) out.push(named(domainSummary(r)));
    }
    return out.sort(order);
}

/** A cursor is an opaque base64url [kind, id] position; only one this index issued decodes to that. */
const encodeCursor = (s) => Buffer.from(JSON.stringify([s.kind, s.id])).toString('base64url');
function decodeCursor(raw) {
    let v;
    try { v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? v : null;
}
const afterCursor = (s, [kind, id]) => s.kind > kind || (s.kind === kind && s.id > id);

/** The query as filters, or { error } for a value that cannot be honoured. An unknown kind is kept (it matches nothing). */
function filtersOf(query) {
    const project = typeof query.project === 'string' && query.project !== '' ? query.project : null;
    if (project && !PROJECT_ID_RE.test(project)) return { error: 'project must be a prj_ id' };
    const owner = typeof query.owner === 'string' && query.owner !== '' ? query.owner : null;
    if (query.owner != null && query.owner !== '' && (!owner || !OWNER_ID_RE.test(owner))) return { error: 'owner must be a usr_ or agt_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, owner, limit, cursor };
}

/** The OVRN type segment → the table and summary it belongs to. */
const OF_TYPE = {
    site: { table: 'host_sites', summary: siteSummary },
    deploy: { table: 'host_deploys', summary: deploySummary },
    domain: { table: 'host_domains', summary: domainSummary },
};

function router({ guard }) {
    const open = (res) => res.set('Cache-Control', 'private, max-age=60');
    const bad = (res, detail) => contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail });
    const unknown = (res, name) => contracts.http.sendProblem(res, 404, 'resources.unknown_resource', { detail: `no resource named ${name}` });

    /**
     * The resource index is read by first-party services for OpenVibe.Services' fan-out; a person holds
     * no service token and the capability is first-party, so only a service token reaches the guard.
     */
    function firstParty(req, res, next) {
        const v = req.viewer;
        if (v && v.kind === 'service') return next();
        if (!v || v.kind === 'anonymous') return contracts.http.sendProblem(res, 401, 'auth.required', { detail: 'the resource index is read by first-party services: present a service token for audience openvibe.host', ctx: req.ov });
        return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: `${SERVICE}.resource.read is first-party and not granted to a person`, ctx: req.ov });
    }

    /** One common.resource-list-result@1 page: the filtered, sorted summaries from the cursor, then `limit` of them. */
    async function page(req, res) {
        const f = filtersOf(req.query);
        if (f.error) return bad(res, f.error);
        const all = await collect(req.app.locals.ctx.store.db, f);
        const rest = f.cursor ? all.filter((s) => afterCursor(s, f.cursor)) : all;
        const resources = rest.slice(0, f.limit);
        const next_cursor = rest.length > f.limit ? encodeCursor(resources[resources.length - 1]) : null;
        open(res).json({ resources, next_cursor });
    }

    /** GET /api/v1/resources/:ovrn: the summary whose computed ovrn is exactly the one asked for. */
    async function one(req, res) {
        const name = String(req.params.ovrn);
        const parsed = contracts.resources.parse(name);
        let summary = null;
        if (parsed && parsed.service === SERVICE && OF_TYPE[parsed.type]) {
            const db = req.app.locals.ctx.store.db;
            const row = await db.prepare(`SELECT * FROM ${OF_TYPE[parsed.type].table} WHERE id = ?`).get(parsed.id);
            if (row) summary = named(OF_TYPE[parsed.type].summary(row));
        }
        if (!summary || summary.ovrn !== name) return unknown(res, name);
        open(res).json(summary);
    }

    const r = express.Router();
    r.use(firstParty);
    r.get('/', guard, run(page));
    r.get('/:ovrn', guard, run(one));
    return r;
}

module.exports = {
    router, SERVICE, KINDS, SITE_KIND, DEPLOY_KIND, DOMAIN_KIND, DEFAULT_LIMIT, MAX_LIMIT,
    siteSummary, deploySummary, domainSummary, ovrnOf, collect, encodeCursor, filtersOf,
};
