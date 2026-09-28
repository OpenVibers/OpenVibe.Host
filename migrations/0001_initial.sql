-- phase: expand
-- OpenVibe.Host on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE host_projects (
    id                  text COLLATE "C" PRIMARY KEY,                  -- prj_<ULID>
    seq               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    network_project_id  text COLLATE "C",                              -- OpenVibe.Network project id (ADR-014), when it exists
    owner_subject       text COLLATE "C" NOT NULL,                     -- usr_…
    name                text COLLATE "C" NOT NULL,
    environment         text COLLATE "C" NOT NULL DEFAULT 'production' CHECK (environment IN ('production','sandbox')),
    status              text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_at          bigint NOT NULL,
    updated_at          bigint NOT NULL,
    deleted_at          bigint
);
CREATE UNIQUE INDEX host_projects_network ON host_projects (network_project_id) WHERE network_project_id IS NOT NULL AND status = 'active';
CREATE INDEX host_projects_owner ON host_projects (owner_subject, status);

CREATE TABLE host_project_members (
    project_id  text COLLATE "C" NOT NULL REFERENCES host_projects(id),
    principal   text COLLATE "C" NOT NULL,                             -- usr_… | app:app_… | svc:<id>
    role        text COLLATE "C" NOT NULL CHECK (role IN ('owner','maintainer','deployer')),
    added_by    text COLLATE "C",
    created_at  bigint NOT NULL,
    PRIMARY KEY (project_id, principal)
);
CREATE INDEX host_project_members_principal ON host_project_members (principal);

CREATE TABLE host_quotas (
    project_id       text COLLATE "C" PRIMARY KEY REFERENCES host_projects(id),
    storage_bytes    bigint,
    deploys_per_day  bigint,
    max_files        bigint,
    max_file_bytes   bigint,
    sites            bigint,
    custom_domains   bigint,
    updated_by       text COLLATE "C",
    updated_at       bigint NOT NULL
);

CREATE TABLE host_sites (
    id                text COLLATE "C" PRIMARY KEY,                    -- site_<ULID>
    seq               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    project_id        text COLLATE "C" NOT NULL REFERENCES host_projects(id),
    name              text COLLATE "C" NOT NULL,                       -- the <name>.openvibe.host label
    active_deploy_id  text COLLATE "C",
    status            text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_by        text COLLATE "C" NOT NULL,
    created_at        bigint NOT NULL,
    updated_at        bigint NOT NULL,
    deleted_at        bigint
);
CREATE UNIQUE INDEX host_sites_name ON host_sites (name) WHERE status = 'active';
CREATE INDEX host_sites_project ON host_sites (project_id, status);

CREATE TABLE host_deploys (
    id               text COLLATE "C" PRIMARY KEY,                     -- dpl_<ULID>
    seq               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    project_id       text COLLATE "C" NOT NULL REFERENCES host_projects(id),
    site_id          text COLLATE "C" NOT NULL REFERENCES host_sites(id),
    state            text COLLATE "C" NOT NULL CHECK (state IN ('ready','failed','deleted')),
    source           text COLLATE "C" NOT NULL CHECK (source IN ('archive','files')),
    manifest         text COLLATE "C",                                 -- JSON host.deploy-manifest@1 (NULL when failed)
    manifest_sha256  text COLLATE "C",
    file_count       bigint NOT NULL DEFAULT 0,
    total_bytes      bigint NOT NULL DEFAULT 0,
    new_bytes        bigint NOT NULL DEFAULT 0,           -- bytes this deploy added to the project's storage
    failure_code     text COLLATE "C",
    created_by       text COLLATE "C" NOT NULL,
    created_at       bigint NOT NULL,
    deleted_at       bigint
);
CREATE INDEX host_deploys_site ON host_deploys (site_id, created_at);
CREATE INDEX host_deploys_project_day ON host_deploys (project_id, created_at);

CREATE TABLE host_deploy_files (
    deploy_id     text COLLATE "C" NOT NULL REFERENCES host_deploys(id),
    path          text COLLATE "C" NOT NULL,
    sha256        text COLLATE "C" NOT NULL,
    size          bigint NOT NULL,
    content_type  text COLLATE "C" NOT NULL,
    PRIMARY KEY (deploy_id, path)
);
CREATE INDEX host_deploy_files_sha ON host_deploy_files (sha256);

CREATE TABLE host_blobs (
    project_id  text COLLATE "C" NOT NULL,
    sha256      text COLLATE "C" NOT NULL,
    size        bigint NOT NULL,
    created_at  bigint NOT NULL,
    PRIMARY KEY (project_id, sha256)
);

