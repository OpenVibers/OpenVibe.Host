# Hosting catalog account data (ADR-033)

The catalog has three person columns: `catalog_providers.created_by`,
`catalog_plans.created_by`, and `catalog_promos.created_by`. The
`server/catalog/account-data.js` map exports the rows created by a person. On
account deletion it sets those three columns to null. The shared provider,
plan, and promo rows stay in the catalog without an author. Source-ingested
rows have no `created_by`. `catalog_price_changes` has no person column.

Host has no existing account-data event handler or service-wide ADR-033 map to
register this with. The helpers are ready for that integration when it lands.
