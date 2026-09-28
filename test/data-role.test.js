'use strict';
// roles/data (ADR-035): the scripts parse, and the settings the ADR fixes are the ones installed: loopback
// only, SCRAM, transaction pooling, volatile-lru, WAL archiving through pgBackRest, exporters on loopback,
// secrets generated into data.env and never echoed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, runTests } = require('./helpers');

const DIR = path.join(__dirname, '..', 'roles', 'data');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

runTests([
    test('the scripts parse', () => {
        for (const f of ['lib.sh', 'provision.sh', 'add-service.sh']) {
            const r = spawnSync('bash', ['-n', path.join(DIR, f)], { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, `${f}: ${r.stderr}`);
        }
    }),
    test('PostgreSQL, PgBouncer and Valkey listen on loopback, with SCRAM and the ADR-035 settings', () => {
        const pg = read('files/postgresql-openvibe.conf');
        assert.match(pg, /^listen_addresses = '127\.0\.0\.1'/m);
        assert.match(pg, /^password_encryption = scram-sha-256/m);
        assert.match(pg, /^shared_buffers = 1GB/m);
        assert.match(pg, /^archive_mode = on/m);
        assert.match(pg, /^shared_preload_libraries = 'pg_stat_statements'/m);
        const hba = read('files/pg_hba.conf').split('\n').filter((l) => l && !l.startsWith('#'));
        assert.ok(hba.every((l) => /peer|scram-sha-256/.test(l)), 'no trust or md5 lines');
        assert.ok(hba.every((l) => !/0\.0\.0\.0|::\/0/.test(l)), 'no open addresses');
        const pb = read('files/pgbouncer.ini');
        assert.match(pb, /^listen_addr = 127\.0\.0\.1/m);
        assert.match(pb, /^pool_mode = transaction/m);
        assert.match(pb, /^auth_type = scram-sha-256/m);
        const vk = read('files/valkey-openvibe.conf');
        assert.match(vk, /^bind 127\.0\.0\.1 -::1/m);
        assert.match(vk, /^maxmemory-policy volatile-lru/m);
        assert.match(vk, /^aclfile /m);
        assert.ok(vk.split('\n').every((l) => l.startsWith('#') || !/\s#/.test(l)), 'Valkey takes no end-of-line comments');
    }),
    test('alerts cover the data role, and the backup metric is written only after a successful backup', () => {
        const rules = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'prometheus', 'openvibe-rules.yml'), 'utf8');
        for (const a of ['DataPostgresDown', 'DataPgBouncerDown', 'DataValkeyDown', 'DataPostgresConnectionsHigh', 'DataWalArchiveFailing', 'DataBackupStale', 'DataValkeyMemoryHigh']) assert.ok(rules.includes(`alert: ${a}`), a);
        const unit = read('files/pgbackrest-backup@.service');
        assert.match(unit, /^ExecStartPost=\+\/usr\/local\/lib\/openvibe-data\/backup-metric\.sh %i$/m, 'ExecStartPost runs only after ExecStart succeeded');
        assert.match(read('files/backup-metric.sh'), /openvibe_pgbackrest_last_success_timestamp_seconds/);
    }),
    test('exporters bind loopback, archiving goes through pgBackRest, and secrets are never echoed', () => {
        const p = read('provision.sh');
        for (const port of ['9187', '9121', '9127']) assert.match(p, new RegExp(`127\\.0\\.0\\.1:${port}|127\\.0\\.0\\.1 *:?${port}`));
        assert.match(p, /pgbackrest --stanza=openvibe archive-push %p/);
        assert.match(p, /repo1-cipher-type=aes-256-cbc/);
        assert.match(p, /repo1-path=\/openvibe-pgbackrest/, 'beside, never under, the pruned backup prefix');
        assert.match(p, /REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;/, 'service roles cannot reach the maintenance database');
        const lib = read('lib.sh');
        assert.match(lib, /SCRAM-SHA-256\$\{it\}/, 'passwords reach SQL as SCRAM secrets');
        // A secret may be hashed (sha256hex, scram) or written into a file by redirection; never printed to the output.
        const SECRET_VAR = /\$\{?[A-Z_]*(PW|PASSWORD|CIPHER|SECRET)\b/;
        for (const f of ['lib.sh', 'provision.sh', 'add-service.sh']) {
            read(f).split('\n').forEach((line, i) => {
                if (!/\b(echo|printf)\b/.test(line) || !SECRET_VAR.test(line)) return;
                const stripped = line.replace(/\$\((sha256hex|scram) "\$\{?[A-Z_]+\}?"\)/g, '');
                const toFile = /(>>?)\s*"?\$?[\w{}\/.\-"$]+"?\s*;?\s*(\}|$)/.test(line) || /\}\s*>\s*"/.test(line);
                assert.ok(!SECRET_VAR.test(stripped) || toFile, `${f}:${i + 1} prints a secret: ${line.trim()}`);
            });
        }
        const add = read('add-service.sh');
        assert.match(add, /ALTER ROLE \$APP SET statement_timeout = '15s'/);
        assert.match(add, /~\$\{PREFIX\}\*/, 'the Valkey user is confined to its prefix');
    }),
]);
