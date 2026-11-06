'use strict';
// The alert rules shipped in deploy/prometheus/openvibe-rules.yml (loaded by Prometheus' rule_files; `ovhost alerts
// relay` sends what fires). Promtool is not installed on every agent box, so this checks the contract the AI gauge
// and the rule share: the alert names the gauge and carries a severity.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rules = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'prometheus', 'openvibe-rules.yml'), 'utf8');
assert.ok(/alert: OpenVibeAiAbuseThrottling\n/.test(rules), 'the abuse alert exists');
assert.ok(/expr: sum\(ai_abuse_throttles\) > 20/.test(rules), 'it reads the AI gauge');
assert.ok(/alert: OpenVibeAiAbuseThrottling[\s\S]{0,200}severity: ticket/.test(rules), 'it opens a review item, never a page');
assert.ok(/alert: OpenVibeAiProviderBalanceLow\n/.test(rules) && /alert: OpenVibeAiGpuInstanceNotDestroyed\n/.test(rules), 'the earlier AI alerts are untouched');
console.log('prometheus rules: all checks passed');
