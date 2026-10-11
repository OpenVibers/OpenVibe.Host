-- phase: expand
-- Public, sourced hosting catalog. Times are epoch milliseconds, like Host's other tables.
CREATE TABLE catalog_providers (
    id text COLLATE "C" PRIMARY KEY,
    slug text COLLATE "C" NOT NULL UNIQUE,
    name text NOT NULL,
    homepage_url text NOT NULL,
    description text,
    affiliate_url text,
    affiliate_note text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
    created_by text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE TABLE catalog_plans (
    id text COLLATE "C" PRIMARY KEY,
    provider_id text COLLATE "C" NOT NULL REFERENCES catalog_providers(id),
    external_id text COLLATE "C" NOT NULL,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('cloud','vps','dedicated','storage','domain')),
    vcpu numeric CHECK (vcpu >= 0),
    ram_mb numeric CHECK (ram_mb >= 0),
    disk_gb numeric CHECK (disk_gb >= 0),
    disk_type text CHECK (disk_type IN ('ssd','nvme','hdd')),
    bandwidth_gb numeric CHECK (bandwidth_gb >= 0),
    unmetered boolean,
    port_mbps numeric CHECK (port_mbps >= 0),
    ipv4 integer CHECK (ipv4 >= 0),
    locations text[],
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    price_monthly numeric(12,4) NOT NULL CHECK (price_monthly >= 0),
    price_hourly numeric(12,6) CHECK (price_hourly >= 0),
    setup_fee numeric(12,4) CHECK (setup_fee >= 0),
    origin text NOT NULL CHECK (origin IN ('sources','staff')),
    source_key text,
    source_item_id text,
    source_url text NOT NULL,
    checked_at bigint NOT NULL,
    first_seen_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','gone','hidden')),
    created_by text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    UNIQUE (provider_id, external_id),
    CHECK (origin = 'staff' OR (source_key IS NOT NULL AND source_item_id IS NOT NULL))
);
CREATE INDEX catalog_plans_public ON catalog_plans (currency, status, price_monthly, id);
CREATE TABLE catalog_price_changes (
    plan_id text COLLATE "C" NOT NULL REFERENCES catalog_plans(id),
    observed_at bigint NOT NULL,
    currency text NOT NULL,
    price_monthly_before numeric(12,4) NOT NULL,
    price_monthly_after numeric(12,4) NOT NULL,
    PRIMARY KEY (plan_id, observed_at),
    CHECK (price_monthly_before <> price_monthly_after)
);
CREATE TABLE catalog_promos (
    id text COLLATE "C" PRIMARY KEY,
    provider_id text COLLATE "C" NOT NULL REFERENCES catalog_providers(id),
    title text NOT NULL,
    details text,
    code text,
    url text NOT NULL,
    affiliate boolean NOT NULL DEFAULT false,
    starts_at bigint,
    ends_at bigint,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','hidden')),
    created_by text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at <= ends_at)
);
CREATE INDEX catalog_promos_live ON catalog_promos (status, ends_at);
CREATE TABLE catalog_ingest_cursor (name text COLLATE "C" PRIMARY KEY, cursor bigint NOT NULL, updated_at bigint NOT NULL);
-- Historical observations are append-only.
CREATE FUNCTION catalog_price_changes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'host: catalog price history is immutable'; END $$;
CREATE TRIGGER catalog_price_changes_immutable BEFORE UPDATE OR DELETE ON catalog_price_changes FOR EACH ROW EXECUTE FUNCTION catalog_price_changes_immutable();
