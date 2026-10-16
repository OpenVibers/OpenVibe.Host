-- phase: expand
-- Domain names compared (plan T20, the owner's "like tld-list.com"): what each registrar charges for a TLD, for the
-- first year, a renewal and a transfer, read from registrars' public price lists through OpenVibe.Sources (category
-- hosting, server/catalog/domains.js) or entered by staff with the page it came from. The registrar is a catalog
-- provider. Every price is an observation with the time it was checked; changes are kept, append-only.
CREATE TABLE catalog_tld_prices (
    id             text COLLATE "C" PRIMARY KEY,
    provider_id    text COLLATE "C" NOT NULL REFERENCES catalog_providers(id),
    tld            text COLLATE "C" NOT NULL CHECK (tld ~ '^(xn--)?[a-z0-9]+(-[a-z0-9]+)*(\.(xn--)?[a-z0-9]+(-[a-z0-9]+)*)*$' AND length(tld) <= 120),
    currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    register       numeric(12,4) CHECK (register >= 0),
    renew          numeric(12,4) CHECK (renew >= 0),
    transfer       numeric(12,4) CHECK (transfer >= 0),
    origin         text NOT NULL CHECK (origin IN ('sources','staff')),
    source_key     text,
    source_item_id text,
    source_url     text NOT NULL,
    checked_at     bigint NOT NULL,
    first_seen_at  bigint NOT NULL,
    last_seen_at   bigint NOT NULL,
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','gone','hidden')),
    created_by     text,
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL,
    UNIQUE (provider_id, tld),
    CHECK (register IS NOT NULL OR renew IS NOT NULL OR transfer IS NOT NULL),
    CHECK (origin = 'staff' OR (source_key IS NOT NULL AND source_item_id IS NOT NULL))
);
CREATE INDEX catalog_tld_prices_tld ON catalog_tld_prices (tld, status, register);
CREATE INDEX catalog_tld_prices_register ON catalog_tld_prices (status, currency, register, tld);
CREATE TABLE catalog_tld_price_changes (
    price_id        text COLLATE "C" NOT NULL REFERENCES catalog_tld_prices(id),
    observed_at     bigint NOT NULL,
    currency        text NOT NULL,
    register_before numeric(12,4),
    register_after  numeric(12,4),
    renew_before    numeric(12,4),
    renew_after     numeric(12,4),
    transfer_before numeric(12,4),
    transfer_after  numeric(12,4),
    PRIMARY KEY (price_id, observed_at)
);
CREATE FUNCTION catalog_tld_price_changes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'host: domain price history is immutable'; END $$;
CREATE TRIGGER catalog_tld_price_changes_immutable BEFORE UPDATE OR DELETE ON catalog_tld_price_changes FOR EACH ROW EXECUTE FUNCTION catalog_tld_price_changes_immutable();
