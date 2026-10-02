'use strict';
/**
 * The dashboard's static assets take their Cache-Control from openvibe-shared/cache-policy (plan T11,
 * cache-policy): the exact `?v=<assetVersion(rel)>` the render layout hands out is immutable for a
 * year; a wrong-but-hex `?v=` and no `?v=` at all are the short window with stale-while-revalidate,
 * never immutable, so a changed file cannot be pinned by a query string that is not the real hash.
 */
const assert = require('assert');
const cache = require('openvibe-shared/cache-policy');
const { assetVersion } = require('../server/render/layout');
const { boot, check, done, DASHBOARD } = require('./stageb/boot');

const ASSET = 'css/host.css';

(async () => {
    const t = await boot();
    try {
        await check("the current ?v=<assetVersion> is 'public, max-age=31536000, immutable'", async () => {
            const r = await t.get(DASHBOARD, `/${ASSET}?v=${assetVersion(ASSET)}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers['cache-control'], cache.IMMUTABLE);
            assert.strictEqual(r.headers['cache-control'], 'public, max-age=31536000, immutable');
        });

        await check("a wrong-but-hex ?v= is 'public, max-age=300, stale-while-revalidate=86400'", async () => {
            const r = await t.get(DASHBOARD, `/${ASSET}?v=deadbeefdeadbeef`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers['cache-control'], cache.assetHeaders(ASSET, { hashed: false }));
            assert.strictEqual(r.headers['cache-control'], 'public, max-age=300, stale-while-revalidate=86400');
        });

        await check("no ?v= is 'public, max-age=300, stale-while-revalidate=86400'", async () => {
            const r = await t.get(DASHBOARD, `/${ASSET}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers['cache-control'], 'public, max-age=300, stale-while-revalidate=86400');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
