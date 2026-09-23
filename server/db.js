'use strict';

/**
 * Host's own SQLite database (WAL), created on boot, idempotently. Nothing here is shared with
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
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host_projects (
    id                  TEXT PRIMARY KEY,                  -- prj_<ULID>
    network_project_id  TEXT,                              -- OpenVibe.Network project id (ADR-014), when it exists
    owner_subject       TEXT NOT NULL,                     -- usr_…
    name                TEXT NOT NULL,
    environment         TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production','sandbox')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    deleted_at          INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS host_projects_network ON host_projects (network_project_id) WHERE network_project_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS host_projects_owner ON host_projects (owner_subject, status);

CREATE TABLE IF NOT EXISTS host_project_members (
    project_id  TEXT NOT NULL REFERENCES host_projects(id),
    principal   TEXT NOT NULL,                             -- usr_… | app:app_… | svc:<id>
    role        TEXT NOT NULL CHECK (role IN ('owner','maintainer','deployer')),
    added_by    TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, principal)
);
CREATE INDEX IF NOT EXISTS host_project_members_principal ON host_project_members (principal);

CREATE TABLE IF NOT EXISTS host_quotas (
    project_id       TEXT PRIMARY KEY REFERENCES host_projects(id),
    storage_bytes    INTEGER,
    deploys_per_day  INTEGER,
    max_files        INTEGER,
    max_file_bytes   INTEGER,
    sites            INTEGER,
    custom_domains   INTEGER,
    updated_by       TEXT,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_sites (
    id                TEXT PRIMARY KEY,                    -- site_<ULID>
    project_id        TEXT NOT NULL REFERENCES host_projects(id),
    name              TEXT NOT NULL,                       -- the <name>.openvibe.host label
    active_deploy_id  TEXT,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    deleted_at        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS host_sites_name ON host_sites (name) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS host_sites_project ON host_sites (project_id, status);

CREATE TABLE IF NOT EXISTS host_deploys (
    id               TEXT PRIMARY KEY,                     -- dpl_<ULID>
    project_id       TEXT NOT NULL REFERENCES host_projects(id),
    site_id          TEXT NOT NULL REFERENCES host_sites(id),
    state            TEXT NOT NULL CHECK (state IN ('ready','failed','deleted')),
    source           TEXT NOT NULL CHECK (source IN ('archive','files')),
    manifest         TEXT,                                 -- JSON host.deploy-manifest@1 (NULL when failed)
    manifest_sha256  TEXT,
    file_count       INTEGER NOT NULL DEFAULT 0,
    total_bytes      INTEGER NOT NULL DEFAULT 0,
    new_bytes        INTEGER NOT NULL DEFAULT 0,           -- bytes this deploy added to the project's storage
    failure_code     TEXT,
    created_by       TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    deleted_at       INTEGER
);
CREATE INDEX IF NOT EXISTS host_deploys_site ON host_deploys (site_id, created_at);
CREATE INDEX IF NOT EXISTS host_deploys_project_day ON host_deploys (project_id, created_at);

CREATE TABLE IF NOT EXISTS host_deploy_files (
    deploy_id     TEXT NOT NULL REFERENCES host_deploys(id),
    path          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    size          INTEGER NOT NULL,
    content_type  TEXT NOT NULL,
    PRIMARY KEY (deploy_id, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS host_deploy_files_sha ON host_deploy_files (sha256);

CREATE TABLE IF NOT EXISTS host_blobs (
    project_id  TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, sha256)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS host_activations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id             TEXT NOT NULL REFERENCES host_sites(id),
    deploy_id           TEXT NOT NULL,
    previous_deploy_id  TEXT,
    kind                TEXT NOT NULL CHECK (kind IN ('activate','rollback')),
    actor               TEXT NOT NULL,
    created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS host_activations_site ON host_activations (site_id, id);

CREATE TABLE IF NOT EXISTS host_deploy_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    deploy_id   TEXT NOT NULL,
    level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
    message     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS host_deploy_logs_deploy ON host_deploy_logs (deploy_id, id);

CREATE TABLE IF NOT EXISTS host_domains (
    id                     TEXT PRIMARY KEY,               -- dom_<ULID>
    project_id             TEXT NOT NULL REFERENCES host_projects(id),
    site_id                TEXT NOT NULL REFERENCES host_sites(id),
    hostname               TEXT NOT NULL,
    kind                   TEXT NOT NULL CHECK (kind IN ('default','custom')),
    status                 TEXT NOT NULL CHECK (status IN ('pending','verified','failed','lapsed')),
    token                  TEXT,                           -- the TXT verification value (custom only; public in DNS, not a secret)
    created_by             TEXT NOT NULL,
    created_at             INTEGER NOT NULL,
    verified_at            INTEGER,
    last_checked_at        INTEGER,
    last_error             TEXT,
    check_count            INTEGER NOT NULL DEFAULT 0,
    record_missing_since   INTEGER                         -- verified domain whose TXT record disappeared
);
CREATE UNIQUE INDEX IF NOT EXISTS host_domains_verified ON host_domains (hostname) WHERE status = 'verified';
CREATE UNIQUE INDEX IF NOT EXISTS host_domains_site_host ON host_domains (site_id, hostname);
CREATE INDEX IF NOT EXISTS host_domains_status ON host_domains (kind, status, last_checked_at);

-- Abuse takedowns (staff only): a site, or every site of a project, stops being served (451) while
-- its deploys, files and objects are KEPT for review. Rows are never deleted: a lift is recorded.
CREATE TABLE IF NOT EXISTS host_takedowns (
    id           INTEGER PRIMARY KEY,
    target_kind  TEXT NOT NULL CHECK (target_kind IN ('project','site')),
    target_id    TEXT NOT NULL,                             -- prj_… or site_…
    reason       TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    lifted_by    TEXT,
    lifted_at    INTEGER,
    lift_note    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS host_takedowns_active ON host_takedowns (target_kind, target_id) WHERE lifted_at IS NULL;

-- Deploy artifacts are immutable: only state / deleted_at may change, and never back from 'deleted'.
CREATE TRIGGER IF NOT EXISTS host_deploys_immutable
BEFORE UPDATE OF id, project_id, site_id, source, manifest, manifest_sha256, file_count, total_bytes, new_bytes, created_by, created_at ON host_deploys
BEGIN SELECT RAISE(ABORT, 'host: deploy artifacts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS host_deploys_no_undelete
BEFORE UPDATE OF state ON host_deploys WHEN OLD.state = 'deleted' OR (OLD.state = 'failed' AND NEW.state = 'ready')
BEGIN SELECT RAISE(ABORT, 'host: a deleted or failed deploy cannot become ready'); END;
CREATE TRIGGER IF NOT EXISTS host_deploy_files_immutable
BEFORE UPDATE ON host_deploy_files
BEGIN SELECT RAISE(ABORT, 'host: deploy files are immutable'); END;
CREATE TRIGGER IF NOT EXISTS host_deploy_files_delete_only_deleted
BEFORE DELETE ON host_deploy_files WHEN (SELECT state FROM host_deploys WHERE id = OLD.deploy_id) <> 'deleted'
BEGIN SELECT RAISE(ABORT, 'host: files of a live deploy cannot be removed'); END;
`;

const CHARTER_TABLES = ['host_projects', 'host_project_members', 'host_quotas', 'host_sites', 'host_deploys', 'host_deploy_files', 'host_blobs', 'host_activations', 'host_deploy_logs', 'host_domains', 'host_takedowns'];

function openStore(dbPath, { now = () => Date.now() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return {
        db,
        now,
        tx: (fn) => db.transaction(fn)(),
        close: () => db.close(),
    };
}

module.exports = { openStore, CHARTER_TABLES };