CREATE TABLE host_activations (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id             text COLLATE "C" NOT NULL REFERENCES host_sites(id),
    deploy_id           text COLLATE "C" NOT NULL,
    previous_deploy_id  text COLLATE "C",
    kind                text COLLATE "C" NOT NULL CHECK (kind IN ('activate','rollback')),
    actor               text COLLATE "C" NOT NULL,
    created_at          bigint NOT NULL
);
CREATE INDEX host_activations_site ON host_activations (site_id, id);

CREATE TABLE host_deploy_logs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deploy_id   text COLLATE "C" NOT NULL,
    level       text COLLATE "C" NOT NULL CHECK (level IN ('info','warn','error')),
    message     text COLLATE "C" NOT NULL,
    created_at  bigint NOT NULL
);
CREATE INDEX host_deploy_logs_deploy ON host_deploy_logs (deploy_id, id);

CREATE TABLE host_domains (
    id                     text COLLATE "C" PRIMARY KEY,               -- dom_<ULID>
    seq               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    project_id             text COLLATE "C" NOT NULL REFERENCES host_projects(id),
    site_id                text COLLATE "C" NOT NULL REFERENCES host_sites(id),
    hostname               text COLLATE "C" NOT NULL,
    kind                   text COLLATE "C" NOT NULL CHECK (kind IN ('default','custom')),
    status                 text COLLATE "C" NOT NULL CHECK (status IN ('pending','verified','failed','lapsed')),
    token                  text COLLATE "C",                           -- the TXT verification value (custom only; public in DNS, not a secret)
    created_by             text COLLATE "C" NOT NULL,
    created_at             bigint NOT NULL,
    verified_at            bigint,
    last_checked_at        bigint,
    last_error             text COLLATE "C",
    check_count            bigint NOT NULL DEFAULT 0,
    record_missing_since   bigint                         -- verified domain whose TXT record disappeared
);
CREATE UNIQUE INDEX host_domains_verified ON host_domains (hostname) WHERE status = 'verified';
CREATE UNIQUE INDEX host_domains_site_host ON host_domains (site_id, hostname);
CREATE INDEX host_domains_status ON host_domains (kind, status, last_checked_at);

-- Abuse takedowns (staff only): a site, or every site of a project, stops being served (451) while
-- its deploys, files and objects are KEPT for review. Rows are never deleted: a lift is recorded.
CREATE TABLE host_takedowns (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    target_kind  text COLLATE "C" NOT NULL CHECK (target_kind IN ('project','site')),
    target_id    text COLLATE "C" NOT NULL,                             -- prj_… or site_…
    reason       text COLLATE "C" NOT NULL,
    created_by   text COLLATE "C" NOT NULL,
    created_at   bigint NOT NULL,
    lifted_by    text COLLATE "C",
    lifted_at    bigint,
    lift_note    text COLLATE "C"
);
CREATE UNIQUE INDEX host_takedowns_active ON host_takedowns (target_kind, target_id) WHERE lifted_at IS NULL;

-- Deploy artifacts are immutable: only state / deleted_at may change, and never back from 'deleted'.
CREATE FUNCTION host_deploys_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TRUE THEN RAISE EXCEPTION 'host: deploy artifacts are immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER host_deploys_immutable BEFORE UPDATE OF id, project_id, site_id, source, manifest, manifest_sha256, file_count, total_bytes, new_bytes, created_by, created_at ON host_deploys FOR EACH ROW EXECUTE FUNCTION host_deploys_immutable();
CREATE FUNCTION host_deploys_no_undelete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state = 'deleted' OR (OLD.state = 'failed' AND NEW.state = 'ready') THEN RAISE EXCEPTION 'host: a deleted or failed deploy cannot become ready'; END IF; RETURN NEW; END $$;
CREATE TRIGGER host_deploys_no_undelete BEFORE UPDATE OF state ON host_deploys FOR EACH ROW EXECUTE FUNCTION host_deploys_no_undelete();
CREATE FUNCTION host_deploy_files_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TRUE THEN RAISE EXCEPTION 'host: deploy files are immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER host_deploy_files_immutable BEFORE UPDATE ON host_deploy_files FOR EACH ROW EXECUTE FUNCTION host_deploy_files_immutable();
CREATE FUNCTION host_deploy_files_delete_only_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT state FROM host_deploys WHERE id = OLD.deploy_id) <> 'deleted' THEN RAISE EXCEPTION 'host: files of a live deploy cannot be removed'; END IF; RETURN OLD; END $$;
CREATE TRIGGER host_deploy_files_delete_only_deleted BEFORE DELETE ON host_deploy_files FOR EACH ROW EXECUTE FUNCTION host_deploy_files_delete_only_deleted();

-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
