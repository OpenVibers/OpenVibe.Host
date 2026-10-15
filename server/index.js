'use strict';

/** OpenVibe.Host catalog service entry point. */
const { createApp } = require('./app');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');

async function main() {
const { app, ctx } = await createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Host] ${config.nodeEnv} on http://${config.host}:${config.port} → catalog ${config.baseUrl} (db ${config.db.url ? 'PostgreSQL' : 'embedded PGlite'})`);
    console.log(`[Host] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
// Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
// class each minute, stored in this service's telemetry_samples table; rows older than 14 days go daily.
telemetry.init({ service: 'host', sink: createPgTelemetrySink({ db: ctx.store.db, log: console }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
const telemetryRetention = startTelemetryRetention({ db: ctx.store.db, log: console, olderThanDays: 14 });
server.requestTimeout = 30_000;
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
        async () => { if (telemetryRetention) await telemetryRetention.stop(); await telemetry.stop(); },
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
