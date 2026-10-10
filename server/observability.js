'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real query on Host's PostgreSQL database (the charter tables answer)
 *   storage         required  the object store directory is writable (uploads and serving need it)
 *   network_jwks    optional  the Network signing key has loaded; without it tenant sites still
 *                             serve, but nobody can sign in and service tokens are refused (503)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows
 *   domain_checks   optional  no custom domain is stuck: pending checks are running
 */
const { createReadiness } = require('openvibe-shared/ready');
const { jwksClient } = require('openvibe-sdk/auth');
const { CHARTER_TABLES } = require('./db');

function createHostReadiness({ store, blobs, outbox, jwksUrl = null, release = null, minFreeBytes = () => 0, valkey = null }) {
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
            { name: 'storage', required: true, check: () => blobs.writable() },
            {
                // Serving goes on; only new deploys are refused below the floor.
                name: 'disk_headroom', required: false,
                check: () => {
                    const free = blobs.freeBytes();
                    const floor = minFreeBytes();
                    return free >= floor ? { ok: true, detail: { free_bytes: free } } : `${free} bytes free, below HOST_MIN_FREE_BYTES (${floor}): new deploys are refused`;
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
            {
                name: 'domain_checks', required: false,
                check: async () => {
                    const stale = (await db.prepare("SELECT COUNT(*) AS n FROM host_domains WHERE kind = 'custom' AND status = 'pending' AND COALESCE(last_checked_at, created_at) < ?").get(store.now() - 3600 * 1000)).n;
                    return stale ? `${stale} pending custom domains not checked in the last hour (is the worker on?)` : true;
                },
            },
        ],
    });
}

module.exports = { createHostReadiness };
