'use strict';
/**
 * The hosting accounts the console can combine, each through the provider's own documented API and the person's own
 * token (sent only to that provider's API host, never anywhere else):
 *
 *   linode        https://api.linode.com/v4       Bearer personal access token (Linodes: read/write)
 *   digitalocean  https://api.digitalocean.com/v2  Bearer personal access token
 *   vultr         https://api.vultr.com/v2        Bearer API key
 *   hetzner       https://api.hetzner.cloud/v1    Bearer project API token
 *
 * Every adapter answers verify(token) → a label for the account, list(token) → servers in one shape
 * { id, name, status: 'running' | 'stopped' | 'other', region, vcpu, ram_mb, disk_gb, ipv4, ipv6, plan, price: { monthly, currency }, created_at },
 * and act(token, id, 'start' | 'stop' | 'reboot').
 */
const PROVIDERS = {
    linode: { name: 'Linode (Akamai)', api: 'https://api.linode.com/v4', tokenUrl: 'https://cloud.linode.com/profile/tokens', tokenHelp: 'A personal access token with Linodes: read/write.' },
    digitalocean: { name: 'DigitalOcean', api: 'https://api.digitalocean.com/v2', tokenUrl: 'https://cloud.digitalocean.com/account/api/tokens', tokenHelp: 'A personal access token (read and write, or droplet scopes).' },
    vultr: { name: 'Vultr', api: 'https://api.vultr.com/v2', tokenUrl: 'https://my.vultr.com/settings/#settingsapi', tokenHelp: 'Your API key (allow this server\'s address if access control is on).' },
    hetzner: { name: 'Hetzner Cloud', api: 'https://api.hetzner.cloud/v1', tokenUrl: 'https://console.hetzner.cloud/', tokenHelp: 'A project API token (Security → API tokens, read and write).' },
};

class ProviderError extends Error {
    constructor(message, status = 502) { super(message); this.status = status; }
}

