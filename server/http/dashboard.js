'use strict';
/**
 * The dashboard: server-rendered pages for projects, sites, deploys (with rollback), domains
 * (with DNS instructions), quotas and upload logs. Every action is a POST form that must come from
 * the dashboard's own origin and carry the form token (see auth/forms.js for why SameSite is not
 * enough on openvibe.host). Every response is private and never cached by a shared cache.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const showcase = require('openvibe-shared/showcase');
const { limitsOf } = require('../limits');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const { readUpload, UploadError } = require('./upload');
const { ApiError, privateNoStore } = require('./errors');

function createDashboard(ctx) {
    const { config, projects, sites, deploys, domains, siteConfig, siteSources, viewers, access, log = console } = ctx;
    const router = express.Router();
    const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });

    const siteUrl = (s) => {
        const u = new URL(config.baseUrl);
        return `${u.protocol}//${sites.defaultHostname(s.name)}${u.port ? `:${u.port}` : ''}`;
    };

    router.use(viewers.middleware('dashboard'));
    if (ctx.actorLimits) router.use(ctx.actorLimits);
    router.use((req, res, next) => { privateNoStore(res); next(); });

    function page(req, res, status, title, body, notice, { indexable = false, styles } = {}) {
        res.status(status).type('html').send(renderPage({ title, body, viewer: req.viewer, config, path: req.originalUrl, notice, indexable, styles }));
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
    /** A staff takedown outranks any other notice: members must see why nothing is served. */
    const takedownNotice = (t) => (t ? { kind: 'error', text: `This ${t.scope} was taken down by OpenVibe staff: ${t.reason}. Nothing of it is served, and nothing can be published or deleted, until staff lift the takedown.` } : null);
    const back = (path, text, kind) => `${path}?notice=${encodeURIComponent(text)}${kind ? `&kind=${kind}` : ''}`;

    // ── Pages ───────────────────────────────────────────────
    // What shipped on OpenVibe.Host: the shared update log every OpenVibe site has.
    router.get('/updates', view((req, res) => page(req, res, 200, 'What shipped on OpenVibe.Host', frame.updatesBody({ service: 'host', siteName: 'OpenVibe.Host' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`, null, { indexable: true })));
    router.get('/', view(async (req, res) => {
        // The signed-out front page is the public page of openvibe.host (sitemap.xml): indexable.
        // Everything behind sign-in stays noindex and private.
        if (req.viewer.kind !== 'user') {
            return page(req, res, 200, null, pages.signedOut({ limits: limitsOf(config), limitsUrl: `${config.baseUrl}/limits.json` }), null,
                { indexable: !req.query || !Object.keys(req.query).length, styles: [showcase.STYLESHEET] });
        }
        page(req, res, 200, 'Projects', pages.home({ projects: await projects.listFor(req.viewer), csrf: csrfToken(config, req.viewer) }), notice(req));
    }));

    router.get('/projects/:id', view(async (req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
        const project = await projects.get(req.params.id);
        const role = await access.authorize(project, req.viewer, 'read');
        page(req, res, 200, project.name, pages.project({
            project, role, sites: await sites.listForProject(project.id), quota: await projects.quotaOf(project), usage: await projects.usageOf(project),
            members: await projects.members(project), csrf: csrfToken(config, req.viewer), siteUrl,
        }), takedownNotice(await ctx.takedowns.ofProject(project.id)) || notice(req));
    }));

    router.get('/sites/:id', view(async (req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
        const { site, project, role } = await sites.load(req.viewer, req.params.id, 'read');
        const cfg = await siteConfig.getForSite(site.id);
        page(req, res, 200, site.name, pages.site({
            site, project, role, url: siteUrl(site), csrf: csrfToken(config, req.viewer), now: ctx.store.now(),
            deploys: await deploys.list(site.id, 50), activations: await deploys.activationsOf(site.id, 10),
            domains: (await domains.listForSite(site.id)).map((d) => ({ domain: d, instructions: domains.instructions(d, site) })),
            siteConfig: { ...cfg, headersText: siteConfig.headersToText(cfg.headers), redirectsText: siteConfig.redirectsToText(cfg.redirects) },
            source: await siteSources.forSite(site.id),
        }), takedownNotice(await ctx.takedowns.ofSite(site)) || notice(req));
    }));

    router.get('/deploys/:id', view(async (req, res) => {
        if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
        const { deploy, site, project } = await deploys.load(req.viewer, req.params.id, 'read');
        page(req, res, 200, `Deploy ${deploy.id.slice(0, 12)}`, pages.deploy({
            deploy, site, project, active: site.active_deploy_id === deploy.id, files: await deploys.filesOf(deploy.id), log: await deploys.logOf(deploy.id),
        }), notice(req));
    }));

    // ── Actions ─────────────────────────────────────────────
    router.post('/projects', action(async (req) => {
        const p = await projects.create(req.viewer, { name: req.body.name, environment: req.body.environment });
        return back(`/projects/${p.id}`, 'Project created.');
    }));
    router.post('/projects/:id/sites', action(async (req) => {
        const project = await projects.get(req.params.id);
        await access.authorize(project, req.viewer, 'read');
        const s = await sites.create(req.viewer, project, { name: req.body.name });
        return back(`/sites/${s.id}`, `Site created: ${siteUrl(s)}`);
    }));
    router.post('/projects/:id/members', action(async (req) => {
        const project = await projects.get(req.params.id);
        await access.authorize(project, req.viewer, 'read');
        await projects.setMember(req.viewer, project, String(req.body.principal || '').trim(), String(req.body.role || ''));
        return back(`/projects/${project.id}`, 'Member saved.');
    }));
    router.post('/projects/:id/members/remove', action(async (req) => {
        const project = await projects.get(req.params.id);
        await access.authorize(project, req.viewer, 'read');
        await projects.removeMember(req.viewer, project, String(req.body.principal || ''));
        return back(`/projects/${project.id}`, 'Member removed.');
    }));
    router.post('/projects/:id/delete', action(async (req) => {
        const project = await projects.get(req.params.id);
        await access.authorize(project, req.viewer, 'read');
        if (req.body.confirm !== 'yes') throw new ApiError(422, 'form.confirm', 'tick the confirmation box to delete');
        await projects.remove(req.viewer, project, { sites });
        return back('/', 'Project deleted.');
    }));
    router.post('/sites/:id/config', action(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'maintain');
        const headers = siteConfig.parseHeadersText(req.body.headers);
        const redirects = siteConfig.parseRedirectsText(req.body.redirects);
        await siteConfig.set(req.viewer, site, { headers, redirects, spa: req.body.spa === '1' });
        return back(`/sites/${site.id}`, 'Site configuration saved.');
    }));
    // The Git source the project's CI deploys from (Host never fetches it); git deploys land as previews.
    router.post('/sites/:id/source', action(async (req) => {
        const { site } = await siteSources.put(req.viewer, req.params.id, { provider: req.body.provider || undefined, repo_url: req.body.repo_url, ref: req.body.ref });
        return back(`/sites/${site.id}`, 'Git source saved. Your CI posts each build to it as a preview.');
    }));
    router.post('/sites/:id/source/remove', action(async (req) => {
        const { site } = await siteSources.remove(req.viewer, req.params.id);
        return back(`/sites/${site.id}`, 'Git source removed.');
    }));
    router.post('/sites/:id/domains', action(async (req) => {
        const { domain } = await domains.add(req.viewer, req.params.id, { hostname: req.body.hostname });
        return back(`/sites/${domain.site_id}`, `Added ${domain.hostname}: publish the DNS records below, then check.`);
    }));
    router.post('/sites/:id/rollback', action(async (req) => {
        const r = await deploys.rollback(req.viewer, req.params.id, { expectedActive: req.body.expected_active || null, traceparent: req.ov && req.ov.traceparent });
        return back(`/sites/${req.params.id}`, r.changed ? `Rolled back: ${r.deploy_id} is active.` : 'Nothing changed.');
    }));
    router.post('/sites/:id/delete', action(async (req) => {
        const { site } = await sites.load(req.viewer, req.params.id, 'maintain');
        if (req.body.confirm !== 'yes') throw new ApiError(422, 'form.confirm', 'tick the confirmation box to delete');
        await sites.remove(req.viewer, site.id, { deploys });
        return back(`/projects/${site.project_id}`, `${site.name} deleted.`);
    }));
    router.post('/deploys/:id/activate', action(async (req) => {
        const { site } = await deploys.load(req.viewer, req.params.id, 'deploy');
        const r = await deploys.activate(req.viewer, req.params.id, { expectedActive: req.body.expected_active || null, traceparent: req.ov && req.ov.traceparent });
        return back(`/sites/${site.id}`, r.changed ? `${r.deploy_id} is active.` : 'That deploy was already active.');
    }));
    router.post('/deploys/:id/delete', action(async (req) => {
        const { site } = await deploys.load(req.viewer, req.params.id, 'maintain');
        await deploys.remove(req.viewer, req.params.id);
        return back(`/sites/${site.id}`, 'Deploy deleted.');
    }));
    router.post('/domains/:id/verify', action(async (req) => {
        const d = await domains.verify(req.viewer, req.params.id, { traceparent: req.ov && req.ov.traceparent });
        return back(`/sites/${d.site_id}`, d.status === 'verified' ? `${d.hostname} is verified and served.` : `${d.hostname}: ${d.last_error || d.status}`, d.status === 'verified' ? null : 'error');
    }));
    router.post('/domains/:id/delete', action(async (req) => {
        const { domain } = await domains.load(req.viewer, req.params.id, 'maintain');
        await domains.remove(req.viewer, domain.id);
        return back(`/sites/${domain.site_id}`, `${domain.hostname} removed.`);
    }));

    // Upload: multipart; the form token is checked after the body is parsed (Origin before).
    router.post('/sites/:id/deploys', async (req, res) => {
        let release = null;
        try {
            if (req.viewer.kind !== 'user') throw new ApiError(401, 'auth.required', 'sign in first');
            if (!sameOrigin(config, req)) throw new ApiError(403, 'form.invalid', 'this form did not come from this dashboard');
            const pre = await deploys.precheck(req.viewer, req.params.id);
            release = ctx.uploadGate.enter();
            if (!release) { res.set('Retry-After', '30'); throw new ApiError(503, 'upload.busy', 'Host is validating other uploads right now; try again in 30 seconds'); }
            let up;
            try {
                up = await readUpload(req, { maxUploadBytes: config.uploads.maxUploadBytes, maxUnpackedBytes: config.uploads.maxUnpackedBytes, limits: pre.limits });
            } catch (err) {
                if (!(err instanceof UploadError)) throw err;
                if (err.closeConnection) res.set('Connection', 'close');
                if (!checkCsrf(config, req.viewer, err.fields && err.fields.csrf) && !err.closeConnection) throw new ApiError(403, 'form.invalid', 'this form expired; reload the page and try again');
                const r = await deploys.recordFailure(req.viewer, pre, { source: err.source || 'files', code: err.code, problems: [{ code: err.code, message: err.message }], traceparent: req.ov && req.ov.traceparent });
                return res.redirect(303, back(`/deploys/${r.deploy.id}`, `Upload refused: ${err.message}`, 'error'));
            }
            if (!checkCsrf(config, req.viewer, up.fields.csrf)) throw new ApiError(403, 'form.invalid', 'this form expired; reload the page and try again');
            try {
                // The form's choice: activate it, keep it ready, or make it the site's private preview.
                const mode = ['activate', 'ready', 'preview'].includes(up.fields.mode) ? up.fields.mode : (up.fields.activate === '1' ? 'activate' : 'ready');
                const r = await deploys.create(req.viewer, pre, up.entries, { source: up.source, activate: mode === 'activate', preview: mode === 'preview', notes: up.notes, traceparent: req.ov && req.ov.traceparent });
                const done = r.preview ? 'Deployed as a preview: open it from the site page. Only members of this project can see it.'
                    : r.activated && r.activated.changed ? 'Deployed and activated.' : 'Deployed. Activate it from the site page.';
                return res.redirect(303, back(`/deploys/${r.deploy.id}`, done));
            } catch (err) {
                if (err instanceof ApiError && err.extra && err.extra.deploy_id) return res.redirect(303, back(`/deploys/${err.extra.deploy_id}`, `Upload refused: ${err.message}`, 'error'));
                throw err;
            }
        } catch (err) {
            if (!req.complete) res.set('Connection', 'close');
            fail(req, res, err);
        } finally {
            if (release) release();
        }
    });

    return router;
}

module.exports = { createDashboard };
