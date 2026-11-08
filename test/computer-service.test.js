'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalise } = require('../lib/inventory');
const { test, runTests } = require('./helpers');

const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));
const service = normalise(inventory).services.computer;

runTests([
    test('Computer can be initialized by ovhost service add on its allocated ports', () => {
        assert.equal(service.repo, '/opt/openvibe.computer');
        assert.deepEqual(service.units, ['openvibe-computer.service']);
        assert.equal(service.envFile, '/etc/openvibe/computer.env');
        assert.equal(service.port, 5135);
        assert.equal(service.origin, 'https://openvibe.computer');
        assert.equal(service.nginx.repoVhost, 'deploy/nginx/openvibe.computer.conf');
        assert.equal(service.ready.url, 'http://127.0.0.1:5135/api/health');
        const servicePorts = Object.values(inventory.services).map((s) => s.port).filter(Boolean);
        assert.equal(servicePorts.filter((p) => p === service.port).length, 1, 'service port is unique');
        assert.equal(service.databases.length, 0, 'Computer stores no data to restore or drill');
    }),
]);
