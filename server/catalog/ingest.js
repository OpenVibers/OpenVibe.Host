'use strict';

const ingest = require('openvibe-publishing/ingest');
const { SOURCES } = require('./mapping');
const offers = require('./offers');
function createCatalogIngest({ config, store, catalog, fetchImpl, source }) {
    if (!config.catalog.ingest || !config.catalog.sourcesUrl) return { enabled: false, pull: async () => ({ disabled: true }), consume: async () => ({ status: 503, code: 'ingest.disabled' }) };
    const sources = source || ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: config.catalog.sourcesUrl, category: 'hosting' } }, fetchImpl });
    const cursor = ingest.createChangeCursor(store.db, { prefix: 'catalog', now: store.now });
    const consumer = ingest.createEventConsumer({ db: store.db, secrets: config.catalog.webhookSecrets, consumer: 'host-catalog-sources', now: store.now });
    return {
        enabled: true,
        async pull() {
            let unknown = 0;
            const result = await ingest.pullChanges({ db: store.db, cursor, source: sources, name: 'sources.hosting.after', apply: async (item, t) => {
                const result = await catalog.applyItem(item, t);
                if (result === 'hold' && !SOURCES[item.source_key] && !offers.SOURCES[item.source_key]) unknown++;
                return result;
            } });
            return { ...result, unknown };
        },
        async consume(raw, headers) {
            return await consumer.apply(raw, headers, async (event) => {
                if (!/^sources\.item\./.test(event.event_type)) return 'ignored';
                const id = event.payload && event.payload.item_id;
                if (typeof id !== 'string') return 'ignored';
                const body = await sources.getItem(id);
                return await catalog.applyItem(body.item);
            });
        },
    };
}
module.exports = { createCatalogIngest };
