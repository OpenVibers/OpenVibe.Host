'use strict';
/**
 * The dashboard: server-rendered pages for projects, sites, deploys (with rollback), domains
 * (with DNS instructions), quotas and upload logs. Every action is a POST form that must come from
 * the dashboard's own origin and carry the form token (see auth/forms.js for why SameSite is not
 * enough on openvibe.host). Every response is private and never cached by a shared cache.
 */
const express = require('express');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const { readUpload, UploadError } = require('./upload');
const { ApiError, privateNoStore } = require('./errors');

function createDashboard(ctx) {
    const { config, projects, sites, deploys, domains, viewers, access, log = console } = ctx;
    const router = express.Router();
    const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });

    const siteUrl = (s) => {
        const u = new URL(config.baseUrl);
        return `${u.protocol}//${sites.defaultHostname(s.name)}${u.port ? `:${u.port}` : ''}`;
    };

    router.use(viewers.middleware('dashboard'));
    router.use((req, res, next) => { privateNoStore(res); next(); });

    function page(req, res, status, title, body, notice) {
        res.status(status).type('html').send(renderPage({ title, body, viewer: req.viewer, config, path: req.originalUrl, notice }));
    }

    function fail(req, res, err) {
        if (err instanceof ApiError || (err && Number.isInteger(err.status) && err.code)) {
            if (err.status === 401) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
            return page(req, res, err.status, 'Error', pages.errorPage({ status: err.status, message: err.message }));
        }
        log.error('[Host dashboard]', err && err.stack ? err.stack : err);
        return page(req, res, 500, 'Error', pages.errorPage({ status: 500, message: 'Something went wrong on our side. Try again in a moment.' }));
    }

    const view = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) { fail(req, res, err); }
    };

    /** POST guard: signed in, same origin, valid form token (urlencoded forms). */
    const action = (fn) => [urlencoded, async (req, res) => {
        try {
            if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
            if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body && req.body.csrf)) throw new ApiError(403, 'form.invalid', 'this form expired or did not come from this dashboard; reload the page and try again');
            const to = await fn(req, res);
            if (to && !res.headersSent) res.redirect(303, to);
        } catch (err) { fail(req, res, err); }
    }];

    const notice = (req) => {
        const n = req.query.notice;
        return typeof n === 'string' && n.length < 300 ? { kind: req.query.kind === 'error' ? 'error' : 'info', text: n } : null;
    };
    const back = (path, text, kind) => `${path}?notice=${encodeURIComponent(text)}${kind ? `&kind=${kind}` : ''}`;

    // ── Pages ───────────────────────────────────────────────
    router.get('/', view((req, res) => {
        if (req.viewer.kind !== 'user') return page(req, res, 200, null, pages.signedOut());
        page(req, res, 200, 'Projects', pages.home({ projects: projects.listFor(req.viewer), csrf: csrfToken(config, req.viewer) }), notice(req));
    }));

    router.get('/projects/:id', view((req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
        const project = projects.get(req.params.id);
        const role = access.authorize(project, req.viewer, 'read');
        page(req, res, 200, project.name, pages.project({
            project, role, sites: sites.listForProject(project.id), quota: projects.quotaOf(project), usage: projects.usageOf(project),
            members: projects.members(project), csrf: csrfToken(config, req.viewer), siteUrl,
        }), notice(req));
    }));

    router.get('/sites/:id', view((req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
        const { site, project, role } = sites.load(req.viewer, req.params.id, 'read');
        page(req, res, 200, site.name, pages.site({
            site, project, role, url: siteUrl(site), csrf: csrfToken(config, req.viewer),
            deploys: deploys.list(site.id, 50), activations: deploys.activationsOf(site.id, 10),
            domains: domains.listForSite(site.id).map((d) => ({ domain: d, instructions: domains.instructions(d, site) })),
        }), notice(req));
    }));

    router.get('/deploys/:id', view((req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
        const { deploy, site, project } = deploys.load(req.viewer, req.params.id, 'deploy');
        page(req, res, 200, `Deploy ${deploy.id.slice(0, 12)}`, pages.deploy({
            deploy, site, project, active: site.active_deploy_id === deploy.id, files: deploys.filesOf(deploy.id), log: deploys.logOf(deploy.id),
        }), notice(req));
    }));

    // ── Actions ─────────────────────────────────────────────
    router.post('/projects', action((req) => {
        const p = projects.create(req.viewer, { name: req.body.name, environment: req.body.environment });
        return back(`/projects/${p.id}`, 'Project created.');
    }));
    router.post('/projects/:id/sites', action((req) => {
        const project = projects.get(req.params.id);
        access.authorize(project, req.viewer, 'read');
        const s = sites.create(req.viewer, project, { name: req.body.name });
        return back(`/sites/${s.id}`, `Site created: ${siteUrl(s)}`);
    }));
    router.post('/projects/:id/members', action((req) => {
        const project = projects.get(req.params.id);
        access.authorize(project, req.viewer, 'read');
        projects.setMember(req.viewer, project, String(req.body.principal || '').trim(), String(req.body.role || ''));
        return back(`/projects/${project.id}`, 'Member saved.');
    }));
    router.post('/projects/:id/members/remove', action((req) => {
        const project = projects.get(req.params.id);
        access.authorize(project, req.viewer, 'read');
        projects.removeMember(req.viewer, project, String(req.body.principal || ''));
        return back(`/projects/${project.id}`, 'Member removed.');
    }));
    router.post('/projects/:id/delete', action((req) => {
        const project = projects.get(req.params.id);
        access.authorize(project, req.viewer, 'read');
        if (req.body.confirm !== 'yes') throw new ApiError(422, 'form.confirm', 'tick the confirmation box to delete');
        projects.remove(req.viewer, project, { sites });
        return back('/', 'Project deleted.');
    }));
    router.post('/sites/:id/domains', action((req) => {
        const { domain } = domains.add(req.viewer, req.params.id, { hostname: req.body.hostname });
        return back(`/sites/${domain.site_id}`, `Added ${domain.hostname}: publish the DNS records below, then check.`);
    }));
    router.post('/sites/:id/rollback', action((req) => {
        const r = deploys.rollback(req.viewer, req.params.id, { expectedActive: req.body.expected_active || null, traceparent: req.ov && req.ov.traceparent });
        return back(`/sites/${req.params.id}`, r.changed ? `Rolled back: ${r.deploy_id} is active.` : 'Nothing changed.');
    }));
    router.post('/sites/:id/delete', action((req) => {
        const { site } = sites.load(req.viewer, req.params.id, 'maintain');
        if (req.body.confirm !== 'yes') throw new ApiError(422, 'form.confirm', 'tick the confirmation box to delete');
        sites.remove(req.viewer, site.id, { deploys });
        return back(`/projects/${site.project_id}`, `${site.name} deleted.`);
    }));
    router.post('/deploys/:id/activate', action((req) => {
        const { site } = deploys.load(req.viewer, req.params.id, 'deploy');
        const r = deploys.activate(req.viewer, req.params.id, { expectedActive: req.body.expected_active || null, traceparent: req.ov && req.ov.traceparent });
        return back(`/sites/${site.id}`, r.changed ? `${r.deploy_id} is active.` : 'That deploy was already active.');
    }));
    router.post('/deploys/:id/delete', action((req) => {
        const { site } = deploys.load(req.viewer, req.params.id, 'maintain');
        deploys.remove(req.viewer, req.params.id);
        return back(`/sites/${site.id}`, 'Deploy deleted.');
    }));
    router.post('/domains/:id/verify', action(async (req) => {
        const d = await domains.verify(req.viewer, req.params.id, { traceparent: req.ov && req.ov.traceparent });
        return back(`/sites/${d.site_id}`, d.status === 'verified' ? `${d.hostname} is verified and served.` : `${d.hostname}: ${d.last_error || d.status}`, d.status === 'verified' ? null : 'error');
    }));
    router.post('/domains/:id/delete', action((req) => {
        const { domain } = domains.load(req.viewer, req.params.id, 'maintain');
        domains.remove(req.viewer, domain.id);
        return back(`/sites/${domain.site_id}`, `${domain.hostname} removed.`);
    }));

    // Upload: multipart; the form token is checked after the body is parsed (Origin before).
    router.post('/sites/:id/deploys', async (req, res) => {
        try {
            if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
            if (!sameOrigin(config, req)) throw new ApiError(403, 'form.invalid', 'this form did not come from this dashboard');
            const pre = deploys.precheck(req.viewer, req.params.id);
            let up;
            try {
                up = await readUpload(req, { maxUploadBytes: config.uploads.maxUploadBytes, maxUnpackedBytes: config.uploads.maxUnpackedBytes, limits: pre.limits });
            } catch (err) {
                if (!(err instanceof UploadError)) throw err;
                if (err.closeConnection) res.set('Connection', 'close');
                if (!checkCsrf(config, req.viewer, err.fields && err.fields.csrf) && !err.closeConnection) throw new ApiError(403, 'form.invalid', 'this form expired; reload the page and try again');
                const r = deploys.recordFailure(req.viewer, pre, { source: err.source || 'files', code: err.code, problems: [{ code: err.code, message: err.message }], traceparent: req.ov && req.ov.traceparent });
                return res.redirect(303, back(`/deploys/${r.deploy.id}`, `Upload refused: ${err.message}`, 'error'));
            }
            if (!checkCsrf(config, req.viewer, up.fields.csrf)) throw new ApiError(403, 'form.invalid', 'this form expired; reload the page and try again');
            try {
                const r = deploys.create(req.viewer, pre, up.entries, { source: up.source, activate: up.fields.activate === '1', notes: up.notes, traceparent: req.ov && req.ov.traceparent });
                return res.redirect(303, back(`/deploys/${r.deploy.id}`, r.activated && r.activated.changed ? 'Deployed and activated.' : 'Deployed. Activate it from the site page.'));
            } catch (err) {
                if (err instanceof ApiError && err.extra && err.extra.deploy_id) return res.redirect(303, back(`/deploys/${err.extra.deploy_id}`, `Upload refused: ${err.message}`, 'error'));
                throw err;
            }
        } catch (err) {
            if (!req.complete) res.set('Connection', 'close');
            fail(req, res, err);
        }
    });

    return router;
}

module.exports = { createDashboard };
