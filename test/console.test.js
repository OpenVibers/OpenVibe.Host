'use strict';
/**
 * The console (server/console/): a person connects their own hosting accounts and sees and runs every server in one
 * place. The token is checked with the provider, sealed (never stored or shown in clear), and sent only to that
 * provider; a refused token connects nothing. The list combines providers with prices, totals and the catalog's cheaper
 * equivalent; power actions reach the provider and are logged; nobody acts on another person's account; disconnecting
 * deletes the token. Account export carries the accounts without their tokens, and deletion removes them. Without
 * HOST_CREDENTIALS_KEY nothing is connected. Fake provider APIs stand in for Linode and DigitalOcean.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const ORIGIN = 'https://openvibe.host';
const KEY = 'a'.repeat(64);
const LINODE_TOKEN = 'linode-token-0123456789abcdef';
const DO_TOKEN = 'do-token-0123456789abcdef0000';

function fakeProviders() {
    const calls = [];
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(String(url));
        const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
        const method = init.method || 'GET';
        if (u.hostname === 'api.linode.com') {
            calls.push({ host: 'linode', method, path: u.pathname, auth });
            if (auth !== `Bearer ${LINODE_TOKEN}`) return json(401, { errors: [{ reason: 'Invalid Token' }] });
            if (u.pathname === '/v4/profile') return json(200, { username: 'alice-linode' });
            if (u.pathname === '/v4/linode/types') return json(200, { data: [{ id: 'g6-standard-2', price: { monthly: 24 } }] });
            if (u.pathname === '/v4/linode/instances') return json(200, { data: [{ id: 101, label: 'web-1', region: 'us-east', status: 'running', type: 'g6-standard-2', specs: { vcpus: 2, memory: 4096, disk: 81920 }, ipv4: ['203.0.113.10'], ipv6: '2001:db8::1/128', created: '2026-01-01T00:00:00' }] });
            if (method === 'POST' && /^\/v4\/linode\/instances\/101\/(boot|shutdown|reboot)$/.test(u.pathname)) return json(200, {});
            return json(404, { errors: [{ reason: 'Not found' }] });
        }
        if (u.hostname === 'api.digitalocean.com') {
            calls.push({ host: 'do', method, path: u.pathname, auth, body: init.body });
            if (auth !== `Bearer ${DO_TOKEN}`) return json(401, { message: 'Unable to authenticate you' });
            if (u.pathname === '/v2/account') return json(200, { account: { email: 'alice@example.test' } });
            if (u.pathname === '/v2/droplets') return json(200, { droplets: [{ id: 202, name: 'db-1', status: 'off', vcpus: 1, memory: 1024, disk: 25, region: { slug: 'fra1' }, size_slug: 's-1vcpu-1gb', size: { price_monthly: 6 }, networks: { v4: [{ type: 'public', ip_address: '198.51.100.7' }] }, created_at: '2026-02-01T00:00:00Z' }] });
            if (method === 'POST' && u.pathname === '/v2/droplets/202/actions') return json(201, { action: { id: 1 } });
            return json(404, { message: 'Not found' });
        }
        return globalThis.fetch(url, init);
    };
    return { calls, fetchImpl };
}

(async () => {
    const fake = fakeProviders();
    const sent = [];
    const accountSend = async (path, body) => { sent.push({ path, body }); return { ok: true, status: 200, json: async () => ({}) }; };
    const t = await boot({ fetchImpl: fake.fetchImpl, accountSend, env: { HOST_CREDENTIALS_KEY: KEY } });
    const { csrfToken } = require('../server/auth/forms');
    const alice = t.user('alice'), bob = t.user('bob'), staff = t.user('editor', { role: 'admin' });
    const csrf = (u) => csrfToken(t.config, { subject: u.subject });
    const post = (u, path, form) => t.api('POST', path, { session: u, form: { csrf: csrf(u), ...form }, headers: { origin: ORIGIN } });
    const notice = (r) => new URLSearchParams(r.headers.location.split('?')[1] || '').get('notice');
    let linodeAcct;
    try {
        await check('signed out, the console sends you to sign in; signed in with nothing connected, it says how to start', async () => {
            const out = await t.api('GET', '/console');
            assert.strictEqual(out.status, 303);
            assert.match(out.headers.location, /^\/auth\/login\?next=%2Fconsole/);
            const r = await t.api('GET', '/console', { session: alice });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Your servers, every provider/);
            assert.match(r.text, /Connect a hosting account below/);
            assert.match(r.headers['cache-control'], /no-store/);
        });

        await check('a refused token connects nothing; a good one is checked, sealed and labelled', async () => {
            const bad = await post(alice, '/console/accounts', { provider: 'linode', token: 'not-the-right-token-xyz' });
            assert.match(notice(bad), /refused the token/);
            assert.strictEqual(Number((await t.ctx.store.db.prepare('SELECT count(*) AS n FROM host_console_accounts').get()).n), 0);
            const ok = await post(alice, '/console/accounts', { provider: 'linode', token: LINODE_TOKEN });
            assert.match(notice(ok), /Linode \(Akamai\) connected/);
            const row = await t.ctx.store.db.prepare('SELECT * FROM host_console_accounts WHERE owner_subject = ?').get(alice.subject);
            linodeAcct = row.id;
            assert.deepStrictEqual([row.label, row.token_hint], ['alice-linode', 'cdef']);
            assert.ok(!row.token_sealed.includes(LINODE_TOKEN) && row.token_sealed.startsWith('v1.'), 'only the sealed token is stored');
            assert.strictEqual(t.ctx.console._open(row.token_sealed), LINODE_TOKEN);
            await post(alice, '/console/accounts', { provider: 'digitalocean', token: DO_TOKEN, label: 'Side projects' });
            const forged = await t.api('POST', '/console/accounts', { session: alice, form: { csrf: 'nope', provider: 'linode', token: LINODE_TOKEN }, headers: { origin: ORIGIN } });
            assert.match(notice(forged), /form expired/);
        });

        await check('the console combines both providers: status, size, address, prices, totals, and a cheaper catalog plan', async () => {
            const p = await t.api('POST', '/api/v1/catalog/providers', { as: staff, json: { slug: 'cheapco', name: 'CheapCo', homepage_url: 'https://cheap.example' } });
            await t.api('POST', '/api/v1/catalog/plans', { as: staff, json: { provider_id: p.json().provider.id, external_id: 'c2', name: 'C2', kind: 'vps', currency: 'USD', price_monthly: 5, vcpu: 2, ram_mb: 4096, disk_gb: 40, source_url: 'https://cheap.example/pricing' } });
            const r = await t.api('GET', '/console?fresh=1', { session: alice });
            assert.match(r.text, /<b>web-1<\/b>/);
            assert.match(r.text, /<b>db-1<\/b>/);
            assert.match(r.text, /203\.0\.113\.10/);
            assert.match(r.text, /\$24</);
            assert.match(r.text, /CheapCo has it for \$5/, 'the catalog has the same size for less');
            assert.match(r.text, /<b>\$30<\/b><span>a month<\/span>/, 'the totals add both');
            assert.match(r.text, /Power on/, 'the stopped droplet can be powered on');
            assert.ok(fake.calls.every((c) => (c.host === 'linode' && c.auth.endsWith(LINODE_TOKEN)) || (c.host === 'do' && (c.auth.endsWith(DO_TOKEN) || c.auth.endsWith('xyz'))) || c.auth.endsWith('xyz')), 'each token goes only to its provider');
        });

        await check('power actions reach the provider and are logged; nobody acts on another person\'s account', async () => {
            const r = await post(alice, `/console/accounts/${linodeAcct}/servers/101/stop`, {});
            assert.match(notice(r), /Power off sent to web-1/);
            assert.ok(fake.calls.some((c) => c.host === 'linode' && c.method === 'POST' && c.path === '/v4/linode/instances/101/shutdown'));
            const doAcct = (await t.ctx.store.db.prepare("SELECT id FROM host_console_accounts WHERE provider = 'digitalocean'").get()).id;
            await post(alice, `/console/accounts/${doAcct}/servers/202/start`, {});
            assert.ok(fake.calls.some((c) => c.host === 'do' && c.path === '/v2/droplets/202/actions' && /power_on/.test(c.body)));
            const page = await t.api('GET', '/console', { session: alice });
            assert.match(page.text, /stop <b>web-1<\/b> \(Linode \(Akamai\)\): sent/);
            const intruder = await post(bob, `/console/accounts/${linodeAcct}/servers/101/reboot`, {});
            assert.match(notice(intruder), /no such connected account/);
            const unknown = await post(alice, `/console/accounts/${linodeAcct}/servers/999/reboot`, {});
            assert.match(notice(unknown), /not in this account/);
        });

        await check('account export carries the accounts and actions without the tokens; deletion removes them', async () => {
            const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
            assert.strictEqual(await t.app.locals.accountData.apply(ev('evt_01JZ0000000000000000HC0001', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000HCX001', subject: alice.subject }), { send: accountSend }), 'exported');
            const part = sent.find((c) => c.path === '/internal/account-exports/exp_01JZ0000000000000000HCX001/parts');
            const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
            assert.deepStrictEqual(files['console-accounts.json'].map((a) => a.provider).sort(), ['digitalocean', 'linode']);
            assert.ok(!/token_sealed|v1\.|linode-token|do-token/.test(JSON.stringify(part.body)), 'no token in the export');
            assert.ok(files['console-actions.json'].some((a) => a.action === 'stop'));
            assert.strictEqual(await t.app.locals.accountData.apply(ev('evt_01JZ0000000000000000HD0001', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000HDE001', subject: alice.subject }), { send: accountSend }), 'erased');
            assert.strictEqual(Number((await t.ctx.store.db.prepare('SELECT count(*) AS n FROM host_console_accounts WHERE owner_subject = ?').get(alice.subject)).n), 0);
            assert.strictEqual(Number((await t.ctx.store.db.prepare('SELECT count(*) AS n FROM host_console_actions WHERE owner_subject = ?').get(alice.subject)).n), 0);
        });

        await check('disconnecting deletes the token', async () => {
            await post(bob, '/console/accounts', { provider: 'linode', token: LINODE_TOKEN });
            const id = (await t.ctx.store.db.prepare('SELECT id FROM host_console_accounts WHERE owner_subject = ?').get(bob.subject)).id;
            const r = await post(bob, `/console/accounts/${id}/remove`, {});
            assert.match(notice(r), /token is deleted/);
            assert.strictEqual(Number((await t.ctx.store.db.prepare('SELECT count(*) AS n FROM host_console_accounts WHERE id = ?').get(id)).n), 0);
        });
    } finally { await t.close(); }

    const t2 = await boot({ fetchImpl: fake.fetchImpl, env: { HOST_CREDENTIALS_KEY: '' } });
    try {
        await check('without HOST_CREDENTIALS_KEY nothing is connected', async () => {
            const carol = t2.user('carol');
            const page = await t2.api('GET', '/console', { session: carol });
            assert.match(page.text, /not set up on this server yet/);
            const { csrfToken: tok } = require('../server/auth/forms');
            const r = await t2.api('POST', '/console/accounts', { session: carol, form: { csrf: tok(t2.config, { subject: carol.subject }), provider: 'linode', token: LINODE_TOKEN }, headers: { origin: ORIGIN } });
            assert.match(new URLSearchParams(r.headers.location.split('?')[1]).get('notice'), /HOST_CREDENTIALS_KEY/);
        });
    } finally { await t2.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
