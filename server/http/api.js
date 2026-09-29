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
 *              GET/PUT/DELETE /sites/:id/config (headers, redirects, SPA fallback)  host.site.config
 *   deploys    GET/POST /sites/:id/deploys · GET /deploys/:id · GET /deploys/:id/log
 *              POST /deploys/:id/activate · POST /sites/:id/rollback              host.deploy.create
 *              DELETE /deploys/:id                                                host.site.manage
 *   domains    GET/POST /sites/:id/domains · POST /domains/:id/verify
 *              DELETE /domains/:id                                                host.domain.manage
 *   takedowns  POST/DELETE /projects/:id/takedown · POST/DELETE /sites/:id/takedown   host.site.manage (staff)
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody, privateNoStore, sendError, ApiError } = require('./errors');
const { guard } = require('../auth/viewer');
const { readUpload, UploadError } = require('./upload');
const out = require('./serialize');

const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

function createApi(ctx) {
    const { config, projects, sites, deploys, domains, siteConfig, viewers, takedowns } = ctx;
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
    if (ctx.actorLimits) router.use(ctx.actorLimits);

    const siteUrl = (hostname) => {
        const u = new URL(config.baseUrl);
        return `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ''}`;
    };
    const siteOut = async (s) => { const hostname = sites.defaultHostname(s.name); return out.site(s, { hostname, url: siteUrl(hostname), takedown: await takedowns.ofSite(s) }); };
    const projectOut = async (p, role) => out.project(p, { role, quota: await projects.quotaOf(p), usage: await projects.usageOf(p), takedown: await takedowns.ofProject(p.id) });
    const tp = (req) => (req.ov ? req.ov.traceparent : undefined);
    const loadProject = async (req, need) => {
        const project = await projects.get(req.params.id);
        const role = await ctx.access.authorize(project, req.viewer, need);
        return { project, role };
    };

    // ── Projects ────────────────────────────────────────────
    router.get('/projects', guard('host.site.manage'), run(async (req) => {
        if (req.viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in with OpenVibe, or present a service token');
        return { projects: (await Promise.all((await projects.listFor(req.viewer)).map(async (p) => out.project(p, { takedown: await takedowns.ofProject(p.id) })))) };
    }));
    router.post('/projects', guard('host.site.manage'), jsonBody, run(async (req) => {
        if (req.viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in with OpenVibe, or present a service token');
        const p = await projects.create(req.viewer, req.body || {});
        return { project: await projectOut(p, 'owner') };
    }, 201));
    router.get('/projects/:id', guard('host.site.manage'), run(async (req) => {
        const { project, role } = await loadProject(req, 'read');
        return { project: await projectOut(project, role), sites: (await Promise.all((await sites.listForProject(project.id)).map(siteOut))), members: (await projects.members(project)).map((m) => ({ principal: m.principal, role: m.role, added_at: out.iso(m.created_at) })) };
    }));
    router.delete('/projects/:id', guard('host.site.manage'), run(async (req) => {
        const { project } = await loadProject(req, 'read');
        return await projects.remove(req.viewer, project, { sites });
    }));
    router.get('/projects/:id/quota', guard('host.site.manage'), run(async (req) => {
        const { project } = await loadProject(req, 'read');
        return { quota: out.quotaOut(await projects.quotaOf(project)), usage: out.usageOut(await projects.usageOf(project)) };
    }));
    router.put('/projects/:id/quota', guard('host.site.manage'), jsonBody, run(async (req) => {
        const project = await projects.get(req.params.id);
        const q = await projects.setQuota(req.viewer, project, req.body || {});
        return { quota: out.quotaOut(q), usage: out.usageOut(await projects.usageOf(project)) };
    }));
    router.put('/projects/:id/members/:principal', guard('host.site.manage'), jsonBody, run(async (req) => {
        const { project } = await loadProject(req, 'read');
        const list = await projects.setMember(req.viewer, project, req.params.principal, String((req.body || {}).role || ''));
        return { members: list.map((m) => ({ principal: m.principal, role: m.role, added_at: out.iso(m.created_at) })) };
    }));
    router.delete('/projects/:id/members/:principal', guard('host.site.manage'), run(async (req) => {
        const { project } = await loadProject(req, 'read');
        const list = await projects.removeMember(req.viewer, project, req.params.principal);
        return { members: list.map((m) => ({ principal: m.principal, role: m.role, added_at: out.iso(m.created_at) })) };
    }));

    // ── Takedowns (staff only; members see them on the project and site) ──
    // Serving stops at once and the content is kept for review (domain/takedowns.js).
    router.post('/projects/:id/takedown', guard('host.site.manage'), jsonBody, run(async (req) => {
        const { project } = await loadProject(req, 'read');
        return { takedown: out.takedownOut(await takedowns.takeDown(req.viewer, 'project', project.id, (req.body || {}).reason)) };
    }, 201));
    router.delete('/projects/:id/takedown', guard('host.site.manage'), jsonBody, run(async (req) => {
        const { project } = await loadProject(req, 'read');
        return await takedowns.lift(req.viewer, 'project', project.id, (req.body || {}).note);
    }));
    router.post('/sites/:id/takedown', guard('host.site.manage'), jsonBody, run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'read');
        return { takedown: out.takedownOut(await takedowns.takeDown(req.viewer, 'site', site.id, (req.body || {}).reason)) };
    }, 201));
    router.delete('/sites/:id/takedown', guard('host.site.manage'), jsonBody, run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'read');
        return await takedowns.lift(req.viewer, 'site', site.id, (req.body || {}).note);
    }));

    // ── Sites ───────────────────────────────────────────────
    router.get('/projects/:id/sites', guard('host.site.manage'), run(async (req) => {
        const { project } = await loadProject(req, 'read');
        return { sites: (await Promise.all((await sites.listForProject(project.id)).map(siteOut))) };
    }));
    router.post('/projects/:id/sites', guard('host.site.manage'), jsonBody, run(async (req) => {
        const project = await projects.get(req.params.id);
        await ctx.access.authorize(project, req.viewer, 'read');
        return { site: await siteOut(await sites.create(req.viewer, project, req.body || {})) };
    }, 201));
    router.get('/sites/:id', guard('host.site.manage'), run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'read');
        return { site: await siteOut(site), domains: (await domains.listForSite(site.id)).map((d) => out.domain(d, domains.instructions(d, site))) };
    }));
    router.delete('/sites/:id', guard('host.site.manage'), run(async (req) => await sites.remove(req.viewer, req.params.id, { deploys })));

    // ── Deploys ─────────────────────────────────────────────
    router.get('/sites/:id/deploys', guard('host.deploy.create'), run(async (req) => {
        // Reads need the least member role (deployer); staff may read them too, e.g. to review a takedown.
        const { site } = await sites.load(req.viewer, req.params.id, 'read');
        return {
            active_deploy_id: site.active_deploy_id || null,
            deploys: (await deploys.list(site.id, Number(req.query.limit) || 50)).map((d) => out.deploy(d, { active: d.id === site.active_deploy_id })),
            activations: (await deploys.activationsOf(site.id, 20)).map(out.activation),
        };
    }));

    router.post('/sites/:id/deploys', guard('host.deploy.create'), async (req, res) => {
        let release = null;
        try {
            const pre = await deploys.precheck(req.viewer, req.params.id);
            release = ctx.uploadGate.enter();
            if (!release) { res.set('Retry-After', '30'); throw new ApiError(503, 'upload.busy', 'Host is validating other uploads right now; try again in 30 seconds'); }
            let up;
            try {
                up = await readUpload(req, { maxUploadBytes: config.uploads.maxUploadBytes, maxUnpackedBytes: config.uploads.maxUnpackedBytes, limits: pre.limits });
            } catch (err) {
                if (!(err instanceof UploadError)) throw err;
                if (err.closeConnection) res.set('Connection', 'close');
                const multipart = String(req.headers['content-type'] || '').startsWith('multipart/');
                const r = await deploys.recordFailure(req.viewer, pre, { source: err.source || (multipart ? 'files' : 'archive'), code: err.code, problems: [{ code: err.code, message: err.message }], traceparent: tp(req) });
                return contracts.http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov, extra: { deploy_id: r.deploy.id, log: r.log.map((l) => `${l.level}: ${l.message}`) } });
            }
            const preview = truthy(up.fields.preview != null ? up.fields.preview : req.query.preview);
            // A preview is never the site's active deploy; it is served only at /preview/<id>/ later.
            const activate = !preview && truthy(up.fields.activate != null ? up.fields.activate : req.query.activate);
            const r = await deploys.create(req.viewer, pre, up.entries, { source: up.source, activate, preview, notes: up.notes, traceparent: tp(req) });
            const site = await sites.get(pre.site.id);
            res.status(201).json({ deploy: out.deploy(r.deploy, { active: site.active_deploy_id === r.deploy.id, log: r.log }), activated: Boolean(r.activated && r.activated.changed), preview: r.preview, url: siteUrl(sites.defaultHostname(site.name)) });
        } catch (err) {
            // Refused before the body was read (404, 429, 503): close instead of draining a large upload.
            if (!req.complete) res.set('Connection', 'close');
            if (!res.headersSent) sendError(res, req, err);
        } finally {
            if (release) release();
        }
    });

    router.get('/deploys/:id', guard('host.deploy.create'), run(async (req) => {
        const { deploy, site } = await deploys.load(req.viewer, req.params.id, 'read');
        return { deploy: out.deploy(deploy, { active: site.active_deploy_id === deploy.id, files: await deploys.filesOf(deploy.id) }) };
    }));
    router.get('/deploys/:id/log', guard('host.deploy.create'), run(async (req) => {
        const { deploy } = await deploys.load(req.viewer, req.params.id, 'read');
        return { deploy_id: deploy.id, state: deploy.state, log: (await deploys.logOf(deploy.id)).map(out.logLine) };
    }));
    router.post('/deploys/:id/activate', guard('host.deploy.create'), jsonBody, run(async (req) => {
        const body = req.body || {};
        const r = await deploys.activate(req.viewer, req.params.id, { expectedActive: 'expected_active' in body ? body.expected_active : undefined, traceparent: tp(req) });
        return { active_deploy_id: r.deploy_id, previous_deploy_id: r.previous_deploy_id, changed: r.changed };
    }));
    router.post('/sites/:id/rollback', guard('host.deploy.create'), jsonBody, run(async (req) => {
        const body = req.body || {};
        const r = await deploys.rollback(req.viewer, req.params.id, { deployId: body.deploy_id || null, expectedActive: 'expected_active' in body ? body.expected_active : undefined, traceparent: tp(req) });
        return { active_deploy_id: r.deploy_id, previous_deploy_id: r.previous_deploy_id, changed: r.changed };
    }));
    router.delete('/deploys/:id', guard('host.site.manage'), run(async (req) => await deploys.remove(req.viewer, req.params.id)));

    // ── Domains ─────────────────────────────────────────────
    router.get('/sites/:id/domains', guard('host.domain.manage'), run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'read');
        return { domains: (await domains.listForSite(site.id)).map((d) => out.domain(d, domains.instructions(d, site))) };
    }));
    router.post('/sites/:id/domains', guard('host.domain.manage'), jsonBody, run(async (req) => {
        const { domain, site } = await domains.add(req.viewer, req.params.id, req.body || {});
        return { domain: out.domain(domain, domains.instructions(domain, site)) };
    }, 201));
    router.post('/domains/:id/verify', guard('host.domain.manage'), run(async (req) => {
        const d = await domains.verify(req.viewer, req.params.id, { traceparent: tp(req) });
        const site = await sites.get(d.site_id);
        return { domain: out.domain(d, domains.instructions(d, site)) };
    }));
    router.delete('/domains/:id', guard('host.domain.manage'), run(async (req) => await domains.remove(req.viewer, req.params.id)));

    // ── Per-site configuration: headers, redirects, SPA fallback (host.site.config) ──
    // Applied by http/tenant.js before the platform's headers; reserved headers are refused on write.
    router.get('/sites/:id/config', guard('host.site.config'), run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'read');
        return { config: await siteConfig.getForSite(site.id) };
    }));
    router.put('/sites/:id/config', guard('host.site.config'), jsonBody, run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'maintain');
        return { config: await siteConfig.set(req.viewer, site, req.body || {}) };
    }));
    router.delete('/sites/:id/config', guard('host.site.config'), run(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'maintain');
        return { config: await siteConfig.remove(site) };
    }));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: `no route ${req.method} ${req.baseUrl}${req.path}`, ctx: req.ov }));
    return router;
}

module.exports = { createApi };
