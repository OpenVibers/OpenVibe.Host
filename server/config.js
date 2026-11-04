'use strict';

/** OpenVibe.Host catalog service configuration. */
const path = require('path');
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4910);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.host' : `http://localhost:${port}`));
    return {
        service: 'host',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        // IndexNow (openvibe-shared/indexnow): with a key, each catalog page a pull adds or reprices is sent to search
        // engines in one batch, and the key is served at /<key>.txt. Unset: off.
        indexnow: { key: String(env.INDEXNOW_KEY || '').trim() },
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,   // nginx (realip) → Node

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        // HOST_PGLITE_DIR: where the development-only embedded database lives (default data/pglite); tests
        // point it at a temp directory so a spawned server gets a database of its own.
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.HOST_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:host:' },
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
            // OpenVibe.Events → Host (ADR-033 account export and deletion, server/account-data.js): the secret(s) that sign
            // its deliveries to /internal/events (32+ characters); the first one is what the subscriptions are made with.
            secrets: String(env.HOST_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
        },
        community: {
            internalUrl: trim(env.HOST_COMMUNITY_URL || ''),
            publicUrl: trim(env.OV_COMMUNITY_URL || 'https://openvibe.community'),
        },
        // OpenVibe.Watch's public site: a plan page links a prefilled watch on the plan's own API (no call is made).
        watch: { publicUrl: trim(env.OV_WATCH_URL || 'https://openvibe.watch') },

        catalog: { ingest: String(env.HOST_CATALOG_INGEST || 'off').trim().toLowerCase() === 'on', sourcesUrl: trim(env.HOST_CATALOG_SOURCES_URL || ''), webhookSecrets: list(env.HOST_CATALOG_WEBHOOK_SECRETS) },

        // The console (server/console/): a person's own hosting accounts, their tokens sealed with HOST_CREDENTIALS_KEY
        // (32 bytes, hex or base64). Without it the console shows servers of no account and connects none.
        console: { credentialsKey: env.HOST_CREDENTIALS_KEY || '', maxAccounts: int(env.HOST_CONSOLE_MAX_ACCOUNTS, 10) },
        // Inference placement planner (PLAN.md §G-P7): a staff-only forecast and break-even, off unless
        // HOST_INFERENCE_PLANNER=on. It never starts, stops or rents a GPU. Its demand comes from the
        // planning JSON (default) or, with HOST_INFERENCE_PLANNER_SOURCE=ai, from OpenVibe.AI's aggregate
        // usage series (GET /api/v1/usage/series, Host's service token, capability ai.usage.read).
        // The budget is integer nano-USD (D1); empty means 0, and an invalid value is treated as 0 by the
        // planner (fail safe) and reported as invalid on the page.
        inferencePlanner: {
            enabled: String(env.HOST_INFERENCE_PLANNER || 'off').trim().toLowerCase() === 'on',
            source: String(env.HOST_INFERENCE_PLANNER_SOURCE || 'json').trim().toLowerCase() === 'ai' ? 'ai' : 'json',
            inputPath: env.HOST_INFERENCE_PLANNER_INPUT || path.join(__dirname, '..', 'workers', 'llm-inference', 'examples', 'inference-planner.example.json'),
            // A feed failure may only fall back to a JSON input the operator configured, never to the
            // bundled example that happens to be the default path.
            inputConfigured: env.HOST_INFERENCE_PLANNER_INPUT != null && String(env.HOST_INFERENCE_PLANNER_INPUT).trim() !== '',
            aiUrl: trim(env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700'),
            aiAudience: 'openvibe.ai',
            aiCapability: 'ai.usage.read',
            days: Math.max(14, Math.min(90, int(env.HOST_INFERENCE_PLANNER_DAYS, 28))),
            cacheMs: Math.max(0, int(env.HOST_INFERENCE_PLANNER_CACHE_MS, 10 * 60 * 1000)),
            timeoutMs: Math.max(100, int(env.HOST_INFERENCE_PLANNER_TIMEOUT_MS, 5000)),
            budgetNanoUsdRaw: env.HOST_INFERENCE_BUDGET_NANO_USD === undefined ? '' : String(env.HOST_INFERENCE_BUDGET_NANO_USD),
        },
        worker: {
            enabled: env.HOST_WORKER !== 'off',
            id: env.HOST_WORKER_ID || `host-${process.pid}`,
        },

    };
}

module.exports = { load };
