'use strict';
/**
 * The page shell carries openvibe-shared boost (plan T11): every rendered page is marked with the
 * deployed release and loads boost.js with data-main="#main", and the shared navbar's sign-in
 * returns to whatever page is showing (the {path} template) instead of a path baked at render time.
 */
const assert = require('assert');
const { test, runTests } = require('./helpers');
const layout = require('../server/render/layout');

const config = { baseUrl: 'https://openvibe.host' };
const page = (o = {}) => layout.renderPage({ title: 'A page', body: '<p>body</p>', viewer: { kind: 'anonymous' }, config, path: '/projects/abc', ...o });

runTests([
    test('every page carries the boost marker and the boost script with data-main', () => {
        layout.setRelease('20260929-120000-deadbeef');
        for (const p of [page(), page({ path: '/', indexable: true })]) {
            assert.match(p, /<meta name="ov-boost" content="host@20260929-120000-deadbeef">/);
            assert.match(p, /<script src="\/shared\/boost\.js\?v=[0-9a-f]+" data-main="#main" defer><\/script>/);
            assert.match(p, /<main id="main"/, 'the swapped part is <main id="main">');
        }
    }),

    test("the shared navbar's sign-in returns to the current page ({path} template)", () => {
        const cfg = JSON.parse(page().match(/window\.__OV_PAGE = (.+);/)[1]);
        assert.strictEqual(cfg.navbar.loginUrl, '/auth/login?next={path}');
        assert.strictEqual(cfg.navbar.logoutUrl, '/auth/logout?next={path}');
    }),
]);
