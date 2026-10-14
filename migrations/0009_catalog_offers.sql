-- phase: expand
-- Hosting offers (plan T20 step 3, "a modern LowEndBox"): the offers providers post on LowEndTalk's Offers board and
-- LowEndBox's offer posts, read from their public feeds through OpenVibe.Sources (category hosting,
-- server/catalog/offers.js). Host keeps the headline, who posted it, the post's date and link, and the price the
-- headline (or the post's opening) states, exactly as stated; never the post's text.
CREATE TABLE catalog_offers (
    id             text COLLATE "C" PRIMARY KEY,
    source_key     text COLLATE "C" NOT NULL,
    external_id    text COLLATE "C" NOT NULL,
    source_item_id text COLLATE "C",
    title          text NOT NULL,
    poster         text,
    url            text NOT NULL,
    published_at   bigint NOT NULL,
    price_text     text,
    price_from     text COLLATE "C" CHECK (price_from IN ('title','post')),
    price_amount   numeric(12,2),
    price_currency text COLLATE "C",
    price_period   text COLLATE "C" CHECK (price_period IN ('month','year')),
    price_monthly  numeric(12,4),
    status         text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
    first_seen_at  bigint NOT NULL,
    checked_at     bigint NOT NULL,
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL,
    UNIQUE (source_key, external_id),
    CHECK ((price_text IS NULL) = (price_monthly IS NULL))
);
CREATE INDEX catalog_offers_recent ON catalog_offers (status, published_at DESC, id);
CREATE INDEX catalog_offers_price ON catalog_offers (status, price_currency, price_monthly, id);
