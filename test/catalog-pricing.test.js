'use strict';
/**
 * What a stored price means in the catalog (server/catalog/pricing.js): a per-GB storage rate is not a monthly
 * server price, and a price last checked over a year ago is stale. Neither is the cheapest plan, neither is a
 * provider's "from" price, and both are shown as what they are (a rate per GB, a stale price).
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createCatalog } = require('../server/catalog/store');
const render = require('../server/render/catalog');
const { check, done } = require('./helpers/boot');

const NOW = Date.parse('2026-11-01T00:00:00Z');
const YEAR = 365 * 86400000;

(async () => {
    const db = await testDb();
    const store = createStore(db.db, { now: () => NOW });
    const catalog = createCatalog({ store });
    try {
        const provider = await catalog.save('providers', { slug: 'azure', name: 'Microsoft Azure', homepage_url: 'https://azure.microsoft.com/' }, null, 'tester');
        const planFor = async (p, over) => await catalog.save('plans', {
            provider_id: p.id, external_id: over.external_id, name: over.name, kind: over.kind || 'cloud',
            currency: 'USD', price_monthly: over.price_monthly, source_url: 'https://azure.microsoft.com/en-us/pricing/',
            vcpu: over.vcpu == null ? null : over.vcpu, ram_mb: over.ram_mb == null ? null : over.ram_mb,
            disk_gb: over.disk_gb == null ? null : over.disk_gb, checked_at: over.checked_at == null ? NOW : over.checked_at,
            price_term: over.price_term, renewal_price: over.renewal_price,
        }, null, 'tester');
        const plan = (over) => planFor(provider, over);

        const fresh = await plan({ external_id: 'fresh', name: 'Standard_D2s_v5', price_monthly: 5, vcpu: 2, ram_mb: 8192, disk_gb: 64 });
        const stale = await plan({ external_id: 'stale', name: 'Standard_D1s_v5', price_monthly: 1, vcpu: 1, ram_mb: 2048, disk_gb: 32, checked_at: NOW - (YEAR + 86400000) });
        const rate = await plan({ external_id: 'rate', name: 'Archive LRS (per GB/month)', kind: 'storage', price_monthly: 0.001 });
        const unpriced = await plan({ external_id: 'unpriced', name: 'Free tier', price_monthly: 0 });

        // A second provider with a term stated, a renewal stated and a zero price that still carries specs: the
        // per-resource columns must not divide it into $0.00 (market outcome 8).
        const affiliate = await catalog.save('providers', { slug: 'example', name: 'Example', homepage_url: 'https://example.test', affiliate_url: 'https://example.test/ref', affiliate_note: 'Referral to Example.' }, null, 'tester');
        const monthly = await planFor(affiliate, { external_id: 'monthly', name: 'Monthly plan', price_monthly: 6, vcpu: 1, ram_mb: 1024, disk_gb: 20, price_term: 'monthly' });
        const yearly = await planFor(affiliate, { external_id: 'yearly', name: 'Yearly plan', price_monthly: 12, vcpu: 1, ram_mb: 1024, disk_gb: 20, price_term: '1-year', renewal_price: 9.5 });
        const free = await planFor(affiliate, { external_id: 'free', name: 'Free with specs', price_monthly: 0, vcpu: 1, ram_mb: 1024, disk_gb: 20, price_term: 'monthly' });

        await check('a price list puts the fresh monthly prices first and the rates and the stale price last', async () => {
            const rows = (await catalog.plans({ provider: 'azure' })).plans;
            assert.deepStrictEqual(rows.map((x) => x.external_id), ['fresh', 'stale', 'unpriced', 'rate']);
            const listed = (await catalog.providers('azure')).plans;
            assert.deepStrictEqual(listed.map((x) => x.external_id), ['fresh', 'stale', 'unpriced', 'rate']);
            assert.strictEqual(rows[0].stale, false);
            assert.strictEqual(rows[1].stale, true, 'a price checked over a year ago is stale');
            assert.strictEqual(rows[3].price_unit, 'per_gb_month', 'a per-GB rate is not a monthly price');
        });

        await check("a provider's from price is the cheapest fresh monthly price, not a rate per GB and not a stale price", async () => {
            const summary = await catalog.providerSummary();
            assert.strictEqual(summary.find((x) => x.slug === 'azure').from_price, 5);
        });

        await check('the provider page shows the from price, the rate per GB and the stale price', async () => {
            const html = render.provider(await catalog.providers('azure'), null, '', NOW);
            assert.ok(html.includes('from <strong>$5.00</strong>/mo'), 'the from price is the fresh monthly price');
            assert.ok(!html.includes('$0.00</span><span class="hc-per">/mo</span>'), 'no rate per GB reads as a monthly price');
            assert.ok(html.includes('$0.0010'), 'the rate is shown as the rate it is');
            assert.ok(html.includes('/GB/month'), 'the rate is shown per GB');
            assert.ok(html.includes('2025-10-31, <span class="hc-stale"'), 'a stale price is marked as stale');
            assert.ok(html.includes('not counted in the price above'), 'the page says what is not counted');
            assert.ok(html.includes('<span class="hc-term">term not published</span>'), 'a row with no term says so');
            assert.ok(html.includes('<span class="hc-term">Renewal price not published</span>'), 'a row with no renewal says so');
        });

        await check('a term and a stated renewal render on every plan row, and a zero price is never $0.00', async () => {
            const html = render.provider(await catalog.providers('example'), null, '', NOW);
            assert.ok(html.includes('<span class="hc-term">Monthly</span>'), 'a monthly row states its term');
            assert.ok(html.includes('<span class="hc-term">1-year term</span>'), 'a 1-year row states its term');
            assert.ok(html.includes('<span class="hc-term">Renews at $9.50 a month</span>'), 'a stated renewal is shown');
            assert.ok(html.includes('<span class="hc-price">price not stated</span>'), 'a zero price reads "price not stated"');
            assert.ok(!/\$0\.00(?!\d)/.test(html), 'no row renders $0.00 for an unknown price');
            assert.ok(html.includes('data-label="Per vCPU" class="hc-n hc-dim"><span class="hc-unknown"'), 'per-resource ratios of a zero price stay Unknown');

            const monthlyPage = render.plan(await catalog.plan(monthly.id), null, { now: NOW });
            assert.ok(monthlyPage.includes('Monthly. Renewal price not published.'), 'the plan page states a monthly term and no renewal');
            const yearlyPage = render.plan(await catalog.plan(yearly.id), null, { now: NOW });
            assert.ok(yearlyPage.includes('1-year term. Renews at $9.50 a month.'), 'the plan page states the term and renewal');
            const freePage = render.plan(await catalog.plan(free.id), null, { now: NOW });
            assert.ok(freePage.includes('<p class="hc-big">price not stated<span>/month</span></p>'), 'the plan page does not print $0.00');
            assert.ok(!/\$0\.00(?!\d)/.test(freePage), 'a zero price never renders $0.00 on a plan page');
            const freeProduct = render.jsonLd.plan('https://openvibe.host', await catalog.plan(free.id)).find((x) => x['@type'] === 'Product');
            assert.strictEqual(freeProduct.offers, undefined, 'a zero price is not a Product Offer');
        });

        await check('every outbound link says what it earns us (market outcome 7)', async () => {
            const outbound = (html) => [...html.matchAll(/<a\b[^>]*href="https?:\/\/[^"]*"[^>]*>[\s\S]*?<\/a>(?:\s*<small class="hc-note">[^<]*<\/small>)?/g)].map((m) => m[0]);
            const providerPage = render.provider(await catalog.providers('example'), null, '', NOW);
            const links = outbound(providerPage);
            assert.ok(links.length >= 4, `the provider page has its visit, homepage, review and source links: ${links.length}`);
            for (const a of links) assert.match(a, /(?:No commission|We earn a commission on this link)/, a.slice(0, 160));
            assert.ok(providerPage.includes('We earn a commission on this link.'), 'an affiliate link says we earn a commission');
            assert.ok(providerPage.includes('No commission.'), 'a link with no deal says we earn nothing');
            const planPage = render.plan(await catalog.plan(monthly.id), null, { now: NOW, baseUrl: 'https://openvibe.host', watchUrl: 'https://openvibe.watch' });
            assert.ok(outbound(planPage).length >= 3, 'the plan page marks its source, visit and watch links');
            for (const a of outbound(planPage)) assert.match(a, /(?:No commission|We earn a commission on this link)/, a.slice(0, 160));
            const comparePage = render.catalog({ result: await catalog.plans({}), query: {}, providers: await catalog.providers(), currencies: ['USD'] });
            assert.ok(outbound(comparePage).length >= 2, 'the comparison marks its source links');
            for (const a of outbound(comparePage)) assert.match(a, /(?:No commission|We earn a commission on this link)/, a.slice(0, 160));
        });

        await check('no uptime, benchmark score or test method field is shown (outcomes 4, 5 and 6 need data we do not collect)', async () => {
            const page = render.plan(await catalog.plan(fresh.id), null, { now: NOW });
            assert.ok(!/uptime/i.test(page), 'no uptime field');
            assert.ok(!/normalised|normalized|100 = fastest|benchmark score/i.test(page), 'no benchmark score');
            assert.ok(!/test method|sample size/i.test(page), 'no test method or sample size');
        });

        await check('a plan page shows a rate per GB as a rate and marks a stale price', async () => {
            const ratePage = render.plan(await catalog.plan(rate.id), null, { now: NOW });
            assert.ok(ratePage.includes('$0.0010'), 'the rate is the stored rate');
            assert.ok(ratePage.includes('/GB/month'), 'the rate is a rate per GB');
            assert.ok(!ratePage.includes('$0.00</span>'), 'a rate never reads as a monthly price');
            const stalePage = render.plan(await catalog.plan(stale.id), null, { now: NOW });
            assert.ok(stalePage.includes('Checked <strong>2025-10-31</strong>, <span class="hc-stale"'), 'the price is marked as stale');
            assert.ok(stalePage.includes('not counted as a cheapest plan'));
        });
    } finally {
        await db.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
