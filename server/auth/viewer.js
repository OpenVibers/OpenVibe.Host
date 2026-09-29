'use strict';

/**
 * Who is calling, resolved once per request into `req.viewer`:
 *
 *   { kind: 'anonymous' }
 *   { kind: 'user', subject: 'usr_…', staff, user }
 *       API: a Network user JWT in `Authorization: Bearer` (cookies are ignored on /api/v1).
 *       Dashboard: the ov_token session cookie (openvibe-sdk/sso; the shared navbar reads the same cookie).
 *       staff = the contracts staff map's staff.site.configure (ADR-022):
 *       quotas, takedowns, and maintaining or deleting any project (never deploying to it).
 *   { kind: 'service', service: 'svc:codes' | 'app:app_…', claims, subject, env }
 *       A Network client-credentials token for audience openvibe.host. A first-party service
 *       (svc:) may name the person it acts for with X-OV-Subject; an app (app:) always acts as
 *       itself. `env` is the token's environment claim ("sandbox" is refused on production
 *       projects).
 *
 * Identity never comes from a request body or query. A bad token is refused (problem+json),
 * never downgraded to anonymous.
 */
const contracts = require('openvibe-contracts');
const { claimsToUser, decodeJwtPayload, parseCookies, COOKIES } = require('openvibe-sdk/sso');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const { checkCapability } = require('./capabilities');

const { ids, http, staff: staffMap } = contracts;
const PRINCIPAL_SUB = /^(svc|app|mod):/;
const AUDIENCE = 'openvibe.host';

/** API callers: only the Authorization header (cookies are never read on /api/v1). */
const bearerToken = (req) => {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
};

class ViewerError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, staff: false });

function createViewerResolver({ auth, config, log = console }) {
    async function fromServiceToken(req, token) {
        // The SDK supplies the key (the shared JWKS client, through a Network outage); every token rule is the
        // service's own pinned openvibe-contracts serviceAuth.verifyServiceToken.
        // acceptSandbox: Host takes sandbox tokens itself and confines them to sandbox projects
        // (projects.js/access.js answer 403 environment.sandbox_token elsewhere); openvibe-contracts
        // >= 0.26.0 refuses them before that unless the receiver opts in.
        const r = await verifyServiceToken(token, {
            jwks: `${config.networkInternalUrl}/api/.well-known/jwks`,
            issuer: config.networkUrl,
            audience: AUDIENCE,
            contracts,
            acceptSandbox: true,
            log,
        });
        if (!r.ok) {
            if (r.code === 'token.unavailable') throw new ViewerError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
            throw new ViewerError(401, r.code, r.reason);
        }
        const sub = r.claims.sub;
        if (sub.startsWith('mod:')) throw new ViewerError(403, 'principal.not_allowed', 'mods cannot manage hosted sites');
        const subjectHeader = req.get('x-ov-subject');
        let subject = null;
        if (subjectHeader) {
            if (!sub.startsWith('svc:')) throw new ViewerError(400, 'subject.not_delegable', 'only first-party services may act for a person (X-OV-Subject); an app acts as itself');
            if (!ids.isSubjectId('user', subjectHeader)) throw new ViewerError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
            subject = subjectHeader;
        }
        const env = r.claims.env || r.claims.environment || null;
        return { kind: 'service', service: sub, claims: r.claims, subject, env: env === 'sandbox' ? 'sandbox' : env, staff: false };
    }

    async function fromUserToken(token) {
        const claims = await auth.verify(token);
        if (!claims || (typeof claims.sub === 'string' && PRINCIPAL_SUB.test(claims.sub))) return null;
        // Network signs FedCM ID assertions (typ "fedcm", aud = any OpenVibe RP origin, including
        // tenant subdomains of openvibe.host) with the same key and issuer as access tokens. An
        // assertion is only ever swapped at /oauth/token, never presented as a session. Access
        // tokens carry no typ.
        if (claims.typ !== undefined || claims.nonce !== undefined) return null;
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        if (!subject) return null;
        return { kind: 'user', subject, staff: staffMap.can(claims, 'staff.site.configure'), user: claimsToUser(claims) };
    }

    async function resolveApi(req) {
        const token = bearerToken(req);
        if (!token) return ANONYMOUS;
        const payload = decodeJwtPayload(token);
        if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) return await fromServiceToken(req, token);
        const v = await fromUserToken(token);
        if (!v) throw new ViewerError(401, 'auth.invalid_token', 'the bearer token is not a valid OpenVibe token');
        return v;
    }

    async function resolveDashboard(req) {
        const token = parseCookies(req)[COOKIES.access] || null;
        if (!token) return ANONYMOUS;
        return (await fromUserToken(token)) || ANONYMOUS;
    }

    function middleware(mode) {
        return async (req, res, next) => {
            try {
                req.viewer = mode === 'api' ? await resolveApi(req) : await resolveDashboard(req);
                next();
            } catch (err) {
                if (!(err instanceof ViewerError)) return next(err);
                http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            }
        };
    }

    return { resolveApi, resolveDashboard, middleware };
}

/**
 * Route guard: a service token must hold `cap`. Browsers and anonymous callers pass here and are
 * judged by project membership in the domain layer. Each route checks exactly one capability.
 */
function guard(cap) {
    return (req, res, next) => {
        const v = req.viewer;
        if (!v || v.kind !== 'service') return next();
        const c = checkCapability(v.claims, cap);
        if (c.allowed) return next();
        return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
}

module.exports = { createViewerResolver, guard, ANONYMOUS, ViewerError, AUDIENCE };
