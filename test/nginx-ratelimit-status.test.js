'use strict';
/**
 * deploy/nginx/openvibe-ratelimit-status.conf: the host-wide answer of a rate limit. It is included inside nginx's http
 * block (sites-enabled/*), so it must hold http-level directives only — never a server or location block, which would
 * change what some site serves — and both limit kinds answer 429, not nginx's default 503.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe-ratelimit-status.conf'), 'utf8');
const directives = conf.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
assert.deepStrictEqual(directives, ['limit_req_status 429;', 'limit_conn_status 429;'], 'exactly the two status directives');
assert.ok(!/[{}]/.test(directives.join('')), 'no block of any kind');
console.log('nginx rate limit status: all checks passed');
