'use strict';
/**
 * A site's Git source (plan T12 Stage B, git deploys Phase 1): the repository and branch the project's
 * own CI builds the site from. Host never clones, fetches or builds it and holds no credential for
 * it: the row is public provenance that a git deploy (deploys.ingestGit) must match. The CI token
 * that posts the build output is the trust boundary.
 *
 *   repo_url  https on the provider's own host (github.com, gitlab.com, codeberg.org), path
 *             owner/repo with an optional .git; never userinfo, a port, a query or a fragment.
 *             Stored canonically as https://<host>/<owner>/<repo>.
 *   ref       one branch name, by git check-ref-format's rules, at most 200 characters.
 *
 * Read at `read`, written and removed at `maintain`, through sites.load (404 to anyone else).
 */
const { ApiError } = require('../http/errors');
const { principalOf } = require('./access');

const PROVIDERS = Object.freeze({ 'github.com': 'github', 'gitlab.com': 'gitlab', 'codeberg.org': 'codeberg' });
const PROVIDER_NAMES = new Set(Object.values(PROVIDERS));
const FIELDS = new Set(['provider', 'repo_url', 'ref']);
const MAX_URL = 300;
const MAX_REF = 200;
// Only these characters, so no userinfo (@), port (:), query (?), fragment (#), percent-encoding or space can hide in a URL.
const URL_RE = /^https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/;
const REF_CHARS_RE = /^[A-Za-z0-9._/+=,#-]+$/;

const fail = (code, message) => { throw new ApiError(422, code, message); };

/** -> { provider, repo_url } (canonical), or throws ApiError(422). */
function cleanRepoUrl(value, provider) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s || s.length > MAX_URL) fail('source.repo_url', `repo_url must be an https URL of at most ${MAX_URL} characters`);
    const m = URL_RE.exec(s);
    if (!m) fail('source.repo_url', 'repo_url must be https://<provider host>/<owner>/<repo>[.git], with no user, port, query or fragment');
    const host = m[1].toLowerCase();
    const repo = m[3].endsWith('.git') ? m[3].slice(0, -4) : m[3];
    if (!PROVIDERS[host]) fail('source.repo_url', `repo_url must be on ${Object.keys(PROVIDERS).join(', ')}`);
    if (provider != null && provider !== '') {
        if (!PROVIDER_NAMES.has(provider)) fail('source.provider', `provider must be one of ${[...PROVIDER_NAMES].join(', ')}`);
        if (provider !== PROVIDERS[host]) fail('source.provider', `a ${provider} repository is not on ${host}`);
    }
    return { provider: PROVIDERS[host], repo_url: `https://${host}/${m[2]}/${repo}` };
}

/** A branch name by git check-ref-format's rules (and a narrower character set), or throws ApiError(422). */
function cleanRef(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    const bad = (why) => fail('source.ref', `ref must be a branch name: ${why}`);
    if (!s || s.length > MAX_REF) bad(`1–${MAX_REF} characters`);
    if (!REF_CHARS_RE.test(s)) bad('letters, digits and . _ / + = , # - only');
    if (s.startsWith('-')) bad('it may not start with "-"');
    if (s.includes('..')) bad('it may not contain ".."');
    if (s.startsWith('/') || s.endsWith('/') || s.includes('//')) bad('no leading, trailing or doubled "/"');
    if (s.endsWith('.')) bad('it may not end with "."');
    if (s === 'HEAD' || s.startsWith('refs/')) bad('name the branch itself, not HEAD or refs/…');
    for (const part of s.split('/')) {
        if (part.startsWith('.') || part.endsWith('.lock')) bad('no part may start with "." or end with ".lock"');
    }
    return s;
}

/** Validates a PUT body -> { provider, repo_url, ref }, or throws ApiError(422). */
function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('source.invalid', 'the body must be { provider, repo_url, ref }');
    const extra = Object.keys(input).filter((k) => !FIELDS.has(k));
    // Refused, not ignored: a token or key sent here must never look as if Host kept it.
    if (extra.length) fail('source.unknown_field', `unknown field ${extra[0]}: a source is { provider, repo_url, ref } and holds no credential`);
    return { ...cleanRepoUrl(input.repo_url, input.provider), ref: cleanRef(input.ref) };
}

function createSiteSources({ store, sites }) {
    const { db } = store;
    const q = {
        bySite: db.prepare('SELECT * FROM host_site_sources WHERE site_id = ?'),
        upsert: db.prepare(`INSERT INTO host_site_sources (site_id, provider, repo_url, ref, created_by, created_at, updated_by, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT (site_id) DO UPDATE SET provider = EXCLUDED.provider, repo_url = EXCLUDED.repo_url, ref = EXCLUDED.ref,
                                updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`),
        remove: db.prepare('DELETE FROM host_site_sources WHERE site_id = ?'),
    };

    /** The site's source row, or null (no authorization: callers have loaded the site). */
    async function forSite(siteId) { return await q.bySite.get(siteId) || null; }

    async function get(viewer, siteId) {
        const { site } = await sites.load(viewer, siteId, 'read');
        return { site, source: await forSite(site.id) };
    }

    async function put(viewer, siteId, input) {
        const { site } = await sites.load(viewer, siteId, 'maintain');
        const src = normalize(input);
        const who = principalOf(viewer);
        const now = store.now();
        await q.upsert.run(site.id, src.provider, src.repo_url, src.ref, who, now, who, now);
        return { site, source: await forSite(site.id) };
    }

    async function remove(viewer, siteId) {
        const { site } = await sites.load(viewer, siteId, 'maintain');
        await q.remove.run(site.id);
        return { site, source: null };
    }

    return { forSite, get, put, remove, normalize };
}

module.exports = { createSiteSources, normalize, cleanRepoUrl, cleanRef, PROVIDERS, MAX_REF };
