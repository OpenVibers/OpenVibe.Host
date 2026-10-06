'use strict';
/**
 * Host's Media-backed object store (HOST_OBJECT_STORE=media, plan T12): local disk is the read cache,
 * OpenVibe.Media is the source of truth. Against a fake Media Object API v2 (test/stageb/media.js)
 * and the same boot() as the other Stage B suites.
 *
 *   - a deploy writes every object through to Media and serves from the local cache;
 *   - a deploy fails (502 storage.object_store) when Media refuses the write;
 *   - a local cache miss re-fetches from Media and verifies the sha256; a tampered object is refused;
 *   - identical bytes in one project are stored in Media once;
 *   - GC deletes a Media object only when no deploy references it;
 *   - project removal deletes the project's Media objects;
 *   - with HOST_OBJECT_STORE unset nothing calls Media at all.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./stageb/boot');
const { startMedia } = require('./stageb/media');
const { createBlobStore, MEDIA_SCOPE } = require('../server/storage');
const { createWorker } = require('../server/worker');

const cachePath = (t, projectId, sha) => path.join(t.dir, 'objects', 'projects', projectId, sha.slice(0, 2), sha);
const shaOf = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** A store built directly (not through the app) with the test's fake Media and mock Network. */
const directStore = (t, media, { dir, isReferenced, fetchTimeoutMs } = {}) => createBlobStore(
    dir || fs.mkdtempSync(path.join(t.dir, 'direct-')),
    {
        media: {
            url: media.url, namespace: 'host', scope: MEDIA_SCOPE, clientId: 'host', clientSecret: t.SECRET,
            tokenUrl: `${t.network.url}/oauth/token`,
            ...(fetchTimeoutMs ? { fetchTimeoutMs } : {}),
        },
        isReferenced,
    },
);
const filesOf = async (t, as, deployId) => (await t.api('GET', `/api/v1/deploys/${deployId}`, { as })).json().deploy.files;

