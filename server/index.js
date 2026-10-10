'use strict';

/**
 * OpenVibe.Host Stage B — process entry. `node server/index.js`
 * Listens on PORT (4910) behind nginx (deploy/nginx). Serves the dashboard and API on BASE_URL's
 * host and tenant sites on <site>.<HOST_SITES_DOMAIN> and verified custom domains. Starts the
 * outbox relay (when EVENTS_URL and the client secret are set) and the worker (domain checks,
 * object sweep).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

async function main() {
const { app, ctx } = await createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Host] ${config.nodeEnv} on http://${config.host}:${config.port} → dashboard ${config.baseUrl}, sites *.${config.sitesDomain} (db ${config.db.url ? 'PostgreSQL' : 'embedded PGlite'}, objects ${ctx.blobs.root})`);
    console.log(`[Host] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 10 * 60_000;   // large uploads on slow links
ctx.outbox.start();
ctx.worker.start();

// Signals belong to the kit: the worker stops taking new work, requests in flight drain for at most
// 4000 ms (a shorter drain than the 10 min upload timeout cuts an upload exactly as the old 5 s
// exit-0 timer did; Host's manifest declares lifecycle.shutdown.deadlineSeconds 5), then the outbox,
// metrics and database close, each best effort, and the process exits 0.
const { stop } = gracefulStop({
    name: 'Host',
    server,
    stop: [() => ctx.worker.stop()],
    close: [
        () => ctx.outbox.stop(),
        () => ctx.stopMetrics(),
        () => ctx.store.close(),
    ],
    drainMs: 4000,
    deadlineMs: 5000,
    deadlineExitCode: 0,
});
return { app, server, shutdown: stop };
}

if (require.main === module) {
    main().catch((err) => { console.error('[Host] failed to start:', err); process.exit(1); });
}
module.exports = { main };
