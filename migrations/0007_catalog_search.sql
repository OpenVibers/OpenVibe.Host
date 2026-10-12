-- phase: expand
-- The hosting catalog in OpenVibe.Search (server/catalog/search-index.js, openvibe-publishing/search-feed): the index
-- sequencer, the last revision and content hash Search was sent for each catalog page, so an unchanged page is never
-- sent twice. The host.index_document.* events themselves go through event_outbox like Host's other events.
CREATE TABLE host_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);
