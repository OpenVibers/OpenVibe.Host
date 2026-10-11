'use strict';

const { serviceAuth, http } = require('openvibe-contracts');
const { createDiscussionClient } = require('openvibe-publishing/discussion');

function createCommunity({ store, config, fetchImpl = globalThis.fetch, log = console }) {
    const base = config.community.internalUrl;
    const enabled = Boolean(base && config.oauth.clientSecret);
    const tokens = (scope) => serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.community', scope, fetchImpl,
    });
    const writeTokens = enabled ? tokens('community.comment.write') : null;
    const modTokens = enabled ? tokens('community.comment.moderate') : null;
    const client = enabled ? createDiscussionClient({ communityUrl: base, tokenClient: writeTokens, fetchImpl }) : null;
    const key = (type, id) => `${type}:${id}`;

    async function call(method, path, { token, body, ctx } = {}) {
        const headers = { Accept: 'application/json', ...(ctx ? http.outboundHeaders(ctx) : {}) };
        if (token) Object.assign(headers, await token.authHeaders());
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4000) });
        const data = await res.json().catch(() => null);
        if (res.status === 401 && token && token.invalidate) token.invalidate();
        if (!res.ok) throw new Error((data && (data.detail || data.error)) || `Community answered ${res.status}`);
        return data;
    }

    return {
        enabled,
        publicUrl: config.community.publicUrl,
        async threadFor(type, entity, label, ctx) {
            if (!enabled) return null;
            const entityId = key(type, entity.id);
            const known = await store.discussion.get(entityId);
            if (known) return known.threadId;
            const ref = { service: 'host', type, id: entity.id, label: String(label).slice(0, 200) };
            const out = await store.discussion.threadFor(entityId, ref, { client, traceparent: ctx && ctx.traceparent, requestId: ctx && ctx.requestId });
            return out.threadId;
        },
        async readThread(threadId, ctx) {
            return await call('GET', `/api/v1/comments/threads/${encodeURIComponent(threadId)}`, { ctx });
        },
        async setThreadVisibility(type, id, visibility) {
            if (!enabled) return false;
            const known = await store.discussion.get(key(type, id));
            if (!known) return false;
            try {
                await call('PUT', `/api/v1/comments/threads/${encodeURIComponent(known.threadId)}/visibility`, { token: modTokens, body: { visibility } });
                return true;
            } catch (err) {
                log.warn(`[Host] could not set ${type} ${id} discussion ${visibility}: ${err.message}`);
                return false;
            }
        },
    };
}

module.exports = { createCommunity };
