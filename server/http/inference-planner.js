'use strict';
/**
 * The staff-only inference planner: GET /catalog/inference (HTML) and
 * GET /api/v1/catalog/inference-planner (JSON). Both are mounted only when
 * HOST_INFERENCE_PLANNER=on, so flag off adds no route at all.
 *
 * The planner itself (server/inference-planner.js) is pure. This module is the only I/O: it reads the
 * planning JSON from HOST_INFERENCE_PLANNER_INPUT (mtime-cached), and with
 * HOST_INFERENCE_PLANNER_SOURCE=ai (default: json) it asks server/inference-planner-feed.js for the
 * daily request series from OpenVibe.AI (cached ten minutes). A feed failure falls back to the JSON
 * series when HOST_INFERENCE_PLANNER_INPUT is configured, and is reported as "demand feed unavailable"
 * either way. There is no action endpoint: nothing can start, stop or rent a GPU from here.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ApiError, run, privateNoStore, sendError } = require('./errors');
const { renderPage } = require('../render/layout');
const { guard } = require('../auth/viewer');
const { plan } = require('../inference-planner');
const { createDemandFeed } = require('../inference-planner-feed');
const render = require('../render/inference-planner');

function createInferencePlannerSource({ config, log = console, feed = null, now = Date.now }) {
    let cached = null;
    const demandFeed = feed || (config.inferencePlanner.source === 'ai' ? createDemandFeed({ config, log, clock: { now } }) : null);

    async function readDocument() {
        const file = path.resolve(config.inferencePlanner.inputPath);
        let stat;
        try {
            stat = await fs.promises.stat(file);
        } catch {
            throw new ApiError(503, 'host.inference_planner.unavailable', 'the planning JSON is missing or unreadable (HOST_INFERENCE_PLANNER_INPUT)');
        }
        if (!stat.isFile()) throw new ApiError(503, 'host.inference_planner.unavailable', 'HOST_INFERENCE_PLANNER_INPUT is not a file');
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.document;
        let document;
        try {
            document = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        } catch (err) {
            throw new ApiError(503, 'host.inference_planner.invalid', `the planning JSON could not be read as JSON: ${err.message}`);
        }
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, document };
        return document;
    }

    function planDocument(document) {
        try {
            return plan(document, { budgetNanoUsd: config.inferencePlanner.budgetNanoUsdRaw });
        } catch (err) {
            throw new ApiError(503, 'host.inference_planner.invalid', `the planning JSON did not validate: ${err.message}`);
        }
    }

    const withDemand = (result, demand) => ({ ...result, demand });

    async function current() {
        const document = await readDocument();
        if (!demandFeed) return withDemand(planDocument(document), { source: 'json' });
        try {
            const series = await demandFeed.current();
            const forecast = document && typeof document.forecast === 'object' && !Array.isArray(document.forecast) ? document.forecast : {};
            const result = planDocument({ ...document, forecast: { ...forecast, series: series.series } });
            return withDemand(result, { source: 'ai', from: series.from, to: series.to, days: series.days, fetched_at: series.fetched_at });
        } catch (err) {
            const warning = `demand feed unavailable: ${err.message}`;
            if (!config.inferencePlanner.inputConfigured) {
                throw new ApiError(503, 'host.inference_planner.unavailable', warning);
            }
            log.warn(`[Host inference planner] ${warning}; using the configured planning JSON`);
            try {
                return withDemand(planDocument(document), { source: 'json', fallback: true, warning });
            } catch (fallbackErr) {
                throw new ApiError(fallbackErr.status || 503, fallbackErr.code || 'host.inference_planner.invalid', `${warning}; ${fallbackErr.message}`);
            }
        }
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