(async () => {
    const media = await startMedia();
    const t = await boot({ env: { HOST_OBJECT_STORE: 'media', OV_MEDIA_URL: media.url } });
    const alice = t.user('alice');

    await check('booting with HOST_OBJECT_STORE=media selects the Media store', async () => {
        assert.strictEqual(t.config.objectStore.mode, 'media');
        assert.strictEqual(t.config.media.url, media.url);
    });

    const pa = await t.project(alice, 'A');
    const sa = await t.site(alice, pa.id, 'mediasite');
    let firstFiles = [];
    await check('a deploy writes every object through to Media, private and keyed per project', async () => {
        const d = await t.deploy(alice, sa.id, { 'index.html': 'HELLO MEDIA', 'app.js': 'console.log(1)' });
        firstFiles = await filesOf(t, alice, d.id);
        assert.strictEqual(firstFiles.length, 2);
        for (const f of firstFiles) {
            const o = media.byHash(pa.id, f.sha256);
            assert.ok(o, `Media holds ${f.path}`);
            assert.strictEqual(o.visibility, 'private');
            assert.strictEqual(o.lifecycle_status, 'ready');
            assert.strictEqual(o.metadata.project_id, pa.id);
            assert.ok(fs.existsSync(cachePath(t, pa.id, f.sha256)), `${f.path} is cached locally`);
        }
        assert.strictEqual((await t.get('mediasite.openvibe.host', '/')).text, 'HELLO MEDIA');
    });

    await check('a deploy fails when Media refuses the write (never a local-only success)', async () => {
        const pb = await t.project(alice, 'B');
        const sb = await t.site(alice, pb.id, 'refuses');
        media.failUpload = true;
        try {
            const r = await t.upload(alice, sb.id, { 'index.html': 'NOPE' });
            assert.strictEqual(r.status, 502, r.text);
            assert.strictEqual(r.json().code, 'storage.object_store');
            assert.ok(r.json().deploy_id, 'the failed deploy is recorded');
            assert.strictEqual(media.readyFor(pb.id).length, 0, 'nothing reached Media as ready');
            assert.strictEqual((await t.get('refuses.openvibe.host', '/')).status, 404, 'nothing is served');
        } finally { media.failUpload = false; }
        // The next deploy of the same project goes through once Media recovers.
        await t.deploy(alice, sb.id, { 'index.html': 'RECOVERED' });
        assert.strictEqual((await t.get('refuses.openvibe.host', '/')).text, 'RECOVERED');
    });

    await check('a local miss re-fetches from Media and verifies the sha256; tampered bytes are refused', async () => {
        const sha = firstFiles.find((f) => f.path === 'index.html').sha256;
        const local = cachePath(t, pa.id, sha);
        fs.rmSync(local);
        assert.ok(!fs.existsSync(local), 'evicted the local cache');
        const ok = await t.get('mediasite.openvibe.host', '/');
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.text, 'HELLO MEDIA');
        assert.ok(fs.existsSync(local), 'a verified fetch is cached again');

        const obj = media.byHash(pa.id, sha);
        fs.rmSync(local);
        media.tamper.add(obj.id);
        const bad = await t.get('mediasite.openvibe.host', '/');
        assert.strictEqual(bad.status, 500);
        assert.ok(!bad.text.includes('HELLO MEDIA'), 'tampered bytes are never served');
        assert.ok(!fs.existsSync(local), 'tampered bytes are never cached');
        media.tamper.delete(obj.id);
    });

    await check('identical bytes in one project are stored in Media once', async () => {
        const before = media.countInits();
        const d = await t.deploy(alice, sa.id, { 'index.html': 'HELLO MEDIA', 'extra.txt': 'EXTRA' });
        const files = await filesOf(t, alice, d.id);
        assert.strictEqual(media.countInits(), before + 1, 'only the new file is uploaded; index.html is reused');
        // One Media object per unique sha of the project (index.html, app.js, extra.txt).
        const uniq = new Set([...firstFiles, ...files].map((f) => f.sha256));
        assert.strictEqual(uniq.size, 3);
        assert.strictEqual(media.readyFor(pa.id).length, uniq.size);
    });

    await check('GC deletes a Media object only when no remaining deploy references it', async () => {
        const pc = await t.project(alice, 'C');
        const sc = await t.site(alice, pc.id, 'gamma');
        const g1 = await t.deploy(alice, sc.id, { 'a.html': 'AAA', 'shared.txt': 'SHARED' });
        const g2 = await t.deploy(alice, sc.id, { 'b.html': 'BBB', 'shared.txt': 'SHARED' });   // now active
        assert.ok(g2.active);
        const f1 = await filesOf(t, alice, g1.id);
        const shaA = f1.find((f) => f.path === 'a.html').sha256;
        const shaShared = f1.find((f) => f.path === 'shared.txt').sha256;
        const del = await t.api('DELETE', `/api/v1/deploys/${g1.id}`, { as: alice });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual(media.byHash(pc.id, shaA), null, 'the unreferenced object is deleted from Media');
        assert.ok(media.byHash(pc.id, shaShared), 'an object a remaining deploy references is kept');
        assert.strictEqual((await t.get('gamma.openvibe.host', '/shared.txt')).text, 'SHARED');
    });

    await check('project removal deletes the project\'s Media objects, and nobody else\'s', async () => {
        const pd = await t.project(alice, 'D');
        const sd = await t.site(alice, pd.id, 'removed');
        const d1 = await t.deploy(alice, sd.id, { 'x.html': 'XXXX' });
        const shaX = (await filesOf(t, alice, d1.id)).find((f) => f.path === 'x.html').sha256;
        const pe = await t.project(alice, 'E');
        const se = await t.site(alice, pe.id, 'kept');
        const d2 = await t.deploy(alice, se.id, { 'y.html': 'YYYY' });
        const shaY = (await filesOf(t, alice, d2.id)).find((f) => f.path === 'y.html').sha256;
        assert.ok(media.byHash(pd.id, shaX) && media.byHash(pe.id, shaY));
        const rm = await t.api('DELETE', `/api/v1/projects/${pd.id}`, { as: alice });
        assert.strictEqual(rm.status, 200, rm.text);
        assert.strictEqual(media.byHash(pd.id, shaX), null, 'the removed project\'s object is gone from Media');
        assert.ok(media.byHash(pe.id, shaY), 'another project\'s object is untouched');
        assert.strictEqual((await t.get('kept.openvibe.host', '/y.html')).text, 'YYYY');
    });

    await check('with HOST_OBJECT_STORE unset nothing calls Media', async () => {
        const media2 = await startMedia();
        const t2 = await boot({ env: { OV_MEDIA_URL: media2.url } });
        try {
            const bob = t2.user('bob');
            const p = await t2.project(bob, 'L');
            const s = await t2.site(bob, p.id, 'localonly');
            await t2.deploy(bob, s.id, { 'index.html': 'LOCAL ONLY' });
            assert.strictEqual(media2.calls.length, 0, 'the local store never talks to Media');
            assert.strictEqual((await t2.get('localonly.openvibe.host', '/')).text, 'LOCAL ONLY');
        } finally { await t2.close(); await media2.close(); }
    });

    await check('a zero-byte file is stored locally only and never sent to Media', async () => {
        const pz = await t.project(alice, 'Z');
        const sz = await t.site(alice, pz.id, 'zero');
        const before = media.countInits();
        const d = await t.deploy(alice, sz.id, { 'index.html': 'ZERO SITE', 'empty.txt': '' });
        const empty = (await filesOf(t, alice, d.id)).find((f) => f.path === 'empty.txt');
        assert.strictEqual(empty.size, 0);
        assert.strictEqual(media.countInits(), before + 1, 'only index.html is uploaded; the empty file is not');
        assert.strictEqual(media.byHash(pz.id, empty.sha256), null, 'Media has no object for the empty file');
        assert.ok(fs.existsSync(cachePath(t, pz.id, empty.sha256)), 'the empty file is in the local cache');
        const r = await t.get('zero.openvibe.host', '/empty.txt');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.text, '');
    });

    await check('put uploads a fresh blob directly and looks up only an already-cached one', async () => {
        const dir = fs.mkdtempSync(path.join(t.dir, 'direct-put-'));
        const s1 = directStore(t, media, { dir });
        const blob = Buffer.from('DIRECT UPLOAD');
        const h = shaOf('DIRECT UPLOAD');
        const lists0 = media.countLists();
        await s1.put(pa.id, h, blob);
        assert.strictEqual(media.countLists(), lists0, 'a fresh blob is uploaded without listing the namespace');
        assert.ok(media.byHash(pa.id, h));
        // A restart: a new store over the same warm cache, with no in-memory id map.
        const s2 = directStore(t, media, { dir });
        const inits = media.countInits();
        const lists1 = media.countLists();
        await s2.put(pa.id, h, blob);
        assert.strictEqual(media.countInits(), inits, 'the cached blob is not uploaded a second time');
        assert.ok(media.countLists() > lists1, 'the already-cached blob is looked up once');
        assert.strictEqual(media.ready().filter((o) => o.metadata.project_id === pa.id && o.content_hash === h).length, 1);
    });

    await check('concurrent puts of one new sha upload it once', async () => {
        const store = directStore(t, media, { dir: fs.mkdtempSync(path.join(t.dir, 'direct-race-')) });
        const blob = Buffer.from('RACE');
        const h = shaOf('RACE');
        const inits = media.countInits();
        const changed = await Promise.all([store.put(pa.id, h, blob), store.put(pa.id, h, blob), store.put(pa.id, h, blob)]);
        assert.deepStrictEqual(changed, [true, false, false]);
        assert.strictEqual(media.countInits(), inits + 1, 'three concurrent puts, one upload');
        assert.strictEqual(media.ready().filter((o) => o.metadata.project_id === pa.id && o.content_hash === h).length, 1);
    });

    await check('remove deletes every Media object for a blob, not just the first', async () => {
        const store = directStore(t, media, { dir: fs.mkdtempSync(path.join(t.dir, 'direct-dupes-')) });
        const blob = Buffer.from('DUPLICATE');
        const h = shaOf('DUPLICATE');
        media.seed(pa.id, blob);
        media.seed(pa.id, blob);            // two pre-existing duplicates (from before puts were serialised)
        await store.put(pa.id, h, blob);    // plus the cache and one more object
        const countOf = () => media.ready().filter((o) => o.metadata.project_id === pa.id && o.content_hash === h).length;
        assert.strictEqual(countOf(), 3);
        assert.strictEqual(await store.remove(pa.id, h), true);
        assert.strictEqual(countOf(), 0, 'every duplicate is gone');
        assert.ok(!fs.existsSync(store.pathFor(pa.id, h)), 'the cache file is gone');
    });

    await check('remove keeps a Media object and cache that host_blobs re-references mid-sweep', async () => {
        let referenced = false;
        const store = directStore(t, media, {
            dir: fs.mkdtempSync(path.join(t.dir, 'direct-ref-')),
            isReferenced: async () => referenced,
        });
        const blob = Buffer.from('RE-REFERENCED');
        const h = shaOf('RE-REFERENCED');
        await store.put(pa.id, h, blob);
        referenced = true;   // a concurrent deploy reused the sha after the caller decided it was unreferenced
        assert.strictEqual(await store.remove(pa.id, h), false, 'remove reports nothing removed');
        assert.ok(media.byHash(pa.id, h), 'the durable copy stays in Media');
        assert.ok(fs.existsSync(store.pathFor(pa.id, h)), 'the cache stays');
        referenced = false;
        assert.strictEqual(await store.remove(pa.id, h), true);
        assert.strictEqual(media.byHash(pa.id, h), null, 'once unreferenced, remove deletes it');
        assert.ok(!fs.existsSync(store.pathFor(pa.id, h)));
    });

    await check('concurrent cache misses for one blob stream it in once and rename it in', async () => {
        const store = directStore(t, media, { dir: fs.mkdtempSync(path.join(t.dir, 'direct-coalesce-')) });
        const blob = Buffer.from('COALESCE ME');
        const h = shaOf('COALESCE ME');
        await store.put(pa.id, h, blob);
        fs.rmSync(store.pathFor(pa.id, h));
        const downloads = media.countDownloads();
        const files = await Promise.all([store.ensure(pa.id, h), store.ensure(pa.id, h), store.ensure(pa.id, h)]);
        assert.deepStrictEqual(files, [store.pathFor(pa.id, h), store.pathFor(pa.id, h), store.pathFor(pa.id, h)]);
        assert.strictEqual(media.countDownloads(), downloads + 1, 'one download for three misses');
        assert.strictEqual(fs.readFileSync(files[0], 'utf8'), 'COALESCE ME');
        assert.deepStrictEqual(fs.readdirSync(store.tmpDir).filter((f) => f.endsWith('.part')), [], 'no temp file is left behind');
    });

    await check('a Media download past the fetch timeout fails cleanly and caches nothing', async () => {
        const store = directStore(t, media, { dir: fs.mkdtempSync(path.join(t.dir, 'direct-slow-')), fetchTimeoutMs: 60 });
        const blob = Buffer.from('SLOW OBJECT');
        const h = shaOf('SLOW OBJECT');
        media.seed(pa.id, blob);
        media.delayContentMs = 400;
        try {
            await assert.rejects(() => store.ensure(pa.id, h), (e) => e.code === 'storage.media');
        } finally { media.delayContentMs = 0; }
        assert.ok(!fs.existsSync(store.pathFor(pa.id, h)), 'nothing is cached from a failed download');
    });

    await check('a failed deploy names the objects it left in the deploy log', async () => {
        const ph = await t.project(alice, 'H');
        const sh = await t.site(alice, ph.id, 'partial');
        const shaA = shaOf('AAAA PARTIAL');
        media.failUploadAfter = media.acceptedInits() + 1;   // the first object lands, the second is refused
        let r;
        try { r = await t.upload(alice, sh.id, { 'a.txt': 'AAAA PARTIAL', 'b.txt': 'BBBB PARTIAL' }); }
        finally { media.failUploadAfter = null; }
        assert.strictEqual(r.status, 502, r.text);
        assert.strictEqual(r.json().code, 'storage.object_store');
        assert.ok(media.byHash(ph.id, shaA), 'the first object was left in Media');
        const log = r.json().log.join('\n');
        assert.ok(log.includes(shaA), `the deploy log names the leftover object: ${log}`);
    });

    await check('the object sweep logs a Media delete failure at warn instead of swallowing it', async () => {
        const dir = fs.mkdtempSync(path.join(t.dir, 'sweep-'));
        const file = path.join(dir, 'blob');
        fs.writeFileSync(file, 'x');
        fs.utimesSync(file, new Date(0), new Date(0));
        const sha = 'a'.repeat(64);
        const warnings = [];
        const worker = createWorker({
            config: { worker: { enabled: false } },
            store: { db: { prepare: () => ({ get: async () => null }) } },   // no host_blobs row
            domains: {},
            blobs: {
                list: function* () { yield { projectId: pa.id, sha256: sha, file }; },
                sweepTmp: () => 0,
                remove: async () => { const e = new Error('media down'); e.code = 'storage.media'; throw e; },
            },
            outbox: {},
            log: { log() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) },
        });
        const removed = await worker.sweepObjects({ graceMs: 0 });
        assert.strictEqual(removed, 0, 'a failed delete is not counted as removed');
        assert.strictEqual(warnings.length, 1, `expected exactly one warn, got ${JSON.stringify(warnings)}`);
        assert.ok(warnings[0].includes('Media') && warnings[0].includes(sha) && warnings[0].includes('media down'), warnings[0]);
    });

    await t.close();
    await media.close();
    done();
})();
