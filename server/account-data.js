'use strict';
/**
 * Account export and deletion → Host (ADR-033; openvibe-sdk/account-data). What Host holds about a person:
 *
 *   the console     the hosting accounts they connected (provider, label, the token's last four characters; never the
 *                   sealed token itself) and the actions they took on their servers. Deletion removes both, so their
 *                   tokens are gone from OpenVibe.Host.
 *   benchmarks      the results they submitted (migration 0012) and their one-time links (never the link's token).
 *                   Deletion removes the links and detaches the results, which stay as anonymous measurements.
 *   catalog rows    providers, plans, promotions and the prices of a TLD a staff member entered: shared rows, so
 *                   deletion keeps them and erases only who entered them.
 *
 * Discussion lives on OpenVibe.Community. A table a held migration has not created yet is skipped. The hosting tables
 * (sites, domains, deploys) were dropped in migration 0008: static hosting is OpenVibe.Space's now.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'host_console_accounts', subject: 'owner_subject', file: 'console-accounts.json', columns: ['provider', 'label', 'token_hint', 'created_at', 'last_ok_at'] },
    { table: 'host_console_actions', subject: 'owner_subject', file: 'console-actions.json', columns: ['provider', 'server_id', 'server_name', 'action', 'result', 'at'], order: 'at' },
    { table: 'catalog_benchmarks', subject: 'submitted_by', file: 'benchmarks.json', erase: { anonymize: {} } },
    { table: 'catalog_bench_links', subject: 'person', file: 'benchmark-links.json', columns: ['provider_name', 'plan_id', 'note', 'created_at', 'expires_at', 'used_at'] },
    { table: 'catalog_providers', subject: 'created_by', file: 'catalog-providers.json', erase: { anonymize: {} } },
    { table: 'catalog_plans', subject: 'created_by', file: 'catalog-plans.json', erase: { anonymize: {} } },
    { table: 'catalog_promos', subject: 'created_by', file: 'catalog-promos.json', erase: { anonymize: {} } },
    // A price a staff member entered is a public observation of what a registrar charges: the row stays, the person who
    // entered it is erased from it, as with the other catalog rows.
    { table: 'catalog_tld_prices', subject: 'created_by', file: 'catalog-tld-prices.json', columns: ['id', 'provider_id', 'tld', 'currency', 'register', 'renew', 'transfer', 'origin', 'source_url', 'checked_at', 'status', 'created_at'], erase: { anonymize: {} } },
];

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'host', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
