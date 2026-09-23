'use strict';

/**
 * Host → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   host.deploy.created    an upload became an immutable, ready deploy
 *   host.deploy.activated  a site's active deploy changed (payload.rollback marks a rollback)
 *   host.deploy.failed     an upload was refused (payload.code, problem codes; no file contents)
 *   host.domain.verified   a custom domain's TXT record was found; the domain is now served
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Host's service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise
 * rows wait in event_outbox and /api/ready reports the relay as off.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = Object.freeze(['host.deploy.created', 'host.deploy.activated', 'host.deploy.failed', 'host.domain.verified']);

function createHostOutbox({ db, config, fetchImpl, now, log = console }) {
    const enabled = Boolean(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0 };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (Events URL or service credentials not configured)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'host' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[Host] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. Returns the complete envelope (with its event_id). */
    function emit(envelope, { traceparent } = {}) {
        if (!EVENT_TYPES.includes(envelope.event_type)) throw new Error(`undeclared event type ${envelope.event_type}`);
        return outbox.enqueue(envelope, { traceparent });
    }

    return {
        emit,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createHostOutbox, EVENT_TYPES };
