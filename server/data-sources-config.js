'use strict';
/**
 * The `host.data_sources` namespace (the owner-setup design of 2026-11-07): the hosting providers' API tokens the
 * comparison needs to read their prices. DigitalOcean and Hetzner Cloud publish their plans and prices only to a
 * signed-in account (a read-only token is enough); Vultr, Linode, AWS Lightsail, OVHcloud and Azure need none and
 * come through OpenVibe.Sources.
 *
 * The tokens are secret class: write-only through /internal/config/host.data_sources/secrets/:key, sealed with the
 * service's KEK, shown only as their last four characters. Each carries x-owner-input (group data-sources), so the
 * admin panel's Setup tab lists it with where to get it and a Test button. No x-env pin: the token entered in the
 * panel wins, and HOST_DIGITALOCEAN_TOKEN / HOST_HETZNER_TOKEN from the environment stay the fallback, read at use
 * time (token() below) by the price feed (server/catalog/keyed-feeds.js).
 */
const shared = require('openvibe-shared/config');

const SERVICE = 'host';
const NAMESPACE = 'host.data_sources';
const GROUP = 'Hosting prices';

const FEEDS = Object.freeze({
    digitalocean: { key: 'digitalocean.token', env: 'HOST_DIGITALOCEAN_TOKEN', name: 'DigitalOcean' },
    hetzner: { key: 'hetzner.token', env: 'HOST_HETZNER_TOKEN', name: 'Hetzner Cloud' },
});

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Hosting price sources',
    description: 'The API tokens Host reads hosting providers\' plans and prices with, for the comparison on openvibe.host. Add one to bring that provider\'s plans into the comparison; remove it to stop reading them.',
    type: 'object',
    additionalProperties: false,
    properties: {
        'digitalocean.token': {
            type: 'string', minLength: 16, maxLength: 512,
            title: 'DigitalOcean API token (read only)', 'x-group': GROUP, 'x-example': 'dop_v1_…',
            description: 'A read-only DigitalOcean token Host uses to read the Droplet plans and their prices every six hours. Without it DigitalOcean is missing from the comparison. Read access cannot create or change anything.',
            'x-owner-input': {
                group: 'data-sources',
                unlocks: 'Adds DigitalOcean\'s Droplet plans and prices to the hosting comparison, refreshed every six hours. Without it DigitalOcean stays out of the comparison.',
                get_it_at: 'https://cloud.digitalocean.com/account/api/tokens',
                get_it_how: 'Generate a new personal access token with the Read scope only, and no expiry or a long one.',
                test: true,
            },
            'x-required-for': 'DigitalOcean in the hosting comparison',
        },
        'hetzner.token': {
            type: 'string', minLength: 16, maxLength: 512,
            title: 'Hetzner Cloud API token (read only)', 'x-group': GROUP, 'x-example': 'a1B2c3…',
            description: 'A read-only Hetzner Cloud token Host uses to read the server types and their prices every six hours. Without it Hetzner is missing from the comparison. Prices are in euros, as Hetzner states them.',
            'x-owner-input': {
                group: 'data-sources',
                unlocks: 'Adds Hetzner Cloud\'s server plans and prices to the hosting comparison, refreshed every six hours. Without it Hetzner stays out of the comparison.',
                get_it_at: 'https://console.hetzner.cloud/projects',
                get_it_how: 'Open any project (an empty one is fine), then Security, API tokens, and generate a token with Read permission.',
                test: true,
            },
            'x-required-for': 'Hetzner in the hosting comparison',
        },
    },
};

const classify = (key) => (Object.values(FEEDS).some((f) => f.key === key) ? 'secret' : 'internal');

/** Create the store; reseal old rows once when a KEK is configured. */
async function create({ db, env = process.env, log = console }) {
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, env, classify, log,
        onChange: ({ namespace, keys, actor: who, revision }) => {
            (log.info || log.log).call(log, `[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${keys.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    /** A feed's token at use time: { value, source: vault | env | null, env }. The panel's value wins. */
    function token(feed) {
        const f = FEEDS[feed];
        if (!f) return { value: '', source: null, env: null };
        const own = store.get(f.key);
        if (typeof own === 'string' && own) return { value: own, source: 'vault', env: f.env };
        const fallback = String(env[f.env] || '').trim();
        return { value: fallback, source: fallback ? 'env' : null, env: f.env };
    }
    return { store, token, FEEDS };
}

module.exports = { create, SCHEMA, NAMESPACE, FEEDS };
