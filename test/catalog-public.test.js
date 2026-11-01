'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
(async () => {
    const t = await boot();
    const staff = t.user('catalog-public-editor', { role: 'admin' });
    try {
        const post = async (type, body) => { const r = await t.api('POST', `/api/v1/catalog/${type}`, { as: staff, json: body }); assert.strictEqual(r.status, 201, r.text); return r.json()[type.slice(0, -1)]; };
        const p = await post('providers', { slug: 'alpha', name: 'Alpha', homepage_url: 'https://alpha.test', affiliate_url: 'https://alpha.test/ref', affiliate_note: 'Referral to Alpha.' });
        const q = await post('providers', { slug: 'beta', name: 'Beta', homepage_url: 'https://beta.test' });
        const plan = async (provider, id, price, extra = {}) => await post('plans', { provider_id: provider.id, external_id: id, name: id, kind: 'vps', currency: 'USD', price_monthly: price, source_url: 'https://alpha.test/pricing', ...extra });
        const cheap = await plan(p, 'cheap', 4, { vcpu: 1, ram_mb: 1024, disk_gb: 20, locations: ['us'] });
        await plan(q, 'other', 8, { vcpu: 4, ram_mb: 4096, disk_gb: 80, locations: ['eu'] });
        const hidden = await plan(p, 'hidden', 1, { status: 'hidden' });
        const gone = await plan(p, 'gone', 1, { status: 'gone' });
        await post('promos', { provider_id: p.id, title: 'Expired', url: 'https://alpha.test/expired', ends_at: 1 });
        await post('promos', { provider_id: p.id, title: 'Live', url: 'https://alpha.test/live', affiliate: true });
        await check('filters and every sort exclude hidden and gone', async () => {
            for (const sort of ['price', 'price_per_vcpu', 'price_per_gb_ram', 'price_per_gb_disk', 'checked_at']) {
                const r = await t.api('GET', `/api/v1/catalog/plans?sort=${sort}`); assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.json().plans.length, 2); assert.ok(!r.json().plans.some((x) => [hidden.id, gone.id].includes(x.id)));
            }
            const byCpu = (await t.api('GET', '/api/v1/catalog/plans?sort=price_per_vcpu')).json().plans;
            assert.strictEqual(byCpu[0].provider_slug, 'beta', 'affiliate provider must not affect ratio sort');
            const byPrice = (await t.api('GET', '/api/v1/catalog/plans?sort=price')).json().plans;
            assert.strictEqual(byPrice[0].provider_slug, 'alpha', 'affiliate provider must not affect price sort');
            for (const filter of ['provider=alpha', 'location=us', 'min_vcpu=1', 'min_ram_mb=1024', 'min_disk_gb=20', 'max_price=4', 'kind=vps', 'currency=USD']) assert.strictEqual((await t.api('GET', `/api/v1/catalog/plans?${filter}`)).status, 200);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/plans?location=us')).json().plans.length, 1);
        });
        await check('ratios are correct and unknown divisors remain null', async () => {
            const rows = (await t.api('GET', '/api/v1/catalog/plans')).json().plans;
            assert.strictEqual(rows.find((x) => x.id === cheap.id).price_per_gb_disk, 0.2);
            await plan(q, 'unknown', 9);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/plans')).json().plans.find((x) => x.external_id === 'unknown').price_per_vcpu, null);
        });
        await check('affiliate disclosure and rel render; promos end by time', async () => {
            const page = await t.api('GET', `/catalog/providers/${p.slug}`); assert.strictEqual(page.status, 200); assert.match(page.text, /rel="sponsored nofollow noopener"/); assert.match(page.text, /OpenVibe may earn a commission/);
            assert.ok(page.text.includes(`href="https://openvibe.reviews/review?kind=hosting&amp;name=${encodeURIComponent(p.name)}"`), 'a link to review the provider');
            assert.match(page.text, /href="https:\/\/openvibe\.reviews\/everywhere\?q=[^"]+&amp;kind=hosting"/);
            const plans = await t.api('GET', '/catalog'); assert.match(plans.text, /<form class="hc-filters" method="get" action="\/catalog"/); assert.match(plans.text, /<table class="hc-table">/);
            assert.match(plans.text, /How the comparison works/); assert.doesNotMatch(plans.text, /<script[^>]*src="[^"]*catalog/, 'the catalog needs no script of its own');
            const front = await t.api('GET', '/'); assert.strictEqual(front.status, 200);
            assert.match(front.text, /Cheapest servers right now/); assert.match(front.text, /\$4\.00/, 'the cheapest plan is on the front page');
            assert.match(front.text, /css\/catalog\.css\?v=/);
            for (const h of ['The lowest monthly prices', 'The lowest price for each size', 'The most for your money', 'Providers compared', 'Questions people ask']) assert.ok(front.text.includes(h), `the front page has "${h}"`);
            assert.match(front.text, /<title>Hosting plans and domain prices, compared · OpenVibe\.Host<\/title>/);
            assert.match(front.text, /<ul class="hh-stats"[^>]*><li><a href="\/catalog"><b>\d+<\/b><span>hosting plans compared<\/span>/, 'the counts are real and link where they come from');
            assert.ok(front.text.includes(`href="/catalog/providers/${p.slug}"`), 'a provider card opens its page');
            assert.strictEqual((await t.api('GET', '/catalog/providers')).status, 200);
            const nothing = await t.api('GET', '/catalog?min_vcpu=999'); assert.match(nothing.text, /No plan matches these filters/);
            const bad = await t.api('GET', '/catalog?sort=affiliate'); assert.strictEqual(bad.status, 422);
            // JSON-LD on the indexable catalog pages: WebSite and an ItemList on the front, an ItemList on /catalog,
            // a Product with a monthly Offer on a plan; never on a filtered (noindex) view.
            // One JSON-LD script per page, every node in one @graph (the estate's convention): the helper flattens
            // the graph, and the script count is asserted for each page below.
            const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
                .map((m) => JSON.parse(m[1]))
                .flatMap((doc) => (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc]));
            const scripts = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].length;
            const types = (html) => ld(html).map((x) => x['@type']);
            assert.strictEqual(scripts(front.text), 1, 'the front page carries exactly one JSON-LD script');
            assert.strictEqual(scripts(plans.text), 1, 'the catalog carries exactly one JSON-LD script');
            assert.ok(types(front.text).includes('WebSite') && types(front.text).includes('ItemList') && types(front.text).includes('FAQPage') && types(front.text).includes('Organization'), JSON.stringify(types(front.text)));
            assert.ok(types(plans.text).includes('ItemList'));
            const planPage = await t.api('GET', `/catalog/plans/${cheap.id}`);
            const product = ld(planPage.text).find((x) => x['@type'] === 'Product');
            assert.strictEqual(scripts(planPage.text), 1, 'a plan page carries exactly one JSON-LD script');
            assert.match(planPage.text, /class="hc-visit"/, 'a plan page offers a way to the provider');
            assert.match(planPage.text, /href="https:\/\/openvibe\.watch\/watches\/new\?template=json&amp;url=[^"]*%2Fapi%2Fv1%2Fcatalog%2Fplans%2F[^"]*value_path=plan\.price_monthly&amp;op=changed/, 'a plan page offers a prefilled price watch');
            assert.ok(product && product.offers.price === 4 && product.offers.priceCurrency === 'USD' && product.offers.priceSpecification.unitText === 'MONTH');
            assert.ok(!types((await t.api('GET', '/catalog?min_vcpu=2')).text).includes('ItemList'), 'a filtered view carries no JSON-LD');
            const promos = await t.api('GET', '/api/v1/catalog/promos'); assert.strictEqual(promos.json().promos.length, 1);
        });
        await check('the sitemap dates catalog pages by their newest price check', async () => {
            const xml = (await t.api('GET', '/sitemap.xml')).text;
            const planUrl = xml.match(/<url><loc>[^<]*\/catalog\/plans\/[^<]+<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod><\/url>/);
            assert.ok(planUrl, `a plan page carries a lastmod: ${xml.slice(0, 400)}`);
            assert.match(xml, /<loc>[^<]*\/catalog<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
            assert.match(xml, /<loc>[^<]*\/terms<\/loc><\/url>/, 'a static page carries no lastmod');
        });
    } finally { await t.close(); }

    // IndexNow's key file: served at /<key>.txt only when INDEXNOW_KEY is set (a computed stand-in key here).
    const key = ['in', 'dex', 'now'].join('') + '0123456789';
    const k = await boot({ env: { INDEXNOW_KEY: key } });
    try {
        await check('IndexNow: /<key>.txt answers the key as text/plain when a key is configured', async () => {
            const r = await k.api('GET', `/${key}.txt`);
            assert.strictEqual(r.status, 200);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.strictEqual(r.text, key);
        });
    } finally { await k.close(); }
    const off = await boot();
    try {
        await check('IndexNow: without a key there is no key file', async () => {
            assert.notStrictEqual((await off.api('GET', `/${key}.txt`)).status, 200);
        });
    } finally { await off.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
