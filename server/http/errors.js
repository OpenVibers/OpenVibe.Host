'use strict';

/**
 * Errors as RFC 9457 problems (contracts errors.problem@1, which keeps the legacy { error } field),
 * and the small request helpers every router shares.
 */
const express = require('express');
const contracts = require('openvibe-contracts');

/** A refusal with a stable problem code (e.g. 404 'site.not_found'). */
class ApiError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}

let logger = console;
/** The app's logger (tests pass a quiet one). */
function setLogger(l) { logger = l || console; }

function sendError(res, req, err, log = logger) {
    if (err instanceof ApiError || (err && Number.isInteger(err.status) && typeof err.code === 'string' && err.name !== 'OpenVibeError')) {
        return contracts.http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov, extra: err.extra || undefined });
    }
    log.error('[Host API]', err && err.stack ? err.stack : err);
    return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
}

/** Wrap a JSON handler: its return value is the body; errors become problems. */
function run(fn, status = 200) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out === undefined || res.headersSent) return;
            res.status(typeof status === 'function' ? status(out) : status).json(out);
        } catch (err) {
            if (res.headersSent) return;
            sendError(res, req, err);
        }
    };
}

const jsonParser = express.json({ limit: '64kb' });
/** JSON body parser whose syntax errors are problems too. */
function jsonBody(req, res, next) {
    jsonParser(req, res, (err) => (err ? contracts.http.sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov }) : next()));
}

/** Private, per-viewer responses: never stored by a shared cache. */
function privateNoStore(res) {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    res.vary('Authorization');
}

module.exports = { ApiError, sendError, setLogger, run, jsonBody, privateNoStore };
