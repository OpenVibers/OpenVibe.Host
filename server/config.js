'use strict';

/**
 * OpenVibe.Host Stage B (tenant static hosting) configuration. Every value comes from the
 * environment (production: /etc/openvibe/host.env, see .env.example). Only environment variable
 * NAMES appear in code and docs; secret values are never logged or returned.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const MiB = 1024 * 1024;

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4910);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.host' : `http://localhost:${port}`));
    const dashboardHost = new URL(baseUrl).hostname.toLowerCase();
    // Tenant sites are served at <site>.<sitesDomain>. It must be a registrable domain of its own,
    // never a subdomain of openvibe.network / openvibe.live (their cookies must never reach tenants).
    const sitesDomain = String(env.HOST_SITES_DOMAIN || 'openvibe.host').toLowerCase().replace(/^\.+|\.+$/g, '');

    const quota = (prefix, defaults) => ({
        storageBytes: int(env[`${prefix}STORAGE_BYTES`], defaults.storageBytes),
        deploysPerDay: int(env[`${prefix}DEPLOYS_PER_DAY`], defaults.deploysPerDay),
        maxFiles: int(env[`${prefix}MAX_FILES`], defaults.maxFiles),
        maxFileBytes: int(env[`${prefix}MAX_FILE_BYTES`], defaults.maxFileBytes),
        sites: int(env[`${prefix}SITES`], defaults.sites),
        customDomains: int(env[`${prefix}CUSTOM_DOMAINS`], defaults.customDomains),
    });

    return {
        service: 'host',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        dashboardHost,
        sitesDomain,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,   // nginx (realip) → Node

        dbPath: env.HOST_DB_PATH || './data/host.db',
        // Content-addressed deploy objects, one directory per project (tenancy keyed by project id).
        storageDir: env.HOST_STORAGE_DIR || './data/objects',

        // OpenVibe.Network: SSO (OAuth2 authorization server), JWKS, client-credentials tokens.
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'host',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the dashboard form tokens (CSRF). Unset: a random per-process key.
        formSecret: env.HOST_FORM_SECRET || '',

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        },

        uploads: {
            // Largest request body accepted for one deploy (the compressed archive or all multipart parts).
            maxUploadBytes: int(env.HOST_MAX_UPLOAD_BYTES, 100 * MiB),
            // Largest size an archive may unpack to (also capped by the project's storage quota). The
            // unpacked files are held in memory while they are checked, so this bounds what a small
            // gzip bomb can cost, whatever quota staff grant a project.
            maxUnpackedBytes: int(env.HOST_MAX_UNPACKED_BYTES, 256 * MiB),
            // Uploads read and validated at the same time, service-wide (each is held in memory).
            maxConcurrent: int(env.HOST_MAX_CONCURRENT_UPLOADS, 2),
            // Uploads are refused while the object store's filesystem has less than this free. The
            // disk is shared with every other service on the host (Live, Media, databases), so a
            // tenant must never be able to fill it.
            minFreeBytes: int(env.HOST_MIN_FREE_BYTES, 5 * 1024 * MiB),
        },
        // Projects one person may own (each gets the per-project quotas below).
        projects: {
            maxPerOwner: int(env.HOST_MAX_PROJECTS_PER_OWNER, 10),
        },

        // Per-project quotas (a row in host_quotas overrides them per project; only staff set it).
        quotas: {
            production: quota('HOST_QUOTA_', { storageBytes: 1024 * MiB, deploysPerDay: 50, maxFiles: 10000, maxFileBytes: 25 * MiB, sites: 10, customDomains: 5 }),
            sandbox: quota('HOST_SANDBOX_QUOTA_', { storageBytes: 100 * MiB, deploysPerDay: 20, maxFiles: 2000, maxFileBytes: 10 * MiB, sites: 3, customDomains: 0 }),
        },

        domains: {
            // What a custom domain's CNAME points at. Default: the site's own <site>.<sitesDomain>.
            cnameTarget: String(env.HOST_CNAME_TARGET || '').toLowerCase() || null,
            originIpv4: env.HOST_ORIGIN_IPV4 || null,
            originIpv6: env.HOST_ORIGIN_IPV6 || null,
            dnsServers: list(env.HOST_DNS_SERVERS),
            recheckIntervalMs: int(env.HOST_DOMAIN_RECHECK_MS, 10 * 60 * 1000),
            pendingDays: int(env.HOST_DOMAIN_PENDING_DAYS, 7),
            lapseDays: int(env.HOST_DOMAIN_LAPSE_DAYS, 7),
            extraReserved: list(env.HOST_RESERVED_DOMAINS).map((d) => d.toLowerCase()),
        },

        sites: { extraReservedNames: list(env.HOST_RESERVED_SITE_NAMES).map((d) => d.toLowerCase()) },

        worker: {
            enabled: env.HOST_WORKER !== 'off',
            id: env.HOST_WORKER_ID || `host-${process.pid}`,
        },

        // Browser origins that may call /api/v1 with a Bearer Network JWT (never cookies).
        apiCorsOrigins: list(env.API_CORS_ORIGINS || 'https://openvibe.network,https://openvibe.codes'),
    };
}

module.exports = { load };
