'use strict';

/**
 * The dashboard's own session cookie, around the openvibe-sdk/sso /auth router.
 *
 * openvibe-sdk/sso keeps the session in `ov_token`: host-only, not HttpOnly (the shared navbar reads
 * it). Tenant sites are served at <site>.openvibe.host, the same site as the dashboard, so a tenant
 * page can plant `ov_token=<its owner's own valid token>; Domain=openvibe.host; Path=/<longer path>`
 * and the browser sends it ahead of the real one (cookie tossing). Host therefore trusts only its own
 * cookie, which no subdomain can set or overwrite:
 *
 *   __Host-ov_host_session   HttpOnly, Secure, Path=/, no Domain, SameSite=Lax; the verified access
 *                            token, written whenever the SDK writes ov_token after a sign-in
 *                            (callback, FedCM) or a refresh, and cleared whenever it clears ov_token
 *                            (sign-out, a refresh the Network refuses).
 *   __Host-ov_host_flow      the OAuth state of a sign-in started here; /auth/callback requires it,
 *                            so a planted ov_oauth_state/ov_oauth_verifier cannot complete the
 *                            attacker's own sign-in in the victim's browser.
 *
 * ov_refresh (Path=/auth) can be planted too: a refresh renews the session only for the subject the
 * session already holds, and never creates one. Inside /auth the SDK sees the trusted session as
 * ov_token (/auth/me and the silent sign-in check never read a planted one). ov_token stays
 * display-only for the shared navbar.
 *
 * Development (COOKIE_SECURE=false, plain http): browsers refuse __Host- cookies without Secure, so
 * the names drop the prefix (ov_host_session, ov_host_flow) and are not Secure.
 */
const crypto = require('crypto');
const { COOKIES, decodeJwtPayload, parseCookies } = require('openvibe-sdk/sso');

const SESSION_MAX_AGE = 30 * 24 * 3600e3;   // the SDK's ov_refresh lifetime: a refresh always finds the session it renews
const FLOW_MAX_AGE = 10 * 60e3;

function cookieNames(config) {
    const prefix = config.cookies.secure ? '__Host-' : '';
    return { session: `${prefix}ov_host_session`, flow: `${prefix}ov_host_flow` };
}

/** The session token this browser holds on the dashboard, or null (never ov_token). */
function sessionToken(config, req) {
    return parseCookies(req)[cookieNames(config).session] || null;
}

const subjectOf = (token) => { const c = token ? decodeJwtPayload(token) : null; return c && typeof c.subject_id === 'string' ? c.subject_id : null; };

function sameString(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** The state of a redirect to the Network's authorize endpoint, or null. */
function authorizeState(url) {
    try {
        const u = new URL(String(url));
        return u.pathname.endsWith('/oauth/authorize') ? u.searchParams.get('state') : null;
    } catch { return null; }
}

function createHostSession({ auth, config }) {
    const names = cookieNames(config);
    const opts = (maxAge) => ({ httpOnly: true, secure: config.cookies.secure, sameSite: 'lax', path: '/', ...(maxAge ? { maxAge } : {}) });

    function guard(req, res, next) {
        const cookies = parseCookies(req);
        const current = cookies[names.session] || null;
        // The SDK handlers read ov_token from req.cookies: give them the trusted session instead.
        if (req.cookies && typeof req.cookies === 'object') {
            if (current) req.cookies[COOKIES.access] = current; else delete req.cookies[COOKIES.access];
        }

        if (req.path === '/callback' && !(req.query && req.query.error)) {
            res.clearCookie(names.flow, opts());
            if (!sameString(req.query && req.query.state, cookies[names.flow])) return res.status(400).send('OAuth state mismatch. Please try signing in again.');
        }
        if (req.path === '/login') {
            const redirect = res.redirect.bind(res);
            res.redirect = (...args) => {
                const state = authorizeState(args[args.length - 1]);
                if (state) res.cookie(names.flow, state, opts(FLOW_MAX_AGE));
                return redirect(...args);
            };
        }

        const setCookie = res.cookie.bind(res);
        const clearCookie = res.clearCookie.bind(res);
        let refused = false;
        res.cookie = (name, value, o) => {
            if (refused && name === COOKIES.refresh) return res;
            if (name === COOKIES.access) {
                // A refresh renews this browser's session; a planted ov_refresh of another account is refused.
                if (req.path === '/refresh' && (!subjectOf(current) || subjectOf(current) !== subjectOf(value))) { refused = true; return res; }
                setCookie(names.session, value, opts(SESSION_MAX_AGE));
            }
            return setCookie(name, value, o);
        };
        res.clearCookie = (name, o) => {
            if (name === COOKIES.access) clearCookie(names.session, opts());
            return clearCookie(name, o);
        };
        if (req.path === '/refresh') {
            const json = res.json.bind(res);
            res.json = (body) => (refused ? (res.status(401), json({ error: 'The session ended. Please sign in again.' })) : json(body));
        }
        next();
    }

    /** The /auth router: Host's guard, then the SDK's handlers. */
    function router(express) {
        const r = express.Router();
        r.use(guard);
        r.use(auth.router(express));
        return r;
    }

    return { names, router };
}

module.exports = { createHostSession, cookieNames, sessionToken };
