'use strict';

/**
 * OpenVibe.Host Stage B — process entry. `node server/index.js`
 * Listens on PORT (4910) behind nginx (deploy/nginx). Serves the dashboard and API on BASE_URL's
 * host and tenant sites on <site>.<HOST_SITES_DOMAIN> and verified custom domains. Starts the
 * outbox relay (when EVENTS_URL and the client secret are set) and the worker (domain checks,
 * object sweep).
 */
const { createApp } = require('./app');

const { app, ctx } = createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Host] ${config.nodeEnv} on http://${config.host}:${config.port} → dashboard ${config.baseUrl}, sites *.${config.sitesDomain} (db ${config.dbPath}, objects ${ctx.blobs.root})`);
    console.log(`[Host] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 10 * 60_000;   // large uploads on slow links
ctx.outbox.start();
ctx.worker.start();

function shutdown(signal) {
    console.log(`[Host] ${signal}: closing`);
    ctx.worker.stop();
    server.close(async () => {
        try { await ctx.outbox.stop(); } catch { /* best effort */ }
        try { ctx.stopMetrics(); } catch { /* best effort */ }
        try { ctx.store.close(); } catch { /* already closed */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
