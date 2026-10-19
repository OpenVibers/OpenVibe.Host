'use strict';
/**
 * The console (plan T20 step 3; owner 2026-10-08: "openvibe.host should just be combined multi provider hosting
 * comparison … while also have our own system that combines em somehow"): a person connects their own hosting accounts
 * and sees every server in one list (status, region, size, address, monthly price, totals), powers them on, off or
 * reboots them, and sees where the catalog has the same size for less.
 *
 * A token is checked with the provider when it is added, sealed with AES-256-GCM under HOST_CREDENTIALS_KEY, and only
 * ever opened to call that provider. Without the key the console says so and keeps nothing.
 */
const crypto = require('crypto');
const { PROVIDERS, createProviders, ProviderError } = require('./providers');

class ConsoleError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function keyFrom(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
    return buf.length === 32 ? buf : null;
}

function createConsole({ store, config, catalog = null, fetchImpl, log = console }) {
    const { db } = store;
    const key = keyFrom(config.console.credentialsKey);
    const providers = createProviders({ fetchImpl });
    const limits = config.console;
    const q = {
        accounts: db.prepare('SELECT id, provider, label, token_hint, created_at, last_ok_at, last_error FROM host_console_accounts WHERE owner_subject = ? ORDER BY created_at'),
        account: db.prepare('SELECT * FROM host_console_accounts WHERE id = ? AND owner_subject = ?'),
        count: db.prepare('SELECT COUNT(*) AS n FROM host_console_accounts WHERE owner_subject = ?'),
        insert: db.prepare(`INSERT INTO host_console_accounts (id, owner_subject, provider, label, token_sealed, token_hint, created_at, last_ok_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        remove: db.prepare('DELETE FROM host_console_accounts WHERE id = ? AND owner_subject = ?'),
        ok: db.prepare('UPDATE host_console_accounts SET last_ok_at = ?, last_error = NULL WHERE id = ?'),
        failed: db.prepare('UPDATE host_console_accounts SET last_error = ? WHERE id = ?'),
        logAction: db.prepare(`INSERT INTO host_console_actions (owner_subject, account_id, provider, server_id, server_name, action, result, at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        actions: db.prepare('SELECT provider, server_name, action, result, at FROM host_console_actions WHERE owner_subject = ? ORDER BY at DESC LIMIT 20'),
    };

    const available = () => Boolean(key);
    function seal(token) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
        return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`;
    }
    function open(sealed) {
        const [v, iv, tag, body] = String(sealed).split('.');
        if (v !== 'v1') throw new ConsoleError(500, 'console.sealed', 'a stored token is in an unknown format');
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    }
    const need = () => { if (!available()) throw new ConsoleError(503, 'console.unavailable', 'Connecting hosting accounts is not set up on this server yet (HOST_CREDENTIALS_KEY).'); };

    async function accounts(subject) { return await q.accounts.all(subject); }

    async function connect(subject, { provider, token, label }) {
        need();
        if (!PROVIDERS[provider]) throw new ConsoleError(422, 'console.provider', 'pick one of the listed providers');
        const t = String(token || '').trim();
        if (t.length < 16 || t.length > 512 || /\s/.test(t)) throw new ConsoleError(422, 'console.token', 'paste the whole API token (no spaces)');
        if ((await q.count.get(subject)).n >= limits.maxAccounts) throw new ConsoleError(429, 'console.too_many', `you can connect ${limits.maxAccounts} accounts`);
        let found;
        try { found = await providers[provider].verify(t); } catch (err) {
            throw new ConsoleError(err instanceof ProviderError && err.status === 401 ? 422 : 502, 'console.verify', err.message);
        }
        const id = `hca_${crypto.randomBytes(12).toString('hex')}`;
        const now = store.now();
        await q.insert.run(id, subject, provider, String(label || '').trim().slice(0, 60) || String(found).slice(0, 60), seal(t), t.slice(-4), now, now);
        cache.delete(id);
        return id;
    }

    async function disconnect(subject, id) {
        const r = await q.remove.run(id, subject);
        cache.delete(id);
        return r.changes > 0;
    }

    // Each account's server list, kept a minute (a refresh asks again).
    const cache = new Map();
    async function serversOf(account, { fresh = false } = {}) {
        const hit = cache.get(account.id);
        if (!fresh && hit && store.now() - hit.at < 60000) return hit.value;
        let value;
        try {
            const list = await providers[account.provider].list(open(account.token_sealed));
            value = { servers: list.map((s) => ({ ...s, provider: account.provider, account_id: account.id })), error: null };
            await q.ok.run(store.now(), account.id);
        } catch (err) {
            value = { servers: [], error: err.message || 'the provider did not answer' };
            await q.failed.run(String(value.error).slice(0, 300), account.id);
        }
        cache.set(account.id, { value, at: store.now() });
        return value;
    }

    /** Where the catalog has at least the same vCPU and memory for less (the cheapest such plan, 15% or more cheaper). */
    async function cheaper(server) {
        if (!catalog || !server.vcpu || !server.ram_mb || !server.price || server.price.monthly == null || server.price.currency !== 'USD') return null;
        try {
            const r = await catalog.plans({ min_vcpu: server.vcpu, min_ram_mb: Math.floor(server.ram_mb * 0.97), currency: 'USD', sort: 'price' });
            const best = (r.plans || []).find((p) => Number(p.price_monthly) > 0);
            if (!best || Number(best.price_monthly) > server.price.monthly * 0.85) return null;
            return { id: best.id, name: best.name, provider: best.provider_name, monthly: Number(best.price_monthly), vcpu: best.vcpu, ram_mb: best.ram_mb };
        } catch { return null; }
    }

    /** Everything the console page shows for a person. */
    async function overview(subject, { fresh = false } = {}) {
        const accs = await accounts(subject);
        const results = await Promise.all(accs.map(async (a) => ({ account: a, ...(await serversOf({ ...a, token_sealed: (await q.account.get(a.id, subject)).token_sealed }, { fresh })) })));
        const servers = results.flatMap((r) => r.servers);
        for (const s of servers) s.cheaper = await cheaper(s);
        const totals = {};
        for (const s of servers) if (s.price && s.price.monthly != null) totals[s.price.currency] = Math.round(((totals[s.price.currency] || 0) + s.price.monthly) * 100) / 100;
        return {
            accounts: results.map((r) => ({ ...r.account, servers: r.servers.length, error: r.error })),
            servers, totals, running: servers.filter((s) => s.status === 'running').length,
            actions: await q.actions.all(subject),
        };
    }

    async function act(subject, accountId, serverId, action) {
        need();
        if (!['start', 'stop', 'reboot'].includes(action)) throw new ConsoleError(422, 'console.action', 'the action is start, stop or reboot');
        const account = await q.account.get(accountId, subject);
        if (!account) throw new ConsoleError(404, 'console.account', 'no such connected account');
        const known = (await serversOf(account)).servers.find((s) => s.id === String(serverId));
        if (!known) throw new ConsoleError(404, 'console.server', 'that server is not in this account');
        let result = 'sent';
        try { await providers[account.provider].act(open(account.token_sealed), known.id, action); } catch (err) { result = `failed: ${err.message}`.slice(0, 300); }
        await q.logAction.run(subject, account.id, account.provider, known.id, String(known.name || '').slice(0, 120), action, result, store.now());
        cache.delete(account.id);
        if (result !== 'sent') throw new ConsoleError(502, 'console.action_failed', result.replace(/^failed: /, ''));
        return { server: known, action };
    }

    return { available, accounts, connect, disconnect, overview, act, PROVIDERS, _seal: seal, _open: open };
}

module.exports = { createConsole, ConsoleError, keyFrom };
