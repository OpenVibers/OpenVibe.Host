'use strict';
/**
 * Background work in the Host process (a few timers; nothing here executes tenant content):
 *
 *   domain checks    every HOST_DOMAIN_RECHECK_MS: pending custom domains are checked again
 *                    (they fail after HOST_DOMAIN_PENDING_DAYS); verified ones are re-checked daily
 *                    and lapse when their TXT record has been gone for HOST_DOMAIN_LAPSE_DAYS
 *   object sweep     hourly: objects on disk that no deploy row references (an upload that failed
 *                    after writing objects) and interrupted temp files are removed after an hour
 *   outbox prune     daily: sent events older than seven days
 */
const fs = require('fs');

function createWorker({ config, store, domains, blobs, outbox, log = console }) {
    const timers = [];
    let checking = false;

    async function domainTick() {
        if (checking) return null;
        checking = true;
        try {
            const s = await domains.recheck();
            if (s.verified) outbox.kick();
            return s;
        } catch (err) {
            log.error('[Host] domain checks failed:', err.message);
            return null;
        } finally { checking = false; }
    }

    /** Remove objects no row references, once they are older than `graceMs`. */
    async function sweepObjects({ graceMs = 3600 * 1000 } = {}) {
        const known = store.db.prepare('SELECT 1 FROM host_blobs WHERE project_id = ? AND sha256 = ?');
        let removed = 0;
        for (const o of blobs.list()) {
            if (await known.get(o.projectId, o.sha256)) continue;
            try {
                if (Date.now() - fs.statSync(o.file).mtimeMs < graceMs) continue;
                // Through the store, so with the Media store the unreferenced Media object goes too.
                if (await blobs.remove(o.projectId, o.sha256)) removed++;
            } catch (err) {
                // A storage.media failure is a delete Media refused (grants, an outage): the sweep would
                // otherwise look like it worked while the object leaks. Anything else raced a write or
                // the file is already gone.
                if (err && err.code === 'storage.media') {
                    log.warn('[Host] object sweep could not delete a Media object:', o.projectId, o.sha256, err.message);
                }
            }
        }
        removed += blobs.sweepTmp(graceMs);
        return removed;
    }

    return {
        domainTick,
        sweepObjects,
        start() {
            if (!config.worker.enabled) return;
            const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
            every(config.domains.recheckIntervalMs, domainTick);
            every(3600 * 1000, async () => { try { await sweepObjects(); } catch (err) { log.warn('[Host] object sweep failed:', err.message); } });
            every(24 * 3600 * 1000, async () => { try { await outbox.outbox.prune(); } catch (err) { log.warn('[Host] outbox prune failed:', err.message); } });
            setTimeout(domainTick, 5000).unref();
        },
        stop() { for (const t of timers) clearInterval(t); timers.length = 0; },
    };
}

module.exports = { createWorker };
