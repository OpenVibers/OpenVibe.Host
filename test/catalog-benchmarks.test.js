'use strict';
/**
 * Benchmarks (migrations/0012, server/catalog/benchmarks.js): YABS's JSON is read field by field (KB/s → MB/s, KiB → MB,
 * the newest Geekbench, only a Geekbench Browser link); a signed-in person gets a one-time link (24 hours, 10 a day)
 * naming a catalog plan or another provider; YABS posts to it and gets one line of text back; the result shows on the
 * list, its own page and the plan's and provider's medians; its submitter or staff removes it; account export carries
 * it and erasure detaches it; the form works without JavaScript.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { parseYabs, LINKS_PER_DAY } = require('../server/catalog/benchmarks');
const { csrfToken } = require('../server/auth/forms');
const accountData = require('../server/account-data');

const YABS = () => ({
    version: 'v2026-10-07', time: '20261016-120000',
    os: { arch: 'x64', distro: 'Ubuntu 24.04.1 LTS', kernel: '6.8.0-45-generic', uptime: 1234, vm: 'KVM' }, net: { ipv4: true, ipv6: false },
    cpu: { model: 'AMD EPYC 7713 64-Core Processor', cores: 2, freq: '1999.999 MHz', aes: true, virt: true },
    mem: { ram: 4012345, ram_units: 'KiB', swap: 1048572, swap_units: 'KiB', disk: 82536444, disk_units: 'KB' },
    ip_info: { protocol: 'IPv4', isp: 'Akamai Connected Cloud', asn: 'AS63949 Akamai Technologies, Inc.', org: 'Linode', city: 'Newark', region: 'New Jersey', region_code: 'NJ', country: 'United States' },
    partition: '/dev/sda',
    fio: [
        { bs: '4k', speed_r: 150000, iops_r: 37500, speed_w: 150300, iops_w: 37575, speed_rw: 300300, iops_rw: 75075, speed_units: 'KBps' },
        { bs: '64k', speed_r: 600000, iops_r: 9375, speed_w: 603000, iops_w: 9421, speed_rw: 1203000, iops_rw: 18796, speed_units: 'KBps' },
        { bs: '512k', speed_r: 800000, iops_r: 1562, speed_w: 840000, iops_w: 1640, speed_rw: 1640000, iops_rw: 3202, speed_units: 'KBps' },
        { bs: '1m', speed_r: 900000, iops_r: 878, speed_w: 950000, iops_w: 927, speed_rw: 1850000, iops_rw: 1805, speed_units: 'KBps' },
    ],
    iperf: [{ mode: 'IPv4', provider: 'Clouvider', loc: 'London, UK (10G)', send: '1.20 Gbits/sec', recv: '1.05 Gbits/sec', latency: '75.3 ms' }],
    geekbench: [{ version: 5, single: 1100, multi: 2050, url: 'https://browser.geekbench.com/v5/cpu/22222' }, { version: 6, single: 1350, multi: 2500, url: 'https://browser.geekbench.com/v6/cpu/1234567' }],
    runtime: { start: 1, end: 2, elapsed: 780 },
});
const linode = (time = '2026-09-22T11:00:00Z') => ({ id: `itm_${'1'.repeat(26)}`, source_key: 'linode-types', category: 'hosting', kind: 'plan', identity: 'g6-standard-2', canonical_url: null, title: 'Linode 4 GB', summary: null, authors: [], published_at: null, source_updated_at: null,
    fields: { vcpus: 2, memory: 4096, disk: 81920, transfer: 4000, price_monthly: 24, price_hourly: 0.036, class: 'standard' }, revision: 1, removed: null,
    provenance: { retrieved_at: time, first_seen_at: time, content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'api@1', fetch_run_id: null, license_note: null, terms_note: null, entered_by: null } });

(async () => {
    await check('YABS JSON: the newest Geekbench, MB/s and MB, the city and network; not YABS or empty is refused', async () => {
        const v = parseYabs(YABS());
        assert.deepStrictEqual([v.tool_version, v.cpu_model, v.cpu_cores, v.aes, v.virt, v.arch], ['v2026-10-07', 'AMD EPYC 7713 64-Core Processor', 2, true, 'KVM', 'x64']);
        assert.deepStrictEqual([v.ram_mb, v.swap_mb, v.disk_gb], [3918, 1024, 78.7]);
        assert.deepStrictEqual([v.gb_version, v.gb_single, v.gb_multi, v.gb_url], [6, 1350, 2500, 'https://browser.geekbench.com/v6/cpu/1234567']);
        assert.deepStrictEqual([v.disk_4k_iops, v.disk_4k_mbps, v.disk_1m_mbps], [75075, 300.3, 1850]);
        assert.deepStrictEqual(v.fio[0], { bs: '4k', read_mbps: 150, write_mbps: 150.3, total_mbps: 300.3, read_iops: 37500, write_iops: 37575, total_iops: 75075 });
        assert.deepStrictEqual([v.city, v.country, v.network, v.elapsed_s], ['Newark', 'United States', 'Linode', 780]);
        assert.deepStrictEqual(v.iperf, [{ mode: 'IPv4', provider: 'Clouvider', location: 'London, UK (10G)', send: '1.20 Gbits/sec', recv: '1.05 Gbits/sec', latency: '75.3 ms' }]);
        const odd = YABS(); odd.geekbench = [{ version: 6, single: 1, multi: 2, url: 'https://evil.test/v6/cpu/1' }]; odd.fio[0].speed_r = 'fast';
        const o = parseYabs(odd);
        assert.deepStrictEqual([o.gb_url, o.fio[0].read_mbps], [null, null], 'only a Geekbench Browser link; a value that is not a number is not invented');
        assert.throws(() => parseYabs({ hello: 'world' }), /not a YABS result/);
        assert.throws(() => parseYabs({ version: 'v2026-10-07', cpu: {} }), /no disk, network or Geekbench/);
        assert.throws(() => parseYabs([1]), /not a YABS result/);
    });

    const t = await boot();
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const ORIGIN = { origin: 'https://openvibe.host' };
    try {
        await t.ctx.catalog.applyItem(linode());
        const plan = (await t.api('GET', '/api/v1/catalog/plans')).json().plans[0];

        await check('a one-time link: signed in only, names a catalog plan; YABS posts once and reads one line back', async () => {
            assert.strictEqual((await t.api('POST', '/api/v1/catalog/benchmarks/links', { json: { plan_id: plan.id } })).status, 401);
            const made = await t.api('POST', '/api/v1/catalog/benchmarks/links', { as: ada, json: { plan_id: plan.id, note: 'Newark' } });
            assert.strictEqual(made.status, 201, made.text);
            const link = made.json().link;
            assert.match(link.url, /^https:\/\/openvibe\.host\/api\/v1\/catalog\/benchmarks\/yabs\/[A-Za-z0-9_-]{32}$/);
            assert.strictEqual(link.command, `curl -sL https://yabs.sh | bash -s -- -s "${link.url}"`);
            assert.strictEqual(link.provider_name, 'Linode');
            const path = new URL(link.url).pathname;
            const bad = await t.api('POST', path, { body: '{"version": "v2026', headers: { 'content-type': 'application/json' } });
            assert.deepStrictEqual([bad.status, /not valid JSON/.test(bad.text)], [400, true], 'a broken body spends nothing');
            const posted = await t.api('POST', path, { body: JSON.stringify(YABS()), headers: { 'content-type': 'application/json' } });
            assert.strictEqual(posted.status, 201, posted.text);
            assert.match(posted.headers['content-type'], /text\/plain/);
            assert.match(posted.text, /^\nOpenVibe\.Host saved this result: https:\/\/openvibe\.host\/catalog\/benchmarks\/hbm_[0-9A-Z]{26}\n$/);
            const again = await t.api('POST', path, { body: JSON.stringify(YABS()), headers: { 'content-type': 'application/json' } });
            assert.deepStrictEqual([again.status, /already used/.test(again.text)], [410, true]);
            assert.strictEqual((await t.api('POST', '/api/v1/catalog/benchmarks/yabs/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { body: '{}' })).status, 404);
        });

        await check('the result: on the list, its own page, the plan\'s and the provider\'s medians; nobody\'s name', async () => {
            const list = (await t.api('GET', '/api/v1/catalog/benchmarks')).json().benchmarks;
            assert.strictEqual(list.length, 1);
            assert.deepStrictEqual([list[0].provider_name, list[0].plan_name, list[0].note, list[0].gb_single, list[0].provider_slug], ['Linode', 'Linode 4 GB', 'Newark', 1350, 'linode']);
            assert.ok(!('submitted_by' in list[0]) || list[0].submitted_by === undefined, 'the submitter is not public');
            assert.doesNotMatch(JSON.stringify(list), new RegExp(ada.subject));
            const page = await t.api('GET', '/catalog/benchmarks');
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<h1>Server benchmarks<\/h1>/);
            assert.match(page.text, /AMD EPYC 7713/);
            const one = await t.api('GET', `/catalog/benchmarks/${list[0].id}`);
            assert.strictEqual(one.status, 200);
            assert.match(one.text, /1,350<span>single<\/span>/);
            assert.match(one.text, /Full result on Geekbench Browser/);
            assert.match(one.text, /<strong>1,850 MB\/s<\/strong>/);
            assert.match(one.text, /Clouvider/);
            assert.match(one.text, /noindex/);
            assert.doesNotMatch(one.text, /Remove this result/, 'a stranger gets no remove button');
            const planPage = await t.api('GET', `/catalog/plans/${plan.id}`);
            assert.match(planPage.text, /1 result from people running Linode Linode 4 GB\. Medians: Geekbench 6 <strong>1,350<\/strong> single/);
            assert.match((await t.api('GET', '/catalog/providers/linode')).text, /4 GB|1 result from people running Linode/);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/benchmarks?provider=linode')).json().benchmarks.length, 1);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/benchmarks?sort=fastest')).status, 422);
        });

        await check('another provider by name; links expire after a day; ten a day each', async () => {
            const other = (await t.api('POST', '/api/v1/catalog/benchmarks/links', { as: bo, json: { provider_name: 'RackNerd', note: 'Black Friday 2 GB' } })).json().link;
            assert.strictEqual(other.provider_name, 'RackNerd');
            const y = YABS(); delete y.geekbench; y.iperf = [];
            assert.strictEqual((await t.api('POST', new URL(other.url).pathname, { body: JSON.stringify(y) })).status, 201);
            const rn = (await t.api('GET', '/api/v1/catalog/benchmarks?provider=racknerd')).json().benchmarks;
            assert.deepStrictEqual([rn.length, rn[0].provider_slug, rn[0].gb_single], [1, null, null]);
            assert.strictEqual((await t.api('POST', '/api/v1/catalog/benchmarks/links', { as: bo, json: {} })).status, 422, 'a provider must be named');
            const late = (await t.api('POST', '/api/v1/catalog/benchmarks/links', { as: bo, json: { provider: 'linode' } })).json().link;
            t.clock.advance(25 * 3600_000);
            const expired = await t.api('POST', new URL(late.url).pathname, { body: JSON.stringify(YABS()) });
            assert.deepStrictEqual([expired.status, /expired/.test(expired.text)], [410, true]);
            const made = [];
            for (let i = 0; i < LINKS_PER_DAY; i++) made.push((await t.api('POST', '/api/v1/catalog/benchmarks/links', { as: bo, json: { provider: 'linode' } })).status);
            assert.ok(made.every((s) => s === 201));
            assert.strictEqual((await t.api('POST', '/api/v1/catalog/benchmarks/links', { as: bo, json: { provider: 'linode' } })).status, 429);
        });

        await check('the form works without JavaScript: sign in first, then a link and the command', async () => {
            const anon = await t.api('GET', '/catalog/benchmarks/new');
            assert.match(anon.text, /Sign in to submit a benchmark/);
            const form = await t.api('GET', '/catalog/benchmarks/new', { session: ada });
            assert.match(form.text, /<optgroup label="Linode">/);
            assert.match(form.text, /name="csrf"/);
            const csrf = csrfToken(t.config, { subject: ada.subject });
            assert.strictEqual((await t.api('POST', '/catalog/benchmarks/new', { session: ada, headers: ORIGIN, form: { csrf: 'nope', provider: 'linode' } })).status, 403);
            const issued = await t.api('POST', '/catalog/benchmarks/new', { session: ada, headers: ORIGIN, form: { csrf, provider: '', provider_name: 'Hetzner', plan_id: '', note: 'CX22' } });
            assert.strictEqual(issued.status, 201, issued.text.slice(0, 300));
            assert.match(issued.text, /Run this on your Hetzner server/);
            assert.match(issued.text, /curl -sL https:\/\/yabs\.sh \| bash -s -- -s &quot;https:\/\/openvibe\.host\/api\/v1\/catalog\/benchmarks\/yabs\//);
            assert.match(issued.headers['cache-control'], /no-store/);
            const none = await t.api('POST', '/catalog/benchmarks/new', { session: ada, headers: ORIGIN, form: { csrf, provider: '', provider_name: '' } });
            assert.deepStrictEqual([none.status, /Name the provider/.test(none.text)], [422, true]);
            assert.match((await t.api('GET', '/robots.txt')).text, /Disallow: \/catalog\/benchmarks\/\nAllow: \/catalog\/benchmarks\$/);
        });

        await check('its submitter or staff removes it; export carries it and erasure detaches it', async () => {
            const id = (await t.api('GET', '/api/v1/catalog/benchmarks?provider=linode')).json().benchmarks[0].id;
            const own = await t.api('GET', `/catalog/benchmarks/${id}`, { session: ada });
            assert.match(own.text, /Remove this result/);
            assert.strictEqual((await t.api('DELETE', `/api/v1/catalog/benchmarks/${id}`, { as: bo })).status, 403);
            const data = accountData.create({ db: t.ctx.store.db, log: { warn() {}, info() {} } });
            const file = (part, name) => (part.files.find((f) => f.name === name) || { content: [] }).content;
            const exported = await data.exportPart(ada.subject);
            assert.strictEqual(file(exported, 'benchmarks.json').length, 1);
            assert.ok(file(exported, 'benchmark-links.json').length >= 2);
            assert.ok(file(exported, 'benchmark-links.json').every((l) => !('token_hash' in l)), 'never the link token');
            assert.strictEqual((await t.api('DELETE', `/api/v1/catalog/benchmarks/${id}`, { as: ada })).status, 200);
            assert.strictEqual((await t.api('GET', `/catalog/benchmarks/${id}`)).status, 404);
            const erased = await data.erase([bo.subject]);
            assert.deepStrictEqual([erased.retained.tombstones, erased.erased.catalog_bench_links > 0], [1, true]);
            assert.strictEqual((await t.api('GET', '/api/v1/catalog/benchmarks?provider=racknerd')).json().benchmarks.length, 1, 'the measurement stays, anonymous');
        });
    } finally { await t.close(); }
    done();
})();
