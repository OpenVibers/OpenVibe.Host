'use strict';
/**
 * /api/v1 — Host's API for people (a Network user JWT as a Bearer token) and principals (Network
 * client-credentials tokens for audience openvibe.host). Cookies are ignored here: tenant pages
 * on <site>.openvibe.host are same-site with openvibe.host, so cookie-authenticated API calls could
 * be forged from any tenant page.
 *
 *   projects   GET/POST /projects · GET/DELETE /projects/:id · GET/PUT /projects/:id/quota
 *              PUT/DELETE /projects/:id/members/:principal                        host.site.manage
 *   sites      GET/POST /projects/:id/sites · GET/DELETE /sites/:id                host.site.manage
 *   deploys    GET/POST /sites/:id/deploys · GET /deploys/:id · GET /deploys/:id/log
 *              POST /deploys/:id/activate · POST /sites/:id/rollback              host.deploy.create
 *              DELETE /deploys/:id                                                host.site.manage
 *   domains    GET/POST /sites/:id/domains · POST /domains/:id/verify
 *              DELETE /domains/:id                                                host.domain.manage
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody, privateNoStore, sendError, ApiError } = require('./errors');
const { guard } = require('../auth/viewer');
const { readUpload, UploadError } = require('./upload');
const out = require('./serialize');

const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

function createApi(ctx) {
    const { config, projects, sites, deploys, domains, viewers } = ctx;
    const router = express.Router();

    // CORS for first-party browser origins presenting a Bearer token (never credentials/cookies).
    router.use((req, res, next) => {
        const origin = req.get('origin');
        if (origin && config.apiCorsOrigins.includes(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        privateNoStore(res);
        next();
    });
    router.use(viewers.middleware('api'));

    const siteUrl = (hostname) => {
        const u = new URL(config.baseUrl);
        return `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ''}`;
    };
    const siteOut = (s) => { const hostname = sites.defaultHostname(s.name); return out.site(s, { hostname, url: siteUrl(hostname) }); };
    const projectOut = (p, role) => out.project(p, { role, quota: projects.quotaOf(p), usage: projects.usageOf(p) });
    const tp = (req) => (req.ov ? req.ov.traceparent : undefined);
    const loadProject = (req, need) => {
        const project = projects.get(req.params.id);
        const role = ctx.access.authorize(project, req.viewer, need);
        return { project, role };
    };

    // ── Projects ────────────────────────────────────────────
    router.get('/projects', guard('host.site.manage'), run((req) => {
        if (req.viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in with OpenVibe, or present a service token');
        return { projects: projects.listFor(req.viewer).map((p) => out.project(p)) };
    }));
    router.post('/projects', guard('host.site.manage'), jsonBody, run((req) => {
        if (req.viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in with OpenVibe, or present a service token');
        const p = projects.create(req.viewer, req.body || {});
        return { project: projectOut(p, 'owner') };
    }, 201));
    router.get('/projects/:id', guard('host.site.manage'), run((req) => {
        const { project, role } = loadProject(req, 'read');
        return { project: projectOut(project, role), sites: sites.listForProject(project.id).map(siteOut), members: projects.members(project).map((m) => ({ principal: m.principal, role: m.role, added_at: out.iso(m.created_at) })) };
    }));
    router.delete('/projects/:id', guard('host.site.manage'), run((req) => {
        const { project } = loadProject(req, 'read');
        return projects.remove(req.viewer, project, { sites });
    }));
    router.get('/projects/:id/quota', guard('host.site.manage'), run((req) => {
        const { project } = loadProject(req, 'read');
        return { quota: out.quotaOut(projects.quotaOf(project)), usage: out.usageOut(projects.usageOf(project)) };
    }));
    router.put('/projects/:id/quota', guard('host.site.manage'), jsonBody, run((req) => {
        const project = projects.get(req.params.id);
        const q = projects.setQuota(req.viewer, project, req.body || {});
        return { quota: out.quotaOut(q), usage: out.usageOut(projects.usageOf(project)) };
    }));
    router.put('/projects/:id/members/:principal', guard('host.site.manage'), jsonBody, run((req) => {
        const { project } = loadProject(req, 'read');
        const list = projects.setMember(req.viewer, project, req.params.principal, String((req.body || {}).role || ''));
        return { members: list.map((m) => ({ principal: m.principal, role: m.role, added_at: out.iso(m.created_at) })) };
    }));
    router.delete('/projects/:id/members/:principal', guard('host.site.manage'), run((req) => {
        const { project } = loadProject(req, 'read');
        const list = projects.removeMember(req.viewer, project, req.params.principal);
        return { members: list.map((m) => ({ principal: m.principal, role: m.role, added_at: out.iso(m.created_at) })) };
    }));

    // ── Sites ───────────────────────────────────────────────
    router.get('/projects/:id/sites', guard('host.site.manage'), run((req) => {
        const { project } = loadProject(req, 'read');
        return { sites: sites.listForProject(project.id).map(siteOut) };
    }));
    router.post('/projects/:id/sites', guard('host.site.manage'), jsonBody, run((req) => {
        const project = projects.get(req.params.id);
        ctx.access.authorize(project, req.viewer, 'read');
        return { site: siteOut(sites.create(req.viewer, project, req.body || {})) };
    }, 201));
    router.get('/sites/:id', guard('host.site.manage'), run((req) => {
        const { site } = sites.load(req.viewer, req.params.id, 'read');
        return { site: siteOut(site), domains: domains.listForSite(site.id).map((d) => out.domain(d, domains.instructions(d, site))) };
    }));
    router.delete('/sites/:id', guard('host.site.manage'), run((req) => sites.remove(req.viewer, req.params.id, { deploys })));

    // ── Deploys ─────────────────────────────────────────────
    router.get('/sites/:id/deploys', guard('host.deploy.create'), run((req) => {
        const { site } = sites.load(req.viewer, req.params.id, 'deploy');
        return {
            active_deploy_id: site.active_deploy_id || null,
            deploys: deploys.list(site.id, Number(req.query.limit) || 50).map((d) => out.deploy(d, { active: d.id === site.active_deploy_id })),
            activations: deploys.activationsOf(site.id, 20).map(out.activation),
        };
    }));

    router.post('/sites/:id/deploys', guard('host.deploy.create'), async (req, res) => {
        try {
            const pre = deploys.precheck(req.viewer, req.params.id);
            let up;
            try {
                up = await readUpload(req, { maxUploadBytes: config.uploads.maxUploadBytes, limits: pre.limits });
            } catch (err) {
                if (!(err instanceof UploadError)) throw err;
                if (err.closeConnection) res.set('Connection', 'close');
                const multipart = String(req.headers['content-type'] || '').startsWith('multipart/');
                const r = deploys.recordFailure(req.viewer, pre, { source: err.source || (multipart ? 'files' : 'archive'), code: err.code, problems: [{ code: err.code, message: err.message }], traceparent: tp(req) });
                return contracts.http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov, extra: { deploy_id: r.deploy.id, log: r.log.map((l) => `${l.level}: ${l.message}`) } });
            }
            const activate = truthy(up.fields.activate != null ? up.fields.activate : req.query.activate);
            const r = deploys.create(req.viewer, pre, up.entries, { source: up.source, activate, notes: up.notes, traceparent: tp(req) });
            const site = sites.get(pre.site.id);
            res.status(201).json({ deploy: out.deploy(r.deploy, { active: site.active_deploy_id === r.deploy.id, log: r.log }), activated: Boolean(r.activated && r.activated.changed), url: siteUrl(sites.defaultHostname(site.name)) });
        } catch (err) {
            // Refused before the body was read (404, 429): close instead of draining a large upload.
            if (!req.complete) res.set('Connection', 'close');
            if (!res.headersSent) sendError(res, req, err);
        }
    });

    router.get('/deploys/:id', guard('host.deploy.create'), run((req) => {
        const { deploy, site } = deploys.load(req.viewer, req.params.id, 'deploy');
        return { deploy: out.deploy(deploy, { active: site.active_deploy_id === deploy.id, files: deploys.filesOf(deploy.id) }) };
    }));
    router.get('/deploys/:id/log', guard('host.deploy.create'), run((req) => {
        const { deploy } = deploys.load(req.viewer, req.params.id, 'deploy');
        return { deploy_id: deploy.id, state: deploy.state, log: deploys.logOf(deploy.id).map(out.logLine) };
    }));
    router.post('/deploys/:id/activate', guard('host.deploy.create'), jsonBody, run((req) => {
        const body = req.body || {};
        const r = deploys.activate(req.viewer, req.params.id, { expectedActive: 'expected_active' in body ? body.expected_active : undefined, traceparent: tp(req) });
        return { active_deploy_id: r.deploy_id, previous_deploy_id: r.previous_deploy_id, changed: r.changed };
    }));
    router.post('/sites/:id/rollback', guard('host.deploy.create'), jsonBody, run((req) => {
        const body = req.body || {};
        const r = deploys.rollback(req.viewer, req.params.id, { deployId: body.deploy_id || null, expectedActive: 'expected_active' in body ? body.expected_active : undefined, traceparent: tp(req) });
        return { active_deploy_id: r.deploy_id, previous_deploy_id: r.previous_deploy_id, changed: r.changed };
    }));
    router.delete('/deploys/:id', guard('host.site.manage'), run((req) => deploys.remove(req.viewer, req.params.id)));

    // ── Domains ─────────────────────────────────────────────
    router.get('/sites/:id/domains', guard('host.domain.manage'), run((req) => {
        const { site } = sites.load(req.viewer, req.params.id, 'read');
        return { domains: domains.listForSite(site.id).map((d) => out.domain(d, domains.instructions(d, site))) };
    }));
    router.post('/sites/:id/domains', guard('host.domain.manage'), jsonBody, run((req) => {
        const { domain, site } = domains.add(req.viewer, req.params.id, req.body || {});
        return { domain: out.domain(domain, domains.instructions(domain, site)) };
    }, 201));
    router.post('/domains/:id/verify', guard('host.domain.manage'), run(async (req) => {
        const d = await domains.verify(req.viewer, req.params.id, { traceparent: tp(req) });
        const site = sites.get(d.site_id);
        return { domain: out.domain(d, domains.instructions(d, site)) };
    }));
    router.delete('/domains/:id', guard('host.domain.manage'), run((req) => domains.remove(req.viewer, req.params.id)));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: `no route ${req.method} ${req.baseUrl}${req.path}`, ctx: req.ov }));
    return router;
}

module.exports = { createApi };
