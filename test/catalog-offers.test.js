'use strict';
/**
 * Hosting offers (server/catalog/offers.js): LowEndTalk's Offers board and LowEndBox posts from Sources rss items. The
 * price is the cheapest "per month|year" the headline (or the post's opening) states, kept as stated with its monthly
 * equivalent; LowEndBox editorials and giveaways are not offers; a removed post is hidden; price sorting needs one
 * currency; the page and the front page list them, newest first.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { statedPrices, mapOffer } = require('../server/catalog/offers');

const NOW = Date.parse('2026-09-22T12:00:00Z');
let n = 0;
const item = (key, title, { published = '2026-09-20T10:00:00Z', summary = null, authors = ['SomeHost'], categories = [], removed = null, retrieved = '2026-09-22T11:00:00Z', identity = null } = {}) => ({
    id: `itm_${String(++n).padStart(26, '0')}`, source_key: key, category: 'hosting', kind: 'article', identity: identity || `https://lowendtalk.com/discussion/${n}`,
    canonical_url: identity || `https://lowendtalk.com/discussion/${n}/offer`, title, summary, authors, published_at: published, source_updated_at: null,
    fields: { categories }, revision: 1, removed,
    provenance: { retrieved_at: retrieved, first_seen_at: '2026-09-22T11:00:00Z', content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'feed@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null },
});

(async () => {
    await check('stated prices: symbol before or after, month or year, cheapest a month first; no period is no price', async () => {
        const p = statedPrices('KVM VPS – From €6.99/year (~$8.03) – Dedicated $45/mo | 9.99€/yr | US$ 14.80 per Year | 2,60€/month');
        assert.deepStrictEqual(p.map((x) => [x.text, x.currency, x.period, x.monthly]), [
            ['€6.99/year', 'EUR', 'year', 0.5825], ['9.99€/yr', 'EUR', 'year', 0.8325], ['US$ 14.80 per Year', 'USD', 'year', 1.2333], ['2,60€/month', 'EUR', 'month', 2.6], ['$45/mo', 'USD', 'month', 45],
        ]);
        assert.deepStrictEqual(statedPrices('Up to 55% off | $500 Halloween Giveaway | 4GB for $5'), []);
        assert.deepStrictEqual(statedPrices('£6 / Month')[0].currency, 'GBP');
    });
    await check('mapping: the headline price, else the post\'s; LowEndBox editorials and giveaways are not offers; too old is dropped', async () => {
        const a = mapOffer(item('lowendtalk-offers', 'Linveo - KVM VPS from $2.85/month - Ohio'), NOW);
        assert.deepStrictEqual([a.price_text, a.price_from, a.price_monthly, a.poster], ['$2.85/month', 'title', 2.85, 'SomeHost']);
        const b = mapOffer(item('lowendtalk-offers', 'DeluxHost | VPS Restock | NL', { summary: 'Plans: 1 GB for 6€/yr, 2 GB for 10€/yr.' }), NOW);
        assert.deepStrictEqual([b.price_text, b.price_from, b.price_monthly], ['6€/yr', 'post', 0.5]);
        const c = mapOffer(item('lowendtalk-offers', 'Blackbox: anonymous VPS', { summary: 'Ask us.' }), NOW);
        assert.deepStrictEqual([c.price_text, c.price_monthly], [null, null]);
        assert.strictEqual(mapOffer(item('lowendbox-posts', 'How Much VPS Do You Actually Need?', { categories: ['Editorial & News'] }), NOW), null);
        assert.strictEqual(mapOffer(item('lowendbox-posts', 'Last day! ServerHost $16.99/YR giveaway', { categories: ['Giveaways'] }), NOW), null);
        assert.ok(mapOffer(item('lowendbox-posts', 'VPSPioneer: France from $2.49/Month!', { categories: ['Editorial & News'] }), NOW));
        assert.ok(mapOffer(item('lowendbox-posts', 'Velohost returns', { categories: ['Low End Virtual'] }), NOW));
        assert.strictEqual(mapOffer(item('lowendtalk-offers', 'Old $1/mo', { published: '2026-01-01T00:00:00Z' }), NOW), null);
        assert.strictEqual(mapOffer({ source_key: 'vultr-plans' }, NOW), null, 'a plan source is not an offer source');
        assert.throws(() => mapOffer(item('lowendtalk-offers', ''), NOW), /title/);
    });

    const t = await boot();
    const catalog = t.ctx.catalog;
    try {
        await check('apply: inserted once, revised in place, a removed post hidden; plans untouched', async () => {
            const first = item('lowendtalk-offers', 'Arct Cloud | EPYC VPS from $3.89/mo', { identity: 'https://lowendtalk.com/discussion/9001/arct' });
            assert.strictEqual(await catalog.applyItem(first), 'applied');
            assert.strictEqual(await catalog.applyItem({ ...first, title: 'Arct Cloud | EPYC VPS from $3.49/mo', provenance: { ...first.provenance, retrieved_at: '2026-09-22T11:30:00Z' } }), 'applied');
            let rows = (await catalog.offers({})).offers;
            assert.strictEqual(rows.length, 1);
            assert.deepStrictEqual([rows[0].title, rows[0].price_text, rows[0].price_monthly, rows[0].source], ['Arct Cloud | EPYC VPS from $3.49/mo', '$3.49/mo', 3.49, 'LowEndTalk']);
            assert.match(rows[0].id, /^hof_/);
            assert.strictEqual(await catalog.applyItem({ ...first, removed: { at: '2026-09-22T11:45:00Z', reason: 'gone' } }), 'removed');
            rows = (await catalog.offers({})).offers;
            assert.strictEqual(rows.length, 0);
            assert.strictEqual(await catalog.applyItem(item('lowendbox-posts', 'Reverse DNS: what is it good for?', { categories: ['Editorial & News'] })), 'hold');
            assert.strictEqual((await catalog.plans({})).plans.length, 0);
        });
        await check('the list: newest first; cheapest a month within one currency; filters', async () => {
            await catalog.applyItem(item('lowendtalk-offers', 'Yearly KVM $12/year', { published: '2026-09-21T09:00:00Z' }));
            await catalog.applyItem(item('lowendtalk-offers', 'EU VPS €3.99/mo', { published: '2026-09-21T10:00:00Z' }));
            await catalog.applyItem(item('lowendbox-posts', 'Godlike: 2GB for $1.83/Month', { published: '2026-09-21T11:00:00Z', categories: ['Low End Virtual'], authors: ['raindog308'] }));
            await catalog.applyItem(item('lowendtalk-offers', 'Dedicated servers, ask for a quote', { published: '2026-09-21T12:00:00Z' }));
            const newest = (await t.api('GET', '/api/v1/catalog/offers')).json().offers;
            assert.deepStrictEqual(newest.map((o) => o.title), ['Dedicated servers, ask for a quote', 'Godlike: 2GB for $1.83/Month', 'EU VPS €3.99/mo', 'Yearly KVM $12/year']);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/offers?sort=price')).status, 422, 'a price sort without a currency converts nothing');
            const usd = (await t.api('GET', '/api/v1/catalog/offers?sort=price&currency=USD')).json().offers;
            assert.deepStrictEqual(usd.map((o) => [o.price_text, o.price_monthly]), [['$12/year', 1], ['$1.83/Month', 1.83]]);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/offers?priced=1')).json().offers.length, 3);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/offers?source=lowendbox-posts')).json().offers.length, 1);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/offers?currency=USD&max_monthly=1.5')).json().offers.length, 1);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/offers?source=elsewhere')).status, 422);
        });
        await check('the page and the front page show them; a price sort without a currency uses USD on the page', async () => {
            const page = await t.api('GET', '/catalog/offers');
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<h1>Hosting offers<\/h1>/);
            assert.match(page.text, /rel="nofollow ugc noopener">Godlike: 2GB for \$1\.83\/Month<\/a>/);
            assert.match(page.text, /\$12\/year<\/strong><span>\$1\.00 a month<\/span>/);
            assert.match(page.text, /Price in the post/);
            assert.match(page.text, /LowEndBox · posted by raindog308/);
            const sorted = await t.api('GET', '/catalog/offers?sort=price');
            assert.strictEqual(sorted.status, 200);
            assert.ok(sorted.text.indexOf('$12/year') < sorted.text.indexOf('$1.83/Month'));
            assert.doesNotMatch(sorted.text, /€3\.99/);
            const front = await t.api('GET', '/');
            assert.match(front.text, /Latest hosting offers/);
            assert.match(front.text, /href="\/catalog\/offers"/);
        });
        await check('before migration 0009 applies (a held contract holds it), the pages serve with no offers', async () => {
            const db = t.ctx.store.db;
            await db.prepare('ALTER TABLE catalog_offers RENAME TO catalog_offers_later').run();
            try {
                assert.deepStrictEqual((await t.api('GET', '/api/v1/catalog/offers')).json().offers, []);
                const page = await t.api('GET', '/catalog/offers');
                assert.strictEqual(page.status, 200);
                assert.match(page.text, /No offer has arrived yet/);
                const front = await t.api('GET', '/');
                assert.strictEqual(front.status, 200);
                assert.doesNotMatch(front.text, /Latest hosting offers/);
                assert.strictEqual((await t.api('GET', '/api/ready')).status, 200, 'ready without the offers table');
            } finally { await db.prepare('ALTER TABLE catalog_offers_later RENAME TO catalog_offers').run(); }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
