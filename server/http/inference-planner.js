'use strict';
/**
 * The staff-only inference planner: GET /catalog/inference (HTML) and
 * GET /api/v1/catalog/inference-planner (JSON). Both are mounted only when
 * HOST_INFERENCE_PLANNER=on, so flag off adds no route at all.
 *
 * The planner itself (server/inference-planner.js) is pure. This module reads the planning JSON
 * from HOST_INFERENCE_PLANNER_INPUT (mtime-cached), and that is the only I/O here. There is no
 * action endpoint: nothing can start, stop or rent a GPU from this page or its API.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ApiError, run, privateNoStore, sendError } = require('./errors');
const { renderPage } = require('../render/layout');
const { guard } = require('../auth/viewer');
const { plan } = require('../inference-planner');
const render = require('../render/inference-planner');

function createInferencePlannerSource({ config, log = console }) {
    let cached = null;
    async function current() {
        const file = path.resolve(config.inferencePlanner.inputPath);
        let stat;
        try {
            stat = await fs.promises.stat(file);
        } catch {
            throw new ApiError(503, 'host.inference_planner.unavailable', 'the planning JSON is missing or unreadable (HOST_INFERENCE_PLANNER_INPUT)');
        }
        if (!stat.isFile()) throw new ApiError(503, 'host.inference_planner.unavailable', 'HOST_INFERENCE_PLANNER_INPUT is not a file');
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
        let document;
        try {
            document = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        } catch (err) {
            throw new ApiError(503, 'host.inference_planner.invalid', `the planning JSON could not be read as JSON: ${err.message}`);
        }
        let result;
        try {
            result = plan(document, { budgetNanoUsd: config.inferencePlanner.budgetNanoUsdRaw });
        } catch (err) {
            throw new ApiError(503, 'host.inference_planner.invalid', `the planning JSON did not validate: ${err.message}`);
        }
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, result };
        return result;
    }
    return { current };
}

function createInferencePlannerPages(ctx) {
    const { config, viewers, planner, log = console } = ctx;
    const router = express.Router();
    router.use(viewers.middleware('dashboard'));
    if (ctx.actorLimits) router.use(ctx.actorLimits);
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); next(); });
    const send = (req, res, status, body) => res.status(status).type('html').send(renderPage({
        title: 'Inference placement planner', body, viewer: req.viewer, config, path: req.originalUrl, indexable: false, css: ['css/catalog.css'],
    }));
    router.get('/', async (req, res, next) => {
        try {
            if (!(req.viewer.kind === 'user' && req.viewer.staff)) return send(req, res, 403, render.errorPage('Staff access required.'));
            let result;
            try {
                result = await planner.current();
            } catch (err) {
                if (!err.status) log.error('[Host inference planner]', err && err.stack ? err.stack : err);
                return send(req, res, err.status || 503, render.errorPage(err.status ? err.message : 'the planner could not build a plan', { input: Boolean(err.status) }));
            }
            return send(req, res, 200, render.page(result));
        } catch (err) { next(err); }
    });
    return router;
}

function createInferencePlannerApi(ctx) {
    const { viewers, planner, actorLimits, log = console } = ctx;
    const router = express.Router();
    router.use(viewers.middleware('api'));
    if (actorLimits) router.use(actorLimits);
    router.use((_req, res, next) => { privateNoStore(res); next(); });
    const staff = (req, _res, next) => req.viewer.kind === 'user' && req.viewer.staff ? next() : next(new ApiError(403, 'host.catalog.forbidden', 'Staff access required'));
    router.get('/', guard('host.catalog.manage'), staff, run(async () => ({ planner: await planner.current() })));
    router.use((err, req, res, next) => { if (res.headersSent) return next(err); sendError(res, req, err, log); });
    return router;
}

module.exports = { createInferencePlannerSource, createInferencePlannerPages, createInferencePlannerApi };
