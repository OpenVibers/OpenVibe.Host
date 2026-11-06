'use strict';
/**
 * The screenshot pass (lib/shots.js, plan L9, devblog §3.3): a capture is stored in OpenVibe.Media with
 * the service, the path, the viewport, the release and the hash of the bytes; the shots of a page and a
 * viewport are kept for 14 days, and the same command prunes the older ones.
 */
const assert = require('assert');
const { scenario, test, runTests } = require('./helpers');
const { shots, plan, expired, VIEWPORTS, RETENTION_MS } = require('../lib/shots');

/** A Media that remembers what it was given. */
function fakeMedia(objects = []) {
    const uploads = [];
    const removed = [];
    return {
        uploads, removed, objects,
        async uploadPng({ data, metadata }) {
            const id = `med_${String(uploads.length + 1).padStart(26, '0')}`;
            uploads.push({ id, data, metadata });
            objects.push({ id, metadata, created_at: metadata.captured_at });
            return { id };
        },
        async listAll() { return objects.slice(); },
        async remove(id) { removed.push(id); const i = objects.findIndex((o) => o.id === id); if (i >= 0) objects.splice(i, 1); },
    };
}

/** A capture that returns the targets it was given, as Chrome would. */
function fakeCapture(data = 'png-bytes') {
    const calls = [];
    const fn = async (targets) => {
        calls.push(targets);
        return { shots: targets.map((t) => ({ ...t, data: Buffer.from(`${data}:${t.path}:${t.viewport}`), hash: `hash-${t.service}-${t.path}-${t.viewport}` })) };
    };
    fn.calls = calls;
    return fn;
}

function site({ pages = null, release = 'abc1234def56' } = {}) {
    const host = scenario();
    host.inv.services.live.origin = 'https://openvibe.live';
    if (pages) host.inv.services.live.shots = { pages };
    host.http.set('https://openvibe.live/release.json', () => ({ status: 200, body: { service: 'live', release, booted_at: '2026-11-01T00:00:00Z' } }));
    return host;
}

runTests([
    test('the plan holds both viewports of §3.3 and the pages of the inventory', async () => {
        const host = site({ pages: ['/', '/pricing'] });
        const p = plan(host.inv, { services: ['live'] });
        assert.deepStrictEqual(p.map((t) => [t.path, t.viewport, t.width, t.height]), [
            ['/', 'phone', 390, 844], ['/', 'desktop', 1440, 900],
            ['/pricing', 'phone', 390, 844], ['/pricing', 'desktop', 1440, 900],
        ]);
        assert.deepStrictEqual(VIEWPORTS.map((v) => v.name), ['phone', 'desktop']);
    }),

    test('without a list of pages the home page is captured', async () => {
        const host = site();
        assert.deepStrictEqual(plan(host.inv, { services: ['live'] }).map((t) => t.path), ['/', '/']);
    }),

    test('a shot is stored in Media with the service, path, viewport, release and hash', async () => {
        const host = site({ pages: ['/'] });
        const media = fakeMedia();
        const capture = fakeCapture();
        const now = Date.parse('2026-11-06T12:00:00Z');
        const r = await shots(host.ctx(), { services: ['live'], media, capture, now });
        assert.strictEqual(r.captured, 2, 'one shot per viewport');
        assert.strictEqual(r.uploaded, 2);
        assert.strictEqual(media.uploads.length, 2);
        const m = media.uploads[0].metadata;
        assert.strictEqual(m.service, 'live');
        assert.strictEqual(m.path, '/');
        assert.strictEqual(m.viewport, 'phone');
        assert.strictEqual(m.release, 'abc1234def56', 'the release the service was on is the key of the shot');
        assert.strictEqual(m.hash, 'hash-live-/-phone');
        assert.strictEqual(m.captured_at, new Date(now).toISOString());
    }),

    test('a shot older than 14 days is pruned, a younger one is kept', async () => {
        const now = Date.parse('2026-11-06T12:00:00Z');
        const old = { id: 'med_old', metadata: { captured_at: new Date(now - RETENTION_MS - 60000).toISOString() } };
        const fresh = { id: 'med_fresh', metadata: { captured_at: new Date(now - RETENTION_MS + 60000).toISOString() } };
        assert.deepStrictEqual(expired([old, fresh], now).map((o) => o.id), ['med_old']);

        const host = site({ pages: ['/'] });
        const media = fakeMedia([old, fresh]);
        const r = await shots(host.ctx(), { services: ['live'], media, capture: fakeCapture(), now });
        assert.deepStrictEqual(media.removed, ['med_old']);
        assert.strictEqual(r.pruned, 1);
        assert.ok(media.objects.some((o) => o.id === 'med_fresh'), 'the young shot stays');
    })
]);
