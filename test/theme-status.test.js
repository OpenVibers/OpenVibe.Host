'use strict';
// Host's status words ("Dropped 82.6%", "Rose 0.6%"), lines and buttons follow the reader's theme. The fixed light
// green, amber and red suited dark themes only (axe on Daylight: 1.8:1, 2026-11-01), and buttons drew dark text on
// the accent (3.6:1 on Daylight's violet).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'host.css'), 'utf8');
assert.match(css, /--hs-ok: var\(--success-text, #34d399\)/);
// Mixed toward the text colour so a warning word also reads on a tinted row (Daylight, 2026-11-02).
assert.match(css, /--hs-warn: color-mix\(in srgb, var\(--warning-text, #fbbf24\) 80%, var\(--text-primary, #e6edf7\)\)/);
assert.match(css, /--hs-bad: var\(--danger-text, #f87171\)/);
assert.match(css, /--hs-line: var\(--border, rgba\(255,255,255,\.12\)\)/);
assert.match(css, /button, \.button \{[^}]*background: var\(--accent-strong, var\(--hs-accent\)\); color: var\(--on-accent-strong, #0a0f1c\)/);
assert.match(css, /button\.danger, \.danger \{ background: var\(--danger, #f87171\); color: #0a0f1c; \}/);
console.log('theme status colours: all checks passed');
