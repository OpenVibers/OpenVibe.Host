-- phase: contract
-- after: 0007
-- Static hosting moved to OpenVibe.Space. No production Host projects, sites or deploys remain.
DROP TABLE IF EXISTS host_deploy_git;
DROP TABLE IF EXISTS host_site_sources;
DROP TABLE IF EXISTS host_site_config;
DROP TABLE IF EXISTS host_deploy_files;
DROP TABLE IF EXISTS host_deploy_logs;
DROP TABLE IF EXISTS host_activations;
DROP TABLE IF EXISTS host_domains;
DROP TABLE IF EXISTS host_takedowns;
DROP TABLE IF EXISTS host_quotas;
DROP TABLE IF EXISTS host_project_members;
DROP TABLE IF EXISTS host_deploys;
DROP TABLE IF EXISTS host_sites;
DROP TABLE IF EXISTS host_blobs;
DROP TABLE IF EXISTS host_projects;
DROP FUNCTION IF EXISTS host_deploy_git_immutable();
DROP FUNCTION IF EXISTS host_deploy_files_delete_only_deleted();
DROP FUNCTION IF EXISTS host_deploy_files_immutable();
DROP FUNCTION IF EXISTS host_deploys_no_undelete();
DROP FUNCTION IF EXISTS host_deploys_immutable();
