'use strict';
// The release UX check's site list (deploy/systemd/openvibe-browsercheck.service): every watched site is a service of
// the host's example inventory with an origin to check (its inventory origin or its manifest's publicOrigin), and no
// service whose manifest says it is not public (openvibe.tips and openvibe.vip are parked: they redirect to
// openvibe.network and would fail every check). Every public product the host runs is watched.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { originOf } = require('../lib/browser-watch');
const { runTests, test } = require('./helpers');

const unit = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'systemd', 'openvibe-browsercheck.service'), 'utf8');
const sites = (/ExecStart=\S+ browser-watch --sites (\S+)/.exec(unit) || [])[1].split(',');
const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));

runTests([
    test('every watched site is a service on the host with an origin to check, listed once', () => {
        assert.strictEqual(new Set(sites).size, sites.length, 'a site listed twice');
        for (const site of sites) {
            assert.ok(inv.services[site], `${site} is not in host.example.json`);
            assert.match(String(originOf(inv, site, contracts)), /^https:\/\/[a-z0-9.-]+$/, `${site} has no origin`);
        }
    }),
    test('no parked site is watched, and every public one the host runs is', () => {
        const exposure = (id) => { const m = contracts.services.get(id); return m && m.exposure ? m.exposure.state : null; };
        // Parked by OpenVibe.Network (parked-domains): their origins redirect to openvibe.network until T5 opens them.
        for (const parked of ['tips', 'vip']) assert.ok(!sites.includes(parked), `${parked} is parked`);
        const live = Object.keys(inv.services).filter((id) => exposure(id) === 'live' && originOf(inv, id, contracts));
        assert.deepStrictEqual(live.filter((id) => !sites.includes(id)), [], 'a public service on the host is not watched');
    }),
]);
