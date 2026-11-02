'use strict';

/**
 * Nothing is hidden to shorten a page (owner, 2026-10-31): the front page's short lists render the same rows at every
 * width and end in a counted link, and the endings list keeps every column on a phone.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'css', f), 'utf8');

assert.ok(!/tr:nth-child\(n\+\d+\)\s*\{\s*display:\s*none/.test(css('host.css')), 'no row of a short list is hidden on a phone');
assert.ok(!/\.hd-list td\[data-label=[^\]]+\][^{]*\{\s*display:\s*none/.test(css('catalog.css')), 'no column of the endings list is hidden on a phone');

const catalog = fs.readFileSync(path.join(__dirname, '..', 'server', 'render', 'catalog.js'), 'utf8');
assert.ok(catalog.includes('planTable(plans.slice(0, 5)'), 'the front page renders the five rows it shows');
assert.ok(catalog.includes('Filter and sort all ${'), 'the door to every plan is counted');
const domains = fs.readFileSync(path.join(__dirname, '..', 'server', 'render', 'domains.js'), 'utf8');
assert.ok(domains.includes('All ${Number(stats.tlds)'), 'the door to every ending is counted');

console.log('front-unhidden: all passed');
