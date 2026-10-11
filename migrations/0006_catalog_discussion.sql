-- phase: expand
-- Community threads for catalog providers and plans (plan T20 step 3): which thread each entity resolved to.
CREATE TABLE host_catalog_discussion_refs (
    entity_id text COLLATE "C" PRIMARY KEY,
    thread_id text NOT NULL,
    ref jsonb NOT NULL,
    resolved_at bigint NOT NULL
);
