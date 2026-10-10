'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../server/db');
const { test, runTests } = require('./helpers');

runTests([
    test('production requires DATABASE_URL before creating a PGlite directory', async () => {
        const dir = path.join(os.tmpdir(), `ovhost-no-fallback-${process.pid}`);
        assert.strictEqual(fs.existsSync(dir), false);
        await assert.rejects(openDb({ isProduction: true, db: { url: '', directUrl: '', pgliteDir: dir } }), /DATABASE_URL is not set: production serves from PostgreSQL/);
        assert.strictEqual(fs.existsSync(dir), false);
    }),
]);
