-- phase: expand
-- Git deploys, Phase 1 (plan T12 Stage B): provenance and preview, with the build OUTSIDE Host.
-- A site may name the Git repository and branch its project's own CI builds from. That CI checks the
-- commit out, builds it and posts the output to POST /api/v1/sites/:id/source/deploys with the ref and
-- the commit it built; Host validates the files exactly like an upload and stores them as a deploy
-- with source 'git' that becomes the site's live preview, never its active deploy. Host never clones,
-- fetches, holds a credential or runs anything: these rows hold public provenance only.
--
--   host_site_sources  the site's connected repository (one per site): an https URL on a known
--                      provider and the branch the CI deploys from. No secret, no credential name.
--   host_deploy_git    what a git deploy was built from, written in the same transaction as the
--                      deploy and immutable afterwards, like the deploy's files.
ALTER TABLE host_deploys DROP CONSTRAINT host_deploys_source_check;
ALTER TABLE host_deploys ADD CONSTRAINT host_deploys_source_check CHECK (source IN ('archive', 'files', 'preview', 'git'));

CREATE TABLE host_site_sources (
    site_id     text COLLATE "C" PRIMARY KEY REFERENCES host_sites(id),
    provider    text COLLATE "C" NOT NULL CHECK (provider IN ('github', 'gitlab', 'codeberg')),
    repo_url    text COLLATE "C" NOT NULL,
    ref         text COLLATE "C" NOT NULL,
    created_by  text COLLATE "C",
    created_at  bigint NOT NULL,
    updated_by  text COLLATE "C",
    updated_at  bigint NOT NULL
);

CREATE TABLE host_deploy_git (
    deploy_id   text COLLATE "C" PRIMARY KEY REFERENCES host_deploys(id),
    provider    text COLLATE "C" NOT NULL,
    repo_url    text COLLATE "C" NOT NULL,
    ref         text COLLATE "C" NOT NULL,
    commit_sha  text COLLATE "C" NOT NULL,
    created_at  bigint NOT NULL
);

-- A deploy's provenance is immutable, like its files.
CREATE FUNCTION host_deploy_git_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TRUE THEN RAISE EXCEPTION 'host: deploy provenance is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER host_deploy_git_immutable BEFORE UPDATE ON host_deploy_git FOR EACH ROW EXECUTE FUNCTION host_deploy_git_immutable();
