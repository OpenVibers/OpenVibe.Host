'use strict';

/** Background work for catalog ingestion, search indexing and the events outbox. */
function createWorker({ config, outbox, catalogIngest, catalogSearch, keyedFeeds = null, log = console }) {
    const timers = [];
    return {
        start() {
            if (!config.worker.enabled) return;
            const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
            every(24 * 3600 * 1000, async () => { try { await outbox.outbox.prune(); } catch (err) { log.warn('[Host] outbox prune failed:', err.message); } });
            const searchSweep = async () => { try { await catalogSearch.sweep(); } catch (err) { log.warn('[Host] catalog search sweep failed:', err.message); } };
            setTimeout(searchSweep, 60_000).unref();
            every(3600 * 1000, searchSweep);
            // DigitalOcean and Hetzner prices with the owner's read-only tokens (a feed without a token is skipped).
            if (keyedFeeds) {
                const feeds = async () => { try { await keyedFeeds.pull(); } catch (err) { log.warn('[Host] keyed price feeds failed:', err.message); } await searchSweep(); };
                every(6 * 3600 * 1000, feeds);
                setTimeout(feeds, 30_000).unref();
            }
            if (catalogIngest.enabled) {
                const pull = async () => { try { await catalogIngest.pull(); } catch (err) { log.warn('[Host] catalog pull failed:', err.message); } await searchSweep(); };
                every(5 * 60_000, pull);
                setTimeout(pull, 5000).unref();
            }
        },
        stop() { for (const t of timers) clearInterval(t); timers.length = 0; },
    };
}
module.exports = { createWorker };
