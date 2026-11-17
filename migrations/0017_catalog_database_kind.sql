-- phase: expand
-- Managed databases join the catalog as their own kind (plan §AD.18: the owner asked for the managed options for the
-- database beside the servers). Sourced from OVHcloud's Public Cloud Databases and Linode's managed databases (Sources
-- ovhcloud-managed-postgresql, linode-managed-postgresql); a database plan's price is the whole service's monthly price.
-- Widening the check is safe for the release before this one: it never writes the new kind.
ALTER TABLE catalog_plans DROP CONSTRAINT IF EXISTS catalog_plans_kind_check;
ALTER TABLE catalog_plans ADD CONSTRAINT catalog_plans_kind_check CHECK (kind IN ('cloud','vps','dedicated','storage','domain','database'));
