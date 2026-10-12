'use strict';

/** Catalog form protection: same-origin request and subject-bound CSRF token. */
const crypto = require('crypto');

const fallback = crypto.randomBytes(32).toString('hex');

function csrfToken(config, viewer) {
    if (!viewer || !viewer.subject) return '';
    return crypto.createHmac('sha256', config.formSecret || fallback).update(`host-form:${viewer.subject}`).digest('base64url').slice(0, 32);
}

function checkCsrf(config, viewer, token) {
    const expected = csrfToken(config, viewer);
    if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/** The request came from the catalog origin. */
function sameOrigin(config, req) {
    const expected = new URL(config.baseUrl).origin;
    const origin = req.get('origin');
    if (origin) return origin === expected;
    const referer = req.get('referer');
    if (!referer) return false;
    try { return new URL(referer).origin === expected; } catch { return false; }
}

module.exports = { csrfToken, checkCsrf, sameOrigin };
