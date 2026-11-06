'use strict';
/**
 * OpenVibe.Media, from ovhost: the screenshot pass (plan L9, devblog §3.3).
 *
 * The shots ovhost captures are Media objects in Host's own tenant ("host"), uploaded through the
 * Object API v2 the way OpenVibe.Community and Codes do: init, PUT the bytes, complete. Host reaches
 * Media with its own service token (the client id it already has, in /etc/openvibe/host.env); the
 * grant is media.object.* on the host namespace (Network's default grants).
 *
 * The secret is never printed and never leaves this module: it is a non-enumerable property of the
 * configuration, so JSON.stringify and util.inspect never show it.
 */
const path = require('path');

const DEFAULT_ENV_FILE = '/etc/openvibe/host.env';
const APP = 'host';
const SCOPE = 'media.object.upload media.object.read media.object.list media.object.delete';

function parseEnv(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '');
        out[m[1]] = v;
    }
    return out;
}

/**
 * -> { file, clientId, networkUrl, mediaUrl } with the secret as a non-enumerable property, or
 * { file, error, notConfigured }.
 */
async function loadCredentials(exec, inv, { file = null, env = {} } = {}) {
    const f = file || env.OVHOST_MEDIA_ENV || (inv.shots && inv.shots.envFile) || DEFAULT_ENV_FILE;
    if (!path.isAbsolute(f)) return { file: f, error: 'the media env file must be an absolute path', notConfigured: true };
    let text;
    try { text = await exec.readFile(f, { privileged: true }); } catch (err) { return { file: f, error: `${f} is not readable (${err.code || 'error'})`, notConfigured: true }; }
    if (text == null) return { file: f, error: `${f} not found`, notConfigured: true };
    const v = parseEnv(text);
    const missing = ['OV_OAUTH_CLIENT_SECRET'].filter((n) => !v[n]);
    if (missing.length) return { file: f, error: `${f} sets no ${missing.join(' and no ')}`, notConfigured: true };
    const network = v.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000';
    const media = v.MEDIA_INTERNAL_URL || v.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100';
    return Object.defineProperty(
        { file: f, clientId: v.OV_OAUTH_CLIENT_ID || 'host', networkUrl: network.replace(/\/+$/, ''), mediaUrl: media.replace(/\/+$/, '') },
        'secret', { value: v.OV_OAUTH_CLIENT_SECRET, enumerable: false },
    );
}

/**
 * The Media client: a token from Network, then the Object API v2 of the "host" tenant.
 * uploadPng() stores one screenshot; list() reads the index; remove() prunes.
 */
function createMedia({ clientId, secret, networkUrl, mediaUrl, app = APP, fetchImpl = globalThis.fetch }) {
    let token = null;
    let tokenAt = 0;

    async function authHeaders() {
        if (token && Date.now() - tokenAt < 240000) return { Authorization: `Bearer ${token}` };
        const body = new URLSearchParams({
            grant_type: 'client_credentials', client_id: clientId, client_secret: secret,
            audience: 'openvibe.media', scope: SCOPE,
        });
        const res = await fetchImpl(`${networkUrl}/oauth/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        });
        if (!res.ok) throw new Error(`Network answered ${res.status} for a Media token`);
        const j = await res.json();
        if (!j || !j.access_token) throw new Error('Network answered no access token');
        token = j.access_token;
        tokenAt = Date.now();
        return { Authorization: `Bearer ${token}` };
    }

    async function request(pathname, { method = 'GET', json, body, headers = {} } = {}) {
        const res = await fetchImpl(`${mediaUrl}${pathname}`, {
            method,
            headers: { Accept: 'application/json', ...(await authHeaders()), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: json ? JSON.stringify(json) : body,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Media answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        if (!text) return null;
        try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    const base = () => `/api/v2/${encodeURIComponent(app)}/objects`;

    return {
        app,
        /** One PNG: init, PUT the bytes, complete. Answers { id, object }. */
        async uploadPng({ data, mime = 'image/png', kind = 'screenshot', visibility = 'unlisted', metadata = {} }) {
            const init = await request(base(), { method: 'POST', json: { kind, visibility, metadata } });
            const id = init && (init.id || (init.object && init.object.id));
            if (!id) throw new Error('Media answered no object id');
            await request(`${base()}/${encodeURIComponent(id)}/content`, { method: 'PUT', body: data, headers: { 'Content-Type': mime } });
            const done = await request(`${base()}/${encodeURIComponent(id)}/complete`, { method: 'POST', json: {} });
            return { id, object: (done && done.object) || done };
        },
        /** The shots of this tenant, newest first. */
        async list({ kind = null, limit = 100, cursor = null, namespace = null } = {}) {
            const q = new URLSearchParams({ limit: String(limit) });
            if (kind) q.set('kind', kind);
            if (cursor) q.set('cursor', cursor);
            if (namespace) q.set('namespace', namespace);
            const r = await request(`${base()}?${q.toString()}`);
            return { objects: (r && r.objects) || [], next_cursor: (r && r.next_cursor) || null };
        },
        /** Every shot, page by page. */
        async listAll({ kind = 'screenshot', limit = 100 } = {}) {
            const out = [];
            let cursor = null;
            for (;;) {
                const page = await this.list({ kind, limit, cursor });
                out.push(...page.objects);
                if (!page.next_cursor) break;
                cursor = page.next_cursor;
            }
            return out;
        },
        async remove(id) { return await request(`${base()}/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    };
}

module.exports = { createMedia, loadCredentials, parseEnv, APP, SCOPE, DEFAULT_ENV_FILE };
