'use strict';

/**
 * Dashboard form protection. SameSite=Lax is NOT enough here: tenant sites on <site>.openvibe.host
 * are the same site as openvibe.host, so their pages could submit forms to the dashboard with the
 * session cookie attached. Every dashboard POST therefore needs both:
 *
 *   1. an Origin (or, without one, a Referer) equal to the dashboard's own origin, and
 *   2. a form token: an HMAC of the signed-in subject under HOST_FORM_SECRET (a random per-process
 *      key when unset, so forms opened before a restart must be reloaded).
 */
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

/** The request came from a dashboard page (not from a tenant page or another site). */
function sameOrigin(config, req) {
    const expected = new URL(config.baseUrl).origin;
    const origin = req.get('origin');
    if (origin) return origin === expected;
    const referer = req.get('referer');
    if (!referer) return false;
    try { return new URL(referer).origin === expected; } catch { return false; }
}

module.exports = { csrfToken, checkCsrf, sameOrigin };
