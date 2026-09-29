'use strict';

/**
 * Host → OpenVibe.Events through the openvibe-sdk service outbox (ADR-004).
 *
 *   host.deploy.created    an upload became an immutable, ready deploy
 *   host.deploy.activated  a site's active deploy changed (payload.rollback marks a rollback)
 *   host.deploy.failed     an upload was refused (payload.code, problem codes; no file contents)
 *   host.domain.verified   a custom domain's TXT record was found; the domain is now served
 *
 * The SDK writes each row inside the change's own transaction (emit joins the ambient openvibe-sdk/db
 * transaction), so an event exists if and only if its change committed. The relay publishes with
 * Host's service token (events.event.publish, audience openvibe.events) only when EVENTS_URL and
 * OV_OAUTH_CLIENT_SECRET are set; otherwise rows wait in event_outbox and /api/ready reports the
 * relay as off. The undeclared event types below are refused by emit().
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = Object.freeze(['host.deploy.created', 'host.deploy.activated', 'host.deploy.failed', 'host.domain.verified']);

function createHostOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'host',
        eventsUrl: config.events.url,
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        now,
        log,
        eventTypes: EVENT_TYPES,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
}

module.exports = { createHostOutbox, EVENT_TYPES };
