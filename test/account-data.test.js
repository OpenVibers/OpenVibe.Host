'use strict';
/**
 * ADR-033: every table in this service with a person column is either in the account-data map, keyed under the
 * row that owns it, or exempted with a reason. A new table with one fails here until it is answered for.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { TABLES } = require('../server//account-data');
const { testDb } = require('./helpers/db');

(async () => {
    const d = await testDb();
    try {
        const missing = await uncovered(d.db, {
            tables: TABLES,

            exempt: {
                account_data_events: 'the ledger of requests itself: which export and deletion host applied',
                host_index_revisions: "owner is the search-index document's owner (type/id), not a person; the row holds a revision and hash",
            },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        console.log('  ✓ every table that names a person is covered or exempted with a reason');
    } finally { await d.close(); }
})();
