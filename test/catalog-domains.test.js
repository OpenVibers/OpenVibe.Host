'use strict';
/**
 * Domain names compared (migrations/0011, server/catalog/domains.js, domain-store.js, rdap.js, domain-check.js): Porkbun's
 * price list from Sources becomes one price per TLD (Handshake names left out, "2,060.25" read, a change kept as history,
 * a TLD no longer sold gone); the TLD table sorts popular first, by price or over five years; a TLD's page lists every
 * registrar; a name check reads what was typed, asks the registry over RDAP (cached, refused redirects, unknown when the
 * ending has no RDAP) and prices the same name at the popular endings; readiness waits for the tables.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const domains = require('../server/catalog/domains');
const { createRdap, BOOTSTRAP_URL } = require('../server/catalog/rdap');

const at = '2026-10-16T12:00:00Z';
let seq = 0;
const item = (tld, fields, { time = at, removed = null } = {}) => ({
    id: `itm_${String(++seq).padStart(26, '0')}`, source_key: 'porkbun-tld-pricing', category: 'hosting', kind: 'tld_price', identity: tld, canonical_url: null, title: tld,
    summary: null, authors: [], published_at: null, source_updated_at: null, fields: { special_type: null, ...fields }, revision: 1, removed,
    provenance: { retrieved_at: time, first_seen_at: at, content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'api@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null },
});
const price = (register, renewal = register, transfer = renewal) => ({ registration: register, renewal, transfer });
// A dns.lookup stand-in that answers one public address, so the egress check passes without the network.
const publicLookup = (_host, _opts, cb) => cb(null, [{ address: '192.30.252.1', family: 4 }]);

function fakeRegistry() {
    const calls = [];
    const fetchImpl = async (u, init) => {
        calls.push({ url: String(u), redirect: init.redirect });
        if (u === BOOTSTRAP_URL) return Response.json({ services: [[['com', 'net'], ['https://rdap.registry.test/com/v1/']], [['dev', 'app'], ['http://insecure.test/', 'https://rdap.dev.test/']]] });
        const m = /\/domain\/([^/?]+)$/.exec(String(u));
        const name = m && decodeURIComponent(m[1]);
        if (name === 'taken.com') {
            return new Response(JSON.stringify({ objectClassName: 'domain', ldhName: 'TAKEN.COM', events: [{ eventAction: 'registration', eventDate: '2001-05-04T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-05-04T00:00:00Z' }],
                entities: [{ objectClassName: 'entity', roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]] }] }), { status: 200, headers: { 'content-type': 'application/rdap+json' } });
        }
        if (name === 'busy.com') return new Response('', { status: 429 });
        return new Response('', { status: 404 });
    };
    return { calls, fetchImpl };
}

(async () => {
    await check('reading registrar prices and typed names', async () => {
        assert.deepStrictEqual([domains.amount('2,060.25'), domains.amount('8.75'), domains.amount(''), domains.amount('n/a'), domains.amount(12)], [2060.25, 8.75, null, null, 12]);
        assert.deepStrictEqual(['.DEV', 'co.uk', 'рф', 'xn--p1ai', 'bad_tld', '..', ''].map(domains.normalizeTld), ['dev', 'co.uk', 'xn--p1ai', 'xn--p1ai', null, null, null]);
        assert.deepStrictEqual(['com', 'uk', 'co.uk', 'xn--p1ai'].map(domains.tldKind), ['generic', 'country', 'second-level', 'internationalized']);
        assert.strictEqual(domains.displayTld('xn--p1ai'), '.рф');
        const known = new Set(['com', 'uk', 'co.uk', 'dev']);
        assert.deepStrictEqual(domains.parseName('https://www.Example.co.uk/path?x', known), { label: 'example', tld: 'co.uk', name: 'example.co.uk' });
        assert.deepStrictEqual(domains.parseName('My-Site.dev', known), { label: 'my-site', tld: 'dev', name: 'my-site.dev' });
        assert.deepStrictEqual(domains.parseName('openvibe', known), { label: 'openvibe', tld: null, name: null });
        assert.deepStrictEqual(domains.parseName('shop.example.zz', known), { label: 'example', tld: 'zz', name: 'example.zz' }, 'an unknown ending is the last label');
        for (const bad of ['', 'a..b', '-x.com', 'x-.com', 'ab--cd.com', 'sp ace.com', 'a'.repeat(64) + '.com', '.com']) assert.strictEqual(domains.parseName(bad, known), null, bad);
        assert.strictEqual(domains.parseName('xn--p1ai.xn--p1ai', known).name, 'xn--p1ai.xn--p1ai', 'punycode labels are names');
        assert.strictEqual(domains.mapTldPrice(item('0zebra', { ...price('3.63', '8.20'), special_type: 'handshake' })), null, 'Handshake names are not ICANN TLDs');
        assert.strictEqual(domains.mapTldPrice(item('dev', price('', ''))), null, 'no price, no row');
        const v = domains.mapTldPrice(item('security', price('2,060.25')));
        assert.deepStrictEqual([v.tld, v.register, v.renew, v.currency, v.provider.slug], ['security', 2060.25, 2060.25, 'USD', 'porkbun']);
        assert.strictEqual(domains.mapTldPrice({ source_key: 'vultr-plans' }), null, 'a plan source is not a price list');
        // OVHcloud's public catalog: hundred-millionths of a dollar; a first year of 0 or the sentinel is not sold that way.
        const ovh = (tld, fields) => ({ ...item(tld, {}), source_key: 'ovhcloud-domain-pricing', fields: { currency: 'USD', ...fields } });
        const com = domains.mapTldPrice(ovh('com', { register: 920000000, renew: 1649000000, transfer: 920000000 }));
        assert.deepStrictEqual([com.tld, com.register, com.renew, com.transfer, com.provider.slug, com.source_url], ['com', 9.2, 16.49, 9.2, 'ovhcloud', 'https://www.ovhcloud.com/en/domains/tld/']);
        assert.strictEqual(domains.mapTldPrice(ovh('co.uk', { register: 849000000, renew: 949000000, transfer: 0 })).transfer, 0, 'a free transfer is a price of 0');
        assert.strictEqual(domains.mapTldPrice(ovh('br', { register: 0, renew: 100000000, transfer: 0 })), null, 'a first year of 0 is not a price to compare');
        assert.strictEqual(domains.mapTldPrice(ovh('tn', { register: 99999900000000, renew: 99999900000000 })), null, 'the premium sentinel is never a price');
        assert.strictEqual(domains.mapTldPrice(ovh('com', { currency: 'EUR', register: 920000000 })), null, 'only US dollars are compared');
        assert.strictEqual(domains.mapTldPrice(ovh('io', { register: 6299000000, renew: 99999900000000 })).renew, null, 'a sentinel renewal is unknown, not a price');
    });

    await check('RDAP: registered, unregistered, rate-limited, no RDAP; https only, no redirects, answers cached', async () => {
        const reg = fakeRegistry();
        let clock = Date.parse(at);
        const rdap = createRdap({ fetchImpl: reg.fetchImpl, now: () => clock, lookup: publicLookup, log: { warn() {} } });
        const taken = await rdap.lookup('taken.com');
        assert.deepStrictEqual([taken.status, taken.registrar, taken.created, taken.expires, taken.server], ['registered', 'Example Registrar, Inc.', '2001-05-04T00:00:00.000Z', '2027-05-04T00:00:00.000Z', 'rdap.registry.test']);
        assert.strictEqual((await rdap.lookup('free.dev')).status, 'unregistered');
        assert.ok(reg.calls.some((c) => c.url === 'https://rdap.dev.test/domain/free.dev'), 'the https server of the two is asked');
        assert.ok(reg.calls.every((c) => c.redirect === 'error'), 'redirects are refused');
        const busy = await rdap.lookup('busy.com');
        assert.deepStrictEqual([busy.status, /slow down/.test(busy.reason)], ['unknown', true]);
        const none = await rdap.lookup('name.zz');
        assert.deepStrictEqual([none.status, /no public RDAP/.test(none.reason)], ['unknown', true]);
        const before = reg.calls.length;
        assert.strictEqual((await rdap.lookup('taken.com')).cached, true);
        assert.strictEqual(reg.calls.length, before, 'a cached answer asks nobody');
        clock += 11 * 60_000;
        assert.strictEqual((await rdap.lookup('taken.com')).cached, false, 'after ten minutes the registry is asked again');
        assert.strictEqual(reg.calls.filter((c) => c.url === BOOTSTRAP_URL).length, 1, 'the bootstrap file is read once a day');
        const denied = createRdap({ fetchImpl: reg.fetchImpl, lookup: (_h, _o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]), log: { warn() {} } });
        assert.strictEqual((await denied.lookup('x.com')).status, 'unknown', 'a registry server resolving to a private address is not asked');
    });

    const reg = fakeRegistry();
    const t = await boot({ rdap: createRdap({ fetchImpl: reg.fetchImpl, lookup: publicLookup, log: { warn() {} } }) });
    const catalog = t.ctx.catalog;
    try {
        await check('applying Porkbun\'s list: one row per TLD, Handshake left out, a change kept, a TLD no longer sold gone', async () => {
            for (const [tld, p] of [['com', price('11.08')], ['dev', price('8.75', '12.87')], ['co.uk', price('5.79', '7.10')], ['uk', price('4.49', '6.20')], ['xn--p1ai', price('7.43')], ['com.mx', price('11.33', '23.32')], ['security', price('2,060.25')]]) {
                assert.strictEqual(await catalog.applyItem(item(tld, p)), 'applied', tld);
            }
            assert.strictEqual(await catalog.applyItem(item('0zebra', { ...price('3.63'), special_type: 'handshake' })), 'hold');
            assert.strictEqual(await catalog.applyItem(item('dev', price('8.75', '13.50'), { time: '2026-10-17T12:00:00Z' })), 'applied');
            assert.strictEqual(await catalog.applyItem(item('dev', price('1.00'), { time: '2026-10-15T12:00:00Z' })), 'hold', 'an older observation never overwrites a newer one');
            assert.strictEqual(await catalog.applyItem(item('com.mx', {}, { removed: { at: at, reason: 'gone' } })), 'removed');
            const dev = (await t.api('GET', '/api/v1/catalog/domains/dev')).json().tld;
            assert.deepStrictEqual([dev.display, dev.kind, dev.cheapest.register, dev.cheapest.renew, dev.cheapest.five_year], ['.dev', 'generic', 8.75, 13.5, 62.75]);
            assert.deepStrictEqual(dev.prices.map((p) => [p.registrar, p.source_url]), [['Porkbun', 'https://porkbun.com/products/domains']]);
            assert.deepStrictEqual(dev.history.map((h) => [h.registrar, h.renew]), [['Porkbun', [12.87, 13.5]]]);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/domains/com.mx')).status, 404, 'a TLD no longer sold is gone');
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/domains/0zebra')).status, 404);
            const providers = (await t.api('GET', '/api/v1/catalog/providers')).json().providers;
            assert.deepStrictEqual(providers.map((p) => p.slug), ['porkbun'], 'the registrar is a catalog provider');
        });

        await check('the TLD table: popular first, sorts by price and five years, filters by kind and ending', async () => {
            const list = async (q = '') => (await t.api('GET', `/api/v1/catalog/domains${q}`)).json().tlds.map((r) => r.tld);
            assert.deepStrictEqual(await list(), ['com', 'dev', 'uk', 'co.uk', 'security', 'xn--p1ai'], 'POPULAR order, then A to Z');
            assert.deepStrictEqual(await list('?sort=register'), ['uk', 'co.uk', 'xn--p1ai', 'dev', 'com', 'security']);
            assert.deepStrictEqual(await list('?sort=five_year'), ['uk', 'co.uk', 'xn--p1ai', 'com', 'dev', 'security'], '.dev is cheap the first year and dear over five');
            assert.deepStrictEqual(await list('?kind=country'), ['uk']);
            assert.deepStrictEqual(await list('?kind=second-level'), ['co.uk']);
            assert.deepStrictEqual(await list('?q=.UK'), ['uk', 'co.uk']);
            assert.deepStrictEqual(await list(`?q=${encodeURIComponent('рф')}`), ['xn--p1ai']);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/domains?sort=cheap')).status, 422);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/domains?q=%25')).status, 422);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/domains?registrar=porkbun&sort=tld')).json().tlds.length, 6);
        });

        await check('pages: the comparison, a TLD (canonical lower case), the provider, the front page, sitemap and robots', async () => {
            const index = await t.api('GET', '/catalog/domains');
            assert.strictEqual(index.status, 200);
            assert.match(index.text, /<h1>Compare domain prices<\/h1>/);
            assert.match(index.text, /6 endings with what registrars charge/);
            assert.match(index.text, /href="\/catalog\/domains\/dev">\.dev<\/a>/);
            assert.match(index.text, /Renews higher/);
            assert.match(index.text, /Porkbun today/);
            assert.match(index.text, /rel="nofollow noopener"/);
            assert.doesNotMatch(index.text, /noindex/);
            const dev = await t.api('GET', '/catalog/domains/dev');
            assert.strictEqual(dev.status, 200);
            assert.match(dev.text, /<h1>\.dev domain prices<\/h1>/);
            assert.match(dev.text, /from <strong>\$8\.75<\/strong> for the first year and renews from <strong>\$13\.50<\/strong>/);
            assert.match(dev.text, /renewal \$12\.87 → <strong>\$13\.50<\/strong>/);
            assert.match(dev.text, /Register at Porkbun/);
            const upper = await t.api('GET', '/catalog/domains/DEV');
            assert.deepStrictEqual([upper.status, upper.headers.location], [301, '/catalog/domains/dev']);
            assert.strictEqual((await t.api('GET', '/catalog/domains/nope')).status, 404);
            const pb = await t.api('GET', '/catalog/providers/porkbun');
            assert.match(pb.text, /6 domain endings priced/);
            assert.doesNotMatch(pb.text, /No plan of this provider/);
            assert.match(pb.text, /href="https:\/\/openvibe\.reviews\/review\?kind=service&amp;name=Porkbun"/, 'a registrar is reviewed as a service');
            const front = await t.api('GET', '/');
            assert.match(front.text, /Domain names, compared too/);
            assert.match(front.text, /href="\/catalog\/domains"/);
            const map = (await t.api('GET', '/sitemap.xml')).text;
            assert.match(map, /\/catalog\/domains<\/loc>/);
            assert.match(map, /\/catalog\/domains\/co\.uk<\/loc>/);
            assert.match((await t.api('GET', '/robots.txt')).text, /Disallow: \/catalog\/domains\/check/);
            const old = await t.api('GET', '/domains');
            assert.deepStrictEqual([old.status, old.headers.location], [301, '/catalog/domains']);
            assert.strictEqual((await t.api('GET', '/domains/abc')).status, 410, 'old custom-domain pages still say hosting moved');
        });

        await check('a name check: typed name read, registry asked, the same name priced at other endings; bad names are 422', async () => {
            const free = await t.api('GET', '/catalog/domains/check?name=OpenVibe.dev');
            assert.strictEqual(free.status, 200);
            assert.match(free.text, /<h1 class="hd-name">openvibe\.dev<\/h1>/);
            assert.match(free.text, /Probably free/);
            assert.match(free.text, /openvibe with other endings/);
            assert.match(free.text, /Check openvibe\.com/);
            assert.match(free.text, /noindex/);
            assert.match(free.headers['cache-control'], /private/);
            const taken = (await t.api('GET', '/api/v1/catalog/domains/check?name=https://taken.com/')).json().check;
            assert.deepStrictEqual([taken.name, taken.status, taken.registrar], ['taken.com', 'registered', 'Example Registrar, Inc.']);
            assert.deepStrictEqual(taken.prices.map((p) => p.tld).slice(0, 3), ['com', 'dev', 'uk']);
            const bare = (await t.api('GET', '/api/v1/catalog/domains/check?name=taken')).json().check;
            assert.strictEqual(bare.name, 'taken.com', 'a bare label is checked as .com');
            const uk = (await t.api('GET', '/api/v1/catalog/domains/check?name=shop.example.co.uk')).json().check;
            assert.deepStrictEqual([uk.label, uk.tld, uk.status], ['example', 'co.uk', 'unknown'], 'the longest priced suffix; .uk has no RDAP here');
            assert.strictEqual((await t.api('GET', '/catalog/domains/check?name=a..b')).status, 422);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/domains/check?name=-x.com')).status, 422);
            const empty = await t.api('GET', '/catalog/domains/check');
            assert.deepStrictEqual([empty.status, empty.headers.location], [303, '/catalog/domains']);
        });

        await check('readiness waits for the domain tables (a release never answers without them)', async () => {
            const { CHARTER_TABLES } = require('../server/db');
            for (const table of ['catalog_tld_prices', 'catalog_tld_price_changes']) assert.ok(CHARTER_TABLES.includes(table), table);
        });
    } finally { await t.close(); }
    done();
})();
