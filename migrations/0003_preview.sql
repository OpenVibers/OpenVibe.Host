-- phase: expand
-- Preview deploys (plan T12 J4, decision D5): a preview is served by the dashboard only, at
-- /preview/<deploy-id>/…, to a member of the deploy's project — never on a public host, never indexed.
--
--   source='preview'   a deploy uploaded as a preview (its archive/files kind is in the upload log).
--   preview pointer    host_sites.preview_deploy_id names the site's ONE live preview; the tenant
--                      server reads it once, like active_deploy_id. The pointer is cleared when the
--                      preview expires, when the site deploys or rolls back (any pointer switch), when
--                      the preview is deleted, or when the site is deleted.
--   preview_expires_at a preview stops being served at this instant (epoch ms); the row and its
--                      objects stay until the deploy is deleted.
ALTER TABLE host_deploys DROP CONSTRAINT host_deploys_source_check;
ALTER TABLE host_deploys ADD CONSTRAINT host_deploys_source_check CHECK (source IN ('archive', 'files', 'preview'));

ALTER TABLE host_sites ADD COLUMN preview_deploy_id text COLLATE "C";
ALTER TABLE host_sites ADD COLUMN preview_expires_at bigint;
