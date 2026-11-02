-- phase: expand
-- The term a catalog plan's price is quoted for, and the price it renews at when the source states one.
--
-- Every sourced plan's stored price is a monthly price (server/catalog/mapping.js reads Linode's price.monthly,
-- Vultr's monthly_cost, Lightsail's hourly rate for its 744-hour month, Azure's hourly rate for 730 hours, and
-- OVHcloud's commitment=0 one-month price), so its term is known: monthly. A staff entry states its own term, or
-- leaves it null and the page says "term not published". No source states a renewal price for a server plan, so
-- renewal_price stays null until one does and the page says "renewal price not published".
ALTER TABLE catalog_plans ADD COLUMN price_term text COLLATE "C" CHECK (price_term IN ('monthly', '1-year', '3-year'));
ALTER TABLE catalog_plans ADD COLUMN renewal_price numeric(12,4) CHECK (renewal_price >= 0);
UPDATE catalog_plans SET price_term = 'monthly' WHERE origin = 'sources' AND price_term IS NULL;
