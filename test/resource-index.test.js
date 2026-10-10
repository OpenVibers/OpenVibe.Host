'use strict';
// Host's authority resource index (ADR-048 section 3, capability host.resource.read, plan T13 step 8):
// GET /api/v1/resources pages common.resource-summary@1 for the resources Host owns - its tenant sites
// (host.site, sit_), the immutable deploys of those sites (host.deploy, dpl_) and their default and
// custom domains (host.domain, dom_) - as common.resource-list-result@1, and GET /api/v1/resources/:ovrn
// reads one by its computed ovrn. ?project=&kind=&owner=&cursor=&limit= are honoured; ?project= is the tenancy
// boundary, so a resource of another project is never returned, and Host lists no projects at all.
// Every summary and every page is validated against the released schemas.
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./stageb/boot');

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const bob = t.user('bob');
    const prjA = (await t.project(alice, 'Resource A')).id;
    const prjB = (await t.project(alice, 'Resource B')).id;
    const prjC = (await t.project(bob, 'Resource C')).id;

    // Sites: two in A, one in B and one owned by Bob in C (each mints a default domain).
    const siteA1 = await t.site(alice, prjA, 'ri-a-one');
    const siteA2 = await t.site(alice, prjA, 'ri-a-two');
    const siteB = await t.site(alice, prjB, 'ri-b-one');
    const siteC = await t.site(bob, prjC, 'ri-c-one');

    // Deploys of A's first site: one ready, one refused (a failed deploy).
    const readyDeploy = await t.deploy(alice, siteA1.id, { 'index.html': 'v1' });
    const refusedUpload = await t.upload(alice, siteA1.id, { 'bad.php': 'x' });
    assert.ok([413, 422].includes(refusedUpload.status), refusedUpload.text);
    const failedDeploy = { id: refusedUpload.json().deploy_id };
    assert.match(failedDeploy.id, /^dpl_/);

    // A custom domain of A's first site, still waiting for its TXT record.
    const custom = await t.api('POST', `/api/v1/sites/${siteA1.id}/domains`, { as: alice, json: { hostname: 'ri.example.org' } });
    assert.strictEqual(custom.status, 201, custom.text);
    const customDomain = custom.json().domain;

    // The default domain each site create mints (its id is what the index lists).
    const defaultDomains = [];
    for (const [site, user] of [[siteA1, alice], [siteA2, alice], [siteB, alice], [siteC, bob]]) {
        const seen = await t.api('GET', `/api/v1/sites/${site.id}`, { as: user });
        assert.strictEqual(seen.status, 200, seen.text);
        for (const d of seen.json().domains) if (d.kind === 'default') defaultDomains.push(d);
    }
    assert.strictEqual(defaultDomains.length, 4);

    const resourcesOf = async (query, headers) => {
        const r = await t.api('GET', `/api/v1/resources${query}`, headers);
        assert.strictEqual(r.status, 200, `${query}: ${r.status} ${r.text}`);
        const page = r.json();
        assert.deepStrictEqual(Object.keys(page).sort(), ['next_cursor', 'resources'], 'the page carries only the contract fields');
        const pageCheck = validate('common.resource-list-result@1', page);
        assert.ok(pageCheck.valid, `${query}: ${JSON.stringify(pageCheck.errors)}`);
        for (const s of page.resources) {
            const v = validate('common.resource-summary@1', s);
            assert.ok(v.valid, `${query} ${s.id}: ${JSON.stringify(v.errors)}`);
        }
        return page;
    };

    await check('auth: no token 401, a token without host.resource.read 403, with it 200', async () => {
        const anonymous = await t.api('GET', '/api/v1/resources');
        assert.strictEqual(anonymous.status, 401);
        assert.strictEqual(anonymous.json().code, 'auth.required');
        const person = await t.api('GET', '/api/v1/resources', { as: alice });
        assert.strictEqual(person.status, 403, 'the index is first-party: a person holds no service capability');
        assert.strictEqual(person.json().code, 'capability.denied');
        const wrongAudience = t.network.sign({ sub: 'svc:services', aud: ['openvibe.blog'], cap: ['host.resource.read'] });
        assert.strictEqual((await t.api('GET', '/api/v1/resources', { as: wrongAudience })).status, 401);
        const noCap = t.network.serviceToken('codes', ['host.site.manage']);
        const denied = await t.api('GET', '/api/v1/resources', { as: noCap });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json().code, 'capability.denied');
        const allowed = await t.api('GET', '/api/v1/resources', { as: t.network.serviceToken('services', ['host.resource.read']) });
        assert.strictEqual(allowed.status, 200, allowed.text);
    });

    const bearer = t.network.serviceToken('services', ['host.resource.read']);
    const auth = { as: bearer };

    await check('the page lists every kind Host owns, sorted by (kind, id), each summary valid', async () => {
        const page = await resourcesOf('', auth);
        const expected = [
            { kind: 'host.deploy', id: readyDeploy.id }, { kind: 'host.deploy', id: failedDeploy.id },
            { kind: 'host.domain', id: customDomain.id },
            { kind: 'host.site', id: siteA1.id }, { kind: 'host.site', id: siteA2.id }, { kind: 'host.site', id: siteB.id }, { kind: 'host.site', id: siteC.id },
        ];
        const byId = new Map(page.resources.map((r) => [r.id, r]));
        for (const d of defaultDomains) expected.push({ kind: 'host.domain', id: d.id });
        expected.sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
        assert.deepStrictEqual(page.resources.map((r) => [r.kind, r.id]), expected.map((r) => [r.kind, r.id]), 'all three kinds, sorted by (kind, id)');
        assert.deepStrictEqual([...new Set(page.resources.map((r) => r.service))], ['host']);
        assert.strictEqual(page.next_cursor, null, 'one page holds the whole index');

        const site = byId.get(siteA1.id);
        assert.strictEqual(site.project_id, prjA, 'a summary carries its project');
        assert.strictEqual(site.name, 'ri-a-one');
        assert.strictEqual(site.state, 'active');
        assert.deepStrictEqual(site.owner, { type: 'user', id: alice.subject }, 'a usr_ subject is the owner');
        assert.strictEqual(byId.get(readyDeploy.id).state, 'ready');
        assert.strictEqual(byId.get(failedDeploy.id).state, 'failed');
        assert.strictEqual(byId.get(customDomain.id).name, 'ri.example.org');
        assert.strictEqual(byId.get(customDomain.id).state, 'pending');
    });

    await check('every summary carries an OVRN composed by contracts.resources.nameOf', async () => {
        const page = await resourcesOf('', auth);
        for (const s of page.resources) {
            assert.strictEqual(s.ovrn, `ovrn:host:${s.project_id}:${s.kind.split('.')[1]}/${s.id}`, s.id);
        }
        assert.strictEqual(page.resources.find((r) => r.id === readyDeploy.id).ovrn, `ovrn:host:${prjA}:deploy/${readyDeploy.id}`);
        assert.strictEqual(page.resources.find((r) => r.id === siteB.id).ovrn, `ovrn:host:${prjB}:site/${siteB.id}`);
    });

    await check('?project= is the tenancy boundary: another project\'s rows are never returned', async () => {
        const a = await resourcesOf(`?project=${prjA}`, auth);
        const ids = a.resources.map((r) => r.id);
        assert.ok(ids.includes(siteA1.id) && ids.includes(siteA2.id) && ids.includes(readyDeploy.id) && ids.includes(customDomain.id));
        assert.ok(a.resources.every((r) => r.project_id === prjA), 'only project A');
        assert.ok(!ids.includes(siteB.id), 'project B is never mixed in');
        const b = await resourcesOf(`?project=${prjB}`, auth);
        assert.deepStrictEqual([...new Set(b.resources.map((r) => r.project_id))], [prjB]);
        assert.ok(b.resources.every((r) => r.id !== siteA1.id && r.id !== readyDeploy.id));
        const empty = await resourcesOf('?project=prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', auth);
        assert.deepStrictEqual(empty.resources, [], 'an unknown project has no resources');
        // Host mints its own prj_ ids and lists no projects: no host.project kind exists.
        assert.ok((await resourcesOf('?kind=host.project', auth)).resources.length === 0);
    });

    await check('?kind= narrows to one kind; an unknown kind is an empty page, not an error', async () => {
        const sites = await resourcesOf('?kind=host.site', auth);
        assert.deepStrictEqual(sites.resources.map((r) => r.id).sort(), [siteA1.id, siteA2.id, siteB.id, siteC.id].sort());
        const deploys = await resourcesOf('?kind=host.deploy', auth);
        assert.deepStrictEqual(deploys.resources.map((r) => r.id).sort(), [readyDeploy.id, failedDeploy.id].sort());
        const domains = await resourcesOf('?kind=host.domain', auth);
        assert.strictEqual(domains.resources.length, 5, "four default domains and A's custom one");
        const scoped = await resourcesOf(`?project=${prjA}&kind=host.site`, auth);
        assert.deepStrictEqual(scoped.resources.map((r) => r.id).sort(), [siteA1.id, siteA2.id].sort(), 'kind narrows within the project');
        assert.deepStrictEqual((await resourcesOf('?kind=host.unknown', auth)).resources, []);
    });

    await check('?owner= filters every kind and combines with project, kind and cursor', async () => {
        const all = (await resourcesOf('', auth)).resources;
        const aliceRows = all.filter((r) => r.owner && r.owner.id === alice.subject);
        const bobRows = all.filter((r) => r.owner && r.owner.id === bob.subject);
        assert.deepStrictEqual(bobRows.map((r) => r.id).sort(), [siteC.id, defaultDomains.find((d) => d.site_id === siteC.id).id].sort());
        const own = await resourcesOf(`?owner=${alice.subject}`, auth);
        assert.deepStrictEqual(own.resources, aliceRows, 'only Alice-owned summaries in index order');
        assert.deepStrictEqual((await resourcesOf(`?owner=${bob.subject}`, auth)).resources, bobRows, 'Bob owns a site and its default domain');
        assert.deepStrictEqual((await resourcesOf(`?owner=${alice.subject}&kind=host.site&project=${prjA}`, auth)).resources,
            aliceRows.filter((r) => r.kind === 'host.site' && r.project_id === prjA));
        assert.deepStrictEqual((await resourcesOf(`?owner=${bob.subject}&project=${prjA}`, auth)).resources, []);
        assert.deepStrictEqual((await resourcesOf(`?owner=${alice.subject}&project=${prjC}`, auth)).resources, []);
        assert.deepStrictEqual((await resourcesOf(`?owner=${alice.subject.replace(/^usr_/, 'agt_')}`, auth)).resources, []);
        assert.deepStrictEqual((await resourcesOf('?owner=', auth)).resources, all, 'empty owner means no filter');

        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const page = await resourcesOf(`?owner=${alice.subject}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, auth);
            assert.ok(page.resources.length <= 2);
            seen.push(...page.resources);
            if (page.next_cursor === null) break;
            cursor = page.next_cursor;
            if (++pages > 50) assert.fail('the owner cursor chain never ended');
        }
        assert.deepStrictEqual(seen, aliceRows, 'owner paging has no duplicates or gaps');
    });

    await check('the cursor pages the index without duplicates, gaps or reordering', async () => {
        const whole = (await resourcesOf('', auth)).resources.map((r) => r.id);
        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const page = await resourcesOf(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, auth);
            assert.ok(page.resources.length <= 2);
            seen.push(...page.resources.map((r) => r.id));
            if (page.next_cursor === null) break;
            assert.ok(typeof page.next_cursor === 'string' && page.next_cursor !== '');
            cursor = page.next_cursor;
            if (++pages > 50) assert.fail('the cursor chain never ended');
        }
        assert.deepStrictEqual(seen, whole, 'no duplicates, none skipped, order preserved');
        assert.deepStrictEqual((await resourcesOf('?limit=1000', auth)).resources.map((r) => r.id), whole, 'a large limit still pages one result');
    });

    await check('GET /:ovrn reads the one resource whose computed ovrn it is', async () => {
        const page = await resourcesOf('', auth);
        const one = await t.api('GET', `/api/v1/resources/${encodeURIComponent(`ovrn:host:${prjA}:site/${siteA1.id}`)}`, auth);
        assert.strictEqual(one.status, 200, one.text);
        assert.strictEqual(one.headers['cache-control'], 'private, max-age=60');
        assert.ok(validate('common.resource-summary@1', one.json()).valid);
        assert.deepStrictEqual(one.json(), page.resources.find((r) => r.id === siteA1.id), 'the same summary the list answers');

        const missing = [
            ['a project OVRN', `ovrn:host:${prjA}:project/${prjA}`],
            ['an unknown type', `ovrn:host:${prjA}:widget/sit_01J8ZQ4Y7N3M2K1H0G9F8E7D6C`],
            ["another service's OVRN", `ovrn:network:${prjA}:site/${siteA1.id}`],
            ['the right id under another project', `ovrn:host:${prjB}:site/${siteA1.id}`],
            ['an unknown id', `ovrn:host:${prjA}:site/sit_01J8ZQ4Y7N3M2K1H0G9F8E7D6C`],
            ['a non-OVRN', 'nope'],
        ];
        for (const [why, name] of missing) {
            const r = await t.api('GET', `/api/v1/resources/${encodeURIComponent(name)}`, auth);
            assert.strictEqual(r.status, 404, `${why}: ${r.status} ${r.text}`);
            assert.strictEqual(r.headers['content-type'], 'application/problem+json', why);
            assert.strictEqual(r.json().code, 'resources.unknown_resource', why);
        }
    });

    await check('a query that cannot be honoured is 400 resources.bad_query', async () => {
        const bad = [['?project=nope', 'project not a prj_ id'], ['?owner=svc:live', 'owner not a subject id'], ['?owner=usr_short', 'owner too short'], ['?limit=0', 'limit below one'], ['?limit=abc', 'limit not a number'], ['?limit=99999', 'limit over the cap'], ['?cursor=***', 'cursor not one this index issued']];
        for (const [q, why] of bad) {
            const r = await t.api('GET', `/api/v1/resources${q}`, auth);
            assert.strictEqual(r.status, 400, why);
            assert.strictEqual(r.json().code, 'resources.bad_query', why);
        }
    });

    await t.close();
    done();
})();
