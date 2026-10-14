'use strict';

/** OpenVibe.Host catalog database. Applied migrations are immutable. */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

const CHARTER_TABLES = ['host_catalog_discussion_refs', 'catalog_providers', 'catalog_plans', 'catalog_price_changes', 'catalog_promos', 'catalog_offers', 'catalog_ingest_cursor'];

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        // HOST_PGLITE_DIR lets a test (or a second local process) point the embedded database somewhere
        // of its own; production never takes this path.
        const pgliteDir = config.db.pgliteDir || DEV_PGLITE;
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh host)');
        log.warn(`[Host] DATABASE_URL unset: embedded PGlite database in ${pgliteDir} (development only, one process)`);
        fs.mkdirSync(pgliteDir, { recursive: true });
        const db = createDb({ pglite: pgliteDir, service: 'host', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'host-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'host', registry, log });
}

/**
 * Every store on a database handle. opts.now — injectable clock (epoch ms), so tests and replays are
 * deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        discussion: createDiscussionRefs(db, { prefix: 'host_catalog', now }),

        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS, CHARTER_TABLES };
