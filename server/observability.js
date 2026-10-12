'use strict';
/** Catalog and outbox readiness. */
const { createReadiness } = require('openvibe-shared/ready');
const { jwksClient } = require('openvibe-sdk/auth');
const { CHARTER_TABLES } = require('./db');

function createHostReadiness({ store, outbox, jwksUrl = null, release = null, valkey = null }) {
    const { db } = store;
    return createReadiness({
        service: 'host',
        release,
        checks: [
            {
                name: 'db', required: true,
                // A real round trip that names the store (postgresql / pglite), and the charter tables present.
                check: async () => {
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    const names = new Set((await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()").all()).map((r) => r.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')} (migrations did not run)` : { ok: true, detail: r.detail };
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (!jwksUrl) return { skipped: 'no Network JWKS URL configured' };
                    const client = jwksClient(jwksUrl);
                    if (client.status().ready) return true;
                    client.refresh().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and service calls are unavailable';
                },
            },
            {
                name: 'events_relay', required: false,
                check: async () => {
                    const s = await outbox.status();
                    if (!s.enabled) return `relay off (Events URL or service credentials not configured); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
        ],
    });
}

module.exports = { createHostReadiness };
