'use strict';

/** Catalog search indexing events through the OpenVibe.Events outbox. */
const { createServiceOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = Object.freeze(['host.index_document.upserted', 'host.index_document.deleted']);

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
