'use strict';
/**
 * Sites: a name (served at <name>.<sitesDomain>) and the pointer to the deploy it serves.
 *
 * Names are one DNS label: 3–40 characters of a–z, 0–9 and single hyphens. Names that could be
 * mistaken for the platform (www, api, admin, openvibe, …) are reserved. A deleted site's name is
 * held for 30 days so nobody else can pick it up and serve content on links that still point there.
 */
const { newId, isId } = require('../ids');
const { ApiError } = require('../http/errors');
const { principalOf } = require('./access');

const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;
const RESERVED = new Set([
    'www', 'api', 'app', 'apps', 'admin', 'administrator', 'root', 'dashboard', 'console', 'host', 'hosting', 'static', 'assets', 'cdn',
    'edge', 'origin', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ssh', 'vpn', 'ns', 'ns1', 'ns2', 'dns', 'mx', 'status', 'metrics',
    'health', 'auth', 'login', 'signin', 'sso', 'oauth', 'account', 'accounts', 'billing', 'pay', 'payments', 'wallet', 'support', 'help',
    'docs', 'blog', 'news', 'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'openvibe', 'openvibers', 'network', 'live',
    'media', 'community', 'events', 'chat', 'tools', 'codes', 'sites', 'sandbox', 'staging', 'test', 'internal', 'localhost', 'wpad',
    'autoconfig', 'autodiscover', 'isatap', 'acme', 'well-known',
]);
const HOLD_MS = 30 * 24 * 3600 * 1000;

function createSites({ store, config, access, projects, takedowns }) {
    const { db } = store;
    const reserved = new Set([...RESERVED, ...config.sites.extraReservedNames]);
    const q = {
        byId: db.prepare('SELECT * FROM host_sites WHERE id = ?'),
        byName: db.prepare("SELECT * FROM host_sites WHERE name = ? AND status = 'active'"),
        held: db.prepare("SELECT project_id FROM host_sites WHERE name = ? AND status = 'deleted' AND deleted_at > ? ORDER BY deleted_at DESC LIMIT 1"),
        forProject: db.prepare("SELECT * FROM host_sites WHERE project_id = ? AND status = 'active' ORDER BY created_at, seq"),
        insert: db.prepare(`INSERT INTO host_sites (id, project_id, name, active_deploy_id, status, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`),
        insertDefaultDomain: db.prepare(`INSERT INTO host_domains (id, project_id, site_id, hostname, kind, status, token, created_by, created_at, verified_at)
                                         VALUES (?, ?, ?, ?, 'default', 'verified', NULL, ?, ?, ?)`),
        markDeleted: db.prepare("UPDATE host_sites SET status = 'deleted', active_deploy_id = NULL, deleted_at = ?, updated_at = ? WHERE id = ?"),
    };

    const defaultHostname = (name) => `${name}.${config.sitesDomain}`;

    async function get(id) {
        return isId('site', id) ? await q.byId.get(id) || null : null;
    }

    /** The site and its project, authorized at `need`; 404 for anyone without access. */
    async function load(viewer, id, need) {
        const site = await get(id);
        const notFound = new ApiError(404, 'site.not_found', 'no such site');
        if (!site || site.status !== 'active') throw notFound;
        const project = await projects.get(site.project_id);
        const role = await access.authorize(project, viewer, need, notFound);
        return { site, project, role };
    }

    function checkName(name) {
        if (typeof name !== 'string' || !NAME_RE.test(name)) {
            throw new ApiError(422, 'site.invalid_name', 'a site name is 3–40 characters: a–z, 0–9 and single hyphens, starting and ending with a letter or digit');
        }
        if (reserved.has(name) || /^xn--/.test(name) || /^openvibe/.test(name)) throw new ApiError(422, 'site.name_reserved', `"${name}" is reserved`);
    }

    async function create(viewer, project, input = {}) {
        await access.authorize(project, viewer, 'maintain');
        const name = String(input.name || '').trim().toLowerCase();
        checkName(name);
        const quota = await projects.quotaOf(project);
        if ((await projects.usageOf(project)).sites >= quota.sites) throw new ApiError(429, 'quota.sites', `this project may have ${quota.sites} sites`);
        if (await q.byName.get(name)) throw new ApiError(409, 'site.name_taken', `${defaultHostname(name)} is taken`);
        const held = await q.held.get(name, store.now() - HOLD_MS);
        if (held && held.project_id !== project.id) throw new ApiError(409, 'site.name_held', `${defaultHostname(name)} was deleted recently and is held for 30 days`);
        const id = newId('site', store.now());
        const now = store.now();
        const who = principalOf(viewer);
        try {
            await store.tx(async () => {
                await q.insert.run(id, project.id, name, who, now, now);
                await q.insertDefaultDomain.run(newId('domain', now), project.id, id, defaultHostname(name), who, now, now);
            });
        } catch (err) {
            if (err.code === '23505') throw new ApiError(409, 'site.name_taken', `${defaultHostname(name)} is taken`);
            throw err;
        }
        return await get(id);
    }

    async function listForProject(projectId) {
        return await q.forProject.all(projectId);
    }

    /** Inside a transaction: the site stops serving immediately; deploys and domains go with it. */
    async function markDeleted(site, now) {
        await q.markDeleted.run(now, now, site.id);
        await db.prepare("UPDATE host_deploys SET state = 'deleted', deleted_at = ? WHERE site_id = ? AND state <> 'deleted'").run(now, site.id);
        await db.prepare('DELETE FROM host_deploy_files WHERE deploy_id IN (SELECT id FROM host_deploys WHERE site_id = ?)').run(site.id);
        await db.prepare('DELETE FROM host_domains WHERE site_id = ?').run(site.id);
    }

    async function remove(viewer, id, { deploys }) {
        const { site, project } = await load(viewer, id, 'maintain');
        await takedowns.assertDeletable(viewer, { site });
        const now = store.now();
        let freed = [];
        await store.tx(async () => {
            await markDeleted(site, now);
            freed = await deploys.collectGarbage(project.id);
        });
        deploys.unlinkBlobs(project.id, freed);
        return { deleted: true };
    }

    return { get, load, create, listForProject, markDeleted, remove, defaultHostname, checkName, byName: async (n) => await q.byName.get(n) || null };
}

module.exports = { createSites, RESERVED, NAME_RE };
