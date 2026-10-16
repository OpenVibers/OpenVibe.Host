'use strict';
/**
 * Account export and deletion → Host (ADR-033; openvibe-sdk/account-data). What Host holds about a person:
 *
 *   the console     the hosting accounts they connected (provider, label, the token's last four characters; never the
 *                   sealed token itself) and the actions they took on their servers. Deletion removes both, so their
 *                   tokens are gone from OpenVibe.Host.
 *
 * The catalog holds no personal rows: staff entries name their source, and discussion lives on OpenVibe.Community.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'host_console_accounts', subject: 'owner_subject', file: 'console-accounts.json', columns: ['provider', 'label', 'token_hint', 'created_at', 'last_ok_at'] },
    { table: 'host_console_actions', subject: 'owner_subject', file: 'console-actions.json', columns: ['provider', 'server_id', 'server_name', 'action', 'result', 'at'], order: 'at' },
];

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'host', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
