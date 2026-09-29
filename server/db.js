'use strict';

/**
 * Host's own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot. Nothing here is shared with
 * another service.
 *
 *   host_projects         tenant projects: owner subject (usr_…), environment (production|sandbox),
 *                         network_project_id once OpenVibe.Network has projects (ADR-014)
 *   host_project_members  principals with a role on a project: usr_… or app:app_…/svc:… principals
 *   host_quotas           per-project overrides of the configured quota defaults (staff only)
 *   host_sites            a site = a name (<name>.openvibe.host) + the pointer to its active deploy
 *   host_deploys          IMMUTABLE artifacts: manifest (sha256 per file), totals, state
 *   host_deploy_files     path → sha256/size/content type per deploy (immutable)
 *   host_blobs            which content-addressed objects a project stores (storage accounting)
 *   host_activations      every pointer switch (activate / rollback), for audit and rollback targets
 *   host_deploy_logs      the upload/validation log of each deploy (there is no build in Stage B)
 *   host_domains          default <site>.openvibe.host and custom domains (TXT-verified)
 *   host_takedowns        staff takedowns of a site or a project (serving stops; content is kept)
 *   event_outbox          openvibe-sdk transactional outbox
 *
 * Immutability is enforced by the database itself: triggers refuse any UPDATE of a deploy's
 * artifact columns or of its file rows, and file rows can only be removed once the deploy is deleted.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

const CHARTER_TABLES = ['host_projects', 'host_project_members', 'host_quotas', 'host_sites', 'host_deploys', 'host_deploy_files', 'host_blobs', 'host_activations', 'host_deploy_logs', 'host_domains', 'host_takedowns'];

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
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms), so tests and replays are
 * deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,

        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS, CHARTER_TABLES };
