'use strict';
// The boot-order drop-ins (deploy/systemd/*.service.d): every openvibe-* and openre-* service starts after
// PostgreSQL, PgBouncer and Valkey, and PgBouncer after PostgreSQL. On the 2026-10-23 reboot ten services met a
// PgBouncer that had cached PostgreSQL's refused logins (server_login_retry) and exited once. The host service
// installs the drop-ins (unitSources), so validate reports drift and `deploy host --install-units` fixes it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalise } = require('../lib/inventory');
const { runTests, test } = require('./helpers');

const root = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'host.example.json'), 'utf8'));
const host = normalise(raw).services.host;

const WANT = {
    'openvibe-.service.d/10-database-order.conf': ['postgresql.service', 'pgbouncer.service', 'valkey-server.service'],
    'openre-.service.d/10-database-order.conf': ['postgresql.service', 'pgbouncer.service', 'valkey-server.service'],
    'pgbouncer.service.d/10-after-postgresql.conf': ['postgresql.service'],
};

function unitSection(text) {
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    assert.strictEqual(lines[0], '[Unit]', 'the drop-in is one [Unit] section');
    return lines.slice(1);
}

runTests([
    test('the host service installs each drop-in from deploy/systemd', () => {
        for (const unit of Object.keys(WANT)) {
            assert.strictEqual(host.unitSources[unit], `deploy/systemd/${unit}`, `${unit} is not in the host service's unitSources`);
            assert.ok(fs.existsSync(path.join(root, 'deploy', 'systemd', unit)), `deploy/systemd/${unit} is missing`);
        }
    }),
    test('each drop-in only orders (After=), never pulls a unit in or changes the service', () => {
        for (const [unit, after] of Object.entries(WANT)) {
            const body = unitSection(fs.readFileSync(path.join(root, 'deploy', 'systemd', unit), 'utf8'));
            assert.deepStrictEqual(body, [`After=${after.join(' ')}`], unit);
        }
    }),
    test('the prefix drop-ins are named for systemd prefix matching (a name ending in "-")', () => {
        for (const unit of Object.keys(WANT).filter((u) => !u.startsWith('pgbouncer'))) {
            assert.match(unit, /^[a-z]+-\.service\.d\//, unit);
        }
    }),
]);