function createProviders({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    async function call(provider, token, path, { method = 'GET', body } = {}) {
        const base = PROVIDERS[provider].api;
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
            });
        } catch (err) {
            throw new ProviderError(`${PROVIDERS[provider].name} did not answer (${err && err.name === 'TimeoutError' ? 'timed out' : 'unreachable'})`);
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (res.status === 401 || res.status === 403) throw new ProviderError(`${PROVIDERS[provider].name} refused the token (${res.status}): check it is valid and allows this`, 401);
        if (!res.ok) {
            const why = json && (json.errors?.[0]?.reason || json.message || json.error?.message || json.error);
            throw new ProviderError(`${PROVIDERS[provider].name} answered ${res.status}${why ? `: ${String(why).slice(0, 160)}` : ''}`);
        }
        return json || {};
    }

    // Public price lists, cached (no token needed).
    const priceCache = new Map();
    async function cachedPublic(key, load) {
        const hit = priceCache.get(key);
        if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.value;
        const value = await load();
        priceCache.set(key, { value, at: Date.now() });
        return value;
    }
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const st = (s) => (['running', 'active'].includes(s) ? 'running' : ['offline', 'stopped', 'off', 'halted'].includes(s) ? 'stopped' : 'other');

    const adapters = {
        linode: {
            async verify(token) { const p = await call('linode', token, '/profile'); return p.username ? `${p.username}` : 'Linode account'; },
            async list(token) {
                const r = await call('linode', token, '/linode/instances?page_size=200');
                const types = await cachedPublic('linode:types', async () => {
                    const t = await call('linode', token, '/linode/types?page_size=200');
                    return Object.fromEntries((t.data || []).map((x) => [x.id, x]));
                });
                return (r.data || []).map((l) => ({
                    id: String(l.id), name: l.label, status: st(l.status), region: l.region, vcpu: num(l.specs?.vcpus), ram_mb: num(l.specs?.memory),
                    disk_gb: num(l.specs?.disk) != null ? Math.round(l.specs.disk / 1024) : null, ipv4: (l.ipv4 || [])[0] || null, ipv6: l.ipv6 ? String(l.ipv6).split('/')[0] : null,
                    plan: l.type, price: { monthly: num(types[l.type]?.price?.monthly), currency: 'USD' }, created_at: l.created,
                }));
            },
            async act(token, id, action) {
                const path = { start: 'boot', stop: 'shutdown', reboot: 'reboot' }[action];
                await call('linode', token, `/linode/instances/${encodeURIComponent(id)}/${path}`, { method: 'POST', body: {} });
            },
        },
        digitalocean: {
            async verify(token) { const a = await call('digitalocean', token, '/account'); return a.account?.email || 'DigitalOcean account'; },
            async list(token) {
                const r = await call('digitalocean', token, '/droplets?per_page=200');
                return (r.droplets || []).map((d) => ({
                    id: String(d.id), name: d.name, status: d.status === 'active' ? 'running' : d.status === 'off' ? 'stopped' : 'other', region: d.region?.slug || null,
                    vcpu: num(d.vcpus), ram_mb: num(d.memory), disk_gb: num(d.disk), ipv4: (d.networks?.v4 || []).find((n) => n.type === 'public')?.ip_address || null,
                    ipv6: (d.networks?.v6 || []).find((n) => n.type === 'public')?.ip_address || null, plan: d.size_slug || d.size?.slug || null,
                    price: { monthly: num(d.size?.price_monthly), currency: 'USD' }, created_at: d.created_at,
                }));
            },
            async act(token, id, action) {
                const type = { start: 'power_on', stop: 'power_off', reboot: 'reboot' }[action];
                await call('digitalocean', token, `/droplets/${encodeURIComponent(id)}/actions`, { method: 'POST', body: { type } });
            },
        },
        vultr: {
            async verify(token) { const a = await call('vultr', token, '/account'); return a.account?.email || a.account?.name || 'Vultr account'; },
            async list(token) {
                const r = await call('vultr', token, '/instances?per_page=500');
                const plans = await cachedPublic('vultr:plans', async () => {
                    const p = await call('vultr', token, '/plans?per_page=500');
                    return Object.fromEntries((p.plans || []).map((x) => [x.id, x]));
                });
                return (r.instances || []).map((v) => ({
                    id: String(v.id), name: v.label || v.hostname || v.id, status: v.power_status === 'running' ? 'running' : v.power_status === 'stopped' ? 'stopped' : st(v.status),
                    region: v.region, vcpu: num(v.vcpu_count), ram_mb: num(v.ram), disk_gb: num(v.disk), ipv4: v.main_ip || null, ipv6: v.v6_main_ip || null,
                    plan: v.plan, price: { monthly: num(plans[v.plan]?.monthly_cost), currency: 'USD' }, created_at: v.date_created,
                }));
            },
            async act(token, id, action) {
                const path = { start: 'start', stop: 'halt', reboot: 'reboot' }[action];
                await call('vultr', token, `/instances/${encodeURIComponent(id)}/${path}`, { method: 'POST', body: {} });
            },
        },
        hetzner: {
            async verify(token) { await call('hetzner', token, '/servers?per_page=1'); return 'Hetzner Cloud project'; },
            async list(token) {
                const r = await call('hetzner', token, '/servers?per_page=50');
                return (r.servers || []).map((h) => {
                    const loc = h.datacenter?.location?.name;
                    const price = (h.server_type?.prices || []).find((p) => p.location === loc) || (h.server_type?.prices || [])[0];
                    return {
                        id: String(h.id), name: h.name, status: st(h.status), region: loc || null, vcpu: num(h.server_type?.cores),
                        ram_mb: num(h.server_type?.memory) != null ? Math.round(h.server_type.memory * 1024) : null, disk_gb: num(h.server_type?.disk),
                        ipv4: h.public_net?.ipv4?.ip || null, ipv6: h.public_net?.ipv6?.ip ? String(h.public_net.ipv6.ip).split('/')[0] : null,
                        plan: h.server_type?.name || null, price: { monthly: num(price?.price_monthly?.gross), currency: 'EUR' }, created_at: h.created,
                    };
                });
            },
            async act(token, id, action) {
                const path = { start: 'poweron', stop: 'shutdown', reboot: 'reboot' }[action];
                await call('hetzner', token, `/servers/${encodeURIComponent(id)}/actions/${path}`, { method: 'POST' });
            },
        },
    };
    return adapters;
}

module.exports = { PROVIDERS, createProviders, ProviderError };
