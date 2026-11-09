'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const oldName = ['OpenVibe[ .-]No' + 'de', 'openvibe-' + 'node', 'no' + 'd_', 'node[.]openvibe[.]network', 'node:lnk_', 'network[.]node', 'platform[.]node'].join('|');
const result = spawnSync('git', ['grep', '-n', '-I', '-i', '-E', oldName, '--', '.', ':!migrations/**', ':!test/link-brand.test.js'], { cwd: root, encoding: 'utf8' });
assert.ok(result.status === 0 || result.status === 1, result.stderr || 'git grep failed');
// `openvibe-nodes` is Host's own registry-sync unit and `platform.nodes` is the inventory's list.
const stale = (result.stdout || '').split('\n').filter((line) => line && !/openvibe-nodes|platform[.]nodes/i.test(line));
assert.equal(stale.length, 0, `Old Link brand or principal returned:\n${stale.slice(0, 10).join('\n')}`);
console.log('  ok  old Link brand and principal IDs are absent');
