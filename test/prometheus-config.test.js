'use strict';
// scripts/prometheus-config.js: one loopback job per service port, declared extra processes, opt-out.
const assert = require('assert');
const { render } = require('../scripts/prometheus-config');

const out = render({ services: {
    live: { port: 3000 },
    tools: { port: 4001, metrics: { extra: [{ name: 'img', port: 4012 }, { name: 'bad name', port: 1 }] } },
    sites: { metrics: false },
    games: { port: 8000 },
    noport: {},
} }, { interval: '15s' });
assert.ok(out.includes('scrape_interval: 15s'));
assert.ok(out.includes("rule_files:\n  - '/etc/prometheus/rules/*.yml'"), 'alert rules');
assert.ok(out.includes("- targets: ['127.0.0.1:9100']"), 'node-exporter');
assert.ok(out.includes("  - job_name: live\n    metrics_path: /metrics\n    static_configs:\n      - targets: ['127.0.0.1:3000']\n        labels:\n          service: live\n          process: live\n"));
assert.ok(out.includes("      - targets: ['127.0.0.1:4012']\n        labels:\n          service: tools\n          process: tools-img\n"), 'declared extra process');
assert.ok(!out.includes('bad name') && !out.includes(':1\''), 'malformed extras are skipped');
assert.ok(!out.includes('job_name: sites') && !out.includes('job_name: noport'), 'opted out or nothing to scrape');
assert.ok(!/0\.0\.0\.0|localhost/.test(out), 'loopback addresses only');
// The data role's exporters (roles/data, ADR-035), from the inventory's `exporters`; malformed entries are skipped.
const withExporters = render({ services: {}, exporters: [{ name: 'postgres', port: 9187 }, { name: 'valkey', port: 9121 }, { name: 'Bad', port: 9 }, { name: 'x' }] });
assert.ok(withExporters.includes("  - job_name: postgres\n    static_configs:\n      - targets: ['127.0.0.1:9187']\n        labels:\n          exporter: postgres\n"));
assert.ok(withExporters.includes("targets: ['127.0.0.1:9121']"));
assert.ok(!withExporters.includes('Bad') && !withExporters.includes('job_name: x'), 'malformed exporters are skipped');
console.log('prometheus config: all checks passed');
