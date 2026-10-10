'use strict';
/**
 * The PostgreSQL inventory: a `databases[]` entry is
 * PostgreSQL (a database in the cluster, named — its object carries NO `path`). The same engine
 * choice reaches the drill block ({ url, directUrl }), nginx tenants (read over psql, not a file)
 * and the protected `postgresql-count` probe. These are the normalised shapes the rest of ovhost
 * depends on, and every code path outside the engine's own code is written to assume no `.path`.
 */
const assert = require('assert');
const { test, runTests } = require('./helpers');
const { normalise } = require('../lib/inventory');

const base = { owner: 'ubuntu', repo: '/opt/openvibe.trade' };
const withDatabases = (databases, extra = {}) => ({ services: { trade: { ...base, databases, ...extra } } });
const first = (doc) => normalise(doc).services.trade.databases[0];

// A service whose single database is PostgreSQL and that drills it: the drill names the two env vars
// the drill instance must be pointed at, instead of a file/env pair.
function pgDrill(overrides = {}) {
    return {
        services: {
            trade: {
                ...base,
                databases: [{ engine: 'postgresql', database: 'ov_trade' }],
                drill: {
                    port: 5555,
                    databases: { trade: { url: 'DATABASE_URL', directUrl: 'DATABASE_DIRECT_URL' } },
                    env: { PORT: '{port}' },
                    ready: '/api/ready',
                    compare: ['/api/items'],
                    ...overrides,
                },
            },
        },
    };
}

runTests([
    test('a PostgreSQL entry normalises to { name, engine, database, role } and carries no path', () => {
        const db = first(withDatabases([{ engine: 'postgresql', database: 'ov_trade' }]));
        assert.deepStrictEqual(db, { name: 'trade', engine: 'postgresql', database: 'ov_trade', role: null });
        assert.ok(!('path' in db), 'a database in the cluster has no file, so no path key at all');
    }),

    test('name defaults to the database minus its ov_ prefix; an explicit name is kept', () => {
        assert.strictEqual(first(withDatabases([{ engine: 'postgresql', database: 'ov_openre' }])).name, 'openre');
        assert.deepStrictEqual(first(withDatabases([{ name: 'ingest', engine: 'postgresql', database: 'ov_openre' }])), { name: 'ingest', engine: 'postgresql', database: 'ov_openre', role: null });
    }),

    test('an optional role is accepted and validated', () => {
        assert.strictEqual(first(withDatabases([{ engine: 'postgresql', database: 'ov_trade', role: 'ov_trade_app' }])).role, 'ov_trade_app');
        assert.throws(() => first(withDatabases([{ engine: 'postgresql', database: 'ov_trade', role: 'Trade' }])), /role must be a database role name/);
        assert.throws(() => first(withDatabases([{ engine: 'postgresql', database: 'ov_trade', role: '1bad' }])), /role must be a database role name/);
    }),

    test('rejections name what is wrong with the entry', () => {
        // A path on a PostgreSQL entry: the database lives in the cluster, not at a file.
        assert.throws(() => first(withDatabases([{ engine: 'postgresql', database: 'ov_trade', path: '/x/trade.db' }])), /has no path/);
        // A database name that is not an owned ov_ database.
        for (const database of ['trade', 'ov-Trade', 'public']) {
            assert.throws(() => first(withDatabases([{ engine: 'postgresql', database }])), /database must match/, database);
        }
        for (const entry of [{ engine: 'mysql', database: 'ov_trade' }, { path: '/x/live.db', database: 'ov_live' }, { name: 'live' }]) {
            assert.throws(() => first(withDatabases([entry])), /engine must be "postgresql"; use/);
        }
    }),

    test('drill.databases for a PostgreSQL database is { engine, url, directUrl }', () => {
        const d = normalise(pgDrill()).services.trade.drill;
        assert.deepStrictEqual(d.databases.trade, { engine: 'postgresql', url: 'DATABASE_URL', directUrl: 'DATABASE_DIRECT_URL' });
    }),

    test('drill.databases rejects a file database shape and bad env var names for a PostgreSQL database', () => {
        const drill = (databases) => pgDrill({ databases });
        assert.throws(() => normalise(drill({ trade: 'DATABASE_URL' })), /for a postgresql database/);
        assert.throws(() => normalise(drill({ trade: { url: 'DATABASE_URL' } })), /directUrl must be an env var name/);
        assert.throws(() => normalise(drill({ trade: { directUrl: 'DATABASE_DIRECT_URL' } })), /url must be an env var name/);
        assert.throws(() => normalise(drill({ trade: { url: '1BAD', directUrl: 'OTHER' } })), /url must be an env var name/);
        assert.throws(() => normalise(drill({ trade: { url: 'DATABASE_URL', directUrl: 'DATABASE_URL' } })), /url and directUrl must be different env vars/);
    }),

    test('countsTolerance is a whole number >= 0, default 0', () => {
        assert.strictEqual(normalise(pgDrill()).services.trade.drill.countsTolerance, 0);
        assert.strictEqual(normalise(pgDrill({ countsTolerance: 25 })).services.trade.drill.countsTolerance, 25);
        assert.throws(() => normalise(pgDrill({ countsTolerance: -1 })), /countsTolerance must be a whole number of rows/);
        assert.throws(() => normalise(pgDrill({ countsTolerance: 1.5 })), /countsTolerance must be a whole number of rows/);
    }),

    test('nginx.tenants.database accepts a PostgreSQL database object', () => {
        const tenants = (database) => normalise({ services: { host: { ...base, nginx: { tenants: { database } } } } }).services.host.nginx.tenants.database;
        assert.deepStrictEqual(tenants({ engine: 'postgresql', database: 'ov_host' }), { engine: 'postgresql', database: 'ov_host' });
    }),

    test('nginx.tenants.database rejects anything else', () => {
        const tenants = (database) => normalise({ services: { host: { ...base, nginx: { tenants: { database } } } } });
        for (const database of [{ engine: 'mysql', database: 'ov_host' }, { engine: 'postgresql', database: 'host' }, { database: 'ov_host' }, 42, []]) {
            assert.throws(() => tenants(database), /nginx\.tenants\.database must be/, JSON.stringify(database));
        }
    }),

    test('the postgresql-count probe validates its database and SQL, alone and inside a sum', () => {
        const probe = (protectedBlock) => normalise({ services: { openre: { ...base, protected: protectedBlock } } }).services.openre.protected;
        const valid = { kind: 'postgresql-count', database: 'ov_openre', sql: 'SELECT count(*) AS n FROM ingest_sessions', label: 'ingest sessions' };
        assert.deepStrictEqual(probe(valid), valid);
        assert.throws(() => probe({ ...valid, database: 'openre' }), /database must match/);
        assert.throws(() => probe({ ...valid, sql: 'DELETE FROM ingest_sessions' }), /sql must be a SELECT/);
        // A sum may hold a postgresql-count part (nested kinds only rule out a sum inside a sum).
        assert.doesNotThrow(() => probe({ kind: 'sum', probes: [valid] }));
    }),
]);
